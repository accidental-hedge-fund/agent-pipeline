import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRG_SCORER_UNIT_TEMPLATE,
  parseFrgRunnerCli,
  runFrgPack,
  runFrgCandidateProbe,
  verifyFrgCandidate,
} from "../lib/frg-runner.mjs";
import {
  attestFrgRequest,
  frgAttestationLayout,
  verifyFrgAttestorTrustRoot,
} from "../lib/frg-attestor.mjs";
import { validateGrantEnvelope } from "../lib/grant.mjs";
import { config as machineFixture, envelope } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, "../../..");

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function canonicalJson(value) {
  const canonical = (entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]));
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

async function privateWrite(path, body, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, body, { mode });
  await chmod(path, mode);
}

async function makeHarness(t) {
  const root = await mkdtemp(join(tmpdir(), "frg-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const candidateScripts = join(candidate, "core", "scripts");
  await mkdir(candidateScripts, { recursive: true });
  await cp(
    join(repositoryRoot, "core", "scripts", "frg-pack-observations.ts"),
    join(candidateScripts, "frg-pack-observations.ts"),
  );
  await cp(
    join(repositoryRoot, "core", "scripts", "frg-packs"),
    join(candidateScripts, "frg-packs"),
    { recursive: true },
  );
  await writeFile(join(candidateScripts, "pipeline.ts"), "// candidate Pipeline test stub\n");

  const manifest = join(candidateScripts, "frg-packs", "factory-gate-v1", "manifest.json");
  const manifestSha256 = digest(await readFile(manifest, "utf8"));
  const factoryState = join(root, "state");
  const stateDir = join(factoryState, "frg", "f".repeat(64), "1.33.0");
  const scorerRequestDir = join(factoryState, "frg-scorer-requests");
  const loopRunDir = join(root, "pipeline-loops", "loop-frg-a");
  const candidateGitSha = "a".repeat(40);
  const issues = [];
  const closedPrs = new Set();
  const closedIssues = new Set();
  const calls = [];
  let nextIssue = 1001;
  let loopUnitLaunched = false;
  let unitObservationFails = false;
  let stopFails = false;
  let createCount = 0;
  let scoreCount = 0;
  let closePrCount = 0;
  let closeIssueCount = 0;

  const options = {
    manifest,
    manifestSha256,
    version: "1.33.0",
    repository: "owner/repo",
    base: "main",
    profile: "codex",
    candidateGitSha,
    actionId: "1".repeat(64),
    stateDir,
    scorerUnitTemplate: FRG_SCORER_UNIT_TEMPLATE,
    scorerRequestDir,
    candidateCheckout: candidate,
  };

  const writeLoopArtifacts = async (outputPath) => {
    const issueNumbers = issues.map((issue) => issue.number);
    const contract = {
      schema: "pipeline/loop-contract@1",
      run_id: "loop-frg-a",
      selector: { type: "label", value: "factory-gate" },
      items: issueNumbers.map((number) => ({ id: String(number), depends_on: [] })),
    };
    const ledger = {
      schema: "pipeline/loop-ledger@1",
      run_id: "loop-frg-a",
      items: Object.fromEntries(issueNumbers.map((number, index) => [String(number), {
        state: "ready",
        blocked_theme: null,
        advance_run_id: `advance-${index + 1}`,
      }])),
    };
    const events = issueNumbers.map((number, index) => ({
      seq: index + 1,
      kind: "loop_item_stage_progress",
      item_id: String(number),
      data: { item_id: String(number), stage: "ready" },
    }));
    const actions = issueNumbers.map((number, index) => ({
      seq: index + 1,
      action: "advance",
      item_id: String(number),
    }));
    await mkdir(loopRunDir, { recursive: true });
    await Promise.all([
      writeFile(join(loopRunDir, "contract.json"), canonicalJson(contract)),
      writeFile(join(loopRunDir, "ledger.json"), canonicalJson(ledger)),
      writeFile(join(loopRunDir, "events.jsonl"), events.map((item) => JSON.stringify(item)).join("\n") + "\n"),
      writeFile(join(loopRunDir, "action-evidence.jsonl"), actions.map((item) => JSON.stringify(item)).join("\n") + "\n"),
    ]);
    await privateWrite(outputPath, `${JSON.stringify({
      schema_version: "1",
      kind: "loop_run_handoff",
      run_id: "loop-frg-a",
      run_dir: loopRunDir,
      events: join(loopRunDir, "events.jsonl"),
    })}\n`);
    for (const issue of issues) issue.labels.push("pipeline:ready-to-deploy");
  };

  const deps = {
    env: { GH_TOKEN: "test-token", PATH: "/usr/bin", HOME: root },
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    emitLine: () => {},
    verifyCandidate: async () => {},
    listPackIssues: async () => issues.map((issue) => ({ ...issue, labels: [...issue.labels] })),
    createIssue: async (rendered) => {
      createCount++;
      const number = nextIssue++;
      issues.push({
        number,
        node_id: `ISSUE_${number}`,
        title: rendered.title,
        body: rendered.body,
        labels: [...rendered.labels],
        created_at: "2026-08-08T12:00:01.000Z",
        state: "OPEN",
        template_id: rendered.provenance.template_id,
      });
      return number;
    },
    observePullRequest: async (issueNumber) => {
      const issue = issues.find((candidateIssue) => candidateIssue.number === issueNumber);
      const prNumber = issueNumber + 1000;
      const head = issueNumber % 2 === 0 ? "b".repeat(40) : "c".repeat(40);
      return {
        number: prNumber,
        node_id: `PR_${prNumber}`,
        head_sha: head,
        base_branch: "main",
        files: issue.template_id === "clean-openspec"
          ? ["openspec/changes/archive/2026-frg/proposal.md", "openspec/specs/frg/spec.md"]
          : ["docs/frg-fixture.md"],
        checks: [{ id: `CHECK_${prNumber}`, name: "ci", head_sha: head, conclusion: "success" }],
      };
    },
    runProbe: async (probe) => ({
      id: probe.id,
      candidate_git_sha: candidateGitSha,
      test_file: probe.test_file,
      test_name: probe.test_name,
      command_argv_sha256: digest(`argv:${probe.id}`),
      stdout_sha256: digest(`stdout:${probe.id}`),
      stderr_sha256: digest(`stderr:${probe.id}`),
      started_at: "2026-08-08T12:01:00.000Z",
      finished_at: "2026-08-08T12:01:01.000Z",
    }),
    exec: async (executable, args) => {
      calls.push({ executable, args: [...args] });
      if (executable === "/usr/bin/systemctl" && args[1] === "show") {
        if (unitObservationFails) return { code: 1, stdout: "", stderr: "transport unavailable" };
        if (!loopUnitLaunched) {
          return {
            code: 1,
            stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n",
            stderr: "unit not found",
          };
        }
        return {
          code: 0,
          stdout: "LoadState=loaded\nActiveState=active\nSubState=exited\nResult=success\nExecMainStatus=0\n",
          stderr: "",
        };
      }
      if (executable === "/usr/bin/systemctl" && args[1] === "stop") {
        if (stopFails) return { code: 1, stdout: "", stderr: "stop unavailable" };
        loopUnitLaunched = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (executable === "/usr/bin/systemctl" && args[1] === "reset-failed") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (executable === "/usr/bin/systemd-run") {
        const outputArg = args.find((arg) => arg.startsWith("--property=StandardOutput=append:"));
        assert.ok(outputArg);
        const outputPath = outputArg.slice("--property=StandardOutput=append:".length);
        await writeLoopArtifacts(outputPath);
        loopUnitLaunched = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${executable} ${args.join(" ")}`);
    },
    startScorer: async (requestPath) => {
      scoreCount++;
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      const runDir = join(stateDir, request.pack_run_id);
      const observations = JSON.parse(await readFile(join(runDir, "observations.json"), "utf8"));
      const frgRunId = request.frg_run_id;
      const attestedEvidencePath = join(runDir, "attested-evidence.json");
      const evidenceText = canonicalJson({
        pass: true,
        version: "1.33.0",
        run_id: frgRunId,
        loop_run_id: request.loop_run_id,
        pack_id: "factory-gate-v1",
        created_at: request.evidence_created_at,
        scoreboard: {
          item_count: 2,
          ready_clean_count: 2,
          engine_class_count: 0,
          engine_class_rate: 0,
        },
        thresholds: { min_clean_ready_to_deploy: 2, max_engine_class_rate: 0.1 },
        composition: { missing: [], false_human_authority_count: 0 },
        pack_provenance: observations.pack_provenance,
        integrity: { pack_provenance_fingerprint: digest("provenance") },
      });
      await privateWrite(attestedEvidencePath, evidenceText);
      const result = {
        schema_version: 1,
        kind: "frg_attestation_result",
        status: "complete",
        request_id: request.request_id,
        grant_fingerprint: request.grant_fingerprint,
        action_id: request.action_id,
        version: request.version,
        loop_run_id: request.loop_run_id,
        pack_run_id: request.pack_run_id,
        candidate_git_sha: request.candidate_git_sha,
        manifest_sha256: request.manifest_sha256,
        frg_run_id: frgRunId,
        signer: {
          mode: "bootstrap-wrapper",
          version: "1.33.0",
          tag: "v1.33.0-bootstrap-policy",
          git_sha: "d".repeat(40),
          policy_id: "factory-gate-v1-hybrid-v1",
          policy_sha256: digest("policy"),
        },
        attestation_payload_sha256: digest("payload"),
        attested_evidence_sha256: digest(evidenceText),
      };
      await privateWrite(join(runDir, "attestation-result.json"), canonicalJson(result));
    },
    observeClosed: async (kind, number) => kind === "pr" ? closedPrs.has(number) : closedIssues.has(number),
    closePr: async (number) => { closePrCount++; closedPrs.add(number); },
    closeIssue: async (number) => {
      closeIssueCount++;
      closedIssues.add(number);
      const issue = issues.find((candidateIssue) => candidateIssue.number === number);
      issue.state = "CLOSED";
    },
    sleep: async () => {},
  };

  return {
    root,
    candidate,
    factoryState,
    stateDir,
    scorerRequestDir,
    options,
    deps,
    issues,
    calls,
    setStopFailure: (value) => { stopFails = value; },
    setUnitObservationFailure: (value) => { unitObservationFails = value; },
    counts: () => ({ createCount, scoreCount, closePrCount, closeIssueCount }),
  };
}

async function runTrustedAttestor(harness, requestPath, overrides = {}) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const config = {
    state_dir: harness.factoryState,
    frg_scorer_request_dir: harness.scorerRequestDir,
    frg_pack_manifest: harness.options.manifest,
    repo_dir: harness.candidate,
    wrapper_dir: resolve(here, ".."),
    wrapper_git_sha: "d".repeat(40),
  };
  const layout = frgAttestationLayout(config, request);
  if (overrides.reset !== false) {
    await rm(layout.result_path, { force: true });
    await rm(layout.attested_evidence_path, { force: true });
  }
  const credentialDir = overrides.credentialDir ?? join(harness.root, "credentials");
  if (overrides.writeCredential !== false) {
    const credentialPath = join(credentialDir, "frg_attestation_key");
    await rm(credentialPath, { force: true });
    await privateWrite(credentialPath, "test-key\n", 0o400);
  }
  const signer = {
    mode: "bootstrap-wrapper",
    version: "1.33.0",
    tag: "v1.33.0-bootstrap-policy",
    git_sha: config.wrapper_git_sha,
    policy_id: "factory-gate-v1-hybrid-v1",
    policy_sha256: digest("trusted-policy"),
  };
  return attestFrgRequest(requestPath, {
    scorerRequestRoot: harness.scorerRequestDir,
    env: overrides.env ?? { CREDENTIALS_DIRECTORY: credentialDir },
    verifyTrustRoot: overrides.verifyTrustRoot ?? (async () => ({ config, layout, signer })),
    ...(overrides.deps ?? {}),
  });
}

test("runner uses one durable candidate loop, derives proof, scores, and closes exact synthetic artifacts", async (t) => {
  const harness = await makeHarness(t);
  const emitted = [];
  const receipt = await runFrgPack(harness.options, {
    ...harness.deps,
    emitLine: (line) => emitted.push(line),
  });

  assert.equal(receipt.kind, "frg_pack_run");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.version, "1.33.0");
  assert.equal(receipt.candidate_git_sha, harness.options.candidateGitSha);
  assert.equal(receipt.synthetic_issues.length, 2);
  assert.ok(receipt.synthetic_issues.every((issue) => issue.closed && issue.pr_closed));
  assert.deepEqual(harness.counts(), { createCount: 2, scoreCount: 1, closePrCount: 2, closeIssueCount: 2 });
  assert.ok(emitted.some((line) => JSON.parse(line).kind === "loop_run_handoff"));

  const launch = harness.calls.find((call) => call.executable === "/usr/bin/systemd-run");
  assert.ok(launch, "candidate loop must launch in a separate transient unit");
  assert.ok(launch.args.some((arg) => arg.startsWith("--unit=hermes-frg-loop-")));
  assert.ok(!launch.args.some((arg) => arg.startsWith("--property=EnvironmentFile=")));
  const unitSeparator = launch.args.indexOf("--");
  assert.equal(launch.args[unitSeparator + 1], process.execPath);
  assert.match(launch.args[unitSeparator + 2], /\/clean-exec\.mjs$/);
  assert.deepEqual(launch.args.slice(unitSeparator + 3, unitSeparator + 6), [
    "--env-file",
    JSON.parse(await readFile(join(harness.stateDir, receipt.pack_run_id, "runner-state.json"), "utf8")).loop_child.env_path,
    "--",
  ]);
  assert.ok(launch.args.includes(harness.options.candidateCheckout + "/core/scripts/pipeline.ts"));
  assert.ok(harness.calls.some((call) => call.executable === "/usr/bin/systemctl"));

  const observations = JSON.parse(await readFile(receipt.observations_path, "utf8"));
  assert.equal(observations.pack_provenance.pack_run_id, receipt.pack_run_id);
  assert.equal(observations.pack_provenance.loop_run_id, receipt.loop_run_id);
  assert.equal(observations.pack_provenance.candidate_git_sha, receipt.candidate_git_sha);
  const state = JSON.parse(await readFile(join(harness.stateDir, receipt.pack_run_id, "runner-state.json"), "utf8"));
  assert.match(state.loop_child.unit, /^hermes-frg-loop-/);
  await assert.rejects(() => readFile(state.loop_child.env_path, "utf8"), { code: "ENOENT" });
  assert.ok(harness.calls.some((call) => call.executable === "/usr/bin/systemctl" && call.args[1] === "stop"));
  assert.ok(await readFile(state.loop_child.handoff_path, "utf8"));
  const cursor = JSON.parse(await readFile(state.loop_child.events_cursor_path, "utf8"));
  assert.equal(cursor.final_event_cursor, 2);
});

test("runner restart reconciles immutable artifacts and does not repeat live mutations", async (t) => {
  const harness = await makeHarness(t);
  const first = await runFrgPack(harness.options, harness.deps);
  const before = harness.counts();
  const second = await runFrgPack(harness.options, {
    ...harness.deps,
    runLoop: async () => { throw new Error("restart must not start another loop"); },
    runProbe: async () => { throw new Error("restart must not rerun probes"); },
    startScorer: async () => { throw new Error("restart must not rescore"); },
  });
  assert.deepEqual(second, first);
  assert.deepEqual(harness.counts(), before);
  assert.equal(harness.calls.filter((call) => call.executable === "/usr/bin/systemd-run").length, 1);
});

test("runner fails before mutation for stale selector members or a credential-bearing environment", async (t) => {
  const stale = await makeHarness(t);
  stale.issues.push({
    number: 9999,
    node_id: "ISSUE_9999",
    title: "stale",
    body: "not this run",
    labels: ["factory-gate"],
    created_at: "2026-08-08T12:00:01.000Z",
    state: "OPEN",
  });
  await assert.rejects(() => runFrgPack(stale.options, stale.deps), /stale or extra open issues: #9999/);
  assert.equal(stale.counts().createCount, 0);

  const secret = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(secret.options, {
      ...secret.deps,
      env: { ...secret.deps.env, PIPELINE_FRG_ATTESTATION_KEY: "must-not-enter" },
    }),
    /refuses credential-bearing environment variable/,
  );
  assert.equal(secret.counts().createCount, 0);
});

test("runner refuses wrong candidate and manifest identity before issue creation", async (t) => {
  const wrongCandidate = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(
      { ...wrongCandidate.options, candidateGitSha: "d".repeat(40) },
      {
        ...wrongCandidate.deps,
        verifyCandidate: async (_checkout, sha) => {
          if (sha !== wrongCandidate.options.candidateGitSha) throw new Error("candidate checkout HEAD does not match");
        },
      },
    ),
    /candidate checkout HEAD does not match/,
  );
  assert.equal(wrongCandidate.counts().createCount, 0);

  const wrongHash = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack({ ...wrongHash.options, manifestSha256: "0".repeat(64) }, wrongHash.deps),
    /manifest SHA-256 does not match/,
  );
  assert.equal(wrongHash.counts().createCount, 0);

  const moved = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack({ ...moved.options, candidateCheckout: join(moved.root, "moved") }, moved.deps),
    /manifest must be the exact candidate/,
  );
  assert.equal(moved.counts().createCount, 0);
});

test("candidate verifier rejects dirt and moved HEAD using only the pinned git executable", async () => {
  const commands = [];
  const deps = {
    exec: async (executable, args) => {
      commands.push({ executable, args });
      if (args[0] === "rev-parse") return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: " M core/scripts/pipeline.ts\n", stderr: "" };
    },
  };
  await assert.rejects(
    () => verifyFrgCandidate("/candidate", "a".repeat(40), deps),
    /candidate checkout is not clean/,
  );
  assert.ok(commands.every((call) => call.executable === "/usr/bin/git"));

  await assert.rejects(
    () => verifyFrgCandidate("/candidate", "b".repeat(40), deps),
    /HEAD does not match/,
  );
});

test("exact TAP probe rejects skipped and ambiguous output", async () => {
  const probe = {
    id: "exact-probe",
    test_file: "core/test/example.test.ts",
    test_name: "exact proof",
  };
  const input = { candidateCheckout: "/candidate", candidateGitSha: "a".repeat(40) };
  const base = {
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    verifyCandidate: async () => {},
  };
  const skipped = [
    "TAP version 13",
    "# Subtest: exact proof",
    "ok 1 - exact proof # SKIP",
    "1..1",
    "# tests 1",
    "# pass 0",
    "# fail 0",
    "# skipped 1",
  ].join("\n") + "\n";
  await assert.rejects(
    () => runFrgCandidateProbe(probe, input, {
      ...base,
      exec: async () => ({ code: 0, stdout: skipped, stderr: "" }),
    }),
    /did not report the one exact unskipped TAP pass/,
  );

  const ambiguous = [
    "TAP version 13",
    "# Subtest: exact proof",
    "# Subtest: exact proof",
    "ok 1 - exact proof",
    "1..1",
    "# tests 1",
    "# pass 1",
    "# fail 0",
    "# skipped 0",
  ].join("\n") + "\n";
  await assert.rejects(
    () => runFrgCandidateProbe(probe, input, {
      ...base,
      exec: async () => ({ code: 0, stdout: ambiguous, stderr: "" }),
    }),
    /did not report the one exact unskipped TAP pass/,
  );
});

test("runner rejects wrong PR/check identity before scoring", async (t) => {
  const badCheck = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(badCheck.options, {
      ...badCheck.deps,
      observePullRequest: async (number, input, deps) => {
        const observed = await badCheck.deps.observePullRequest(number, input, deps);
        observed.checks[0].conclusion = "failure";
        return observed;
      },
    }),
    /not final and green/,
  );
  assert.equal(badCheck.counts().scoreCount, 0);

  const duplicatePr = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(duplicatePr.options, {
      ...duplicatePr.deps,
      observePullRequest: async (number, input, deps) => {
        const observed = await duplicatePr.deps.observePullRequest(number, input, deps);
        return { ...observed, number: 2001, node_id: "PR_2001" };
      },
    }),
    /FRG live PR numbers contains duplicate/,
  );
  assert.equal(duplicatePr.counts().scoreCount, 0);
});

test("runner fails if cleanup cannot be reconciled", async (t) => {
  const harness = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(harness.options, {
      ...harness.deps,
      closeIssue: async () => {},
    }),
    /did not close/,
  );
  assert.equal(harness.counts().scoreCount, 1);
});

test("runner stop request terminates the durable loop before dropping its private environment", async (t) => {
  const harness = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(harness.options, {
      ...harness.deps,
      shouldStop: async () => "operator stop",
    }),
    /candidate Pipeline loop stopped: operator stop/,
  );
  const stop = harness.calls.find((call) => call.executable === "/usr/bin/systemctl" && call.args[1] === "stop");
  assert.ok(stop);
  const entries = await readdir(harness.stateDir);
  const runRoot = join(harness.stateDir, entries[0]);
  const state = JSON.parse(await readFile(join(runRoot, "runner-state.json"), "utf8"));
  await assert.rejects(() => readFile(state.loop_child.env_path, "utf8"), { code: "ENOENT" });
  assert.equal(harness.counts().scoreCount, 0);
});

test("runner retains the private environment when stop and terminal observation both fail", async (t) => {
  const harness = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(harness.options, {
      ...harness.deps,
      shouldStop: async () => {
        harness.setStopFailure(true);
        harness.setUnitObservationFailure(true);
        return "operator stop";
      },
    }),
    /observe systemd unit .* failed with exit 1: transport unavailable/,
  );

  const entries = await readdir(harness.stateDir);
  const state = JSON.parse(await readFile(join(harness.stateDir, entries[0], "runner-state.json"), "utf8"));
  assert.match(await readFile(state.loop_child.env_path, "utf8"), /GH_TOKEN="test-token"/);
  assert.equal(harness.counts().scoreCount, 0);
});

test("runner retains the private environment when loop polling cannot observe the unit", async (t) => {
  const harness = await makeHarness(t);
  await assert.rejects(
    () => runFrgPack(harness.options, {
      ...harness.deps,
      emitLine: () => harness.setUnitObservationFailure(true),
    }),
    /observe systemd unit .* failed with exit 1: transport unavailable/,
  );

  const entries = await readdir(harness.stateDir);
  const state = JSON.parse(await readFile(join(harness.stateDir, entries[0], "runner-state.json"), "utf8"));
  assert.match(await readFile(state.loop_child.env_path, "utf8"), /GH_TOKEN="test-token"/);
  assert.equal(harness.counts().scoreCount, 0);
});

test("runner CLI has a closed argument surface", () => {
  assert.throws(
    () => parseFrgRunnerCli(["run", "--status", "pass"]),
    /unknown or incomplete runner argument --status/,
  );
  assert.throws(
    () => parseFrgRunnerCli(["score", "--request", "/state/frg-scorer-requests/id.json"]),
    /expected run or attest subcommand/,
  );
  assert.deepEqual(
    parseFrgRunnerCli(["attest", "--checkpoint", "/state/checkpoint.json", "--config", "/config.json"]),
    { mode: "attest", checkpoint: "/state/checkpoint.json", config: "/config.json" },
  );
  assert.throws(
    () => parseFrgRunnerCli(["attest", "--checkpoint", "relative.json", "--config", "/config.json"]),
    /attest requires/,
  );
});

test("isolated attestor checks request ownership and mode before reading its credential", async (t) => {
  const harness = await makeHarness(t);
  const receipt = await runFrgPack(harness.options, harness.deps);
  const requestPath = join(harness.scorerRequestDir, `${receipt.pack_run_id}.json`);
  const credentialDir = join(harness.root, "credentials");
  const credentialPath = join(credentialDir, "frg_attestation_key");
  await privateWrite(credentialPath, "test-key\n", 0o400);

  await chmod(requestPath, 0o644);
  await assert.rejects(
    () => runTrustedAttestor(harness, requestPath, { credentialDir, reset: false }),
    /FRG attestation request mode must be 600/,
  );

  await chmod(requestPath, 0o600);
  await assert.rejects(
    () => runTrustedAttestor(harness, requestPath, {
      credentialDir,
      reset: false,
      deps: { getuid: () => 2 ** 31 - 1 },
    }),
    /must be owned by the attestor user/,
  );
});

test("credentialed attestor neither imports nor executes malicious candidate code", async (t) => {
  const harness = await makeHarness(t);
  const receipt = await runFrgPack(harness.options, harness.deps);
  const requestPath = join(harness.scorerRequestDir, `${receipt.pack_run_id}.json`);
  const credentialDir = join(harness.root, "credentials");
  const canary = join(harness.root, "candidate-read-credential");
  const malicious = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const canary = ${JSON.stringify(canary)};`,
    'const root = process.env.CREDENTIALS_DIRECTORY;',
    'if (root) writeFileSync(canary, readFileSync(join(root, "frg_attestation_key"), "utf8"));',
    'throw new Error("candidate code executed inside attestor");',
    "",
  ].join("\n");
  await writeFile(join(harness.candidate, "core", "scripts", "frg-pack-observations.ts"), malicious);
  await writeFile(join(harness.candidate, "core", "scripts", "pipeline.ts"), malicious);

  const result = await runTrustedAttestor(harness, requestPath, {
    credentialDir,
    env: {
      CREDENTIALS_DIRECTORY: credentialDir,
      PATH: "/usr/bin",
      HOME: harness.root,
      MANAGER_SECRET_CANARY: "must-not-reach-candidate",
    },
  });
  assert.equal(result.frg_run_id, receipt.frg_run_id);
  await assert.rejects(() => readFile(canary, "utf8"), { code: "ENOENT" });
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  assert.equal("candidate_checkout" in request, false);
  assert.equal("collector_path" in request, false);
  assert.equal("pipeline_path" in request, false);
  assert.equal("result_path" in request, false);
});

test("isolated attestor reprojects the bundle and rejects caller-authored outcomes before the key read", async (t) => {
  const harness = await makeHarness(t);
  const receipt = await runFrgPack(harness.options, harness.deps);
  const requestPath = join(harness.scorerRequestDir, `${receipt.pack_run_id}.json`);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const runDir = join(harness.stateDir, request.pack_run_id);
  const observationsPath = join(runDir, "observations.json");
  const observations = JSON.parse(await readFile(observationsPath, "utf8"));
  observations.scenarios[0].status = "fail";
  const inventedText = canonicalJson(observations);
  await privateWrite(observationsPath, inventedText);
  request.observations_sha256 = digest(inventedText);
  await privateWrite(requestPath, canonicalJson(request));
  let credentialRead = false;

  await assert.rejects(
    () => runTrustedAttestor(harness, requestPath, {
      writeCredential: false,
      env: { CREDENTIALS_DIRECTORY: join(harness.root, "credentials") },
      deps: {
        readFile: async (path, encoding) => {
          if (String(path).endsWith("/frg_attestation_key")) credentialRead = true;
          return readFile(path, encoding);
        },
      },
    }),
    /not the exact trusted projection/,
  );
  assert.equal(credentialRead, false);
});

test("isolated attestor requires its trust root and credential", async (t) => {
  const trust = await makeHarness(t);
  const trustReceipt = await runFrgPack(trust.options, trust.deps);
  const trustRequest = join(trust.scorerRequestDir, `${trustReceipt.pack_run_id}.json`);
  await assert.rejects(
    () => runTrustedAttestor(trust, trustRequest, {
      env: {},
      verifyTrustRoot: async () => { throw new Error("no active integrated candidate trust root"); },
    }),
    /no active integrated candidate trust root/,
  );

  const credential = await makeHarness(t);
  const credentialReceipt = await runFrgPack(credential.options, credential.deps);
  const credentialRequest = join(credential.scorerRequestDir, `${credentialReceipt.pack_run_id}.json`);
  await assert.rejects(
    () => runTrustedAttestor(credential, credentialRequest, {
      env: {},
      writeCredential: false,
    }),
    /CREDENTIALS_DIRECTORY is invalid/,
  );
});

test("attestor trust root binds the signed grant journal to the exact integrated candidate", async (t) => {
  const harness = await makeHarness(t);
  const wrapperDir = resolve(here, "..");
  const stateDir = join(harness.root, "trusted-state");
  const configPath = join(harness.root, "config", "config.json");
  const activeGrantFile = join(stateDir, "active-grant.json");
  const machine = machineFixture({
    repo_dir: harness.candidate,
    state_dir: stateDir,
    inbox_dir: join(stateDir, "inbox"),
    active_grant_file: activeGrantFile,
    control_file: join(stateDir, "control.json"),
    artifact_checkout: join(stateDir, "artifact"),
    production_pin_file: join(stateDir, "production-engine.json"),
    wrapper_dir: wrapperDir,
    wrapper_manifest_file: join(wrapperDir, "pinned-artifacts.json"),
    candidate_version: "1.33.0",
    frg_pack_manifest: harness.options.manifest,
    frg_pack_manifest_sha256: harness.options.manifestSha256,
    pipeline_loop_state_dir: join(stateDir, "pipeline-loops"),
    frg_scorer_request_dir: join(stateDir, "frg-scorer-requests"),
    node_command: process.execPath,
    pipeline_command: [process.execPath, "/home/user/.codex/skills/pipeline/scripts/pipeline.mjs"],
    candidate_pipeline_command: [process.execPath, "--experimental-strip-types", join(harness.candidate, "core", "scripts", "pipeline.ts")],
    frg_runner_command: [process.execPath, join(wrapperDir, "lib", "frg-runner.mjs")],
  });
  const grantEnvelope = envelope({
    grant: {
      nonce: "release-1.33.0-run-001",
      release_version: "1.33.0",
      milestone: "v1.33.0",
    },
  });
  const validated = validateGrantEnvelope(grantEnvelope, machine, { now: () => new Date("2026-08-08T12:00:00.000Z") });
  const integratedAction = {
    action_id: "integrated-action",
    kind: "integrated_candidate",
    state: "completed",
    result: { git_sha: harness.options.candidateGitSha },
  };
  const frgAction = {
    action_id: "frg-action",
    kind: "frg",
    state: "running",
    target: {
      version: "1.33.0",
      pack_id: "factory-gate-v1",
      manifest_sha256: harness.options.manifestSha256,
      candidate_git_sha: harness.options.candidateGitSha,
    },
  };
  const activePath = join(stateDir, "active.json");
  const journalPath = join(stateDir, "runs", `${validated.fingerprint}.json`);
  await privateWrite(configPath, canonicalJson(machine));
  await privateWrite(activeGrantFile, canonicalJson(grantEnvelope));
  await privateWrite(activePath, canonicalJson({ fingerprint: validated.fingerprint, status: "running" }));
  await privateWrite(journalPath, canonicalJson({
    grant_fingerprint: validated.fingerprint,
    status: "running",
    current: { action_id: frgAction.action_id, kind: "frg" },
    actions: { integrated: integratedAction, frg: frgAction },
  }));
  const request = {
    action_id: frgAction.action_id,
    grant_fingerprint: validated.fingerprint,
    version: "1.33.0",
    repository: "owner/repo",
    base_branch: "main",
    candidate_git_sha: harness.options.candidateGitSha,
    manifest_sha256: harness.options.manifestSha256,
    pack_run_id: "pack-run",
  };
  const deps = {
    machineConfigPath: configPath,
    scorerRequestRoot: machine.frg_scorer_request_dir,
    readFile,
    stat,
    getuid: () => typeof process.getuid === "function" ? process.getuid() : null,
    now: () => new Date("2026-08-08T12:00:00.000Z"),
    verifyWrapperArtifact: async () => ({ git_commit: machine.wrapper_git_sha, file_count: 1 }),
  };
  await verifyFrgAttestorTrustRoot(request, deps);

  frgAction.target.candidate_git_sha = "d".repeat(40);
  await privateWrite(journalPath, canonicalJson({
    grant_fingerprint: validated.fingerprint,
    status: "running",
    current: { action_id: frgAction.action_id, kind: "frg" },
    actions: { integrated: integratedAction, frg: frgAction },
  }));
  await assert.rejects(
    () => verifyFrgAttestorTrustRoot(request, deps),
    /not bound to the active integrated candidate and FRG action/,
  );
});
