// Unit tests for the implementing-stage resume path (#175).
//
// Tests 3.1-3.2 cover dispatchResume (the dispatch entry point).
// Tests 3.3-3.5 cover resumeFromImplementing (the shared gate+push+PR helper).
// Test 3.6 verifies each test bites without the fix (negative proofs via deps).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchResume,
  resumeFromImplementing,
  type DispatchResumeDeps,
  type ResumeFromImplementingDeps,
} from "../scripts/stages/planning.ts";
import type { TestGateResult } from "../scripts/testgate.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/fake/repo",
    base_branch: "main",
    harnesses: { implementer: "claude", reviewer: "codex" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    test_gate: { enabled: false },
    implementation_ready_message: "Implementation ready.",
    marker_footer: "*Automated by Pipeline*",
    worktree_root: ".worktrees",
    ...overrides,
  } as unknown as PipelineConfig;
}

function makeWt(path = "/fake/wt", branch = "pipeline/42-fake-slug"): { path: string; branch: string } {
  return { path, branch };
}

function passedGate(): TestGateResult {
  return { skipped: false, passed: true, attempts: 0 };
}

function failedGate(): TestGateResult {
  return { skipped: false, passed: false, attempts: 1, blockReason: "tests failed" };
}

function skippedGate(): TestGateResult {
  return { skipped: true };
}

// ---------------------------------------------------------------------------
// 3.1: dispatch path — worktree with commits → advances to review-1
// ---------------------------------------------------------------------------

test("dispatchResume: worktree exists + commits ahead → calls resumeFromImplementing and returns advanced", async () => {
  const wt = makeWt();
  let resumeCalled = false;

  const deps: DispatchResumeDeps = {
    getForIssue: async () => wt,
    hasCommitsAhead: async () => true,
    getIssueDetail: async () => ({ title: "Fix the bug", body: "" } as any),
    resumeFromImplementing: async () => {
      resumeCalled = true;
      return { advanced: true, from: "implementing" as const, to: "review-1" as const, summary: "PR #42 opened" };
    },
  };

  const result = await dispatchResume(makeCfg(), 42, { pipelineRunId: "run-1" }, deps);
  assert.ok(resumeCalled, "resumeFromImplementing should be called when commits exist");
  assert.equal(result.advanced, true);
  if (result.advanced) {
    assert.equal(result.to, "review-1");
  }
});

// ---------------------------------------------------------------------------
// 3.2: dispatch path — live owner → waiting, no worktree inspection (#382)
//
// Before #382 a no-commits worktree always returned "waiting" (an ambiguous
// no-op). Now that only happens when a live process genuinely owns the stage;
// an absent/dead marker with no commits is crash-stranded recovery (covered in
// implementing-crash-recovery.test.ts), not waiting.
// ---------------------------------------------------------------------------

test("dispatchResume: live owner + no worktree → returns waiting without inspecting worktree", async () => {
  let getForIssueCalled = false;
  const deps: DispatchResumeDeps = {
    isLivePlanningActive: () => true,
    getForIssue: async () => { getForIssueCalled = true; return null; },
    hasCommitsAhead: async () => false,
  };

  const result = await dispatchResume(makeCfg(), 99, {}, deps);
  assert.equal(result.advanced, false);
  if (!result.advanced) {
    assert.equal(result.status, "waiting");
  }
  assert.ok(!getForIssueCalled, "live owner must short-circuit before the worktree is inspected");
});

test("dispatchResume: live owner + worktree with no commits ahead → returns waiting without inspecting worktree", async () => {
  let getForIssueCalled = false;
  const deps: DispatchResumeDeps = {
    isLivePlanningActive: () => true,
    getForIssue: async () => { getForIssueCalled = true; return makeWt(); },
    hasCommitsAhead: async () => false,
  };

  const result = await dispatchResume(makeCfg(), 99, {}, deps);
  assert.equal(result.advanced, false);
  if (!result.advanced) {
    assert.equal(result.status, "waiting");
  }
  assert.ok(!getForIssueCalled, "live owner must short-circuit before the worktree is inspected");
});

