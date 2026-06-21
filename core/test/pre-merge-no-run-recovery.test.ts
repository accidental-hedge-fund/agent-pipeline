// Tests for the CI no-run recovery path (#281).
//
// When GitHub Actions never fires a run for the PR head SHA (common after an
// archive-only commit that didn't re-trigger the pull_request event), the gate
// used to poll until ci_timeout. This suite proves the recovery path fires
// after the grace window and routes correctly based on the diff shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  advancePolling,
  type AdvancePreMergeDeps,
  type PreMergePollingContext,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const SHA_HEAD = "aaaa000000000000000000000000000000000000";
const SHA_PRE_ARCHIVE = "bbbb000000000000000000000000000000000000";
const PR_NUMBER = 42;

/** Minimal cfg covering the CI-gate and no-run paths. */
function makeCfg(graceS = 60): PipelineConfig {
  return {
    ci_no_run_grace_s: graceS,
    ci_timeout: 3600,
    ci_poll_interval: 0,
    eval_gate: { enabled: false },
    shipcheck_gate: { enabled: false },
    steps: { docs: false },
  } as unknown as PipelineConfig;
}

/** Review comment that satisfies the SHA gate for SHA_HEAD. */
const APPROVE_COMMENT = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

/** Base deps that satisfy everything except CI pending → caller customises getPrChecks / getHeadCheckRunCount. */
function baseDeps(): AdvancePreMergeDeps {
  return {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [{ body: APPROVE_COMMENT, author: "test-actor", createdAt: "2024-01-01T00:00:00Z" }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      ({
        head_sha: SHA_HEAD,
        mergeable: true,
        mergeable_state: "CLEAN",
      }) as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>,
    getPrCommits: async () => [],
    getPrDiff: async () => "diff",
    getForIssue: async () => null,
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getGhActor: async () => "test-actor",
    // No worktree → archive skips.
    openspecIsActive: () => false,
    closePr: async () => {},
    reopenPr: async () => {},
  };
}

// ---------------------------------------------------------------------------
// advance() unit tests: grace window and zero-run check
// ---------------------------------------------------------------------------

test("pre-merge no-run: grace window not elapsed → getHeadCheckRunCount NOT called (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let countCalls = 0;
  let nowValue = 0;

  const ctx: PreMergePollingContext = { ciGateEnteredAt: undefined, preArchiveSha: SHA_PRE_ARCHIVE };
  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async () => { countCalls++; return 0; },
    nowMs: () => nowValue,
  };

  // ci_no_run_grace_s = 60: grace is 60 000 ms. nowValue stays at 0 throughout.
  // ciGateEnteredAt will be set to 0; elapsed = 0 - 0 = 0 < 60 000 → no query.
  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "waiting");
  assert.equal(out.reason, "CI still running");
  assert.equal(countCalls, 0, "getHeadCheckRunCount must NOT be called before grace window");
  assert.ok(ctx.ciGateEnteredAt !== undefined, "ciGateEnteredAt should be set after first CI-pending encounter");
});

test("pre-merge no-run: grace window elapsed, zero runs, archive-only diff + prior SHA green → close+reopen then waiting (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let closedPr: number | undefined;
  let reopenedPr: number | undefined;
  let blockedReason: string | undefined;

  // Simulate grace already elapsed: ciGateEnteredAt was 0, nowMs returns 61 000.
  const ctx: PreMergePollingContext = {
    ciGateEnteredAt: 0,
    preArchiveSha: SHA_PRE_ARCHIVE,
  };

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async (_cfg, sha) => {
      // current HEAD has 0 runs; pre-archive SHA has 3 runs (prior green)
      return sha === SHA_HEAD ? 0 : 3;
    },
    getDiffFilePaths: async () => ["openspec/changes/foo/spec.md", "openspec/specs/bar.md"],
    closePr: async (_cfg, n) => { closedPr = n; },
    reopenPr: async (_cfg, n) => { reopenedPr = n; },
    setBlocked: async (_cfg, _n, reason) => { blockedReason = reason; },
    nowMs: () => 61_000, // 61 s past epoch → elapsed = 61 000 - 0 = 61 000 ≥ 60 000
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "waiting");
  assert.equal(out.reason, "no CI run detected; closed and reopened PR to re-fire CI");
  assert.equal(closedPr, PR_NUMBER, "closePr must be called with the PR number");
  assert.equal(reopenedPr, PR_NUMBER, "reopenPr must be called with the PR number");
  assert.equal(blockedReason, undefined, "setBlocked must NOT be called on successful recovery");
  assert.equal(ctx.noRunRecoveryAttemptedForSha, SHA_HEAD, "noRunRecoveryAttemptedForSha must be set after recovery");
});

