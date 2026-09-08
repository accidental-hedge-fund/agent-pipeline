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
import {
  observeTesterImplementationRole,
  rebindTesterEvidenceAfterPr,
} from "../scripts/rebind-tester-evidence-after-pr.ts";
import {
  testerEvidencePath,
  type TesterEvidence,
  type TesterEvidenceIoDeps,
} from "../scripts/tester-evidence.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { VerifyDeps, VerifyResult } from "../scripts/verify-harness-commits.ts";

function msgsDeps(
  messages: string[],
  diffFiles: string[] = ["core/scripts/example.ts"],
): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => diffFiles,
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// enforceTestFixCommitFormat — gate isolation (4.5 / 4.6)
// ---------------------------------------------------------------------------

test("test-fix format: matching commit → proceeds (4.6)", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["fix: resolve test/build failures (#42)\n"]),
  );
  assert.equal(result.ok, true);
});

test("test-fix format: case-insensitive match → proceeds", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["Fix: Resolve Test/Build Failures (#42)\n"]),
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

test("test-fix format: correctly formatted empty commit → blocked (#1562 review 1)", async () => {
  const result = await enforceTestFixCommitFormat(
    1562,
    "/wt",
    "abc",
    msgsDeps([
      "fix: resolve test/build failures (#1562)\n\nIssue: #1562\nPipeline-Run: 1562/run",
    ], []),
  );
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("no candidate-content changes"));
});