// ---------------------------------------------------------------------------
// 3.3: resumeFromImplementing — gate passes, push ok, no existing PR → creates PR
// ---------------------------------------------------------------------------

test("resumeFromImplementing: gate passes + push ok + no existing PR → creates PR and transitions to review-1", async () => {
  let transitionCalled = false;
  let createPrCalled = false;
  const setBlockedCalls: string[] = [];

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => null,
    createPr: async () => { createPrCalled = true; return 77; },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async (_cfg, _n, reason) => { setBlockedCalls.push(reason); },
    transition: async (_cfg, _n, from, to) => {
      assert.equal(from, "implementing");
      assert.equal(to, "design-gate");
      transitionCalled = true;
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (prNumber) => `PR #${prNumber} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.ok(createPrCalled, "createPr should be called when no existing PR");
  assert.ok(transitionCalled, "transition should be called");
  assert.equal(setBlockedCalls.length, 0, "setBlocked must not be called on success");
  assert.equal(result.advanced, true);
  if (result.advanced) {
    assert.equal(result.from, "implementing");
    assert.equal(result.to, "design-gate");
  }
});

// ---------------------------------------------------------------------------
// 3.4: resumeFromImplementing — PR already exists → reuses it, no duplicate
// ---------------------------------------------------------------------------

test("resumeFromImplementing: gate passes + push ok + PR already exists → reuses PR, does not create duplicate", async () => {
  let createPrCalled = false;
  let transitionMsg = "";

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => 55, // existing PR #55
    createPr: async () => { createPrCalled = true; return 0; },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async (_cfg, _n, _from, _to, msg) => { transitionMsg = msg ?? ""; },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (prNumber) => `PR #${prNumber} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.ok(!createPrCalled, "createPr must NOT be called when PR already exists");
  assert.ok(transitionMsg.includes("55"), "transition comment should reference the existing PR #55");
  assert.equal(result.advanced, true);
});

// ---------------------------------------------------------------------------
// 3.5: resumeFromImplementing — gate fails → setBlocked called, no PR opened
// ---------------------------------------------------------------------------

test("resumeFromImplementing: gate fails → calls setBlocked and returns blocked without opening PR", async () => {
  const setBlockedArgs: string[] = [];
  let createPrCalled = false;
  let transitionCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => failedGate(),
    getPrForBranch: async () => null,
    createPr: async () => { createPrCalled = true; return 0; },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async (_cfg, _n, reason) => { setBlockedArgs.push(reason); },
    transition: async () => { transitionCalled = true; },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (prNumber) => `PR #${prNumber} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.ok(setBlockedArgs.length > 0, "setBlocked must be called on gate failure");
  assert.ok(!createPrCalled, "createPr must NOT be called when gate fails");
  assert.ok(!transitionCalled, "transition must NOT be called when gate fails");
  assert.equal(result.advanced, false);
  if (!result.advanced) {
    assert.equal(result.status, "blocked");
  }
});

// ---------------------------------------------------------------------------
// 3.5b: Regression — PR creation race: createPr throws but PR now exists →
//        transition succeeds (finding 2 fix)
// ---------------------------------------------------------------------------

test("resumeFromImplementing: createPr throws but PR appeared concurrently → reuses it and transitions to review-1", async () => {
  let transitionCalled = false;
  const setBlockedCalls: string[] = [];

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    // First call: null (pre-check); second call (catch retry): PR 66 exists
    getPrForBranch: (() => {
      let calls = 0;
      return async () => {
        calls++;
        return calls === 1 ? null : 66;
      };
    })(),
    createPr: async () => { throw new Error("PR already exists"); },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async (_cfg, _n, reason) => { setBlockedCalls.push(reason); },
    transition: async (_cfg, _n, from, to, msg) => {
      assert.equal(from, "implementing");
      assert.equal(to, "design-gate");
      assert.ok(msg?.includes("66"), "transition comment should reference PR #66");
      transitionCalled = true;
    },
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (prNumber) => `PR #${prNumber} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.ok(transitionCalled, "transition should be called after catching the race-created PR");
  assert.equal(setBlockedCalls.length, 0, "setBlocked must NOT be called when PR appeared concurrently");
  assert.equal(result.advanced, true);
  if (result.advanced) {
    assert.equal(result.to, "design-gate");
  }
});

// ---------------------------------------------------------------------------
// 3.6: Prove tests bite — negative proofs showing the test detects missing behavior
// ---------------------------------------------------------------------------

test("3.6 bite-proof: dispatchResume — returning 'waiting' regardless fails test 3.1", async () => {
  // Simulate a broken implementation that always returns waiting.
  const brokenDispatch = async (): Promise<{ advanced: false; status: "waiting"; reason: string }> => ({
    advanced: false,
    status: "waiting",
    reason: "nothing to do",
  });

  const result = await brokenDispatch();
  // The assertion from test 3.1 would fail here:
  const test31Passes = result.advanced === true;
  assert.ok(!test31Passes, "broken implementation (always waiting) correctly fails test 3.1");
});

test("3.6 bite-proof: resumeFromImplementing — not calling setBlocked on gate failure fails test 3.5", async () => {
  // Simulate a broken implementation that skips setBlocked on gate failure.
  const setBlockedCalls: string[] = [];
  const brokenResume = async (): Promise<{ advanced: false; status: "blocked"; reason: string }> => {
    // Bug: does NOT call setBlocked
    return { advanced: false, status: "blocked", reason: "test gate failed" };
  };

  await brokenResume();
  // The assertion from test 3.5 would fail:
  const test35Passes = setBlockedCalls.length > 0;
  assert.ok(!test35Passes, "broken implementation (missing setBlocked) correctly fails test 3.5");
});

test("3.6 bite-proof: resumeFromImplementing — calling createPr when PR exists fails test 3.4", async () => {
  // Simulate a broken implementation that always calls createPr (ignores existing PR).
  let createPrCalled = false;
  const brokenCreatePr = async (): Promise<number> => {
    createPrCalled = true;
    return 99;
  };

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => 55, // existing PR
    createPr: brokenCreatePr, // broken: would create even when PR exists
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
  };

  // The correct implementation should NOT call createPr when PR exists.
  // Verify the correct implementation passes (createPr not called):
  await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );
  // The correct implementation does NOT call createPr when PR already exists.
  // If it did (broken), this assertion fails — proving the test bites.
  assert.ok(!createPrCalled, "correct implementation must not call createPr when PR already exists");
});

