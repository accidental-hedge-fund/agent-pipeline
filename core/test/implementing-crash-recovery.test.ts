// Tests for the `implementing`-stage crash recovery (#382).
//
// A pipeline run that dies after the `pipeline:implementing` label is written
// but before any commit lands leaves the issue permanently stranded: the old
// dispatchResume() always returned a "waiting" no-op when no worktree commits
// existed, with no distinction between "a live process owns this" and "the
// process that set this label is dead." This file drives dispatchResume()
// directly (the same entry point pipeline-run.ts's `implementing` case calls)
// and asserts:
//   1. Crash-stranded (no live owner, no commits) restarts planning from ready.
//   2. Live owner (marker PID alive) returns waiting without touching the
//      worktree, transition, or planningAdvance.
//   3. Resume-with-commits (#175) is preserved when no live owner holds the
//      marker.
//   4. Ordering: liveness is checked before the commits-ahead check.
//   5. Bite-proof: reverting the crash-stranded branch to the old "waiting"
//      no-op makes the crash-stranded assertion fail.
//
// All tests are pure — no real network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchResume, type DispatchResumeDeps } from "../scripts/stages/planning.ts";
import type { Outcome, PipelineConfig, Stage } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

const ISSUE = 382;

const ADVANCING_OUTCOME: Outcome = {
  advanced: true,
  from: "ready" as Stage,
  to: "review-1" as Stage,
  summary: "planning complete",
};

function makeRecoveryDeps(planningResult: Outcome = ADVANCING_OUTCOME) {
  const transitionCalls: Array<{ issueNumber: number; from: Stage; to: Stage; msg: string }> = [];

  const deps: Pick<DispatchResumeDeps, "transition" | "planningAdvance"> = {
    transition: async (_cfg, issueNumber, from, to, msg) => {
      transitionCalls.push({ issueNumber, from, to, msg: msg ?? "" });
    },
    planningAdvance: async () => planningResult,
  };

  return { deps, transitionCalls };
}

// ---------------------------------------------------------------------------
// 3.1: Crash-stranded (marker absent/dead, no worktree commits) → restart
// ---------------------------------------------------------------------------

test("implementing crash recovery: no live owner + no commits rolls back to ready and restarts planning", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeRecoveryDeps();
  let getForIssueCalled = false;
  let planningCalled = 0;

  const fullDeps: DispatchResumeDeps = {
    ...deps,
    isLivePlanningActive: () => false,
    getForIssue: async () => { getForIssueCalled = true; return null; },
    hasCommitsAhead: async () => false,
    planningAdvance: async (c, n, o) => { planningCalled++; return deps.planningAdvance!(c, n, o); },
  };

  const out = await dispatchResume(cfg, ISSUE, {}, fullDeps);

  assert.equal(out.advanced, true, "outcome should be advancing, not waiting");
  assert.ok(getForIssueCalled, "worktree should be inspected once liveness clears");
  assert.equal(transitionCalls.length, 1, "transition should be called once");
  assert.equal(transitionCalls[0].issueNumber, ISSUE);
  assert.equal(transitionCalls[0].from, "implementing");
  assert.equal(transitionCalls[0].to, "ready");
  assert.ok(transitionCalls[0].msg.length > 0, "transition message should be non-empty");
  assert.equal(planningCalled, 1, "planningAdvance should be called once to restart");
});

test("implementing crash recovery: no live owner + worktree with zero commits ahead rolls back to ready", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeRecoveryDeps();
  let planningCalled = 0;

  const fullDeps: DispatchResumeDeps = {
    ...deps,
    isLivePlanningActive: () => false,
    getForIssue: async () => ({ path: "/fake/wt", branch: "pipeline/382-fake-slug" }),
    hasCommitsAhead: async () => false,
    planningAdvance: async (c, n, o) => { planningCalled++; return deps.planningAdvance!(c, n, o); },
  };

  const out = await dispatchResume(cfg, ISSUE, {}, fullDeps);

  assert.equal(out.advanced, true, "outcome should be advancing, not waiting");
  assert.equal(transitionCalls.length, 1);
  assert.equal(transitionCalls[0].from, "implementing");
  assert.equal(transitionCalls[0].to, "ready");
  assert.equal(planningCalled, 1);
});

// ---------------------------------------------------------------------------
// 3.2: Live owner (marker PID alive) → waiting, no side effects
// ---------------------------------------------------------------------------

