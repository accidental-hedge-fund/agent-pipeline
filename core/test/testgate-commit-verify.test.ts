// Regression tests for test-fix loop commit message verification (#68, 4.5/4.6).
// Tests enforceTestFixCommitFormat directly (per-gate isolation) AND verifies
// that runTestGate blocks when the injectable verifyTestFix dep returns failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceTestFixCommitFormat,
  runTestGate,
  type TestGateDeps,
} from "../scripts/testgate.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { VerifyDeps, VerifyResult } from "../scripts/verify-harness-commits.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// enforceTestFixCommitFormat — gate isolation (4.5 / 4.6)
// ---------------------------------------------------------------------------

test("test-fix format: matching commit with trailers → proceeds (4.6)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["fix: resolve test/build failures (#42)\n\nIssue: #42\nPipeline-Run: run-123\n"]),
  );
  assert.equal(result.ok, true);
});

test("test-fix format: case-insensitive match with trailers → proceeds", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["Fix: Resolve Test/Build Failures (#42)\n\nIssue: #42\nPipeline-Run: run-456\n"]),
  );
  assert.equal(result.ok, true);
});

test("test-fix format: non-matching commit → blocked (4.5)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["wip: trying to fix the build\n"]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("Test-fix commit message does not match prescribed format"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("test-fix format: unrelated commit → blocked", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["feat: add new feature (#42)\n"]),
  );
  assert.equal(result.ok, false);
});

test("test-fix format: empty range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await enforceTestFixCommitFormat(42, "/wt", "abc", msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("test-fix format: wrong issue number → blocked", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["fix: resolve test/build failures (#99)\n"]),
  );
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// enforceTestFixCommitFormat — trailer verification (finding 2)
// ---------------------------------------------------------------------------

test("test-fix trailers: matching subject + both trailers → ok (finding 2)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps([
      "fix: resolve test/build failures (#42)\n\nIssue: #42\nPipeline-Run: run-456\n",
    ]),
  );
  assert.equal(result.ok, true);
});

test("test-fix trailers: matching subject but missing Issue trailer → blocked (finding 2)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps([
      "fix: resolve test/build failures (#42)\n\nPipeline-Run: run-456\n",
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes('"Issue:"'),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("test-fix trailers: matching subject but missing Pipeline-Run trailer → blocked (finding 2)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps([
      "fix: resolve test/build failures (#42)\n\nIssue: #42\n",
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes('"Pipeline-Run:"'),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

// ---------------------------------------------------------------------------
// runTestGate integration: verifyTestFix dep blocks the gate (4.5)
// ---------------------------------------------------------------------------

function baseCfg(): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_merge: false,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: true, max_attempts: 2, timeout: 300, command: "true" },
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 1 },
  };
}

function okInvoke(): HarnessResult {
  return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
}

test("runTestGate: verifyTestFix blocks → gate returns blocked with reason (4.5)", async () => {
  let n = 0;
  const deps: TestGateDeps = {
    invoke: async () => okInvoke(),
    runTests: async () => ({ passed: false, output: "FAIL", durationSec: 0.1 }),
    detectTestCommand: () => ({ cmd: "true", args: [] }),
    gitHead: async () => `sha-${n++}`,
    gitDirty: async () => false,
    verifyTestFix: async (): Promise<VerifyResult> => ({
      ok: false,
      reason: "Test-fix commit message does not match prescribed format",
    }),
  };

  const result = await runTestGate(baseCfg(), 42, "/wt", deps);
  assert.equal(result.skipped, false);
  assert.equal(result.passed, false);
  assert.ok(
    result.blockReason?.includes("Test-fix commit message does not match prescribed format"),
    `blockReason: ${result.blockReason}`,
  );
});

test("runTestGate: verifyTestFix passes → gate continues normally (4.6)", async () => {
  let n = 0;
  const deps: TestGateDeps = {
    invoke: async () => okInvoke(),
    // fail first time so loop runs, then pass
    runTests: async () => n++ === 0
      ? { passed: false, output: "FAIL", durationSec: 0.1 }
      : { passed: true, output: "ok", durationSec: 0.1 },
    detectTestCommand: () => ({ cmd: "true", args: [] }),
    gitHead: async () => `sha-${n}`,
    gitDirty: async () => false,
    verifyTestFix: async (): Promise<VerifyResult> => ({ ok: true }),
  };

  const result = await runTestGate(baseCfg(), 42, "/wt", deps);
  assert.equal(result.skipped, false);
  assert.equal(result.passed, true);
});