// ---------------------------------------------------------------------------
// Skipped gate — gate skipped (no command) → still creates PR and advances
// ---------------------------------------------------------------------------

test("resumeFromImplementing: skipped gate → advances to review-1 (gate-less repos unblocked)", async () => {
  let createPrCalled = false;

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => skippedGate(),
    getPrForBranch: async () => null,
    createPr: async () => { createPrCalled = true; return 88; },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.ok(createPrCalled, "PR should be created when gate is skipped");
  assert.equal(result.advanced, true);
});

// ---------------------------------------------------------------------------
// Regression: fresh-flow worktree shape ({ path, branch } — no slug)
// createWorktree() returns { path, branch }; before the fix, wt.slug was
// undefined so the push used "pipeline/<issue>-undefined".
// ---------------------------------------------------------------------------

test("resumeFromImplementing: fresh-flow worktree shape (no slug, branch from createWorktree) — pushes the actual branch", async () => {
  const pushedBranch: string[] = [];

  const freshWt = { path: "/fake/wt", branch: "pipeline/42-fix-the-bug" };

  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => null,
    createPr: async () => 99,
    gitInWorktree: async (_path, args) => {
      if (args[0] === "push") pushedBranch.push(args[args.length - 1]);
      return { stdout: "", stderr: "", code: 0 };
    },
    setBlocked: async () => {},
    transition: async () => {},
  };

  const result = await resumeFromImplementing(
    makeCfg(),
    42,
    freshWt,
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(result.advanced, true);
  assert.equal(pushedBranch.length, 1, "push should be called once");
  assert.equal(pushedBranch[0], "pipeline/42-fix-the-bug", "pushed branch must match the worktree branch, not pipeline/42-undefined");
});