test("test-fix format: wrong issue number → blocked", async () => {
  const result = await enforceTestFixCommitFormat(
    42, "/wt", "abc",
    msgsDeps(["fix: resolve test/build failures (#99)\n"]),
  );
  assert.equal(result.ok, false);
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
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
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
  let head = "sha-before";
  const deps: TestGateDeps = {
    invoke: async () => {
      head = "sha-after";
      return okInvoke();
    },
    runTests: async () => ({ passed: false, output: "FAIL", durationSec: 0.1 }),
    detectTestCommand: () => ({ cmd: "true", args: [] }),
    gitHead: async () => head,
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
  let testRuns = 0;
  let head = "sha-before";
  const deps: TestGateDeps = {
    invoke: async () => {
      head = "sha-after";
      return okInvoke();
    },
    // fail first time so loop runs, then pass
    runTests: async () => testRuns++ === 0
      ? { passed: false, output: "FAIL", durationSec: 0.1 }
      : { passed: true, output: "ok", durationSec: 0.1 },
    detectTestCommand: () => ({ cmd: "true", args: [] }),
    gitHead: async () => head,
    gitDirty: async () => false,
    verifyTestFix: async (): Promise<VerifyResult> => ({ ok: true }),
  };

  const result = await runTestGate(baseCfg(), 42, "/wt", deps);
  assert.equal(result.skipped, false);
  assert.equal(result.passed, true);
});

test("clean no-change retry preserves the PR candidate through Tester rebind (#1562)", async () => {
  const candidate = "a".repeat(40);
  const runDir = "/runs/1562-current";
  const files = new Map<string, string>();
  const io: TesterEvidenceIoDeps = {
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return value;
    },
    writeFile: async (filePath, value) => { files.set(filePath, value); },
    rename: async (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    mkdir: async () => {},
  };

  // This is the real pre-fix contradiction: the commit verifier rejects the
  // empty range even though the unchanged candidate can pass on rerun.
  const emptyRange = await enforceTestFixCommitFormat(
    1562,
    "/wt",
    candidate,
    msgsDeps([]),
  );
  assert.equal(emptyRange.ok, false);

  let testRuns = 0;
  let verifierCalls = 0;
  let persisted: TesterEvidence | null = null;
  const gate = await runTestGate(
    { ...baseCfg(), test_gate: { ...baseCfg().test_gate, max_attempts: 1 } },
    1562,
    "/wt",
    {
      runTests: async () => testRuns++ === 0
        ? { passed: false, output: "transient integration assertion", durationSec: 0.1, toolingError: false }
        : { passed: true, output: "ok", durationSec: 0.1, toolingError: false },
      invoke: async () => okInvoke(),
      gitHead: async () => candidate,
      gitDirty: async () => false,
      verifyTestFix: async (wtPath, headBefore) => {
        verifierCalls++;
        return enforceTestFixCommitFormat(1562, wtPath, headBefore, msgsDeps([]));
      },
      gitCommitMessages: async () => {
        throw new Error("clean no-change retry has no commit range");
      },
      writeTesterEvidence: async (_dest, evidence) => {
        persisted = evidence;
        files.set(testerEvidencePath(runDir), `${JSON.stringify(evidence, null, 2)}\n`);
        return { ok: true };
      },
      resolvePinnedEngineIdentity: () => null,
    },
    "1562/2026-09-08T16:20:43Z",
    "test-gate",
    undefined,
    runDir,
  );

  assert.equal(gate.passed, true);
  assert.equal(gate.attempts, 1);
  assert.equal(testRuns, 2, "the unchanged candidate must still pass a fresh rerun");
  assert.equal(verifierCalls, 0, "the empty commit range is exempt only on clean unchanged HEAD");
  assert.equal(gate.persist?.candidate_sha, candidate);
  assert.equal(persisted?.candidate_sha, candidate);

  const rebound = await rebindTesterEvidenceAfterPr({
    cfg: baseCfg(),
    issueNumber: 1562,
    stage: "design-gate",
    runDir,
    prNumber: 99,
    prHeadSha: candidate,
    pushedHeadSha: candidate,
    pushedPrNumber: 99,
    trustedSurface: {
      outcome: "passthrough",
      candidate_sha: candidate,
      effective_verifier_hash: "b".repeat(64),
    },
    domain: "acme",
    engineFingerprint: "c".repeat(64),
    io,
  });
  assert.equal(rebound.ok, true);
  if (!rebound.ok) return;
  assert.equal(rebound.candidateSha, candidate);
  assert.equal(rebound.suiteCommandInvoked, false);
  assert.equal(rebound.evidence?.candidate_sha, candidate);
  assert.ok(observeTesterImplementationRole(rebound.evidence, candidate, 99));
});

test("HEAD movement before the test-fix harness cannot become a no-change retry (#1562 review 2)", async () => {
  const candidate = "a".repeat(40);
  const movedHead = "b".repeat(40);
  let headReads = 0;
  let harnessCalls = 0;
  let testRuns = 0;

  const gate = await runTestGate(
    { ...baseCfg(), test_gate: { ...baseCfg().test_gate, max_attempts: 1 } },
    1562,
    "/wt",
    {
      runTests: async () => {
        testRuns++;
        return { passed: false, output: "FAIL", durationSec: 0.1, toolingError: false };
      },
      invoke: async () => {
        harnessCalls++;
        return okInvoke();
      },
      gitHead: async () => headReads++ === 0 ? candidate : movedHead,
      gitDirty: async () => false,
    },
  );

  assert.equal(gate.passed, false);
  assert.match(gate.blockReason ?? "", /candidate moved before the fix harness ran/);
  assert.equal(testRuns, 1, "movement must block before the retry command runs");
  assert.equal(harnessCalls, 0, "movement before invocation is not harness-owned work");
});

test("HEAD movement during a clean retry blocks without passed Tester evidence (#1562 review 2)", async () => {
  const candidate = "a".repeat(40);
  const movedHead = "b".repeat(40);
  let currentHead = candidate;
  let testRuns = 0;
  let persisted: TesterEvidence | null = null;

  const gate = await runTestGate(
    { ...baseCfg(), test_gate: { ...baseCfg().test_gate, max_attempts: 1 } },
    1562,
    "/wt",
    {
      runTests: async () => {
        testRuns++;
        if (testRuns === 1) {
          return { passed: false, output: "FAIL", durationSec: 0.1, toolingError: false };
        }
        currentHead = movedHead;
        return { passed: true, output: "ok", durationSec: 0.1, toolingError: false };
      },
      invoke: async () => okInvoke(),
      gitHead: async () => currentHead,
      gitDirty: async () => false,
      verifyTestFix: async () => {
        throw new Error("clean no-change retry must not enter commit verification");
      },
      writeTesterEvidence: async (_dest, evidence) => {
        persisted = evidence;
        return { ok: true };
      },
      resolvePinnedEngineIdentity: () => null,
    },
    "1562/2026-09-08T17:23:07Z",
    "test-gate",
    undefined,
    "/runs/1562-moved-during-retry",
  );

  assert.equal(gate.passed, false);
  assert.match(gate.blockReason ?? "", /candidate moved during the clean no-change retry/);
  assert.equal(testRuns, 2);
  assert.equal(persisted?.candidate_sha, movedHead);
  assert.equal(persisted?.overall_status, "unavailable");
});

test("formatted empty test-fix commit cannot produce passed Tester evidence (#1562 review 1)", async () => {
  const candidate = "a".repeat(40);
  const emptyCommit = "b".repeat(40);
  const message =
    "fix: resolve test/build failures (#1562)\n\n" +
    "Issue: #1562\n" +
    "Pipeline-Run: 1562/2026-09-08T17:23:07Z";
  let headReads = 0;
  let testRuns = 0;
  let persisted: TesterEvidence | null = null;

  const gate = await runTestGate(
    { ...baseCfg(), test_gate: { ...baseCfg().test_gate, max_attempts: 1 } },
    1562,
    "/wt",
    {
      runTests: async () => {
        testRuns++;
        return testRuns === 1
          ? { passed: false, output: "FAIL", durationSec: 0.1, toolingError: false }
          : { passed: true, output: "ok", durationSec: 0.1, toolingError: false };
      },
      invoke: async () => okInvoke(),
      gitHead: async () => headReads++ < 4 ? candidate : emptyCommit,
      gitDirty: async () => false,
      verifyTestFix: (wtPath, headBefore) =>
        enforceTestFixCommitFormat(1562, wtPath, headBefore, msgsDeps([message], [])),
      gitCommitMessages: async () => [message],
      writeTesterEvidence: async (_dest, evidence) => {
        persisted = evidence;
        return { ok: true };
      },
      resolvePinnedEngineIdentity: () => null,
    },
    "1562/2026-09-08T17:23:07Z",
    "test-gate",
    undefined,
    "/runs/1562-empty-commit",
  );

  assert.equal(gate.passed, false);
  assert.match(gate.blockReason ?? "", /no candidate-content changes/);
  assert.equal(testRuns, 1, "the empty candidate must block before the retry can pass");
  assert.notEqual(persisted?.overall_status, "passed");
});
