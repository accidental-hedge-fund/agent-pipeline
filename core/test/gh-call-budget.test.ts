// #839: unit-test regression gates on injectable deps-invocation counts.
// No real network, git, or subprocess — deps seams only.
//
// Ceilings are named constants. Raising one is a deliberate, reviewed edit:
// each constant's comment states which amortization/efficiency win it protects.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  type AdvancePreMergeDeps,
  type PreMergePollingContext,
} from "../scripts/stages/pre_merge.ts";
import {
  advanceReview,
  type AdvanceReviewDeps,
} from "../scripts/stages/review.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Named budget ceilings (#839)
// ---------------------------------------------------------------------------

/**
 * Maximum total injectable deps invocations for a shared-context pre-merge poll
 * of PRE_MERGE_POLL_TICKS pending-CI ticks with an unchanged open PR head.
 *
 * Guards against regression of the #816 entry-gate head-SHA proceed memo and
 * related redundant per-tick entry work (SHA gate, archive/active-change listing,
 * identity re-scan). Calibrated 2026-08-11 against this fixture:
 *   memo-enabled baseline ≈ 30 (entry once + CI-path rest for N=10; includes
 *   getForIssue / shared review+pre-merge surface counters)
 *   full per-tick entry stack for same N ≈ 100
 * Ceiling sits just above the memo baseline so removing the memo skip path fails
 * `npm test`. Raise only via deliberate review when a legitimate new read is added.
 */
export const PRE_MERGE_POLL_DEPS_CEILING = 32;

/**
 * Maximum total injectable deps invocations for a deterministic multi-stage
 * full advance walk under one shared counter: review-1 (approve) → review-2
 * (approve) → pre-merge (green CI + entry gates + terminal transition).
 *
 * Guards against silent reintroduction of redundant GitHub reads across the
 * advance path (review SHA/diff acquisition, issue-thread reads, pre-merge
 * entry/CI stack) after efficiency work. Calibrated 2026-08-11 against this
 * fixture: multi-stage baseline ≈ 33. Raise only via deliberate review when a
 * legitimate new advance-path dep is added.
 */
export const ADVANCE_WALK_DEPS_CEILING = 35;

/** Pending multi-tick poll length (spec requires N ≥ 10). */
const PRE_MERGE_POLL_TICKS = 10;

const SHA_H1 = "1111111111111111111111111111111111111111";
const PR_NUMBER = 839;
const ISSUE = 839;
const APPROVE_STDOUT =
  '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
const PR_DIFF = "diff --git a/x.ts b/x.ts\n+const a = 1;\n";

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    review_mode: "prompt-harness",
    harnesses: { reviewer: "codex", implementer: "claude" },
    repo_dir: "/tmp/repo",
    domain: "test/repo",
    repo: "test/repo",
    models: { review: "opus" },
    // Default policy: block on every finding so approve is the only happy path.
    review_policy: { block_threshold: "low", min_confidence: 0 },
    test_gate: { enabled: true },
    eval_gate: { enabled: false },
    visual_gate: { enabled: false },
    shipcheck_gate: { enabled: false },
    ci_timeout: 600,
    ci_poll_interval: 1,
    ci_no_run_grace_s: 3600,
    steps: { docs: false },
    ...overrides,
  } as unknown as PipelineConfig;
}

const BUDGET_RUN_ID = "test/budget-review-run";

type PrDetailFake = Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;

/**
 * Load-bearing injectable GitHub / stage-write deps counted for budget
 * assertions. Covers the shared review + pre-merge + SHA-gate surface so a
 * silent reintroduction of redundant reads fails the ceiling (not a hand-picked
 * pre-merge-only subset). Harness-only seams (runReview, gitInWorktree, …) are
 * stubbed but not summed — the capability pins GitHub deps-invocation counts.
 */
