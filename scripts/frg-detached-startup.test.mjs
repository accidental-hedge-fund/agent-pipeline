import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(process.env.FRG_DETACHED_TEST_PACKAGE_ROOT ?? fixtureRoot);
const fixture = (name) => path.join(fixtureRoot, "scripts", "test-fixtures", `frg-detached-${name}.mjs`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stopOwnedGroup(pid, marker) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !existsSync(marker)) return;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 50; i += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(20);
  }
  try { process.kill(-pid, "SIGKILL"); } catch {}
}

function eventTypes(root) {
  const eventsPath = path.join(root, ".agent-pipeline", "runs", "frg-detached-fullchain", "events.jsonl");
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).type);
}

test("detached FRG resume owns output after its transient prepare exits (#1547)", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frg-detached-startup-"));
  const artifacts = path.join(root, "artifacts");
  const target = path.join(root, "target");
  const runDir = path.join(root, "run");
  mkdirSync(artifacts);
  mkdirSync(target);
  mkdirSync(runDir);
  writeFileSync(path.join(target, "README.md"), "detached startup fixture\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: target });
  execFileSync("git", ["add", "."], { cwd: target });
  execFileSync("git", ["-c", "user.name=FRG Test", "-c", "user.email=frg@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: target });
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
  let supervisorPid = null;
  let prepare = null;
  const marker = path.join(artifacts, "spawned-pid");
  try {
    prepare = spawn(process.execPath, [fixture("prepare")], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH, HOME: root, AGENT_PIPELINE_NODE: process.execPath, NODE_NO_WARNINGS: "1",
        FRG_DETACHED_PACKAGE_ROOT: packageRoot, FRG_DETACHED_TARGET: target,
        FRG_DETACHED_FIXTURE_ROOT: fixtureRoot,
        FRG_DETACHED_RUN_DIR: runDir, FRG_DETACHED_ARTIFACTS: artifacts,
        FRG_DETACHED_CANDIDATE_SHA: candidate,
      },
    });
    let stdout = "";
    let stderr = "";
    prepare.stdout.on("data", (chunk) => { stdout += chunk; });
    prepare.stderr.on("data", (chunk) => { stderr += chunk; });
    const prepareExit = await Promise.race([
      new Promise((resolve) => prepare.once("exit", (code, signal) => resolve({ code, signal }))),
      sleep(8_000).then(() => ({ timeout: true })),
    ]);
    const spawnResultPath = path.join(artifacts, "spawn-result.json");
    const spawnResultText = existsSync(spawnResultPath) ? readFileSync(spawnResultPath, "utf8") : "missing";
    assert.deepEqual(prepareExit, { code: 0, signal: null }, `prepare failed: result=${spawnResultText}; stdout=${stdout}; stderr=${stderr}`);
    const spawnResult = JSON.parse(spawnResultText);
    assert.equal(spawnResult.dispatch_state, "dispatched");
    supervisorPid = spawnResult.pid;
    assert.equal(Number(readFileSync(marker, "utf8")), supervisorPid);

    writeFileSync(path.join(artifacts, "go"), "go\n", { mode: 0o600 });
    try {
      await waitFor(() => existsSync(path.join(artifacts, "result.json")), "nested advance result");
    } catch (error) {
      const uncaught = readdirSync(artifacts).filter((name) => name.startsWith("uncaught-"));
      assert.fail(`${error.message}; events=${JSON.stringify(eventTypes(target))}; uncaught=${JSON.stringify(uncaught)}`);
    }
    const result = JSON.parse(readFileSync(path.join(artifacts, "result.json"), "utf8"));
    if (result.code !== 0 || result.signal !== null) {
      const uncaught = readdirSync(artifacts)
        .filter((name) => name.startsWith("uncaught-"))
        .map((name) => JSON.parse(readFileSync(path.join(artifacts, name), "utf8")));
      assert.fail(`nested advance failed: result=${JSON.stringify(result)}; events=${JSON.stringify(eventTypes(target))}; uncaught=${JSON.stringify(uncaught)}`);
    }
    assert.equal(existsSync(path.join(artifacts, "mutation-boundary")), true);
    assert.ok(eventTypes(target).includes("stage_start"));
    assert.ok(eventTypes(target).includes("run_complete"));
    assert.deepEqual(readdirSync(artifacts).filter((name) => name.startsWith("uncaught-")), []);
  } finally {
    if (prepare && prepare.exitCode === null && prepare.signalCode === null) prepare.kill("SIGKILL");
    if (!supervisorPid && existsSync(marker)) supervisorPid = Number(readFileSync(marker, "utf8"));
    await stopOwnedGroup(supervisorPid, marker);
    rmSync(root, { recursive: true, force: true });
  }
});