test("pre-merge no-run: second zero-count poll for the same SHA after recovery → block, no second close+reopen (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let closeCalls = 0;
  let blockedReason: string | undefined;

  // Simulate recovery already attempted on a prior poll.
  const ctx: PreMergePollingContext = {
    ciGateEnteredAt: 0,
    preArchiveSha: SHA_PRE_ARCHIVE,
    noRunRecoveryAttemptedForSha: SHA_HEAD, // already attempted
  };

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async () => 0,
    getDiffFilePaths: async () => ["openspec/changes/foo/spec.md"],
    closePr: async () => { closeCalls++; },
    reopenPr: async () => {},
    setBlocked: async (_cfg, _n, reason) => { blockedReason = reason; },
    nowMs: () => 61_000,
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "blocked");
  assert.equal(closeCalls, 0, "closePr must NOT be called again after recovery already attempted");
  assert.ok(blockedReason?.includes("recovery was already attempted"), "block reason must mention prior recovery attempt");
});

test("pre-merge no-run: zero runs, non-archive diff → block with actionable message, no close+reopen (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let closeCalls = 0;
  let blockedReason: string | undefined;

  const ctx: PreMergePollingContext = {
    ciGateEnteredAt: 0,
    preArchiveSha: SHA_PRE_ARCHIVE,
  };

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async () => 0,
    getDiffFilePaths: async () => ["openspec/changes/foo/spec.md", "core/scripts/gh.ts"], // non-openspec file
    closePr: async () => { closeCalls++; },
    setBlocked: async (_cfg, _n, reason) => { blockedReason = reason; },
    nowMs: () => 61_000,
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "blocked");
  assert.equal(closeCalls, 0, "closePr must NOT be called for non-archive diff");
  assert.ok(blockedReason?.includes("try closing and reopening"), "block reason must include manual recovery suggestion");
});

test("pre-merge no-run: check-runs count > 0 → no recovery, still waiting (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let closeCalls = 0;
  let countCalls = 0;

  const ctx: PreMergePollingContext = { ciGateEnteredAt: 0 };

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async () => { countCalls++; return 2; }, // runs exist
    closePr: async () => { closeCalls++; },
    nowMs: () => 61_000,
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "waiting");
  assert.equal(out.reason, "CI still running");
  assert.equal(closeCalls, 0, "closePr must NOT be called when check-runs > 0");
  assert.equal(countCalls, 1, "getHeadCheckRunCount should be called once (after grace elapsed)");
});

test("pre-merge no-run: normal CI (agg.pending = false) → unaffected, advances normally (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let countCalls = 0;

  const ctx: PreMergePollingContext = {};

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pass", state: "success" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async () => { countCalls++; return 1; },
    transition: async () => {},
    nowMs: () => 99_000,
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.advanced, true, "must advance when CI passes");
  assert.equal(countCalls, 0, "getHeadCheckRunCount must NOT be called when CI is not pending");
});