const COUNTED_DEPS = [
  "getPrForIssue",
  "getPrDetail",
  "getPrChecks",
  "getIssueDetail",
  "listPrHeadChangeDirs",
  "getPrCommits",
  "getPrDiff",
  "getHeadCheckRunCount",
  "getGhActor",
  "getForIssue",
  "transition",
  "setBlocked",
  "postComment",
  "postPrComment",
  "createIssue",
  "addIssueComment",
] as const;

type CountedDep = (typeof COUNTED_DEPS)[number];

interface BudgetRec {
  counts: Record<CountedDep, number>;
  /** Harness invocations (not part of the gh ceiling total). */
  runReviewCalls: number;
}

function emptyCounts(): Record<CountedDep, number> {
  const counts = {} as Record<CountedDep, number>;
  for (const k of COUNTED_DEPS) counts[k] = 0;
  return counts;
}

function totalDeps(rec: BudgetRec): number {
  let n = 0;
  for (const k of COUNTED_DEPS) n += rec.counts[k];
  return n;
}

/**
 * Shared injectable bag for pre-merge poll and multi-stage advance-walk budgets.
 * One counter spans every counted dep; review comments accumulate so the
 * pre-merge SHA gate can read the approve markers posted by advanceReview.
 */
function makeBudgetHarness(opts: {
  checksBucket?: "pending" | "pass" | "fail";
  /** When true, getPrChecks returns pass after `pendingTicks` pending polls. */
  pendingThenPass?: { pendingTicks: number };
  /** Seed issue comments (poll fixture seeds a prior review-2 approve). */
  seedComments?: string[];
  /**
   * PR diff body returned by getPrDiff. Review stages need a non-empty diff;
   * the pre-merge poll fixture keeps the empty default so SHA-gate diff-hash
   * work does not inflate the poll ceiling calibration.
   */
  prDiff?: string;
} = {}): {
  deps: AdvancePreMergeDeps & AdvanceReviewDeps;
  rec: BudgetRec;
  headSha: { current: string };
  comments: string[];
} {
  const rec: BudgetRec = { counts: emptyCounts(), runReviewCalls: 0 };
  const headSha = { current: SHA_H1 };
  let checkCalls = 0;
  const comments: string[] = [...(opts.seedComments ?? [])];

  const track =
    <T extends unknown[], R>(name: CountedDep, fn: (...args: T) => R) =>
    (...args: T): R => {
      rec.counts[name]++;
      return fn(...args);
    };

  const deps: AdvancePreMergeDeps & AdvanceReviewDeps = {
    getPrForIssue: track("getPrForIssue", async () => PR_NUMBER),
    getIssueDetail: track("getIssueDetail", async () => {
      return {
        number: ISSUE,
        type: "issue",
        title: "Title",
        body: "Body",
        state: "open",
        url: "https://example.invalid/issue",
        labels: [],
        comments: comments.map((body) => ({ body, author: "test-actor" })),
      } as Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>>;
    }),
    getPrDetail: track("getPrDetail", async (_cfg, n) => {
      return {
        number: n,
        title: "t",
        body: "",
        state: "open",
        url: "https://example.invalid/pr",
        head_ref: "head",
        head_sha: headSha.current,
        base_ref: "main",
        mergeable: true,
        mergeable_state: "CLEAN",
        draft: false,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        merge_commit_sha: null,
      } as PrDetailFake;
    }),
    getPrCommits: track("getPrCommits", async () => []),
    getPrChecks: track("getPrChecks", async () => {
      checkCalls++;
      let bucket: "pending" | "pass" | "fail" = opts.checksBucket ?? "pending";
      if (opts.pendingThenPass) {
        bucket = checkCalls <= opts.pendingThenPass.pendingTicks ? "pending" : "pass";
      }
      return [{ name: "ci", bucket, state: bucket }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    }),
    getForIssue: track("getForIssue", async () => null),
    listPrHeadChangeDirs: track("listPrHeadChangeDirs", async () => []),
    openspecIsActive: async () => false,
    changeDirExists: () => false,
    gitInWorktree: async () => {
      throw new Error("gitInWorktree must not run in #839 budget unit tests");
    },
    postComment: track("postComment", async (_cfg, _n, body) => {
      comments.push(body);
    }),
    postPrComment: track("postPrComment", async () => {}),
    transition: track("transition", async () => {}),
    setBlocked: track("setBlocked", async () => {}),
    getGhActor: track("getGhActor", async () => "test-actor"),
    getPrDiff: track("getPrDiff", async () => opts.prDiff ?? ""),
    getHeadCheckRunCount: track("getHeadCheckRunCount", async () => 1),
    createIssue: track("createIssue", async () => 1),
    addIssueComment: track("addIssueComment", async () => {}),
    tryRebaseAndPush: async () => false,
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: () => {},
    runReview: async () => {
      rec.runReviewCalls++;
      return {
        result: {
          success: true,
          stdout: APPROVE_STDOUT,
          stderr: "",
          exit_code: 0,
          duration: 0.1,
          timed_out: false,
        },
        effectiveReviewer: "codex",
        selfReview: false,
      };
    },
  };

  return { deps, rec, headSha, comments };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

// ---------------------------------------------------------------------------
// Pre-merge multi-tick poll budget
// ---------------------------------------------------------------------------

test("#839 pre-merge poll: pending multi-tick under PRE_MERGE_POLL_DEPS_CEILING", async (t) => {
  const seed =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_H1} -->`;
  const { deps, rec } = makeBudgetHarness({
    checksBucket: "pending",
    seedComments: [seed],
  });
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    for (let i = 0; i < PRE_MERGE_POLL_TICKS; i++) {
      const out = await advance(cfg, ISSUE, { pollingCtx }, deps);
      assert.equal(out.advanced, false);
      assert.equal(out.status, "waiting");
      assert.equal(out.reason, "CI still running");
    }
  });

  assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1, "memo must land");
  assert.equal(rec.counts.getPrChecks, PRE_MERGE_POLL_TICKS, "one CI poll per tick");

  const total = totalDeps(rec);
  assert.ok(
    total <= PRE_MERGE_POLL_DEPS_CEILING,
    `memo-enabled poll total ${total} must be ≤ PRE_MERGE_POLL_DEPS_CEILING=${PRE_MERGE_POLL_DEPS_CEILING} ` +
      `(counts=${JSON.stringify(rec.counts)})`,
  );
});

test("#839 pre-merge poll: full per-tick entry stack exceeds PRE_MERGE_POLL_DEPS_CEILING", async (t) => {
  // Prove the ceiling is tight enough: clear the entry-gate memo every tick so
  // head-bound gates re-run (simulates memo skip path removed while head is
  // unchanged). Identity cache (prNumber) is also cleared so the fixture matches
  // a cold entry stack each tick — the cost that #816 amortization removes.
  const seed =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_H1} -->`;
  const { deps, rec } = makeBudgetHarness({
    checksBucket: "pending",
    seedComments: [seed],
  });
  const cfg = makeCfg();

  await quiet(t, async () => {
    for (let i = 0; i < PRE_MERGE_POLL_TICKS; i++) {
      // Fresh context each tick → no entryGatesPassedForSha / prNumber reuse.
      const pollingCtx: PreMergePollingContext = {};
      const out = await advance(cfg, ISSUE, { pollingCtx }, deps);
      assert.equal(out.advanced, false);
      assert.equal(out.status, "waiting");
    }
  });

  const total = totalDeps(rec);
  assert.ok(
    total > PRE_MERGE_POLL_DEPS_CEILING,
    `full per-tick entry stack total ${total} must exceed PRE_MERGE_POLL_DEPS_CEILING=${PRE_MERGE_POLL_DEPS_CEILING} ` +
      `so removing the memo fails npm test (counts=${JSON.stringify(rec.counts)})`,
  );
});

test("#839 pre-merge poll ceiling is a named constant with regression comment", () => {
  // Structural: constant is exported, finite, and below the no-memo estimate.
  assert.equal(typeof PRE_MERGE_POLL_DEPS_CEILING, "number");
  assert.ok(Number.isFinite(PRE_MERGE_POLL_DEPS_CEILING));
  assert.ok(PRE_MERGE_POLL_DEPS_CEILING > 0);
  // N≥10 is part of the pinned scenario; ceiling must be above a pure CI-only
  // lower bound (N checks + N detail) so the memo path can pass.
  assert.ok(
    PRE_MERGE_POLL_DEPS_CEILING >= PRE_MERGE_POLL_TICKS * 2,
    "ceiling must allow at least CI+detail per tick",
  );
});

// ---------------------------------------------------------------------------
// Full advance walk budget (review-1 → review-2 → pre-merge under one counter)
// ---------------------------------------------------------------------------

test("#839 advance walk: multi-stage review-1/review-2/pre-merge under ADVANCE_WALK_DEPS_CEILING", async (t) => {
  const { deps, rec } = makeBudgetHarness({
    checksBucket: "pass",
    prDiff: PR_DIFF,
  });
  const cfg = makeCfg();

  let r1: Awaited<ReturnType<typeof advanceReview>> | undefined;
  let r2: Awaited<ReturnType<typeof advanceReview>> | undefined;
  let pm: Awaited<ReturnType<typeof advance>> | undefined;

  await quiet(t, async () => {
    // Composed full advance walk under one shared deps counter (design §6):
    // load-bearing stage entrypoints, not a live GitHub issue.
    r1 = await advanceReview(cfg, ISSUE, 1, { pipelineRunId: BUDGET_RUN_ID }, 0, deps);
    r2 = await advanceReview(cfg, ISSUE, 2, { pipelineRunId: BUDGET_RUN_ID }, 0, deps);
    pm = await advance(cfg, ISSUE, {}, deps);
  });

  assert.equal(r1?.advanced, true, "review-1 must advance");
  assert.equal(r1?.from, "review-1");
  assert.equal(r1?.to, "review-2");
  assert.equal(r2?.advanced, true, "review-2 must advance");
  assert.equal(r2?.from, "review-2");
  assert.equal(r2?.to, "pre-merge");
  assert.equal(pm?.advanced, true, "pre-merge happy path must advance");
  assert.equal(pm?.from, "pre-merge");

  // Structural proof this is a multi-stage walk (not pre-merge-only):
  assert.equal(rec.runReviewCalls, 2, "both review rounds must invoke the harness");
  assert.equal(rec.counts.getPrDiff, 2, "each review round fetches the PR diff");
  assert.equal(rec.counts.getPrChecks, 1, "exactly one CI poll on green pre-merge");
  assert.equal(rec.counts.transition, 3, "three stage transitions (r1, r2, pre-merge)");
  assert.ok(rec.counts.getPrDetail >= 5, "SHA capture + pre-merge entry use getPrDetail");
  assert.ok(rec.counts.getIssueDetail >= 3, "review threads + SHA gate read issue comments");

  const total = totalDeps(rec);
  assert.ok(
    total <= ADVANCE_WALK_DEPS_CEILING,
    `advance-walk total ${total} must be ≤ ADVANCE_WALK_DEPS_CEILING=${ADVANCE_WALK_DEPS_CEILING} ` +
      `(counts=${JSON.stringify(rec.counts)})`,
  );
});

test("#839 advance-walk ceiling is a named constant with regression comment", () => {
  assert.equal(typeof ADVANCE_WALK_DEPS_CEILING, "number");
  assert.ok(Number.isFinite(ADVANCE_WALK_DEPS_CEILING));
  assert.ok(ADVANCE_WALK_DEPS_CEILING > 0);
  // Multi-stage walk (review-1 + review-2 + pre-merge) must leave room above a
  // single green pre-merge entry stack (~10 counted deps) but stay tight.
  assert.ok(
    ADVANCE_WALK_DEPS_CEILING >= 20,
    "ceiling must fit a multi-stage review+pre-merge walk, not pre-merge alone",
  );
});
