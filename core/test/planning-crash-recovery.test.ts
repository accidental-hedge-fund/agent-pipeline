// Tests for planning crash recovery (#271).
//
// When the advance loop enters dispatchStage() with stage `planning` or
// `plan-review`, those stages are crash-stranded (the per-issue lock is already
// held by the current process — a genuine concurrent run would have failed at
// lock acquisition before reaching dispatch). The dispatcher should:
//   1. Print a one-line recovery diagnostic.
//   2. Roll back the stage to `ready` via `transition()`.
//   3. Restart planning by calling `planningStage.advance()`.
//   4. Return the advance outcome (never `waiting`).
//
// All tests are pure — no real network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals, type PlanningRecoveryDeps } from "../scripts/pipeline.ts";
import type { Outcome, PipelineConfig, Stage } from "../scripts/types.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

const { dispatch } = _internals;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "test-owner/test-repo",
    repo_dir: "/tmp/fake-repo",
    domain: "test-domain",
    base_branch: "main",
    invocation: "pipeline",
  } as unknown as PipelineConfig;
}

const ISSUE = 271;
const OPTS = { dryRun: false };
const RUN_ID = "271-2026-01-01T00:00:00Z";

function makeDeps(planningResult: Outcome): {
  deps: PlanningRecoveryDeps;
  transitionCalls: Array<{ cfg: PipelineConfig; issueNumber: number; from: Stage; to: Stage; msg: string }>;
  planningAdvanceCalls: number;
} {
  const transitionCalls: Array<{ cfg: PipelineConfig; issueNumber: number; from: Stage; to: Stage; msg: string }> = [];
  let planningAdvanceCalls = 0;

  const deps: PlanningRecoveryDeps = {
    transition: async (cfg: PipelineConfig, issueNumber: number, from: Stage, to: Stage, msg: string) => {
      transitionCalls.push({ cfg, issueNumber, from, to, msg });
    },
    planningAdvance: async (_cfg: PipelineConfig, _issueNumber: number, _opts: unknown) => {
      planningAdvanceCalls++;
      return planningResult;
    },
  };

  return { deps, transitionCalls, planningAdvanceCalls: 0, get planningAdvanceCalls() { return planningAdvanceCalls; } };
}

const ADVANCING_OUTCOME: Outcome = {
  advanced: true,
  from: "ready" as Stage,
  to: "review-1" as Stage,
  summary: "planning complete",
};

// ---------------------------------------------------------------------------
// 3.1  Stranded `planning` → restart
// ---------------------------------------------------------------------------

test("planning crash recovery: stranded planning rolls back to ready and restarts", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const trackingDeps: PlanningRecoveryDeps = {
    ...deps,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "planning", OPTS, RUN_ID, undefined, undefined, undefined, trackingDeps);

  assert.equal(out.advanced, true, "outcome should be advancing (not waiting)");
  assert.equal(planningCalled, 1, "planningAdvance should be called once");
  assert.equal(transitionCalls.length, 1, "transition should be called once");
  assert.equal(transitionCalls[0].issueNumber, ISSUE);
  assert.equal(transitionCalls[0].from, "planning");
  assert.equal(transitionCalls[0].to, "ready");
  assert.ok(transitionCalls[0].msg.length > 0, "transition message should be non-empty");
});

// ---------------------------------------------------------------------------
// 3.2  Stranded `plan-review` → restart (identical behavior)
// ---------------------------------------------------------------------------

test("planning crash recovery: stranded plan-review rolls back to ready and restarts", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const trackingDeps: PlanningRecoveryDeps = {
    ...deps,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "plan-review", OPTS, RUN_ID, undefined, undefined, undefined, trackingDeps);

  assert.equal(out.advanced, true, "outcome should be advancing (not waiting)");
  assert.equal(planningCalled, 1, "planningAdvance should be called once");
  assert.equal(transitionCalls.length, 1, "transition should be called once");
  assert.equal(transitionCalls[0].issueNumber, ISSUE);
  assert.equal(transitionCalls[0].from, "plan-review");
  assert.equal(transitionCalls[0].to, "ready");
  assert.ok(transitionCalls[0].msg.length > 0, "transition message should be non-empty");
});