test("pre-merge no-run: close+reopen throws → block with failure detail (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let blockedReason: string | undefined;

  const ctx: PreMergePollingContext = {
    ciGateEnteredAt: 0,
    preArchiveSha: SHA_PRE_ARCHIVE,
  };

  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>,
    getHeadCheckRunCount: async (_cfg, sha) => sha === SHA_HEAD ? 0 : 5,
    getDiffFilePaths: async () => ["openspec/specs/bar.md"],
    closePr: async () => { throw new Error("gh: PR not found"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReason = reason; },
    nowMs: () => 61_000,
  };

  const out = await advance(makeCfg(60), 281, { pollingCtx: ctx }, deps);

  assert.equal(out.status, "blocked");
  assert.ok(blockedReason?.includes("close+reopen recovery failed"), "block reason must include failure detail");
  assert.ok(blockedReason?.includes("PR not found"), "block reason must include the underlying error");
});

// ---------------------------------------------------------------------------
// advancePolling regression: grace window persists across multiple polls (#281)
//
// Key assertion: getHeadCheckRunCount is NOT called on the first poll (grace
// not yet elapsed) and IS called on the second poll (grace elapsed). This proves
// the grace window is measured from the first CI-pending encounter across polls,
// not reset on each advance() call.
// ---------------------------------------------------------------------------

test("advancePolling: grace window spans multiple polls — getHeadCheckRunCount queried only after grace elapsed (#281)", async (t) => {
  t.mock.method(console, "log", () => {});

  let nowValue = 0; // fake clock starts at epoch
  let countCalls = 0;
  let pollCount = 0;
  let closedPr: number | undefined;

  // ci_no_run_grace_s = 60: poll 1 sets ciGateEnteredAt = 0; elapsed = 0 → no query.
  // sleepMs advances the fake clock past the grace window.
  // Poll 2: elapsed = 61 000 - 0 = 61 000 ≥ 60 000 → query fires, zero runs → close+reopen.
  // Poll 3: zero runs again, recovery already attempted → block. advancePolling returns.
  //
  // preArchiveSha is pre-seeded (SHA_PRE_ARCHIVE ≠ SHA_HEAD) so handleZeroRunRecovery
  // takes the archive-only + prior-green path and calls close+reopen.
  const deps: AdvancePreMergeDeps = {
    ...baseDeps(),
    getPrChecks: async () => {
      pollCount++;
      return [{ name: "ci", bucket: "pending", state: "pending" }] as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>>;
    },
    getHeadCheckRunCount: async (_cfg, sha) => {
      countCalls++;
      return sha === SHA_HEAD ? 0 : 3; // HEAD has 0 runs; pre-archive SHA has 3 (prior green)
    },
    getDiffFilePaths: async () => ["openspec/specs/bar.md"],
    closePr: async (_cfg, n) => { closedPr = n; },
    reopenPr: async () => {},
    nowMs: () => nowValue,
    sleepMs: async () => {
      // Advance the clock past the grace window on each sleep call.
      nowValue = 61_000;
    },
  };

  // ci_timeout large enough not to expire within our 3-poll test (deadline = 3 600 000 ms).
  const cfg: PipelineConfig = {
    ...makeCfg(60),
    ci_timeout: 3600,
  };

  // Pre-seed preArchiveSha so advance() skips the getPrDetail capture and uses
  // SHA_PRE_ARCHIVE (≠ SHA_HEAD) — this is the archive-only recovery path.
  const out = await advancePolling(cfg, 281, { pollingCtx: { preArchiveSha: SHA_PRE_ARCHIVE } }, deps);

  assert.equal(out.status, "blocked", "must block after recovery already attempted on a second zero-run poll");
  assert.ok(pollCount >= 2, `must poll at least twice; got ${pollCount}`);
  assert.ok(countCalls >= 1, "getHeadCheckRunCount must be called at least once (after grace elapsed)");
  assert.equal(closedPr, PR_NUMBER, "closePr must be called during recovery");

  // Structural proof that the grace window persisted across polls: close+reopen
  // was triggered (only reachable after getHeadCheckRunCount returned 0 post-grace),
  // which means ciGateEnteredAt set on poll 1 (= 0) was still in effect on poll 2
  // (elapsed = 61 000 - 0 = 61 000 ≥ 60 000). Had the timer reset, poll 2 would
  // have set ciGateEnteredAt = 61 000 and elapsed = 0 → no query → no recovery.
});
