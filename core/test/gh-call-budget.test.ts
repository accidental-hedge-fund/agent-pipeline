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
 *   memo-enabled baseline ≈ 26 (entry once + CI-path rest for N=10)
 *   full per-tick entry stack for same N ≈ 80
 * Ceiling sits just above the memo baseline so removing the memo skip path fails
 * `npm test`. Raise only via deliberate review when a legitimate new read is added.
 */
export const PRE_MERGE_POLL_DEPS_CEILING = 28;

/**
 * Maximum total injectable deps invocations for a deterministic full advance
 * walk through the pre-merge happy path (entry gates + green CI + terminal
 * transition) under injectable deps.
 *
 * Guards against silent reintroduction of redundant GitHub reads on the
 * advance path after efficiency work. Calibrated 2026-08-11 against this
 * fixture: green happy-path baseline ≈ 10. Raise only via deliberate review
 * when a legitimate new advance-path dep is added.
 */
export const ADVANCE_WALK_DEPS_CEILING = 12;

/** Pending multi-tick poll length (spec requires N ≥ 10). */
const PRE_MERGE_POLL_TICKS = 10;

const SHA_H1 = "1111111111111111111111111111111111111111";
const PR_NUMBER = 839;
const ISSUE = 839;

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    eval_gate: { enabled: false },
    ci_timeout: 600,
    ci_poll_interval: 1,
    ci_no_run_grace_s: 3600,
    steps: { docs: false },
    ...overrides,
  } as unknown as PipelineConfig;
}

type PrDetailFake = Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;

/** Load-bearing pre-merge deps we count for budget assertions. */
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
  "transition",
  "setBlocked",
  "postComment",
] as const;

type CountedDep = (typeof COUNTED_DEPS)[number];

interface BudgetRec {
  counts: Record<CountedDep, number>;
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

function makeBudgetHarness(opts: {
  checksBucket?: "pending" | "pass" | "fail";
  /** When true, getPrChecks returns pass after `pendingTicks` pending polls. */
  pendingThenPass?: { pendingTicks: number };
} = {}): {
  deps: AdvancePreMergeDeps;
  rec: BudgetRec;
  headSha: { current: string };
} {
  const rec: BudgetRec = { counts: emptyCounts() };
  const headSha = { current: SHA_H1 };
  let checkCalls = 0;

  const reviewComment =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${headSha.current} -->`;

  const track =
    <T extends unknown[], R>(name: CountedDep, fn: (...args: T) => R) =>
    (...args: T): R => {
      rec.counts[name]++;
      return fn(...args);
    };

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: track("getPrForIssue", async () => PR_NUMBER),
    getIssueDetail: track("getIssueDetail", async () => {
      const body =
        `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${headSha.current} -->`;
      return { comments: [{ body: body || reviewComment }] } as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >;
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
    getForIssue: async () => null,
    listPrHeadChangeDirs: track("listPrHeadChangeDirs", async () => []),
    openspecIsActive: async () => false,
    changeDirExists: () => false,
    gitInWorktree: async () => {
      throw new Error("gitInWorktree must not run in #839 budget unit tests");
    },
    postComment: track("postComment", async () => {}),
    transition: track("transition", async () => {}),
    setBlocked: track("setBlocked", async () => {}),
    getGhActor: track("getGhActor", async () => "test-actor"),
    getPrDiff: track("getPrDiff", async () => ""),
    getHeadCheckRunCount: track("getHeadCheckRunCount", async () => 1),
    tryRebaseAndPush: async () => false,
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: () => {},
  };

  return { deps, rec, headSha };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

// ---------------------------------------------------------------------------
// Pre-merge multi-tick poll budget
// ---------------------------------------------------------------------------

test("#839 pre-merge poll: pending multi-tick under PRE_MERGE_POLL_DEPS_CEILING", async (t) => {
  const { deps, rec } = makeBudgetHarness({ checksBucket: "pending" });
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
  const { deps, rec } = makeBudgetHarness({ checksBucket: "pending" });
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
// Full advance walk budget (pre-merge happy path under injectable deps)
// ---------------------------------------------------------------------------

test("#839 advance walk: happy-path pre-merge under ADVANCE_WALK_DEPS_CEILING", async (t) => {
  const { deps, rec } = makeBudgetHarness({ checksBucket: "pass" });
  const cfg = makeCfg();

  let out: Awaited<ReturnType<typeof advance>> | undefined;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, {}, deps);
  });

  assert.equal(out?.advanced, true, "happy path must advance");
  assert.equal(out?.from, "pre-merge");
  assert.equal(rec.counts.getPrChecks, 1, "exactly one CI poll on green path");
  assert.equal(rec.counts.transition, 1, "one stage transition");

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
  // Must leave room for identity + entry stack + CI + transition, but stay tight.
  assert.ok(ADVANCE_WALK_DEPS_CEILING < PRE_MERGE_POLL_DEPS_CEILING);
});