// ---------------------------------------------------------------------------
// 3.3  Regression: `planning` no longer returns `waiting`
// ---------------------------------------------------------------------------

test("planning crash recovery: planning stage never returns waiting outcome", async () => {
  const cfg = makeCfg();
  const { deps } = makeDeps(ADVANCING_OUTCOME);

  const out = await dispatch(cfg, ISSUE, "planning", OPTS, RUN_ID, undefined, undefined, undefined, deps);

  assert.notEqual(
    (out as { status?: string }).status,
    "waiting",
    "planning dispatch must not return waiting — it must recover",
  );
});

// ---------------------------------------------------------------------------
// 3.4  Regression: `plan-review` no longer returns `waiting`
// ---------------------------------------------------------------------------

test("planning crash recovery: plan-review stage never returns waiting outcome", async () => {
  const cfg = makeCfg();
  const { deps } = makeDeps(ADVANCING_OUTCOME);

  const out = await dispatch(cfg, ISSUE, "plan-review", OPTS, RUN_ID, undefined, undefined, undefined, deps);

  assert.notEqual(
    (out as { status?: string }).status,
    "waiting",
    "plan-review dispatch must not return waiting — it must recover",
  );
});

// ---------------------------------------------------------------------------
// Transition args: from must match the starting stranded stage
// ---------------------------------------------------------------------------

test("planning crash recovery: transition called with correct from-stage for planning", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);

  await dispatch(cfg, ISSUE, "planning", OPTS, RUN_ID, undefined, undefined, undefined, deps);

  assert.equal(transitionCalls[0]?.from, "planning");
  assert.equal(transitionCalls[0]?.to, "ready");
});

test("planning crash recovery: transition called with correct from-stage for plan-review", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);

  await dispatch(cfg, ISSUE, "plan-review", OPTS, RUN_ID, undefined, undefined, undefined, deps);

  assert.equal(transitionCalls[0]?.from, "plan-review");
  assert.equal(transitionCalls[0]?.to, "ready");
});

// ---------------------------------------------------------------------------
// Dry-run: transition must NOT be called (#271 review-1 finding)
// ---------------------------------------------------------------------------

test("planning crash recovery: dry-run does not call transition for planning", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const trackingDeps: PlanningRecoveryDeps = {
    ...deps,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "planning", { dryRun: true }, RUN_ID, undefined, undefined, undefined, trackingDeps);

  assert.equal(transitionCalls.length, 0, "dry-run must not call transition for planning");
  assert.equal(planningCalled, 1, "dry-run must still call planningAdvance");
  assert.ok(out !== undefined, "dry-run must return an outcome");
});

test("planning crash recovery: dry-run does not call transition for plan-review", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const trackingDeps: PlanningRecoveryDeps = {
    ...deps,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "plan-review", { dryRun: true }, RUN_ID, undefined, undefined, undefined, trackingDeps);

  assert.equal(transitionCalls.length, 0, "dry-run must not call transition for plan-review");
  assert.equal(planningCalled, 1, "dry-run must still call planningAdvance");
  assert.ok(out !== undefined, "dry-run must return an outcome");
});

// ---------------------------------------------------------------------------
// Cross-domain/worktree guard (#271 review-2 finding 1)
//
// Two processes with different --domain values (different worktree basenames)
// each acquire their own domain-scoped lock.  If process A is actively planning,
// its live-planning marker must prevent process B from treating the planning
// label as crash-stranded and rolling back A's in-flight work.
// ---------------------------------------------------------------------------