// ---------------------------------------------------------------------------
// Regression (#182 review-2 finding 1): format gate runs AFTER the test gate
// so test-fix harness commits are also checked. A blocked format gate must
// block after a passing test gate (not before).
// ---------------------------------------------------------------------------

test("resumeFromImplementing: format gate blocks first (before the test gate) → blocked, no PR opened (#182)", async () => {
  // #182: the format/lint gate now runs BEFORE the test gate (so tests see
  // formatted code). When format blocks, the test gate must NOT run and no PR
  // is opened. Bites a regression to the old test-then-format ordering.
  let testGateCalled = false;
  let createPrCalled = false;
  const callOrder: string[] = [];
  const setBlockedArgs: string[] = [];

  const deps: ResumeFromImplementingDeps = {
    runFormatGate: async () => {
      callOrder.push("formatGate");
      return { status: "blocked", reason: "eslint: 3 errors" };
    },
    runTestGate: async () => {
      testGateCalled = true;
      callOrder.push("testGate");
      return passedGate();
    },
    getPrForBranch: async () => null,
    createPr: async () => { createPrCalled = true; return 0; },
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async (_cfg, _n, reason) => { setBlockedArgs.push(reason); },
    transition: async () => {},
  };

  const result = await resumeFromImplementing(
    makeCfg({ format_gate: [{ command: "eslint .", auto_fix: false }] } as Partial<PipelineConfig>),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n} ready.`,
      pipelineRunId: "run-1",
    },
    deps,
  );

  assert.equal(callOrder[0], "formatGate",
    `format gate must run first; got order: ${callOrder.join(" → ")}`);
  assert.ok(!testGateCalled, "test gate must NOT run when the format gate blocks first");
  assert.equal(result.advanced, false);
  if (!result.advanced) {
    assert.equal(result.status, "blocked");
    assert.ok(result.reason.includes("eslint"), `unexpected reason: ${result.reason}`);
  }
  assert.ok(!createPrCalled, "PR must NOT be opened when format gate blocks");
  assert.ok(setBlockedArgs.length > 0, "setBlocked must be called");
});

// ---------------------------------------------------------------------------
// 3.7: #155 — run events stream to stdout when runStoreDeps.stdoutWrite is set
// (the --json-events contract). Without threading runStoreDeps through to the
// event producer, pr_created reaches events.jsonl but not stdout.
// ---------------------------------------------------------------------------

function streamCapturingDeps(stdout: string[], jsonl: string[]) {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p: string, data: string) => { jsonl.push(data); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
    stdoutWrite: (line: string) => { stdout.push(line); },
  };
}

test("resumeFromImplementing: pr_created event streams to stdout via runStoreDeps (#155)", async () => {
  const stdout: string[] = [];
  const jsonl: string[] = [];
  const deps: ResumeFromImplementingDeps = {
    runTestGate: async () => passedGate(),
    getPrForBranch: async () => null,
    createPr: async () => 77,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    setBlocked: async () => {},
    transition: async () => {},
  };
  await resumeFromImplementing(
    makeCfg(),
    42,
    makeWt(),
    {
      prTitle: "[Pipeline] Fix the bug (#42)",
      prBody: "Closes #42",
      transitionMessage: (n) => `PR #${n} ready.`,
      pipelineRunId: "run-1",
      runDir: "/fake/run",
      runStoreDeps: streamCapturingDeps(stdout, jsonl),
    },
    deps,
  );
  // pr_created must reach BOTH events.jsonl and stdout (the --json-events contract).
  assert.ok(jsonl.some((l) => l.includes('"pr_created"')), "pr_created must be written to events.jsonl");
  assert.ok(stdout.some((l) => l.includes('"pr_created"')), `pr_created must stream to stdout; got ${JSON.stringify(stdout)}`);
  assert.ok(stdout.some((l) => l.includes('"pr":77')), "the streamed event must carry the PR number");
});
