// Regression: ship playbook must post a useful failure reason to Buzz on a
// failed phase (not just "train exit 1"). `write_state` enriches the posted
// detail via `failure_detail <phase>`, which reads the phase's captured
// output (train blocker sidecar, *.err, *.json). This test sources the bash
// function from the playbook and asserts it extracts the operator-useful line.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const playbook = path.join(
  repoRoot,
  "examples/supervisor/shell/tugboat.sh",
);

function extractFailureDetail(
  runDir: string,
  logFile: string,
  phase: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-fd-"));
  try {
    // Extract just the failure_detail() function body from the playbook.
    const src = fs.readFileSync(playbook, "utf8");
    const m = src.match(/^failure_detail\(\) \{[\s\S]*?\n\}/m);
    assert.ok(m, "failure_detail() function not found in tugboat.sh");
    const fn = m[0];
    const runner = path.join(dir, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        `RUN_DIR=${JSON.stringify(runDir)}`,
        `LOG_FILE=${JSON.stringify(logFile)}`,
        fn,
        `printf '%s' "$(failure_detail '${phase}')"`,
        "",
      ].join("\n"),
    );
    fs.chmodSync(runner, 0o755);
    const r = spawnSync("bash", [runner], { encoding: "utf8" });
    assert.equal(r.status, 0, `runner exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ship-fd-run-"));
}

test("failure_detail train: reads blocker sidecar", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "advance failed for #978: pipeline single exited with code 2",
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /advance failed for #978/);
    assert.match(out, /pipeline single exited with code 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure_detail train (#1074): preserves structured stop class from train blocker", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "train.json.blocker"),
      "held: #1010: advance failed for #1010: supervisor_no_progress",
    );
    const out = extractFailureDetail(dir, "", "train");
    assert.match(out, /supervisor_no_progress/);
    assert.match(out, /1010/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure_detail release-finish: checks sidecar beats tester-evidence warn", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "release-checks.fail.json"),
      JSON.stringify({
        pr: "1109",
        check_name: "test",
        bucket: "fail",
        link: "https://github.com/o/r/actions/runs/32075787450",
        reason:
          "PR #1109 check test fail https://github.com/o/r/actions/runs/32075787450",
      }),
    );
    const logFile = path.join(dir, "playbook.log");
    fs.writeFileSync(
      logFile,
      "[pipeline] tester-evidence: trusted-surface blocked prevents readiness subject emission (fail closed)\n",
    );
    const out = extractFailureDetail(dir, logFile, "release-finish");
    assert.match(out, /PR #1109/);
    assert.match(out, /\btest\b/);
    assert.match(out, /32075787450/);
    assert.doesNotMatch(out, /tester-evidence/);
    assert.doesNotMatch(out, /trusted-surface blocked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure_detail release-finish: surfaces pending checks line", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "release-finish.err"),
      [
        "[pipeline release finish] #988: inspecting…",
        "pipeline release finish: No required checks configured, but observable checks are not green:",
        "  - test (pending)",
        "",
      ].join("\n"),
    );
    const out = extractFailureDetail(dir, "", "release-finish");
    assert.match(out, /observable checks are not green/);
    assert.doesNotMatch(out, /^\s*- test/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure_detail engine-promote: falls back to capture last line", () => {
  const dir = makeRunDir();
  try {
    fs.writeFileSync(
      path.join(dir, "engine-promote.err"),
      "[pipeline engine-promote] install failed: npx exit 1",
    );
    const out = extractFailureDetail(dir, "", "engine-promote");
    assert.match(out, /install failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failure_detail: empty when no capture and no log", () => {
  const dir = makeRunDir();
  try {
    const out = extractFailureDetail(dir, path.join(dir, "nope.log"), "wait-release");
    assert.equal(out, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