test("planning crash recovery: live marker from another domain prevents rollback", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const crossDomainDeps: PlanningRecoveryDeps = {
    ...deps,
    // Simulate another process actively holding the repo-stable marker.
    isLivePlanningActive: (_repo: string, _issueNumber: number) => true,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "planning", OPTS, RUN_ID, undefined, undefined, undefined, crossDomainDeps);

  assert.equal(
    (out as { status?: string }).status,
    "waiting",
    "when live marker is set by another process, dispatch must return waiting",
  );
  assert.equal(transitionCalls.length, 0, "must not roll back when live planning is active");
  assert.equal(planningCalled, 0, "must not call planningAdvance when live planning is active");
});

test("planning crash recovery: live marker from another domain prevents rollback for plan-review", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const crossDomainDeps: PlanningRecoveryDeps = {
    ...deps,
    isLivePlanningActive: (_repo: string, _issueNumber: number) => true,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "plan-review", OPTS, RUN_ID, undefined, undefined, undefined, crossDomainDeps);

  assert.equal(
    (out as { status?: string }).status,
    "waiting",
    "when live marker is set by another process, plan-review dispatch must return waiting",
  );
  assert.equal(transitionCalls.length, 0, "must not roll back when live planning is active");
  assert.equal(planningCalled, 0, "must not call planningAdvance when live planning is active");
});

// ---------------------------------------------------------------------------
// Cross-domain guard for `ready` stage (#271 pre-merge finding)
//
// A domain-B run can reach dispatch with stage=`ready` while domain-A is still
// in the pre-label planning window (label not yet flipped to `planning`).
// The live-planning marker must prevent domain-B from calling planningAdvance
// and starting a second planning arc.
// ---------------------------------------------------------------------------

test("planning crash recovery: ready stage waits when tryAcquire fails (live marker held)", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const crossDomainDeps: PlanningRecoveryDeps = {
    ...deps,
    // Simulate atomic acquire failing because another process holds the marker
    tryAcquireLivePlanningMarker: (_repo: string, _issueNumber: number) => false,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "ready", OPTS, RUN_ID, undefined, undefined, undefined, crossDomainDeps);

  assert.equal(
    (out as { status?: string }).status,
    "waiting",
    "ready dispatch must return waiting when tryAcquire returns false",
  );
  assert.equal(transitionCalls.length, 0, "must not call transition when acquire fails");
  assert.equal(planningCalled, 0, "must not call planningAdvance when acquire fails");
});

test("planning crash recovery: ready stage proceeds when tryAcquire succeeds", async () => {
  const cfg = makeCfg();
  const { deps } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const acquiredDeps: PlanningRecoveryDeps = {
    ...deps,
    tryAcquireLivePlanningMarker: (_repo: string, _issueNumber: number) => true,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "ready", OPTS, RUN_ID, undefined, undefined, undefined, acquiredDeps);

  assert.equal(out.advanced, true, "ready dispatch must advance when tryAcquire succeeds");
  assert.equal(planningCalled, 1, "planningAdvance must be called when marker is acquired");
});

test("planning crash recovery: absent live marker still triggers recovery (crash-stranded path)", async () => {
  const cfg = makeCfg();
  const { deps, transitionCalls } = makeDeps(ADVANCING_OUTCOME);
  let planningCalled = 0;
  const noliveMarkerDeps: PlanningRecoveryDeps = {
    ...deps,
    // Explicitly return false: no live process, marker is absent/stale.
    isLivePlanningActive: (_repo: string, _issueNumber: number) => false,
    planningAdvance: async (c, n, o) => {
      planningCalled++;
      return deps.planningAdvance(c, n, o);
    },
  };

  const out = await dispatch(cfg, ISSUE, "planning", OPTS, RUN_ID, undefined, undefined, undefined, noliveMarkerDeps);

  assert.equal(out.advanced, true, "absent live marker must trigger recovery and advance");
  assert.equal(transitionCalls.length, 1, "must call transition to roll back to ready");
  assert.equal(planningCalled, 1, "must call planningAdvance to restart");
});
