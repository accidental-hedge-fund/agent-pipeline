import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "./runtime.mjs";
import { parseUnitProperties, serializeEnvironment, systemdRunArgs } from "./durable-command.mjs";
import { validateMachineConfig } from "./config.mjs";
import { validateGrantEnvelope } from "./grant.mjs";

export const FRG_RUNNER_SCHEMA_VERSION = 1;
export const FRG_RUNNER_PACK_ID = "factory-gate-v1";
export const FRG_RUNNER_PILOT_VERSION = "1.33.0";
export const FRG_SCORER_UNIT_TEMPLATE = "hermes-factory-frg@.service";

const GIT = "/usr/bin/git";
const GH = "/usr/bin/gh";
const SYSTEMCTL = "/usr/bin/systemctl";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  const canonical = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    const output = {};
    for (const key of Object.keys(entry).sort()) output[key] = canonical(entry[key]);
    return output;
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function parseJson(text, name) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function requireString(value, name, pattern = null) {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireSafeId(value, name) {
  const id = requireString(value, name, SAFE_ID_RE);
  if (id.includes("..")) throw new Error(`${name} is not safe`);
  return id;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function exactSet(actual, expected, name) {
  const left = [...actual].map(String).sort();
  const right = [...expected].map(String).sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${name} [${left.join(",")}] does not equal [${right.join(",")}]`);
  }
}

function compareSemver(left, right) {
  const a = requireString(left, "version", SEMVER_RE).split(".").map(Number);
  const b = requireString(right, "version", SEMVER_RE).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function confinedTo(path, root) {
  if (!isAbsolute(path)) return false;
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function assertOwnedMode(path, expectedModes, type, deps, name) {
  const info = await deps.stat(path);
  const isExpectedType = type === "directory" ? info.isDirectory() : info.isFile();
  if (!isExpectedType) throw new Error(`${name} must be a regular ${type}`);
  const mode = info.mode & 0o777;
  if (!expectedModes.includes(mode)) {
    throw new Error(`${name} mode must be ${expectedModes.map((value) => value.toString(8)).join(" or ")}`);
  }
  const uid = deps.getuid();
  if (uid !== null && info.uid !== uid) throw new Error(`${name} must be owned by the scorer user`);
}

async function secureMkdir(path, deps) {
  await deps.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await deps.chmod(path, PRIVATE_DIRECTORY_MODE);
  await assertOwnedMode(path, [PRIVATE_DIRECTORY_MODE], "directory", deps, path);
}

async function immutableWrite(filePath, body, deps) {
  await secureMkdir(dirname(filePath), deps);
  const temporary = `${filePath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    await deps.writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE });
    await deps.chmod(temporary, PRIVATE_FILE_MODE);
    await deps.link(temporary, filePath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertOwnedMode(filePath, [PRIVATE_FILE_MODE], "file", deps, filePath);
    const existing = await deps.readFile(filePath, "utf8");
    if (existing !== body) throw new Error(`refusing to replace different immutable artifact ${filePath}`);
  } finally {
    await deps.unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await deps.chmod(filePath, PRIVATE_FILE_MODE);
  await assertOwnedMode(filePath, [PRIVATE_FILE_MODE], "file", deps, filePath);
}

function parseJsonLines(text, name) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${name} is empty`);
  return lines.map((line, index) => parseJson(line, `${name} line ${index + 1}`));
}

async function command(deps, executable, args, options = {}) {
  const result = await deps.exec(executable, args, options);
  if (!result || typeof result.code !== "number") throw new Error(`${executable} returned no process result`);
  return result;
}

function commandFailure(result, name) {
  const detail = String(result?.stderr ?? "").trim().split(/\r?\n/).at(-1);
  return new Error(`${name} failed with exit ${String(result?.code)}${detail ? `: ${detail}` : ""}`);
}

export async function verifyFrgCandidate(candidateCheckout, candidateGitSha, deps, { allowEvidence = false } = {}) {
  const head = await command(deps, GIT, ["rev-parse", "HEAD"], { cwd: candidateCheckout });
  if (head.code !== 0 || head.stdout.trim() !== candidateGitSha) {
    throw new Error("candidate checkout HEAD does not match --candidate-git-sha");
  }
  const branch = await command(deps, GIT, ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: candidateCheckout });
  if (branch.code === 0 || branch.code > 1) throw new Error("candidate checkout must be detached");
  const status = await command(
    deps,
    GIT,
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: candidateCheckout },
  );
  if (status.code !== 0) throw commandFailure(status, "git status");
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean);
  if (!allowEvidence && dirty.length > 0) throw new Error("candidate checkout is not clean");
  if (
    allowEvidence &&
    dirty.some((line) => {
      const file = line.slice(3);
      return !file.startsWith(`.agent-pipeline/frg/${FRG_RUNNER_PILOT_VERSION}/`) &&
        file !== ".agent-pipeline/frg/trend-ledger.jsonl";
    })
  ) {
    throw new Error("candidate checkout has dirt outside the expected FRG evidence paths");
  }
}

async function defaultListPackIssues(input, deps) {
  const result = await command(
    deps,
    GH,
    [
      "issue", "list", "--repo", input.repository, "--state", "all", "--label",
      input.selectorLabel, "--limit", "1000", "--json",
      "number,id,title,body,labels,createdAt,state",
    ],
    { cwd: input.candidateCheckout },
  );
  if (result.code !== 0) throw commandFailure(result, "gh issue list");
  const rows = parseJson(result.stdout, "gh issue list");
  if (!Array.isArray(rows)) throw new Error("gh issue list did not return an array");
  return rows.map((row) => ({
    number: row.number,
    node_id: row.id,
    title: row.title,
    body: row.body ?? "",
    labels: Array.isArray(row.labels) ? row.labels.map((label) => label?.name).filter(Boolean) : [],
    created_at: row.createdAt,
    state: String(row.state ?? "").toUpperCase(),
  }));
}

async function defaultCreateIssue(rendered, input, deps) {
  const args = [
    "issue", "create", "--repo", input.repository,
    "--title", rendered.title,
    "--body", rendered.body,
  ];
  for (const label of rendered.labels) args.push("--label", label);
  const result = await command(deps, GH, args, { cwd: input.candidateCheckout });
  if (result.code !== 0) throw commandFailure(result, "gh issue create");
  const match = result.stdout.trim().match(/\/issues\/(\d+)(?:\s*)$/);
  if (!match) throw new Error("gh issue create did not return an issue URL");
  return Number(match[1]);
}

function parseLoopHandoff(stdout) {
  const objects = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const handoff = objects.find((entry) => entry?.kind === "loop_run_handoff");
  if (
    handoff?.schema_version !== "1" ||
    !SAFE_ID_RE.test(handoff?.run_id ?? "") ||
    !isAbsolute(handoff?.run_dir ?? "") ||
    !isAbsolute(handoff?.events ?? "")
  ) {
    throw new Error("candidate Pipeline loop did not emit a valid early run handoff");
  }
  if (resolve(handoff.events) !== resolve(handoff.run_dir, "events.jsonl")) {
    throw new Error("candidate Pipeline handoff events path is not run-confined");
  }
  return { loop_run_id: handoff.run_id, run_dir: resolve(handoff.run_dir) };
}

async function optionalText(path, deps) {
  try {
    return await deps.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function unitIsProvenTerminal(state) {
  return state?.state === "missing" || state?.active_state === "inactive";
}

async function defaultUnitState(unit, deps) {
  const result = await command(
    deps,
    SYSTEMCTL,
    [
      "--user", "show", unit,
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=Result",
      "--property=ExecMainStatus",
    ],
    { timeoutMs: 30_000 },
  );
  let parsed;
  try {
    parsed = parseUnitProperties(result.stdout);
  } catch (error) {
    if (result.code !== 0) {
      throw commandFailure(result, `observe systemd unit ${unit}`);
    }
    throw error;
  }
  if (result.code !== 0 && !unitIsProvenTerminal(parsed)) {
    throw commandFailure(result, `observe systemd unit ${unit}`);
  }
  return parsed;
}

async function defaultLaunchLoopUnit(input, deps) {
  const args = [
    "--experimental-strip-types", input.pipelinePath,
    "loop", "--label", input.selectorLabel,
    "--repo-path", input.candidateCheckout,
    "--profile", input.profile,
  ];
  const runArgs = systemdRunArgs({
    unit: input.loopChild.unit,
    cwd: input.candidateCheckout,
    outputPath: input.loopChild.output_path,
    diagnosticPath: input.loopChild.diagnostic_path,
    envFile: input.loopChild.env_path,
    cleanExecNode: process.execPath,
    cleanExecScript: join(dirname(fileURLToPath(import.meta.url)), "clean-exec.mjs"),
    command: process.execPath,
    args,
  });
  const result = await command(
    deps,
    SYSTEMD_RUN,
    runArgs,
    { cwd: input.candidateCheckout, timeoutMs: 30_000 },
  );
  if (result.code !== 0) throw commandFailure(result, `launch candidate Pipeline loop unit ${input.loopChild.unit}`);
}

async function defaultStopUnit(unit, deps) {
  const stop = await command(deps, SYSTEMCTL, ["--user", "stop", unit], { timeoutMs: 30_000 });
  if (stop.code !== 0) {
    const state = await deps.unitState(unit, deps);
    if (!unitIsProvenTerminal(state)) throw commandFailure(stop, `stop systemd unit ${unit}`);
  }
  await command(deps, SYSTEMCTL, ["--user", "reset-failed", unit], { timeoutMs: 30_000 });
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await deps.unitState(unit, deps);
    if (unitIsProvenTerminal(state)) return;
    await deps.sleep(250);
  }
  throw new Error(`systemd unit ${unit} did not become terminal after stop`);
}

function finalEventCursor(text) {
  let cursor = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isSafeInteger(event?.seq) && event.seq > cursor) cursor = event.seq;
    } catch {}
  }
  return cursor;
}

export async function runFrgLoopChild(input, deps) {
  const child = input.loopChild;
  await secureMkdir(dirname(child.output_path), deps);
  const privateJsonIfPresent = async (path, name) => {
    try {
      await assertOwnedMode(path, [PRIVATE_FILE_MODE], "file", deps, name);
      return parseJson(await deps.readFile(path, "utf8"), name);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const persistedHandoff = await privateJsonIfPresent(child.handoff_path, "FRG loop handoff");
  const persistedCursor = await privateJsonIfPresent(child.events_cursor_path, "FRG loop event cursor");
  if (!persistedHandoff && persistedCursor) {
    throw new Error("persisted FRG loop event cursor has no handoff identity");
  }
  if (persistedHandoff && persistedCursor) {
    const loopRunId = requireSafeId(persistedHandoff.loop_run_id, "persisted FRG loop run id");
    const runDir = requireString(persistedHandoff.run_dir, "persisted FRG loop run directory");
    if (
      !isAbsolute(runDir) ||
      persistedCursor.loop_run_id !== loopRunId ||
      resolve(persistedCursor.events_path) !== join(resolve(runDir), "events.jsonl") ||
      !Number.isSafeInteger(persistedCursor.final_event_cursor) ||
      persistedCursor.final_event_cursor < 1
    ) {
      throw new Error("persisted FRG loop completion proof is invalid");
    }
    const state = await deps.unitState(child.unit, deps);
    if (!unitIsProvenTerminal(state)) {
      await deps.stopUnit(child.unit, deps);
    }
    await deps.unlink(child.env_path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    deps.emitLine(canonicalJson({
      schema_version: "1",
      kind: "loop_run_handoff",
      run_id: loopRunId,
      run_dir: resolve(runDir),
      events: join(resolve(runDir), "events.jsonl"),
    }).trimEnd());
    return { loop_run_id: loopRunId, run_dir: resolve(runDir) };
  }
  const childEnv = { ...deps.env };
  for (const name of ["PIPELINE_FRG_ATTESTATION_KEY", "PIPELINE_FRG_ATTESTATION_KEY_FILE", "CREDENTIALS_DIRECTORY"]) {
    delete childEnv[name];
  }
  await immutableWrite(child.env_path, serializeEnvironment(childEnv), deps);

  let unitState = await deps.unitState(child.unit, deps);
  if (unitState.state === "missing") {
    if (persistedHandoff) {
      throw new Error("candidate Pipeline loop unit disappeared after handoff but before completion proof");
    }
    await deps.launchLoopUnit(input, deps);
    unitState = { state: "running" };
  }

  let handoff = null;
  let announced = false;
  for (let attempt = 0; attempt < 10_800; attempt++) {
    const stopReason = await deps.shouldStop();
    if (stopReason) {
      await deps.stopUnit(child.unit, deps);
      await deps.unlink(child.env_path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      throw new Error(`candidate Pipeline loop stopped: ${stopReason}`);
    }
    const output = await optionalText(child.output_path, deps);
    if (!handoff && output) {
      try {
        handoff = parseLoopHandoff(output);
        await immutableWrite(child.handoff_path, canonicalJson(handoff), deps);
      } catch (error) {
        if (!String(error?.message ?? "").includes("did not emit")) throw error;
      }
    }
    if (handoff && !announced) {
      deps.emitLine(canonicalJson({
        schema_version: "1",
        kind: "loop_run_handoff",
        run_id: handoff.loop_run_id,
        run_dir: handoff.run_dir,
        events: join(handoff.run_dir, "events.jsonl"),
      }).trimEnd());
      announced = true;
    }
    unitState = await deps.unitState(child.unit, deps);
    if (unitState.state === "complete") break;
    if (unitState.state === "failed" || unitState.state === "missing") {
      const diagnostic = (await optionalText(child.diagnostic_path, deps)).trim().split(/\r?\n/).at(-1);
      throw new Error(`candidate Pipeline loop unit ${child.unit} ${unitState.state}${diagnostic ? `: ${diagnostic}` : ""}`);
    }
    await deps.sleep(2000);
  }
  if (unitState.state !== "complete") throw new Error(`candidate Pipeline loop unit ${child.unit} timed out`);
  if (!handoff) handoff = parseLoopHandoff(await optionalText(child.output_path, deps));
  const eventsPath = join(handoff.run_dir, "events.jsonl");
  const cursor = finalEventCursor(await optionalText(eventsPath, deps));
  await immutableWrite(child.events_cursor_path, canonicalJson({
    schema_version: 1,
    loop_run_id: handoff.loop_run_id,
    events_path: eventsPath,
    final_event_cursor: cursor,
  }), deps);
  await deps.stopUnit(child.unit, deps);
  await deps.unlink(child.env_path).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return handoff;
}

function itemIdFromRecord(record) {
  const candidates = [record?.item_id, record?.data?.item_id];
  for (const value of candidates) {
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

async function defaultReadLoopArtifacts(run, deps) {
  const paths = {
    contract: join(run.run_dir, "contract.json"),
    ledger: join(run.run_dir, "ledger.json"),
    events: join(run.run_dir, "events.jsonl"),
    actions: join(run.run_dir, "action-evidence.jsonl"),
  };
  const [contractText, ledgerText, eventsText, actionsText] = await Promise.all([
    deps.readFile(paths.contract, "utf8"),
    deps.readFile(paths.ledger, "utf8"),
    deps.readFile(paths.events, "utf8"),
    deps.readFile(paths.actions, "utf8"),
  ]);
  const contract = parseJson(contractText, "loop contract");
  const ledger = parseJson(ledgerText, "loop ledger");
  const events = parseJsonLines(eventsText, "loop events");
  const actions = parseJsonLines(actionsText, "loop action evidence");
  return {
    contract_text: contractText,
    ledger_text: ledgerText,
    events_text: eventsText,
    actions_text: actionsText,
    contract,
    ledger,
    events,
    actions,
  };
}

export async function observeFrgPullRequest(issueNumber, input, deps) {
  const list = await command(
    deps,
    GH,
    [
      "pr", "list", "--repo", input.repository, "--state", "open", "--base", input.baseBranch,
      "--limit", "1000", "--json",
      "number,id,state,isDraft,headRefName,headRefOid,baseRefName,isCrossRepository,closingIssuesReferences",
    ],
    { cwd: input.candidateCheckout },
  );
  if (list.code !== 0) throw commandFailure(list, "gh pr list");
  const rows = parseJson(list.stdout, "gh pr list");
  if (!Array.isArray(rows)) throw new Error("gh pr list did not return an array");
  const matches = rows.filter((pr) =>
    !pr.isCrossRepository &&
    pr.state === "OPEN" &&
    pr.baseRefName === input.baseBranch &&
    typeof pr.headRefName === "string" &&
    pr.headRefName.startsWith(`pipeline/${issueNumber}-`) &&
    Array.isArray(pr.closingIssuesReferences) &&
    pr.closingIssuesReferences.some((issue) => issue?.number === issueNumber),
  );
  if (matches.length !== 1) throw new Error(`issue #${issueNumber} must resolve to exactly one open Pipeline PR`);
  const match = matches[0];
  const view = await command(
    deps,
    GH,
    ["pr", "view", String(match.number), "--repo", input.repository, "--json", "number,id,state,isDraft,headRefOid,baseRefName,files"],
    { cwd: input.candidateCheckout },
  );
  if (view.code !== 0) throw commandFailure(view, "gh pr view");
  const pr = parseJson(view.stdout, "gh pr view");
  const checksResult = await command(
    deps,
    GH,
    [
      "api", "--paginate", "--slurp",
      `repos/${input.repository}/commits/${pr.headRefOid}/check-runs?per_page=100`,
    ],
    { cwd: input.candidateCheckout },
  );
  if (checksResult.code !== 0) throw commandFailure(checksResult, "gh check-runs query");
  const pages = parseJson(checksResult.stdout, "gh check-runs query");
  if (!Array.isArray(pages)) throw new Error("gh check-runs query did not return pages");
  const checks = pages.flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []);
  if (checks.length === 0) throw new Error(`PR #${pr.number} has no candidate-head checks`);
  if (
    checks.some((check) =>
      check?.head_sha !== pr.headRefOid ||
      check?.status !== "completed" ||
      !["success", "neutral", "skipped"].includes(check?.conclusion),
    )
  ) {
    throw new Error(`PR #${pr.number} has a pending, failed, or wrong-head check`);
  }
  return {
    number: pr.number,
    node_id: pr.id,
    head_sha: pr.headRefOid,
    base_branch: pr.baseRefName,
    files: Array.isArray(pr.files) ? pr.files.map((file) => file?.path).filter(Boolean) : [],
    checks: checks.map((check) => ({
      id: String(check.id),
      name: check.name,
      head_sha: check.head_sha,
      conclusion: check.conclusion,
    })),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runFrgCandidateProbe(probe, input, deps) {
  await deps.verifyCandidate(input.candidateCheckout, input.candidateGitSha, deps);
  const testPath = resolve(input.candidateCheckout, probe.test_file);
  if (relative(input.candidateCheckout, testPath).startsWith("..")) throw new Error(`probe ${probe.id} escapes candidate checkout`);
  const args = [
    "--test", "--experimental-strip-types", "--test-reporter=tap",
    "--test-name-pattern", `^${escapeRegExp(probe.test_name)}$`,
    testPath,
  ];
  const startedAt = deps.now().toISOString();
  const result = await command(deps, process.execPath, args, { cwd: input.candidateCheckout, timeoutMs: 30 * 60 * 1000 });
  const finishedAt = deps.now().toISOString();
  if (result.code !== 0) throw commandFailure(result, `Layer A probe ${probe.id}`);
  if (
    result.stdout.split(`# Subtest: ${probe.test_name}\n`).length - 1 !== 1 ||
    (result.stdout.match(new RegExp(`^ok \\d+ - ${escapeRegExp(probe.test_name)}$`, "gm")) ?? []).length !== 1 ||
    !/^# tests 1$/m.test(result.stdout) ||
    !/^# pass 1$/m.test(result.stdout) ||
    !/^# fail 0$/m.test(result.stdout) ||
    !/^# skipped 0$/m.test(result.stdout)
  ) {
    throw new Error(`Layer A probe ${probe.id} did not report the one exact unskipped TAP pass`);
  }
  await deps.verifyCandidate(input.candidateCheckout, input.candidateGitSha, deps);
  return {
    id: probe.id,
    candidate_git_sha: input.candidateGitSha,
    test_file: probe.test_file,
    test_name: probe.test_name,
    command_argv_sha256: digest(canonicalJson([process.execPath, ...args])),
    stdout_sha256: digest(result.stdout),
    stderr_sha256: digest(result.stderr),
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

async function defaultStartScorer(requestPath, unitTemplate, deps) {
  if (unitTemplate !== FRG_SCORER_UNIT_TEMPLATE) throw new Error(`unsupported FRG scorer unit ${unitTemplate}`);
  const requestId = requireSafeId(requestPath.split("/").at(-1)?.replace(/\.json$/, ""), "FRG score request id");
  const unit = unitTemplate.replace("@.service", `@${requestId}.service`);
  const result = await command(deps, SYSTEMCTL, ["--user", "start", unit], {
    timeoutMs: 6 * 60 * 60 * 1000,
    shouldStop: deps.shouldStop,
  });
  if (result.stopped) {
    await deps.stopUnit(unit, deps);
    throw new Error(`isolated FRG scorer stopped: ${result.stopped}`);
  }
  if (result.code !== 0) throw commandFailure(result, `systemctl start ${unit}`);
}

async function defaultClosePr(number, input, deps) {
  const result = await command(
    deps,
    GH,
    ["pr", "close", String(number), "--repo", input.repository, "--comment", input.closeComment],
    { cwd: input.candidateCheckout },
  );
  if (result.code !== 0) throw commandFailure(result, `gh pr close #${number}`);
}

async function defaultCloseIssue(number, input, deps) {
  const result = await command(
    deps,
    GH,
    ["issue", "close", String(number), "--repo", input.repository, "--reason", "completed", "--comment", input.closeComment],
    { cwd: input.candidateCheckout },
  );
  if (result.code !== 0) throw commandFailure(result, `gh issue close #${number}`);
}

async function defaultObserveClosed(kind, number, input, deps) {
  const result = await command(
    deps,
    GH,
    [kind, "view", String(number), "--repo", input.repository, "--json", "state"],
    { cwd: input.candidateCheckout },
  );
  if (result.code !== 0) throw commandFailure(result, `gh ${kind} view #${number}`);
  return parseJson(result.stdout, `gh ${kind} view`).state === "CLOSED";
}

function defaultDeps(overrides = {}) {
  const deps = {
    env: process.env,
    now: () => new Date(),
    readFile,
    writeFile,
    link,
    mkdir,
    chmod,
    rename,
    stat,
    unlink,
    getuid: () => typeof process.getuid === "function" ? process.getuid() : null,
    scorerRequestRoot: join(homedir(), ".local", "state", "hermes-factory", "frg-scorer-requests"),
    machineConfigPath: join(homedir(), ".config", "hermes-factory", "config.json"),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    shouldStop: async () => null,
    exec: (executable, args, options = {}) => runProcess(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? 60_000,
      shouldStop: options.shouldStop,
    }),
    verifyCandidate: verifyFrgCandidate,
    listPackIssues: defaultListPackIssues,
    createIssue: defaultCreateIssue,
    runLoop: runFrgLoopChild,
    unitState: defaultUnitState,
    launchLoopUnit: defaultLaunchLoopUnit,
    stopUnit: defaultStopUnit,
    emitLine: (line) => process.stdout.write(`${line}\n`),
    readLoopArtifacts: defaultReadLoopArtifacts,
    observePullRequest: observeFrgPullRequest,
    runProbe: runFrgCandidateProbe,
    startScorer: defaultStartScorer,
    closePr: defaultClosePr,
    closeIssue: defaultCloseIssue,
    observeClosed: defaultObserveClosed,
    ...overrides,
  };
  return deps;
}

function validateRunOptions(options) {
  if (options.version !== FRG_RUNNER_PILOT_VERSION) {
    throw new Error(`the hybrid FRG runner is valid only for v${FRG_RUNNER_PILOT_VERSION}; #908 owns later releases`);
  }
  requireString(options.repository, "--repository", REPOSITORY_RE);
  requireString(options.base, "--base");
  requireString(options.profile, "--profile", /^(claude|codex|grok|opencode)$/);
  requireString(options.candidateGitSha, "--candidate-git-sha", GIT_SHA_RE);
  requireString(options.manifestSha256, "--manifest-sha256", DIGEST_RE);
  requireSafeId(options.actionId, "--action-id");
  if (!isAbsolute(options.manifest) || !isAbsolute(options.stateDir) || !isAbsolute(options.scorerRequestDir)) {
    throw new Error("manifest, state-dir, and scorer-request-dir must be absolute paths");
  }
  if (options.scorerUnitTemplate !== FRG_SCORER_UNIT_TEMPLATE) {
    throw new Error(`--scorer-unit-template must be ${FRG_SCORER_UNIT_TEMPLATE}`);
  }
  const resolvedStateDir = resolve(options.stateDir);
  const frgRoot = dirname(dirname(resolvedStateDir));
  const factoryStateDir = dirname(frgRoot);
  if (
    basename(resolvedStateDir) !== options.version ||
    basename(frgRoot) !== "frg" ||
    !/^[0-9a-f]{64}$/.test(basename(dirname(resolvedStateDir))) ||
    resolve(options.scorerRequestDir) !== join(factoryStateDir, "frg-scorer-requests")
  ) {
    throw new Error("FRG state and scorer request directories do not match the factory state layout");
  }
}

function loopChildDescriptor(packRunId, stateDir) {
  const root = join(resolve(stateDir), packRunId, "loop-child");
  return {
    unit: `hermes-frg-loop-${digest(packRunId).slice(0, 32)}`,
    output_path: join(root, "output.log"),
    diagnostic_path: join(root, "diagnostic.log"),
    env_path: join(root, "child.env"),
    handoff_path: join(root, "handoff.json"),
    events_cursor_path: join(root, "events-cursor.json"),
  };
}

function runnerState(packRunId, options, startedAt) {
  return {
    schema_version: 1,
    kind: "frg_pack_runner_state",
    pack_run_id: packRunId,
    version: options.version,
    repository: options.repository,
    base_branch: options.base,
    candidate_git_sha: options.candidateGitSha,
    manifest_sha256: options.manifestSha256,
    action_id: options.actionId,
    started_at: startedAt,
    loop_child: loopChildDescriptor(packRunId, options.stateDir),
  };
}

function packRunIdentity(options) {
  const identity = canonicalJson({
    pack_id: FRG_RUNNER_PACK_ID,
    version: options.version,
    repository: options.repository.toLowerCase(),
    base_branch: options.base,
    candidate_git_sha: options.candidateGitSha,
    manifest_sha256: options.manifestSha256,
    action_id: options.actionId,
  });
  return `frg-${options.version.replaceAll(".", "-")}-${digest(identity).slice(0, 24)}`;
}

function issueMarker(packRunId, templateId) {
  return `pack_run_id=${packRunId}\ntemplate_id=${templateId}\n`;
}

function validateExistingIssue(issue, rendered, startedAt) {
  requirePositiveInteger(issue.number, "synthetic issue number");
  requireSafeId(issue.node_id, "synthetic issue node id");
  if (issue.title !== rendered.title || issue.body !== rendered.body) {
    throw new Error(`synthetic issue #${issue.number} differs from template ${rendered.provenance.template_id}`);
  }
  const created = Date.parse(issue.created_at ?? "");
  if (!Number.isFinite(created) || created < Date.parse(startedAt)) {
    throw new Error(`synthetic issue #${issue.number} is not fresh for this pack run`);
  }
  for (const label of rendered.labels) {
    if (!issue.labels.includes(label)) throw new Error(`synthetic issue #${issue.number} is missing label ${label}`);
  }
}

function validateLoopRecords(artifacts, expectedIssueNumbers, selectorLabel) {
  const contract = artifacts.contract;
  const ledger = artifacts.ledger;
  if (
    contract?.schema !== "pipeline/loop-contract@1" ||
    contract?.selector?.type !== "label" ||
    contract?.selector?.value !== selectorLabel ||
    !Array.isArray(contract?.items)
  ) {
    throw new Error("loop contract does not preserve the exact fixed selector");
  }
  const contractNumbers = contract.items.map((item) => Number(item?.id));
  exactSet(contractNumbers, expectedIssueNumbers, "loop contract issue set");
  if (ledger?.schema !== "pipeline/loop-ledger@1" || ledger?.run_id !== contract.run_id) {
    throw new Error("loop ledger identity does not match its contract");
  }
  const ledgerEntries = Object.entries(ledger.items ?? {});
  exactSet(ledgerEntries.map(([id]) => Number(id)), expectedIssueNumbers, "loop ledger issue set");
  for (const [id, item] of ledgerEntries) {
    if (item?.state !== "ready" || item?.blocked_theme != null || !SAFE_ID_RE.test(item?.advance_run_id ?? "")) {
      throw new Error(`loop ledger item #${id} is not a clean ready item with an advance run identity`);
    }
  }
  const eventIssueNumbers = [...new Set(artifacts.events.map(itemIdFromRecord).filter(Boolean))];
  const actionIssueNumbers = [...new Set(artifacts.actions.map(itemIdFromRecord).filter(Boolean))];
  exactSet(eventIssueNumbers, expectedIssueNumbers, "loop event issue set");
  exactSet(actionIssueNumbers, expectedIssueNumbers, "loop action-evidence issue set");
  return {
    contract: {
      artifact_sha256: digest(artifacts.contract_text),
      selector: { type: "label", value: selectorLabel },
      issue_numbers: [...contractNumbers],
      items: contract.items.map((item) => ({
        issue_number: Number(item.id),
        depends_on: (item.depends_on ?? []).map(Number),
      })),
    },
    ledger: {
      artifact_sha256: digest(artifacts.ledger_text),
      items: ledgerEntries.map(([id, item]) => ({
        issue_number: Number(id),
        state: item.state,
        advance_run_id: item.advance_run_id,
        blocked_theme: item.blocked_theme ?? null,
      })),
    },
    events: {
      artifact_sha256: digest(artifacts.events_text),
      event_ids: artifacts.events.map((event) => `event:${event.seq}:${event.kind}`),
      issue_numbers: eventIssueNumbers,
    },
    action_evidence: {
      artifact_sha256: digest(artifacts.actions_text),
      action_ids: artifacts.actions.map((action) => `action:${action.seq}:${action.action}`),
      issue_numbers: actionIssueNumbers,
    },
  };
}

function validateAttestationResult(result, request) {
  if (
    result?.schema_version !== 1 ||
    result?.kind !== "frg_attestation_result" ||
    result?.status !== "complete" ||
    result?.request_id !== request.request_id ||
    result?.grant_fingerprint !== request.grant_fingerprint ||
    result?.action_id !== request.action_id ||
    result?.version !== request.version ||
    result?.loop_run_id !== request.loop_run_id ||
    result?.pack_run_id !== request.pack_run_id ||
    result?.candidate_git_sha !== request.candidate_git_sha ||
    result?.manifest_sha256 !== request.manifest_sha256 ||
    result?.frg_run_id !== request.frg_run_id ||
    !SAFE_ID_RE.test(result?.frg_run_id ?? "") ||
    !DIGEST_RE.test(result?.attestation_payload_sha256 ?? "") ||
    !DIGEST_RE.test(result?.attested_evidence_sha256 ?? "")
  ) {
    throw new Error("isolated FRG attestor returned an invalid result identity");
  }
  const signer = result?.signer;
  if (
    !signer ||
    !SAFE_ID_RE.test(signer.mode ?? "") ||
    !SAFE_ID_RE.test(signer.version ?? "") ||
    !SAFE_ID_RE.test(signer.tag ?? "") ||
    !GIT_SHA_RE.test(signer.git_sha ?? "") ||
    !SAFE_ID_RE.test(signer.policy_id ?? "") ||
    !DIGEST_RE.test(signer.policy_sha256 ?? "")
  ) {
    throw new Error("isolated FRG attestor signer identity is invalid");
  }
  return result;
}

function deterministicFrgRunId(request) {
  return `frg-${request.version.replaceAll(".", "-")}-${digest(canonicalJson({
    action_id: request.action_id,
    candidate_git_sha: request.candidate_git_sha,
    loop_run_id: request.loop_run_id,
    manifest_sha256: request.manifest_sha256,
    pack_run_id: request.pack_run_id,
  })).slice(0, 24)}`;
}

async function writeTrendLedger(candidateCheckout, evidence, deps) {
  const ledgerPath = join(candidateCheckout, ".agent-pipeline", "frg", "trend-ledger.jsonl");
  const row = {
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pass: evidence.pass,
    pack_id: evidence.pack_id,
    created_at: evidence.created_at,
    item_count: evidence.scoreboard.item_count,
    ready_clean_count: evidence.scoreboard.ready_clean_count,
    engine_class_count: evidence.scoreboard.engine_class_count,
    engine_class_rate: evidence.scoreboard.engine_class_rate,
    thresholds: { ...evidence.thresholds },
    composition_missing: [...evidence.composition.missing],
    false_human_authority_count: evidence.composition.false_human_authority_count,
    ...(evidence.recovery_aggregates ? { recovery_aggregates: evidence.recovery_aggregates } : {}),
  };
  let existing = "";
  try {
    existing = await deps.readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = existing.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const prior = parseJson(line, "FRG trend ledger row");
    if (prior?.version === row.version && prior?.run_id === row.run_id) return ledgerPath;
    if (prior?.version === row.version) {
      throw new Error(`FRG trend ledger already binds version ${row.version} to another run`);
    }
  }
  const body = `${lines.length ? `${lines.join("\n")}\n` : ""}${JSON.stringify(row)}\n`;
  await secureMkdir(dirname(ledgerPath), deps);
  if (existing === "") {
    await immutableWrite(ledgerPath, body, deps);
    return ledgerPath;
  }
  const temporary = `${ledgerPath}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  await deps.writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: PRIVATE_FILE_MODE });
  await deps.rename(temporary, ledgerPath);
  await deps.chmod(ledgerPath, PRIVATE_FILE_MODE);
  return ledgerPath;
}

export async function runFrgPack(options, overrides = {}) {
  validateRunOptions(options);
  const deps = defaultDeps(overrides);
  for (const name of ["PIPELINE_FRG_ATTESTATION_KEY", "PIPELINE_FRG_ATTESTATION_KEY_FILE", "CREDENTIALS_DIRECTORY"]) {
    if (typeof deps.env?.[name] === "string" && deps.env[name] !== "") {
      throw new Error(`FRG live runner refuses credential-bearing environment variable ${name}`);
    }
  }
  const candidateCheckout = resolve(options.candidateCheckout ?? process.cwd());
  const manifestPath = resolve(options.manifest);
  const expectedManifest = join(candidateCheckout, "core", "scripts", "frg-packs", "factory-gate-v1", "manifest.json");
  const collectorPath = join(candidateCheckout, "core", "scripts", "frg-pack-observations.ts");
  const pipelinePath = join(candidateCheckout, "core", "scripts", "pipeline.ts");
  if (manifestPath !== expectedManifest) throw new Error("--manifest must be the exact candidate factory-gate-v1 manifest");
  const packRunId = packRunIdentity(options);
  const runDir = join(resolve(options.stateDir), packRunId);
  const statePath = join(runDir, "runner-state.json");
  let priorStateText = null;
  try {
    await assertOwnedMode(statePath, [PRIVATE_FILE_MODE], "file", deps, "FRG runner state");
    priorStateText = await deps.readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await deps.verifyCandidate(
    candidateCheckout,
    options.candidateGitSha,
    deps,
    { allowEvidence: priorStateText !== null },
  );
  const manifestText = await deps.readFile(manifestPath, "utf8");
  if (digest(manifestText) !== options.manifestSha256) throw new Error("candidate manifest SHA-256 does not match --manifest-sha256");
  const collector = await import(`${pathToFileURL(collectorPath).href}?candidate=${options.candidateGitSha}`);
  const pack = await collector.loadFrgPack(dirname(manifestPath));
  if (pack.manifest_sha256 !== options.manifestSha256 || pack.manifest.pilot_policy.release_version !== options.version) {
    throw new Error("candidate collector loaded another manifest or pilot release");
  }

  await secureMkdir(runDir, deps);
  let state;
  if (priorStateText === null) {
    state = runnerState(packRunId, options, deps.now().toISOString());
    await immutableWrite(statePath, canonicalJson(state), deps);
  } else {
    await assertOwnedMode(statePath, [PRIVATE_FILE_MODE], "file", deps, "FRG runner state");
    state = parseJson(priorStateText, "FRG runner state");
  }
  if (canonicalJson(state) !== canonicalJson(runnerState(packRunId, options, state.started_at))) {
    throw new Error("existing FRG runner state does not match this exact candidate run");
  }
  let reconcilingCompletedRun = false;
  try {
    await deps.readFile(join(runDir, "attestation-result.json"), "utf8");
    reconcilingCompletedRun = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const renderedIssues = collector.renderFrgPackIssues(pack, {
    release_version: options.version,
    pack_run_id: packRunId,
  });
  let allIssues = await deps.listPackIssues({
    repository: options.repository,
    selectorLabel: pack.manifest.selector.value,
    candidateCheckout,
  }, deps);
  const currentMatches = new Map();
  for (const rendered of renderedIssues) {
    const marker = issueMarker(packRunId, rendered.provenance.template_id);
    const matches = allIssues.filter((issue) => issue.body.includes(marker));
    if (matches.length > 1) throw new Error(`duplicate synthetic issue provenance for ${rendered.provenance.template_id}`);
    if (matches.length === 1) currentMatches.set(rendered.provenance.template_id, matches[0]);
  }
  const currentNumbers = new Set([...currentMatches.values()].map((issue) => issue.number));
  const staleOpen = allIssues.filter((issue) => issue.state === "OPEN" && !currentNumbers.has(issue.number));
  if (staleOpen.length > 0) {
    throw new Error(`selector label ${pack.manifest.selector.value} has stale or extra open issues: ${staleOpen.map((issue) => `#${issue.number}`).join(",")}`);
  }
  for (const rendered of renderedIssues) {
    if (currentMatches.has(rendered.provenance.template_id)) continue;
    await deps.createIssue(rendered, { repository: options.repository, candidateCheckout }, deps);
  }
  allIssues = await deps.listPackIssues({
    repository: options.repository,
    selectorLabel: pack.manifest.selector.value,
    candidateCheckout,
  }, deps);
  const issues = renderedIssues.map((rendered) => {
    const marker = issueMarker(packRunId, rendered.provenance.template_id);
    const matches = allIssues.filter((issue) => issue.body.includes(marker));
    if (matches.length !== 1) throw new Error(`synthetic issue ${rendered.provenance.template_id} was not created exactly once`);
    validateExistingIssue(matches[0], rendered, state.started_at);
    if (matches[0].state !== "OPEN" && !reconcilingCompletedRun) {
      throw new Error(`synthetic issue #${matches[0].number} is not open before its loop`);
    }
    return { ...matches[0], rendered };
  });
  const issueNumbers = issues.map((issue) => issue.number);
  const openSelectorNumbers = allIssues.filter((issue) => issue.state === "OPEN").map((issue) => issue.number);
  if (!reconcilingCompletedRun) {
    exactSet(openSelectorNumbers, issueNumbers, "open fixed-selector issue set");
  }

  const observationsPath = join(runDir, "observations.json");
  const bundlePath = join(runDir, "evidence-bundle.json");
  let observationsText;
  let bundleText;
  let loopRunId;
  let rawArtifacts = null;
  try {
    await Promise.all([
      assertOwnedMode(observationsPath, [PRIVATE_FILE_MODE], "file", deps, "FRG observations"),
      assertOwnedMode(bundlePath, [PRIVATE_FILE_MODE], "file", deps, "FRG evidence bundle"),
    ]);
    [observationsText, bundleText] = await Promise.all([
      deps.readFile(observationsPath, "utf8"),
      deps.readFile(bundlePath, "utf8"),
    ]);
    const existingObservations = parseJson(observationsText, "FRG observations");
    const existingBundle = parseJson(bundleText, "FRG evidence bundle");
    const recollected = collector.serializeFrgPackObservations(
      collector.collectFrgPackObservations(pack, existingBundle),
    );
    if (recollected !== observationsText) {
      throw new Error("existing FRG observations are not the exact projection of their verified bundle");
    }
    loopRunId = existingObservations?.pack_provenance?.loop_run_id;
    if (existingBundle?.loop_run_id !== loopRunId) throw new Error("existing FRG artifacts disagree on loop identity");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const loop = await deps.runLoop({
      candidateCheckout,
      pipelinePath,
      selectorLabel: pack.manifest.selector.value,
      profile: options.profile,
      loopChild: state.loop_child,
    }, deps);
    loopRunId = requireSafeId(loop.loop_run_id, "FRG loop run id");
    const artifacts = await deps.readLoopArtifacts(loop, deps);
    rawArtifacts = artifacts;
    if (artifacts.contract?.run_id !== loopRunId) throw new Error("loop handoff and contract run ids differ");
    const loopRecords = validateLoopRecords(artifacts, issueNumbers, pack.manifest.selector.value);
    const refreshedIssues = await deps.listPackIssues({
      repository: options.repository,
      selectorLabel: pack.manifest.selector.value,
      candidateCheckout,
    }, deps);
    const refreshedByNumber = new Map(refreshedIssues.map((issue) => [issue.number, issue]));
    const liveIssues = [];
    for (const issue of issues) {
      const refreshed = refreshedByNumber.get(issue.number);
      if (!refreshed || refreshed.state !== "OPEN" || !refreshed.labels.includes("pipeline:ready-to-deploy")) {
        throw new Error(`synthetic issue #${issue.number} is not open at pipeline:ready-to-deploy`);
      }
      const pr = await deps.observePullRequest(issue.number, {
        repository: options.repository,
        baseBranch: options.base,
        candidateCheckout,
      }, deps);
      liveIssues.push({
        issue_number: issue.number,
        issue_node_id: issue.node_id,
        created_at: issue.created_at,
        title: issue.title,
        body: issue.body,
        labels: refreshed.labels,
        template_id: issue.rendered.provenance.template_id,
        template_sha256: issue.rendered.provenance.template_sha256,
        pr,
      });
    }
    const probes = [];
    for (const probe of pack.manifest.pilot_policy.layer_a_probes) {
      probes.push(await deps.runProbe(probe, { candidateCheckout, candidateGitSha: options.candidateGitSha }, deps));
    }
    const bundle = {
      schema_version: 1,
      policy_id: pack.manifest.pilot_policy.id,
      pack_id: pack.manifest.pack_id,
      manifest_version: pack.manifest.manifest_version,
      manifest_sha256: pack.manifest_sha256,
      release_version: options.version,
      candidate_git_sha: options.candidateGitSha,
      pack_run_id: packRunId,
      loop_run_id: loopRunId,
      repository: options.repository,
      base_branch: options.base,
      started_at: state.started_at,
      ...loopRecords,
      issues: liveIssues,
      probes,
    };
    const observations = collector.collectFrgPackObservations(pack, bundle);
    bundleText = canonicalJson(bundle);
    observationsText = collector.serializeFrgPackObservations(observations);
    await immutableWrite(bundlePath, bundleText, deps);
    await immutableWrite(observationsPath, observationsText, deps);
  }

  if (!rawArtifacts) {
    await assertOwnedMode(state.loop_child.handoff_path, [PRIVATE_FILE_MODE], "file", deps, "FRG loop handoff");
    const handoff = parseJson(await deps.readFile(state.loop_child.handoff_path, "utf8"), "FRG loop handoff");
    if (
      handoff?.loop_run_id !== loopRunId ||
      !isAbsolute(handoff?.run_dir ?? "")
    ) {
      throw new Error("persisted FRG loop handoff does not bind the observation loop");
    }
    rawArtifacts = await deps.readLoopArtifacts(
      { loop_run_id: loopRunId, run_dir: resolve(handoff.run_dir) },
      deps,
    );
  }
  const rawArtifactPaths = {
    contract: join(runDir, "contract.json"),
    ledger: join(runDir, "ledger.json"),
    events: join(runDir, "events.jsonl"),
    action_evidence: join(runDir, "action-evidence.jsonl"),
  };
  const rawArtifactTexts = {
    contract: rawArtifacts.contract_text,
    ledger: rawArtifacts.ledger_text,
    events: rawArtifacts.events_text,
    action_evidence: rawArtifacts.actions_text,
  };
  const parsedBundle = parseJson(bundleText, "FRG evidence bundle");
  for (const [name, path] of Object.entries(rawArtifactPaths)) {
    const expected = name === "action_evidence" ? parsedBundle.action_evidence : parsedBundle[name];
    if (digest(rawArtifactTexts[name]) !== expected?.artifact_sha256) {
      throw new Error(`raw FRG ${name} does not match the verified bundle digest`);
    }
    await immutableWrite(path, rawArtifactTexts[name], deps);
  }

  const requestId = requireSafeId(packRunId, "FRG attestation request id");
  const scorerRequestDir = resolve(options.scorerRequestDir);
  const requestPath = join(scorerRequestDir, `${requestId}.json`);
  const attestationResultPath = join(runDir, "attestation-result.json");
  const attestedEvidencePath = join(runDir, "attested-evidence.json");
  const requestIdentity = {
    action_id: options.actionId,
    candidate_git_sha: options.candidateGitSha,
    loop_run_id: loopRunId,
    manifest_sha256: options.manifestSha256,
    pack_run_id: packRunId,
    version: options.version,
  };
  const request = Object.freeze({
    schema_version: 1,
    kind: "frg_attestation_request",
    request_id: requestId,
    grant_fingerprint: basename(dirname(resolve(options.stateDir))),
    action_id: options.actionId,
    version: options.version,
    repository: options.repository,
    base_branch: options.base,
    candidate_git_sha: options.candidateGitSha,
    manifest_sha256: options.manifestSha256,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    frg_run_id: deterministicFrgRunId(requestIdentity),
    evidence_created_at: new Date(state.started_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
    observations_sha256: digest(observationsText),
    evidence_bundle_sha256: digest(bundleText),
    contract_sha256: digest(rawArtifactTexts.contract),
    ledger_sha256: digest(rawArtifactTexts.ledger),
    events_sha256: digest(rawArtifactTexts.events),
    action_evidence_sha256: digest(rawArtifactTexts.action_evidence),
  });
  await immutableWrite(requestPath, canonicalJson(request), deps);
  let attestationResult;
  try {
    await assertOwnedMode(attestationResultPath, [PRIVATE_FILE_MODE], "file", deps, "FRG attestation result");
    attestationResult = validateAttestationResult(
      parseJson(await deps.readFile(attestationResultPath, "utf8"), "FRG attestation result"),
      request,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    let launchError = null;
    try {
      await deps.startScorer(requestPath, options.scorerUnitTemplate, deps);
    } catch (error) {
      launchError = error;
    }
    let lastMissing = error;
    for (let attempt = 0; attempt < 900; attempt++) {
      const stopReason = await deps.shouldStop();
      if (stopReason) {
        const scorerUnit = options.scorerUnitTemplate.replace("@.service", `@${requestId}.service`);
        await deps.stopUnit(scorerUnit, deps);
        throw new Error(`isolated FRG attestor stopped: ${stopReason}`);
      }
      try {
        await assertOwnedMode(attestationResultPath, [PRIVATE_FILE_MODE], "file", deps, "FRG attestation result");
        attestationResult = validateAttestationResult(
          parseJson(await deps.readFile(attestationResultPath, "utf8"), "FRG attestation result"),
          request,
        );
        break;
      } catch (pollError) {
        if (pollError?.code !== "ENOENT") throw pollError;
        lastMissing = pollError;
        await deps.sleep(1000);
      }
    }
    if (!attestationResult) {
      if (launchError) throw launchError;
      throw new Error(`isolated FRG attestor did not write its result: ${lastMissing?.message ?? "timed out"}`);
    }
  }
  const scorerUnit = options.scorerUnitTemplate.replace("@.service", `@${requestId}.service`);
  let scorerState = await deps.unitState(scorerUnit, deps);
  if (!unitIsProvenTerminal(scorerState)) {
    await deps.stopUnit(scorerUnit, deps);
    scorerState = await deps.unitState(scorerUnit, deps);
  }
  if (!unitIsProvenTerminal(scorerState)) {
    throw new Error("isolated FRG attestor is not proven terminal");
  }
  await assertOwnedMode(attestedEvidencePath, [PRIVATE_FILE_MODE], "file", deps, "FRG attested evidence");
  const evidenceText = await deps.readFile(attestedEvidencePath, "utf8");
  if (digest(evidenceText) !== attestationResult.attested_evidence_sha256) {
    throw new Error("isolated FRG attestor evidence hash does not match its result");
  }
  const evidence = parseJson(evidenceText, "FRG attested evidence");
  if (
    evidence.pass !== true ||
    evidence.version !== options.version ||
    evidence.run_id !== request.frg_run_id ||
    evidence.loop_run_id !== loopRunId ||
    evidence.pack_provenance?.pack_run_id !== packRunId ||
    evidence.pack_provenance?.candidate_git_sha !== options.candidateGitSha ||
    evidence.integrity?.pack_provenance_fingerprint == null
  ) {
    throw new Error("isolated FRG attestor did not produce candidate-bound passing evidence");
  }
  await deps.verifyCandidate(candidateCheckout, options.candidateGitSha, deps, { allowEvidence: true });
  const frgEvidencePath = join(
    candidateCheckout,
    ".agent-pipeline", "frg", request.version, request.frg_run_id, "evidence.json",
  );
  const frgLatestPath = join(candidateCheckout, ".agent-pipeline", "frg", request.version, "latest.json");
  await immutableWrite(frgEvidencePath, evidenceText, deps);
  await immutableWrite(frgLatestPath, evidenceText, deps);
  await writeTrendLedger(candidateCheckout, evidence, deps);
  const scoreResult = {
    ...attestationResult,
    frg_evidence_path: frgEvidencePath,
    frg_evidence_sha256: digest(evidenceText),
    frg_latest_path: frgLatestPath,
    frg_latest_sha256: digest(evidenceText),
  };

  const bundle = parsedBundle;
  const closeComment = `FRG ${options.version} pass (pack_run_id=${packRunId}): close synthetic pack artifact without merge.`;
  const syntheticIssues = [];
  for (const issue of bundle.issues) {
    const prNumber = requirePositiveInteger(issue?.pr?.number, "synthetic PR number");
    const issueNumber = requirePositiveInteger(issue?.issue_number, "synthetic issue number");
    const closeInput = { repository: options.repository, candidateCheckout, closeComment };
    if (!(await deps.observeClosed("pr", prNumber, closeInput, deps))) {
      await deps.closePr(prNumber, closeInput, deps);
    }
    if (!(await deps.observeClosed("issue", issueNumber, closeInput, deps))) {
      await deps.closeIssue(issueNumber, closeInput, deps);
    }
    const prClosed = await deps.observeClosed("pr", prNumber, closeInput, deps);
    const issueClosed = await deps.observeClosed("issue", issueNumber, closeInput, deps);
    if (!prClosed || !issueClosed) throw new Error(`synthetic issue #${issueNumber} or PR #${prNumber} did not close`);
    syntheticIssues.push({ number: issueNumber, pr_number: prNumber, closed: true, pr_closed: true });
  }

  return {
    schema_version: 1,
    kind: "frg_pack_run",
    status: "complete",
    pack_id: FRG_RUNNER_PACK_ID,
    version: options.version,
    manifest_sha256: options.manifestSha256,
    candidate_git_sha: options.candidateGitSha,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    observations_path: observationsPath,
    observations_sha256: digest(observationsText),
    evidence_bundle_path: bundlePath,
    evidence_bundle_sha256: digest(bundleText),
    frg_run_id: scoreResult.frg_run_id,
    frg_evidence_path: scoreResult.frg_evidence_path,
    frg_evidence_sha256: scoreResult.frg_evidence_sha256,
    frg_latest_path: scoreResult.frg_latest_path,
    frg_latest_sha256: scoreResult.frg_latest_sha256,
    synthetic_issues: syntheticIssues.sort((left, right) => left.number - right.number),
  };
}

const NATIVE_CHECKPOINT_KEYS = Object.freeze([
  "schema_version", "kind", "status", "action_id", "grant_fingerprint", "repository",
  "base_branch", "target_version", "candidate_git_sha", "checkpoint", "frg",
]);
const NATIVE_CHECKPOINT_FRG_KEYS = Object.freeze([
  "pack_id", "manifest_path", "manifest_sha256", "pack_run_id", "loop_run_id", "frg_run_id",
  "evidence_created_at", "observations", "evidence_bundle", "contract", "ledger", "events",
  "action_evidence",
]);
const FRG_HANDOFF_KEYS = Object.freeze([
  "schema_version", "kind", "status", "action_id", "grant_fingerprint", "checkpoint", "version",
  "candidate_git_sha", "manifest_sha256", "pack_run_id", "loop_run_id", "frg_run_id", "signer",
  "attestation_payload_sha256", "frg_evidence_path", "frg_evidence_sha256", "frg_latest_path",
  "frg_latest_sha256",
]);

function exactObjectKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  exactSet(Object.keys(value), keys, `${name} fields`);
}

function validateCheckpointArtifact(value, name, config) {
  exactObjectKeys(value, ["path", "sha256"], `${name} artifact`);
  if (!isAbsolute(value.path) || !DIGEST_RE.test(value.sha256 ?? "")) {
    throw new Error(`${name} artifact identity is invalid`);
  }
  const allowedRoots = [
    resolve(config.state_dir),
    join(resolve(config.repo_dir), ".agent-pipeline", "factory-release"),
  ];
  if (!allowedRoots.some((root) => confinedTo(value.path, root))) {
    throw new Error(`${name} artifact is outside the fixed factory roots`);
  }
  return { path: resolve(value.path), sha256: value.sha256 };
}

function validateNativeFrgCheckpoint(checkpoint, config, checkpointPath) {
  exactObjectKeys(checkpoint, NATIVE_CHECKPOINT_KEYS, "factory release FRG checkpoint");
  if (
    checkpoint.schema_version !== 1 ||
    checkpoint.kind !== "factory_release_frg_checkpoint" ||
    checkpoint.status !== "awaiting_frg_attestation" ||
    !DIGEST_RE.test(checkpoint.grant_fingerprint ?? "") ||
    !REPOSITORY_RE.test(checkpoint.repository ?? "") ||
    !GIT_SHA_RE.test(checkpoint.candidate_git_sha ?? "") ||
    checkpoint.repository !== config.repository ||
    checkpoint.base_branch !== config.base_branch ||
    compareSemver(checkpoint.target_version, FRG_RUNNER_PILOT_VERSION) <= 0
  ) {
    throw new Error("factory release FRG checkpoint identity is invalid");
  }
  for (const [name, value] of [
    ["action_id", checkpoint.action_id],
    ["checkpoint", checkpoint.checkpoint],
  ]) requireSafeId(value, `factory release ${name}`);
  const expectedCheckpointRoot = join(
    resolve(config.state_dir),
    "native-release",
    checkpoint.grant_fingerprint,
    checkpoint.target_version,
  );
  if (!confinedTo(checkpointPath, expectedCheckpointRoot)) {
    throw new Error("factory release checkpoint is outside its fixed workflow root");
  }
  exactObjectKeys(checkpoint.frg, NATIVE_CHECKPOINT_FRG_KEYS, "factory release FRG payload");
  const frg = checkpoint.frg;
  if (
    frg.pack_id !== FRG_RUNNER_PACK_ID ||
    frg.manifest_sha256 !== config.frg_pack_manifest_sha256 ||
    resolve(frg.manifest_path ?? "") !== resolve(config.frg_pack_manifest)
  ) {
    throw new Error("factory release checkpoint does not use the configured FRG manifest");
  }
  for (const [name, value] of [
    ["pack_run_id", frg.pack_run_id],
    ["loop_run_id", frg.loop_run_id],
    ["frg_run_id", frg.frg_run_id],
  ]) requireSafeId(value, `factory release FRG ${name}`);
  const evidenceTime = Date.parse(frg.evidence_created_at ?? "");
  if (!Number.isFinite(evidenceTime)) throw new Error("factory release FRG evidence time is invalid");
  const artifacts = {};
  for (const name of ["observations", "evidence_bundle", "contract", "ledger", "events", "action_evidence"]) {
    artifacts[name] = validateCheckpointArtifact(frg[name], name, config);
  }
  return Object.freeze({
    ...checkpoint,
    frg: Object.freeze({ ...frg, ...artifacts }),
  });
}

function parseProductionPin(raw) {
  const pin = parseJson(raw, "production engine pin");
  if (
    pin?.schema_version !== 1 ||
    !SEMVER_RE.test(pin?.version ?? "") ||
    pin?.tag !== `v${pin.version}` ||
    !GIT_SHA_RE.test(pin?.git_sha ?? "")
  ) {
    throw new Error("production engine pin is invalid for trusted FRG attestation");
  }
  return Object.freeze({ version: pin.version, tag: pin.tag, git_sha: pin.git_sha });
}

async function verifyNativeAttestationTrustRoot(checkpoint, config, deps) {
  await assertOwnedMode(config.active_grant_file, [0o400, PRIVATE_FILE_MODE], "file", deps, "active Hermes factory grant");
  const validated = validateGrantEnvelope(
    parseJson(await deps.readFile(config.active_grant_file, "utf8"), "active Hermes factory grant"),
    config,
    { now: deps.now },
  );
  if (
    validated.fingerprint !== checkpoint.grant_fingerprint ||
    validated.grant.repository !== checkpoint.repository ||
    validated.grant.base_branch !== checkpoint.base_branch ||
    validated.grant.release_version !== checkpoint.target_version ||
    !validated.grant.actions.includes("frg") ||
    !validated.grant.actions.includes("release_prepare")
  ) {
    throw new Error("factory release checkpoint does not match the signed active grant");
  }
  const activePath = join(config.state_dir, "active.json");
  const journalPath = join(config.state_dir, "runs", `${checkpoint.grant_fingerprint}.json`);
  await Promise.all([
    assertOwnedMode(activePath, [PRIVATE_FILE_MODE], "file", deps, "active Hermes factory journal binding"),
    assertOwnedMode(journalPath, [PRIVATE_FILE_MODE], "file", deps, "Hermes factory grant journal"),
  ]);
  const active = parseJson(await deps.readFile(activePath, "utf8"), "active Hermes factory journal binding");
  const journal = parseJson(await deps.readFile(journalPath, "utf8"), "Hermes factory grant journal");
  const actions = Object.values(journal.actions ?? {});
  const integrated = actions.filter((action) =>
    action?.kind === "integrated_candidate" &&
    action?.state === "completed" &&
    action?.result?.git_sha === checkpoint.candidate_git_sha,
  );
  const checkpointActions = actions.filter((action) =>
    action?.action_id === checkpoint.action_id &&
    action?.kind === "native_release_checkpoint" &&
    action?.state === "completed",
  );
  const attestActions = actions.filter((action) =>
    action?.kind === "native_release_attest" &&
    ["running", "ambiguous"].includes(action?.state) &&
    action?.target?.workflow_action_id === checkpoint.action_id &&
    action?.target?.checkpoint === checkpoint.checkpoint &&
    action?.target?.checkpoint_sha256 === digest(canonicalJson(checkpoint)) &&
    action?.target?.candidate_git_sha === checkpoint.candidate_git_sha,
  );
  if (
    active?.fingerprint !== checkpoint.grant_fingerprint ||
    active?.status !== "running" ||
    journal?.grant_fingerprint !== checkpoint.grant_fingerprint ||
    journal?.status !== "running" ||
    integrated.length !== 1 ||
    checkpointActions.length !== 1 ||
    attestActions.length !== 1 ||
    journal.current?.action_id !== attestActions[0].action_id ||
    journal.current?.kind !== "native_release_attest"
  ) {
    throw new Error("factory release attestation is not the current bound journal action");
  }
}

export function validateFrgAttestationHandoff(value, expected = {}) {
  exactObjectKeys(value, FRG_HANDOFF_KEYS, "FRG attestation handoff");
  if (
    value.schema_version !== 1 ||
    value.kind !== "frg_attestation_handoff" ||
    value.status !== "complete" ||
    !SAFE_ID_RE.test(value.action_id ?? "") ||
    !DIGEST_RE.test(value.grant_fingerprint ?? "") ||
    !SEMVER_RE.test(value.version ?? "") ||
    !GIT_SHA_RE.test(value.candidate_git_sha ?? "") ||
    !DIGEST_RE.test(value.manifest_sha256 ?? "") ||
    !DIGEST_RE.test(value.attestation_payload_sha256 ?? "") ||
    !DIGEST_RE.test(value.frg_evidence_sha256 ?? "") ||
    !DIGEST_RE.test(value.frg_latest_sha256 ?? "") ||
    value.frg_evidence_sha256 !== value.frg_latest_sha256
  ) {
    throw new Error("FRG attestation handoff identity is invalid");
  }
  for (const [name, entry] of [
    ["checkpoint", value.checkpoint],
    ["pack_run_id", value.pack_run_id],
    ["loop_run_id", value.loop_run_id],
    ["frg_run_id", value.frg_run_id],
  ]) requireSafeId(entry, `FRG attestation handoff ${name}`);
  exactObjectKeys(value.signer, ["mode", "version", "tag", "git_sha", "policy_id", "policy_sha256"], "FRG signer");
  for (const name of ["mode", "version", "tag", "policy_id"]) requireSafeId(value.signer[name], `FRG signer ${name}`);
  requireString(value.signer.git_sha, "FRG signer git_sha", GIT_SHA_RE);
  requireString(value.signer.policy_sha256, "FRG signer policy_sha256", DIGEST_RE);
  for (const name of ["frg_evidence_path", "frg_latest_path"]) {
    if (!isAbsolute(value[name])) throw new Error(`FRG attestation handoff ${name} is invalid`);
  }
  const checkpoint = expected.checkpoint;
  if (checkpoint && (
    value.action_id !== checkpoint.action_id ||
    value.grant_fingerprint !== checkpoint.grant_fingerprint ||
    value.checkpoint !== checkpoint.checkpoint ||
    value.version !== checkpoint.target_version ||
    value.candidate_git_sha !== checkpoint.candidate_git_sha ||
    value.manifest_sha256 !== checkpoint.frg.manifest_sha256 ||
    value.pack_run_id !== checkpoint.frg.pack_run_id ||
    value.loop_run_id !== checkpoint.frg.loop_run_id ||
    value.frg_run_id !== checkpoint.frg.frg_run_id
  )) {
    throw new Error("FRG attestation handoff does not match its checkpoint");
  }
  const pin = expected.productionPin;
  if (pin && (
    value.signer.mode !== "installed-production" ||
    value.signer.version !== pin.version ||
    value.signer.tag !== pin.tag ||
    value.signer.git_sha !== pin.git_sha
  )) {
    throw new Error("FRG attestation handoff signer is not the current production pin");
  }
  if (expected.repoDir && expected.checkpoint) {
    const expectedEvidence = join(
      resolve(expected.repoDir), ".agent-pipeline", "frg", value.version, value.frg_run_id, "evidence.json",
    );
    const expectedLatest = join(resolve(expected.repoDir), ".agent-pipeline", "frg", value.version, "latest.json");
    if (resolve(value.frg_evidence_path) !== expectedEvidence || resolve(value.frg_latest_path) !== expectedLatest) {
      throw new Error("FRG attestation handoff paths are not the exact candidate evidence paths");
    }
  }
  return Object.freeze({ ...value, signer: Object.freeze({ ...value.signer }) });
}

async function submitClosedAttestation(request, config, deps) {
  const runDir = join(
    resolve(config.state_dir), "frg", request.grant_fingerprint, request.version, request.pack_run_id,
  );
  const resultPath = join(runDir, "attestation-result.json");
  const evidencePath = join(runDir, "attested-evidence.json");
  const requestPath = join(resolve(config.frg_scorer_request_dir), `${request.request_id}.json`);
  await immutableWrite(requestPath, canonicalJson(request), deps);
  let result = null;
  try {
    await assertOwnedMode(resultPath, [PRIVATE_FILE_MODE], "file", deps, "FRG attestation result");
    result = validateAttestationResult(parseJson(await deps.readFile(resultPath, "utf8"), "FRG attestation result"), request);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    let launchError = null;
    try {
      await deps.startScorer(requestPath, config.frg_scorer_unit_template, deps);
    } catch (error) {
      launchError = error;
    }
    for (let attempt = 0; attempt < 900 && !result; attempt++) {
      const stopReason = await deps.shouldStop();
      if (stopReason) {
        const unit = config.frg_scorer_unit_template.replace("@.service", `@${request.request_id}.service`);
        await deps.stopUnit(unit, deps);
        throw new Error(`isolated FRG attestor stopped: ${stopReason}`);
      }
      try {
        await assertOwnedMode(resultPath, [PRIVATE_FILE_MODE], "file", deps, "FRG attestation result");
        result = validateAttestationResult(
          parseJson(await deps.readFile(resultPath, "utf8"), "FRG attestation result"),
          request,
        );
      } catch (pollError) {
        if (pollError?.code !== "ENOENT") throw pollError;
        await deps.sleep(1000);
      }
    }
    if (!result) {
      if (launchError) throw launchError;
      throw new Error("isolated FRG attestor did not write its result before timeout");
    }
  }
  const unit = config.frg_scorer_unit_template.replace("@.service", `@${request.request_id}.service`);
  let unitState = await deps.unitState(unit, deps);
  if (!unitIsProvenTerminal(unitState)) {
    await deps.stopUnit(unit, deps);
    unitState = await deps.unitState(unit, deps);
  }
  if (!unitIsProvenTerminal(unitState)) throw new Error("isolated FRG attestor is not proven terminal");
  await assertOwnedMode(evidencePath, [PRIVATE_FILE_MODE], "file", deps, "FRG attested evidence");
  const evidenceText = await deps.readFile(evidencePath, "utf8");
  if (digest(evidenceText) !== result.attested_evidence_sha256) {
    throw new Error("FRG attested evidence does not match the trusted result");
  }
  const evidence = parseJson(evidenceText, "FRG attested evidence");
  if (
    evidence?.pass !== true ||
    evidence?.version !== request.version ||
    evidence?.run_id !== request.frg_run_id ||
    evidence?.loop_run_id !== request.loop_run_id
  ) {
    throw new Error("FRG attested evidence does not match the closed request");
  }
  return { requestPath, result, evidence, evidenceText };
}

export async function submitFrgAttestation(checkpointValue, context, overrides = {}) {
  if (!context || !isAbsolute(context.configPath ?? "") || !isAbsolute(context.checkpointPath ?? "")) {
    throw new Error("submitFrgAttestation requires absolute configPath and checkpointPath");
  }
  const deps = defaultDeps({ ...overrides, machineConfigPath: resolve(context.configPath) });
  for (const name of ["PIPELINE_FRG_ATTESTATION_KEY", "PIPELINE_FRG_ATTESTATION_KEY_FILE", "CREDENTIALS_DIRECTORY"]) {
    if (typeof deps.env?.[name] === "string" && deps.env[name] !== "") {
      throw new Error(`FRG attestation submitter refuses credential-bearing environment variable ${name}`);
    }
  }
  await assertOwnedMode(context.configPath, [0o400, PRIVATE_FILE_MODE], "file", deps, "Hermes factory machine config");
  const config = validateMachineConfig(
    parseJson(await deps.readFile(context.configPath, "utf8"), "Hermes factory machine config"),
    { requireEnabled: true },
  );
  await assertOwnedMode(context.checkpointPath, [PRIVATE_FILE_MODE], "file", deps, "factory release FRG checkpoint");
  const checkpointOnDisk = parseJson(
    await deps.readFile(context.checkpointPath, "utf8"),
    "factory release FRG checkpoint",
  );
  if (canonicalJson(checkpointOnDisk) !== canonicalJson(checkpointValue)) {
    throw new Error("factory release FRG checkpoint input does not match its immutable file");
  }
  const checkpoint = validateNativeFrgCheckpoint(checkpointValue, config, context.checkpointPath);
  await (deps.verifyNativeTrustRoot ?? verifyNativeAttestationTrustRoot)(checkpoint, config, deps);
  await assertOwnedMode(config.production_pin_file, [0o400, PRIVATE_FILE_MODE], "file", deps, "production engine pin");
  const productionPin = parseProductionPin(await deps.readFile(config.production_pin_file, "utf8"));
  const runDir = join(
    resolve(config.state_dir), "frg", checkpoint.grant_fingerprint, checkpoint.target_version, checkpoint.frg.pack_run_id,
  );
  await secureMkdir(runDir, deps);
  const artifactDestinations = {
    observations: join(runDir, "observations.json"),
    evidence_bundle: join(runDir, "evidence-bundle.json"),
    contract: join(runDir, "contract.json"),
    ledger: join(runDir, "ledger.json"),
    events: join(runDir, "events.jsonl"),
    action_evidence: join(runDir, "action-evidence.jsonl"),
  };
  for (const [name, destination] of Object.entries(artifactDestinations)) {
    const source = checkpoint.frg[name];
    const info = await deps.stat(source.path);
    if (!info.isFile()) throw new Error(`${name} checkpoint artifact must be a regular file`);
    const body = await deps.readFile(source.path, "utf8");
    if (digest(body) !== source.sha256) throw new Error(`${name} checkpoint artifact digest changed`);
    await immutableWrite(destination, body, deps);
  }
  const normalizedEvidenceTime = new Date(checkpoint.frg.evidence_created_at).toISOString().replace(/\.\d{3}Z$/, "Z");
  const requestId = `frg-attest-${digest(canonicalJson({
    action_id: checkpoint.action_id,
    checkpoint: checkpoint.checkpoint,
    frg: checkpoint.frg,
  })).slice(0, 32)}`;
  const request = Object.freeze({
    schema_version: 1,
    kind: "frg_attestation_request",
    request_id: requestId,
    grant_fingerprint: checkpoint.grant_fingerprint,
    action_id: checkpoint.action_id,
    version: checkpoint.target_version,
    repository: checkpoint.repository,
    base_branch: checkpoint.base_branch,
    candidate_git_sha: checkpoint.candidate_git_sha,
    manifest_sha256: checkpoint.frg.manifest_sha256,
    pack_run_id: checkpoint.frg.pack_run_id,
    loop_run_id: checkpoint.frg.loop_run_id,
    frg_run_id: checkpoint.frg.frg_run_id,
    evidence_created_at: normalizedEvidenceTime,
    observations_sha256: checkpoint.frg.observations.sha256,
    evidence_bundle_sha256: checkpoint.frg.evidence_bundle.sha256,
    contract_sha256: checkpoint.frg.contract.sha256,
    ledger_sha256: checkpoint.frg.ledger.sha256,
    events_sha256: checkpoint.frg.events.sha256,
    action_evidence_sha256: checkpoint.frg.action_evidence.sha256,
  });
  const submitted = await submitClosedAttestation(request, config, deps);
  if (
    submitted.result.signer?.mode !== "installed-production" ||
    submitted.result.signer?.version !== productionPin.version ||
    submitted.result.signer?.tag !== productionPin.tag ||
    submitted.result.signer?.git_sha !== productionPin.git_sha
  ) {
    throw new Error("trusted FRG result signer is not the current production pin");
  }
  const frgEvidencePath = join(
    resolve(config.repo_dir), ".agent-pipeline", "frg", request.version, request.frg_run_id, "evidence.json",
  );
  const frgLatestPath = join(resolve(config.repo_dir), ".agent-pipeline", "frg", request.version, "latest.json");
  await immutableWrite(frgEvidencePath, submitted.evidenceText, deps);
  await immutableWrite(frgLatestPath, submitted.evidenceText, deps);
  await writeTrendLedger(config.repo_dir, submitted.evidence, deps);
  return validateFrgAttestationHandoff({
    schema_version: 1,
    kind: "frg_attestation_handoff",
    status: "complete",
    action_id: checkpoint.action_id,
    grant_fingerprint: checkpoint.grant_fingerprint,
    checkpoint: checkpoint.checkpoint,
    version: checkpoint.target_version,
    candidate_git_sha: checkpoint.candidate_git_sha,
    manifest_sha256: checkpoint.frg.manifest_sha256,
    pack_run_id: checkpoint.frg.pack_run_id,
    loop_run_id: checkpoint.frg.loop_run_id,
    frg_run_id: checkpoint.frg.frg_run_id,
    signer: submitted.result.signer,
    attestation_payload_sha256: submitted.result.attestation_payload_sha256,
    frg_evidence_path: frgEvidencePath,
    frg_evidence_sha256: digest(submitted.evidenceText),
    frg_latest_path: frgLatestPath,
    frg_latest_sha256: digest(submitted.evidenceText),
  }, { checkpoint, productionPin, repoDir: config.repo_dir });
}

export function parseFrgRunnerCli(argv) {
  const [mode, ...tokens] = argv;
  if (mode === "attest") {
    if (
      tokens.length !== 4 ||
      tokens[0] !== "--checkpoint" ||
      !isAbsolute(tokens[1] ?? "") ||
      tokens[2] !== "--config" ||
      !isAbsolute(tokens[3] ?? "")
    ) {
      throw new Error("attest requires --checkpoint <absolute-path> --config <absolute-path>");
    }
    return { mode, checkpoint: tokens[1], config: tokens[3] };
  }
  if (mode !== "run") throw new Error("expected run or attest subcommand");
  const names = new Map([
    ["--manifest", "manifest"],
    ["--manifest-sha256", "manifestSha256"],
    ["--version", "version"],
    ["--repository", "repository"],
    ["--base", "base"],
    ["--profile", "profile"],
    ["--candidate-git-sha", "candidateGitSha"],
    ["--action-id", "actionId"],
    ["--state-dir", "stateDir"],
    ["--scorer-unit-template", "scorerUnitTemplate"],
    ["--scorer-request-dir", "scorerRequestDir"],
  ]);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const field = names.get(tokens[index]);
    const value = tokens[index + 1];
    if (!field || typeof value !== "string") throw new Error(`unknown or incomplete runner argument ${String(tokens[index])}`);
    if (options[field] !== undefined) throw new Error(`duplicate runner argument ${tokens[index]}`);
    options[field] = value;
  }
  for (const field of names.values()) {
    if (options[field] === undefined) throw new Error(`missing runner argument ${field}`);
  }
  return { mode, options };
}

async function main() {
  const parsed = parseFrgRunnerCli(process.argv.slice(2));
  if (parsed.mode === "attest") {
    await assertOwnedMode(parsed.checkpoint, [PRIVATE_FILE_MODE], "file", defaultDeps(), "factory release FRG checkpoint");
    const checkpoint = parseJson(await readFile(parsed.checkpoint, "utf8"), "factory release FRG checkpoint");
    const handoff = await submitFrgAttestation(checkpoint, {
      checkpointPath: parsed.checkpoint,
      configPath: parsed.config,
    });
    process.stdout.write(`${JSON.stringify(handoff)}\n`);
    return;
  }
  let stopReason = null;
  const onSigterm = () => { stopReason = "SIGTERM"; };
  const onSigint = () => { stopReason = "SIGINT"; };
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  try {
    const receipt = await runFrgPack(
      { ...parsed.options, candidateCheckout: process.cwd() },
      { shouldStop: async () => stopReason },
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`FRG runner failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
