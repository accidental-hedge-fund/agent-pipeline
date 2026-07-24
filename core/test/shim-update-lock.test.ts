// Regression tests for the launcher shim's update-lock reservation (#450 round 2).
//
// The installer's live-run scan (scripts/install.mjs) can only refuse an update
// when a run's lock is already on disk at scan time. Without a guard on the
// shim side, a run started between that scan and the copy would load a mixed
// old/new engine tree. The shim (hosts/_shared/entry.template.mjs) closes this
// by reserving a pipeline-*.lock-shaped slot and re-checking the installer's
// update lock immediately before spawning the engine subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = fileURLToPath(new URL("../../hosts/_shared/entry.template.mjs", import.meta.url));

function buildShimLayout(tmpDir: string, pipelineTsBody: string) {
  const shimScriptsDir = path.join(tmpDir, "scripts");
  const coreSrcDir = path.join(tmpDir, "core", "scripts");
  fs.mkdirSync(shimScriptsDir, { recursive: true });
  fs.mkdirSync(coreSrcDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "core", "node_modules"), { recursive: true }); // skip npm ci

  const shimSrc = fs.readFileSync(TEMPLATE_PATH, "utf8").replaceAll("__PROFILE__", "test");
  const shimPath = path.join(shimScriptsDir, "pipeline.mjs");
  fs.writeFileSync(shimPath, shimSrc);

  fs.writeFileSync(path.join(tmpDir, "core", "package.json"), JSON.stringify({ version: "0.0.0-test" }));
  fs.writeFileSync(path.join(coreSrcDir, "pipeline.ts"), pipelineTsBody);
  return shimPath;
}

const REPORT_RESERVATION_STUB = `
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
const files = readdirSync(tmpdir()).filter((f) => /^pipeline-starting-\\d+\\.lock$/.test(f));
console.log("RESERVED:" + JSON.stringify(files));
process.exit(0);
`;

test("shim: reserves a pipeline-starting-<pid>.lock slot visible to the engine, then releases it", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-lock-test-"));
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-lock-isolated-"));
  try {
    const shimPath = buildShimLayout(tmpDir, REPORT_RESERVATION_STUB);

    const result = spawnSync(process.execPath, [shimPath], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: isolatedTmp },
    });

    assert.equal(result.status, 0, `shim exited ${result.status}; stderr:\n${result.stderr}`);
    const match = result.stdout.match(/RESERVED:(\[.*\])/);
    assert.ok(match, `expected a RESERVED: line in stdout, got:\n${result.stdout}`);
    const files = JSON.parse(match[1]);
    assert.equal(files.length, 1, "engine subprocess must observe exactly one reservation slot while running");

    const remaining = fs
      .readdirSync(isolatedTmp)
      .filter((f) => /^pipeline-starting-\d+\.lock$/.test(f));
    assert.deepEqual(remaining, [], "reservation must be released once the engine subprocess exits");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

test("shim: refuses to start the engine while the installer's update lock is held", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-lock-test-"));
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-lock-isolated-"));
  try {
    const shimPath = buildShimLayout(tmpDir, REPORT_RESERVATION_STUB);
    fs.writeFileSync(path.join(isolatedTmp, ".pipeline-installer-update.lock"), "1");

    const result = spawnSync(process.execPath, [shimPath], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: isolatedTmp },
    });

    assert.notEqual(result.status, 0, "shim must refuse to start while an update is in progress");
    assert.doesNotMatch(
      result.stdout,
      /RESERVED:/,
      "the engine subprocess must never run while the update lock is held",
    );
    assert.match(result.stderr, /update is in progress/i);

    const reservations = fs
      .readdirSync(isolatedTmp)
      .filter((f) => /^pipeline-starting-\d+\.lock$/.test(f));
    assert.deepEqual(reservations, [], "a refused start must not leave a dangling reservation");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Read-only-command exemption (#567) — `logs`/`status`/`summary` must not
// reserve or hold the `pipeline-starting-<pid>.lock` slot, so a long-lived
// `logs --follow` never blocks a concurrent `install.mjs update`. A
// run-mutating command (e.g. `advance`) must keep reserving — the #450
// deferral is unchanged.
// ---------------------------------------------------------------------------

/** Extract just the `READ_ONLY_COMMANDS` + `isReadOnlyCommand` source from the
 *  template and evaluate it in an isolated vm context — proves the classifier
 *  itself is a pure function with no real filesystem/process-signal/subprocess
 *  call, independent of the rest of the shim (which does touch the filesystem). */
function loadIsReadOnlyCommand(): (argv0: string | undefined) => boolean {
  const src = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const start = src.indexOf("const READ_ONLY_COMMANDS");
  const end = src.indexOf("function updateInProgress");
  assert.ok(start >= 0 && end > start, "expected to find the read-only classifier block in the template");
  const snippet = src.slice(start, end) + "\nisReadOnlyCommand";
  const context = vm.createContext({});
  return vm.runInContext(snippet, context);
}

test("isReadOnlyCommand: classifies logs/status/summary read-only, everything else run-mutating (pure, no I/O)", () => {
  const isReadOnlyCommand = loadIsReadOnlyCommand();
  assert.equal(isReadOnlyCommand("logs"), true);
  assert.equal(isReadOnlyCommand("status"), true);
  assert.equal(isReadOnlyCommand("summary"), true);
  assert.equal(isReadOnlyCommand("advance"), false);
  assert.equal(isReadOnlyCommand("loop"), false);
  assert.equal(isReadOnlyCommand("queue"), false);
  assert.equal(isReadOnlyCommand("improve"), false);
  assert.equal(isReadOnlyCommand(undefined), false, "fail-safe default: unknown/absent command reserves");
});

test("shim: a logs-shaped invocation reserves no pipeline-starting-<pid>.lock, even under --follow", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-readonly-test-"));
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-readonly-isolated-"));
  try {
    const shimPath = buildShimLayout(tmpDir, REPORT_RESERVATION_STUB);

    const result = spawnSync(process.execPath, [shimPath, "logs", "42", "--events", "--follow"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: isolatedTmp },
    });

    assert.equal(result.status, 0, `shim exited ${result.status}; stderr:\n${result.stderr}`);
    const match = result.stdout.match(/RESERVED:(\[.*\])/);
    assert.ok(match, `expected a RESERVED: line in stdout, got:\n${result.stdout}`);
    const files = JSON.parse(match[1]);
    assert.deepEqual(files, [], "a read-only `logs --follow` invocation must hold no run-liveness lock");

    const remaining = fs
      .readdirSync(isolatedTmp)
      .filter((f) => /^pipeline-starting-\d+\.lock$/.test(f));
    assert.deepEqual(remaining, [], "no reservation should remain after the read-only command exits");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});

test("shim: a run-mutating invocation (advance) still reserves a pipeline-starting-<pid>.lock", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-mutating-test-"));
  const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-mutating-isolated-"));
  try {
    const shimPath = buildShimLayout(tmpDir, REPORT_RESERVATION_STUB);

    const result = spawnSync(process.execPath, [shimPath, "advance", "42"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: isolatedTmp },
    });

    assert.equal(result.status, 0, `shim exited ${result.status}; stderr:\n${result.stderr}`);
    const match = result.stdout.match(/RESERVED:(\[.*\])/);
    assert.ok(match, `expected a RESERVED: line in stdout, got:\n${result.stdout}`);
    const files = JSON.parse(match[1]);
    assert.equal(files.length, 1, "a run-mutating command must still reserve exactly one slot (#450 unchanged)");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  }
});