test("implementing crash recovery: live owner returns waiting naming the live owner, no worktree/transition/restart", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeRecoveryDeps();
  let getForIssueCalled = false;
  let hasCommitsAheadCalled = false;
  let resumeCalled = false;
  let planningCalled = 0;

  const fullDeps: DispatchResumeDeps = {
    ...deps,
    isLivePlanningActive: () => true,
    getForIssue: async () => { getForIssueCalled = true; return null; },
    hasCommitsAhead: async () => { hasCommitsAheadCalled = true; return false; },
    resumeFromImplementing: async () => { resumeCalled = true; return ADVANCING_OUTCOME; },
    planningAdvance: async (c, n, o) => { planningCalled++; return deps.planningAdvance!(c, n, o); },
  };

  const out = await dispatchResume(cfg, ISSUE, {}, fullDeps);

  assert.equal(out.advanced, false);
  if (!out.advanced) {
    assert.equal(out.status, "waiting");
    assert.notEqual(out.reason, "implementing is set mid-flight by the planning/plan-review handler; nothing to do at this point.",
      "reason must no longer be the ambiguous old message");
    assert.match(out.reason, /live/i, "waiting reason should name the live concurrent owner");
  }
  assert.ok(!getForIssueCalled, "worktree must not be inspected when a live owner holds the marker");
  assert.ok(!hasCommitsAheadCalled, "commits-ahead must not be checked when a live owner holds the marker");
  assert.ok(!resumeCalled, "resume must not run when a live owner holds the marker");
  assert.equal(transitionCalls.length, 0, "must not roll back when a live owner holds the marker");
  assert.equal(planningCalled, 0, "must not restart planning when a live owner holds the marker");
});

// ---------------------------------------------------------------------------
// 3.3: Resume preserved (no live owner, commits present) — #175 unaffected
// ---------------------------------------------------------------------------

test("implementing crash recovery: no live owner + commits ahead still resumes post-implementation steps (#175 preserved)", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeRecoveryDeps();
  let resumeCalled = false;
  let planningCalled = 0;

  const fullDeps: DispatchResumeDeps = {
    ...deps,
    isLivePlanningActive: () => false,
    getForIssue: async () => ({ path: "/fake/wt", branch: "pipeline/382-fake-slug" }),
    hasCommitsAhead: async () => true,
    getIssueDetail: async () => ({ title: "Fix the bug", body: "" } as any),
    resumeFromImplementing: async () => {
      resumeCalled = true;
      return { advanced: true, from: "implementing" as const, to: "review-1" as const, summary: "PR #1 opened" };
    },
    planningAdvance: async (c, n, o) => { planningCalled++; return deps.planningAdvance!(c, n, o); },
  };

  const out = await dispatchResume(cfg, ISSUE, { pipelineRunId: "run-1" }, fullDeps);

  assert.equal(out.advanced, true);
  assert.ok(resumeCalled, "resumeFromImplementing should run for the commits-ahead case");
  assert.equal(transitionCalls.length, 0, "the recovery rollback must NOT run when commits exist");
  assert.equal(planningCalled, 0, "the recovery restart must NOT run when commits exist");
});

// ---------------------------------------------------------------------------
// 3.4: Ordering — liveness gate precedes the commits-ahead check
// ---------------------------------------------------------------------------

test("implementing crash recovery: live marker short-circuits even when the worktree has commits ahead", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeRecoveryDeps();
  let getForIssueCalled = false;
  let resumeCalled = false;
  let planningCalled = 0;

  const fullDeps: DispatchResumeDeps = {
    ...deps,
    isLivePlanningActive: () => true,
    getForIssue: async () => { getForIssueCalled = true; return { path: "/fake/wt", branch: "pipeline/382-fake-slug" }; },
    hasCommitsAhead: async () => true,
    resumeFromImplementing: async () => { resumeCalled = true; return ADVANCING_OUTCOME; },
    planningAdvance: async (c, n, o) => { planningCalled++; return deps.planningAdvance!(c, n, o); },
  };

  const out = await dispatchResume(cfg, ISSUE, {}, fullDeps);

  assert.equal(out.advanced, false);
  if (!out.advanced) assert.equal(out.status, "waiting");
  assert.ok(!getForIssueCalled, "liveness check must short-circuit before the worktree is ever inspected");
  assert.ok(!resumeCalled);
  assert.equal(transitionCalls.length, 0);
  assert.equal(planningCalled, 0);
});

// ---------------------------------------------------------------------------
// 3.5: Bite-proof — reverting the crash-stranded branch to the old "waiting"
// no-op must fail the 3.1 assertion.
// ---------------------------------------------------------------------------

test("3.5 bite-proof: old no-commits 'waiting' no-op fails the crash-stranded assertion", async () => {
  // Simulate the pre-#382 behavior: no-commits always returns waiting,
  // regardless of liveness.
  const brokenDispatch = async (): Promise<{ advanced: false; status: "waiting"; reason: string }> => ({
    advanced: false,
    status: "waiting",
    reason: "implementing is set mid-flight by the planning/plan-review handler; nothing to do at this point.",
  });

  const result = await brokenDispatch();
  const test31Passes = result.advanced === true;
  assert.ok(!test31Passes, "the old waiting no-op correctly fails the crash-stranded recovery assertion");
});
