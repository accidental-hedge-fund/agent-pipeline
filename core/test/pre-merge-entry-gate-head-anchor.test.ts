// #816: head-anchor the pre-CI entry-gate stack within a polling session.
// Head-bound gates (review-SHA, OpenSpec archive, active-change guard) run once
// per PR head SHA per advancePolling session; early-conflict + CI still run
// every tick. Deps only — no real network/git/subprocess.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advance,
  advancePolling,
  isEarlyConflictPrDetail,
  type AdvancePreMergeDeps,
  type PreMergePollingContext,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const SHA_H1 = "1111111111111111111111111111111111111111";
const SHA_H2 = "2222222222222222222222222222222222222222";
const PR_NUMBER = 816;
const PR_REPLACEMENT = 817;
const ISSUE = 816;

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeCfg(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    eval_gate: { enabled: false },
    ci_timeout: 600,
    ci_poll_interval: 1,
    ci_no_run_grace_s: 3600, // keep pending path from entering no-run recovery
    ...overrides,
  } as unknown as PipelineConfig;
}

type PrDetailFake = Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;

interface CallRec {
  getPrForIssue: number;
  getPrDetail: number;
  getPrChecks: number;
  getIssueDetail: number;
  /** Head-bound active-change / archive listing (no-worktree path). */
  listPrHeadChangeDirs: number;
  getPrCommits: number;
  /** Per-tick snapshots of entry-gate deps after each advance call. */
  ticks: Array<{
    getPrForIssue: number;
    getPrDetail: number;
    getPrChecks: number;
    getIssueDetail: number;
    listPrHeadChangeDirs: number;
  }>;
}

function emptyRec(): CallRec {
  return {
    getPrForIssue: 0,
    getPrDetail: 0,
    getPrChecks: 0,
    getIssueDetail: 0,
    listPrHeadChangeDirs: 0,
    getPrCommits: 0,
    ticks: [],
  };
}

function snapshot(rec: CallRec): CallRec["ticks"][number] {
  return {
    getPrForIssue: rec.getPrForIssue,
    getPrDetail: rec.getPrDetail,
    getPrChecks: rec.getPrChecks,
    getIssueDetail: rec.getIssueDetail,
    listPrHeadChangeDirs: rec.listPrHeadChangeDirs,
  };
}

function delta(
  a: CallRec["ticks"][number],
  b: CallRec["ticks"][number],
): CallRec["ticks"][number] {
  return {
    getPrForIssue: b.getPrForIssue - a.getPrForIssue,
    getPrDetail: b.getPrDetail - a.getPrDetail,
    getPrChecks: b.getPrChecks - a.getPrChecks,
    getIssueDetail: b.getIssueDetail - a.getIssueDetail,
    listPrHeadChangeDirs: b.listPrHeadChangeDirs - a.listPrHeadChangeDirs,
  };
}

interface HarnessOpts {
  /** Mutable head SHA observed by getPrDetail. */
  headSha?: { current: string };
  /** Mutable mergeability. */
  mergeable?: { current: boolean | null };
  mergeableState?: { current: string };
  /** Mutable PR state (open/closed/merged). */
  prState?: { current: "open" | "closed" | "merged" };
  /** Mutable PR number returned by getPrDetail / identity. */
  prNumber?: { current: number };
  /** When true, getPrForIssue returns null after first closed invalidation. */
  noOpenPrAfterClose?: boolean;
  /**
   * Force non-null entry-gate outcome: no-worktree archive/guard sees an
   * active OpenSpec change id on the PR tip.
   */
  forceActiveChangeGuard?: boolean;
  checksBucket?: "pending" | "pass" | "fail";
}

function makeHarness(opts: HarnessOpts = {}): {
  deps: AdvancePreMergeDeps;
  rec: CallRec;
  headSha: { current: string };
  mergeable: { current: boolean | null };
  mergeableState: { current: string };
  prState: { current: "open" | "closed" | "merged" };
  prNumber: { current: number };
} {
  const rec = emptyRec();
  const headSha = opts.headSha ?? { current: SHA_H1 };
  const mergeable = opts.mergeable ?? { current: true };
  const mergeableState = opts.mergeableState ?? { current: "CLEAN" };
  const prState = opts.prState ?? { current: "open" as const };
  const prNumber = opts.prNumber ?? { current: PR_NUMBER };
  let resolvedOnceAfterClose = false;

  const reviewComment =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${headSha.current} -->`;

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => {
      rec.getPrForIssue++;
      if (opts.noOpenPrAfterClose && prState.current !== "open") {
        if (resolvedOnceAfterClose) return null;
        // First re-resolve after close: no open PR remains.
        resolvedOnceAfterClose = true;
        return null;
      }
      return prNumber.current;
    },
    getIssueDetail: async () => {
      rec.getIssueDetail++;
      // Rebuild body from current head so head-invalidation tests stay currency-clean.
      const body =
        `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${headSha.current} -->`;
      return { comments: [{ body: body || reviewComment }] } as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >;
    },
    getPrDetail: async (_cfg, n) => {
      rec.getPrDetail++;
      const state = prState.current;
      return {
        number: n,
        title: "t",
        body: "",
        state,
        url: "https://example.invalid/pr",
        head_ref: "head",
        head_sha: headSha.current,
        base_ref: "main",
        mergeable: mergeable.current,
        mergeable_state: mergeableState.current,
        draft: false,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        merge_commit_sha: null,
      } as PrDetailFake;
    },
    getPrCommits: async () => {
      rec.getPrCommits++;
      return [];
    },
    getPrChecks: async () => {
      rec.getPrChecks++;
      const bucket = opts.checksBucket ?? "pending";
      return [{ name: "ci", bucket, state: bucket }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    },
    // No worktree → archive uses PR-head change-dir listing; active-change guard
    // also uses listPrHeadChangeDirs (not getPrDiff) on the missing-worktree path.
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => {
      rec.listPrHeadChangeDirs++;
      return opts.forceActiveChangeGuard ? ["still-active-change"] : [];
    },
    // When a forced active change is listed with no worktree, archive tries
    // rematerialize — fail it closed without real git/network.
    ensureManagedWorktree: async () =>
      ({
        result: "fail",
        blockerKind: "worktree-missing",
        reason: "test-forced rematerialize deny",
      }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["ensureManagedWorktree"]>>
      >,
    openspecIsActive: async () => false,
    changeDirExists: () => false,
    gitInWorktree: async () => {
      throw new Error("gitInWorktree must not run in #816 unit tests");
    },
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getGhActor: async () => "test-actor",
    getPrDiff: async () => "",
    // Avoid real no-run recovery side effects if grace ever elapses.
    getHeadCheckRunCount: async () => 1,
    tryRebaseAndPush: async () => false,
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: () => {},
  };

  return { deps, rec, headSha, mergeable, mergeableState, prState, prNumber };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

async function runTick(
  cfg: PipelineConfig,
  deps: AdvancePreMergeDeps,
  rec: CallRec,
  pollingCtx: PreMergePollingContext,
): Promise<Awaited<ReturnType<typeof advance>>> {
  const before = snapshot(rec);
  const out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  const after = snapshot(rec);
  rec.ticks.push(delta(before, after));
  return out;
}

// ---------------------------------------------------------------------------
// 3.1 Multi-tick pending CI: head-bound gates once, later ticks CI-path only
// ---------------------------------------------------------------------------

test("#816 multi-tick pending CI: entry gates once; later ticks are CI-path reads", async (t) => {
  const { deps, rec, headSha } = makeHarness({ checksBucket: "pending" });
  // Keep reviewed-sha aligned if head mutates (it should not here).
  void headSha;
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();
  const TICKS = 10;

  await quiet(t, async () => {
    for (let i = 0; i < TICKS; i++) {
      const out = await runTick(cfg, deps, rec, pollingCtx);
      assert.equal(out.advanced, false);
      assert.equal(out.status, "waiting");
      assert.equal(out.reason, "CI still running");
    }
  });

  assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1, "memo set to steady head");
  assert.equal(pollingCtx.prNumber, PR_NUMBER, "PR number cached on context");

  // First tick runs head-bound entry-gate deps (issue detail + PR-head change dirs).
  const first = rec.ticks[0]!;
  assert.ok(first.getIssueDetail >= 1, "tick 1 runs SHA-gate (getIssueDetail)");
  assert.ok(
    first.listPrHeadChangeDirs >= 1,
    "tick 1 runs archive/active-change listing (listPrHeadChangeDirs)",
  );
  assert.ok(first.getPrChecks >= 1, "tick 1 polls CI");
  assert.ok(first.getPrForIssue >= 1, "tick 1 resolves PR identity");

  // Later ticks: no head-bound entry deps; identity not re-scanned; detail+checks only.
  for (let i = 1; i < TICKS; i++) {
    const tick = rec.ticks[i]!;
    assert.equal(
      tick.getIssueDetail,
      0,
      `tick ${i + 1}: must not re-run SHA gate (getIssueDetail)`,
    );
    assert.equal(
      tick.listPrHeadChangeDirs,
      0,
      `tick ${i + 1}: must not re-run archive/active-change listing`,
    );
    assert.equal(
      tick.getPrForIssue,
      0,
      `tick ${i + 1}: must reuse cached prNumber (no getPrForIssue)`,
    );
    assert.ok(tick.getPrDetail >= 1, `tick ${i + 1}: still fetches PR detail`);
    assert.equal(tick.getPrChecks, 1, `tick ${i + 1}: one CI poll`);
    // CI-path order of magnitude: detail (+ maybe post-stack none on memo hit) + checks
    assert.ok(
      tick.getPrDetail <= 2,
      `tick ${i + 1}: detail calls should stay on CI path (got ${tick.getPrDetail})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3.2 Head invalidation: H1 memo then H2 re-runs full head-bound stack
// ---------------------------------------------------------------------------

test("#816 head invalidation: H1 memo then H2 re-runs head-bound entry gates", async (t) => {
  const headSha = { current: SHA_H1 };
  const { deps, rec } = makeHarness({ headSha, checksBucket: "pending" });

  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    const o1 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o1.reason, "CI still running");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);

    // Head moves (developer push / fix / archive / rebase).
    headSha.current = SHA_H2;
    const o2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o2.reason, "CI still running");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H2);
  });

  const tick1 = rec.ticks[0]!;
  const tick2 = rec.ticks[1]!;
  assert.ok(tick1.getIssueDetail >= 1, "H1 tick runs SHA gate");
  assert.ok(tick1.listPrHeadChangeDirs >= 1, "H1 tick runs archive/active-change listing");
  // Critical: H2 must re-run head-bound gates. If the implementation skips
  // whenever any memo is set (without comparing to current head), this fails.
  assert.ok(
    tick2.getIssueDetail >= 1,
    "H2 tick must re-run SHA gate after head movement (invalidation regression)",
  );
  assert.ok(
    tick2.listPrHeadChangeDirs >= 1,
    "H2 tick must re-run archive/active-change listing after head movement",
  );
});

// ---------------------------------------------------------------------------
// 3.2b Revert-to-prior-SHA: H1 proceed → H2 non-proceed → H1 re-runs stack
// Stale memo must not survive the intervening head movement (9a76bc08).
// ---------------------------------------------------------------------------

test("#816 head invalidation: H1 proceed → H2 non-proceed → H1 re-runs all head-bound gates", async (t) => {
  const headSha = { current: SHA_H1 };
  // Force active-change guard only while observing H2 (non-proceed).
  let forceGuard = false;
  const { deps, rec } = makeHarness({ headSha, checksBucket: "pending" });
  deps.listPrHeadChangeDirs = async () => {
    rec.listPrHeadChangeDirs++;
    return forceGuard ? ["still-active-change"] : [];
  };

  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    // Tick 1: H1 clean proceed into CI → memo = H1.
    const o1 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o1.reason, "CI still running");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);

    // Tick 2: head moves to H2; entry gate blocks (non-proceed).
    // Memo must be cleared on mismatch — not retained as H1.
    headSha.current = SHA_H2;
    forceGuard = true;
    const o2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.notEqual(o2.reason, "CI still running");
    assert.equal(o2.status, "blocked");
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      undefined,
      "H2 non-proceed must not leave a prior H1 proceed memo after head movement",
    );

    // Tick 3: force-push/revert back to H1. Stale H1 memo would skip gates;
    // invalidation on mismatch requires a full re-run.
    headSha.current = SHA_H1;
    forceGuard = false;
    const o3 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o3.reason, "CI still running");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);
  });

  const tick3 = rec.ticks[2]!;
  assert.ok(
    tick3.getIssueDetail >= 1,
    "final H1 tick after H2 intervening must re-run SHA gate (not stale memo hit)",
  );
  assert.ok(
    tick3.listPrHeadChangeDirs >= 1,
    "final H1 tick after H2 intervening must re-run archive/active-change listing",
  );
});

// ---------------------------------------------------------------------------
// 3.3 Non-proceed does not set memo
// ---------------------------------------------------------------------------

test("#816 non-proceed active-change guard does not set entryGatesPassedForSha", async (t) => {
  const { deps, rec } = makeHarness({
    forceActiveChangeGuard: true,
    checksBucket: "pending",
  });
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    const out = await runTick(cfg, deps, rec, pollingCtx);
    // Archive/guard blocks rather than enter CI waiting.
    assert.notEqual(out.reason, "CI still running");
    assert.equal(out.status, "blocked");
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      undefined,
      "blocking entry gate must not set proceed memo",
    );
    assert.equal(rec.getPrChecks, 0, "CI not polled when entry gate returns");

    // Same head next tick still runs the stack (memo unset).
    const out2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.notEqual(out2.reason, "CI still running");
    assert.ok(
      rec.ticks[1]!.listPrHeadChangeDirs >= 1,
      "next tick re-runs archive/active-change listing",
    );
  });
});

test("#816 early-conflict recovery does not set proceed memo", async (t) => {
  const { deps, rec } = makeHarness({
    checksBucket: "pending",
    mergeable: { current: false },
    mergeableState: { current: "DIRTY" },
  });
  // Rebase already attempted → conflict path blocks without CI.
  deps.rebaseAlreadyAttempted = () => true;
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    const out = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(out.advanced, false);
    assert.equal(out.status, "blocked");
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      undefined,
      "early-conflict recovery must not set proceed memo",
    );
    assert.equal(rec.getPrChecks, 0);
  });
});

// ---------------------------------------------------------------------------
// 3.4 Memo hit + base-driven DIRTY still takes conflict recovery
// ---------------------------------------------------------------------------

test("#816 memo hit with base-driven DIRTY still takes early-conflict path", async (t) => {
  const mergeable = { current: true as boolean | null };
  const mergeableState = { current: "CLEAN" };
  const { deps, rec } = makeHarness({
    checksBucket: "pending",
    mergeable,
    mergeableState,
  });
  deps.rebaseAlreadyAttempted = () => true;
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    // Tick 1: clean proceed into CI waiting → memo set.
    const o1 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o1.reason, "CI still running");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);

    // Tick 2: same head, base moved → DIRTY.
    mergeable.current = false;
    mergeableState.current = "DIRTY";
    const o2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o2.advanced, false);
    assert.equal(o2.status, "blocked");
    // #1065: clean-rebase already attempted + missing worktree → product/engine
    // failure (review-findings), not merge-conflict “manual rebase” park.
    assert.equal(o2.blockerKind, "review-findings");
    assert.match(String(o2.reason), /worktree/i);
    // Head-bound gates skipped (memo hit) but conflict path ran (no CI poll).
    assert.equal(rec.ticks[1]!.getIssueDetail, 0, "memo hit skips SHA gate");
    assert.equal(
      rec.ticks[1]!.listPrHeadChangeDirs,
      0,
      "memo hit skips archive/active-change listing",
    );
    assert.equal(rec.ticks[1]!.getPrChecks, 0, "early conflict skips CI");
  });
});

// ---------------------------------------------------------------------------
// 3.5 Post-stack external head race must not acquire a proceed memo
// ---------------------------------------------------------------------------

test("#816 post-stack external head change does not memoize ungated SHA", async (t) => {
  // Gates complete against H1; only after all three head-bound gates finish
  // does getPrDetail report H2 (external push/force-push race). H2 must not
  // become entryGatesPassedForSha — next tick must re-run the full stack.
  let stackComplete = false;
  let getIssueDetailN = 0;
  let listPrHeadChangeDirsN = 0;
  const { deps, rec } = makeHarness({ checksBucket: "pending" });
  deps.getIssueDetail = async () => {
    rec.getIssueDetail++;
    getIssueDetailN++;
    // No reviewed-sha → SHA gate no-ops without blocking on either head.
    return { comments: [] } as Awaited<
      ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
    >;
  };
  deps.listPrHeadChangeDirs = async () => {
    rec.listPrHeadChangeDirs++;
    listPrHeadChangeDirsN++;
    // Archive + active-change guard both list; mark complete after the stack
    // has exercised this dep (both gate paths use it without a worktree).
    stackComplete = true;
    return [];
  };
  deps.getPrDetail = async (_cfg, n) => {
    rec.getPrDetail++;
    // Early hoist + any mid-stack reads stay on H1; only the post-stack
    // re-fetch (after listing) observes the external H2.
    const sha = stackComplete ? SHA_H2 : SHA_H1;
    return {
      number: n,
      title: "t",
      body: "",
      state: "open",
      url: "https://example.invalid/pr",
      head_ref: "head",
      head_sha: sha,
      base_ref: "main",
      mergeable: true,
      mergeable_state: "CLEAN",
      draft: false,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      merge_commit_sha: null,
    } as PrDetailFake;
  };

  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    const out1 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(out1.reason, "CI still running");
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      undefined,
      "external post-stack head must not acquire a proceed memo",
    );
    assert.notEqual(
      pollingCtx.entryGatesPassedForSha,
      SHA_H2,
      "ungated H2 must never be memoized",
    );
    assert.equal(pollingCtx.preArchiveSha, SHA_H1, "preArchiveSha remains stack-entry H1");
    assert.ok(getIssueDetailN >= 1, "tick 1 ran SHA gate");
    assert.ok(listPrHeadChangeDirsN >= 1, "tick 1 ran archive/active-change listing");

    // Next tick observes H2 from the start with memo unset → full stack re-runs
    // and may memoize H2 only after gates complete against H2 itself.
    const issueBefore = getIssueDetailN;
    const listBefore = listPrHeadChangeDirsN;
    const out2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(out2.reason, "CI still running");
    assert.ok(
      getIssueDetailN > issueBefore,
      "tick 2 must re-run SHA gate for ungated H2",
    );
    assert.ok(
      listPrHeadChangeDirsN > listBefore,
      "tick 2 must re-run archive/active-change for ungated H2",
    );
    // Tick 2 entered the stack on H2 (early detail already H2) and post-stack
    // still reports H2, so H2 is now stack-validated and may be memoized.
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      SHA_H2,
      "after a full stack that starts and ends on H2, memo may record H2",
    );
  });
});

// ---------------------------------------------------------------------------
// 3.6 Closed / replaced PR clears cached identity and entry memo
// ---------------------------------------------------------------------------

test("#816 closed PR clears cached prNumber and entry memo; does not keep polling closed", async (t) => {
  const prState = { current: "open" as "open" | "closed" | "merged" };
  const prNumber = { current: PR_NUMBER };
  const { deps, rec } = makeHarness({
    prState,
    prNumber,
    checksBucket: "pending",
    noOpenPrAfterClose: true,
  });
  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    const o1 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o1.reason, "CI still running");
    assert.equal(pollingCtx.prNumber, PR_NUMBER);
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);

    // PR closes mid-session.
    prState.current = "closed";
    const o2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o2.advanced, false);
    assert.equal(o2.status, "blocked");
    assert.equal(o2.reason, "no PR");
    assert.equal(pollingCtx.prNumber, undefined, "cached PR number cleared");
    assert.equal(
      pollingCtx.entryGatesPassedForSha,
      undefined,
      "entry memo cleared when PR identity invalid",
    );
  });
});

test("#816 replaced open PR re-resolves identity after closed cached number", async (t) => {
  const prState = { current: "open" as "open" | "closed" | "merged" };
  const prNumber = { current: PR_NUMBER };
  let getPrForIssueN = 0;
  const { deps, rec, headSha } = makeHarness({
    prState,
    prNumber,
    checksBucket: "pending",
  });
  deps.getPrForIssue = async () => {
    rec.getPrForIssue++;
    getPrForIssueN++;
    // After close of PR_NUMBER, next resolution yields replacement PR.
    if (prState.current === "closed" || getPrForIssueN > 1) {
      // When validity probe sees closed, clear and re-resolve → open replacement.
      if (prNumber.current === PR_NUMBER && prState.current === "closed") {
        prNumber.current = PR_REPLACEMENT;
        prState.current = "open";
        headSha.current = SHA_H2;
      }
      return prNumber.current;
    }
    return PR_NUMBER;
  };
  deps.getIssueDetail = async () => {
    rec.getIssueDetail++;
    const body =
      `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${headSha.current} -->`;
    return { comments: [{ body }] } as Awaited<
      ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
    >;
  };

  const pollingCtx: PreMergePollingContext = {};
  const cfg = makeCfg();

  await quiet(t, async () => {
    await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(pollingCtx.prNumber, PR_NUMBER);
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);

    prState.current = "closed";
    const o2 = await runTick(cfg, deps, rec, pollingCtx);
    assert.equal(o2.reason, "CI still running");
    assert.equal(pollingCtx.prNumber, PR_REPLACEMENT, "identity re-resolved to new open PR");
    assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H2, "memo is for new head");
    // Replacement tick must re-run head-bound gates (memo was cleared on close).
    assert.ok(rec.ticks[1]!.getIssueDetail >= 1);
  });
});

// ---------------------------------------------------------------------------
// 3.7 Early-conflict predicate stability + UNKNOWN/BEHIND fall-through
// ---------------------------------------------------------------------------

test("#816 isEarlyConflictPrDetail is byte-stable and matches routing source", async () => {
  assert.equal(isEarlyConflictPrDetail({ mergeable: false, mergeable_state: "DIRTY" }), true);
  assert.equal(isEarlyConflictPrDetail({ mergeable: false, mergeable_state: "CLEAN" }), true);
  assert.equal(isEarlyConflictPrDetail({ mergeable: true, mergeable_state: "DIRTY" }), true);
  assert.equal(isEarlyConflictPrDetail({ mergeable: true, mergeable_state: "dirty" }), true);
  assert.equal(isEarlyConflictPrDetail({ mergeable: null, mergeable_state: "" }), false);
  assert.equal(isEarlyConflictPrDetail({ mergeable: null, mergeable_state: "UNKNOWN" }), false);
  assert.equal(isEarlyConflictPrDetail({ mergeable: true, mergeable_state: "BEHIND" }), false);
  assert.equal(isEarlyConflictPrDetail({ mergeable: true, mergeable_state: "BLOCKED" }), false);
  assert.equal(isEarlyConflictPrDetail({ mergeable: true, mergeable_state: "CLEAN" }), false);

  // Source-level guard: routing still uses the shared helper (no divergent copy).
  const routingSrc = readFileSync(
    join(__dirname, "../scripts/stages/pre-merge-routing.ts"),
    "utf8",
  );
  assert.match(
    routingSrc,
    /if \(isEarlyConflictPrDetail\(prDetail\)\)/,
    "advance() must call isEarlyConflictPrDetail for the early path",
  );
  assert.match(
    routingSrc,
    /prDetail\.mergeable === false \|\|\s*\n\s*\(prDetail\.mergeable_state \?\? ""\)\.toUpperCase\(\) === "DIRTY"/,
    "helper body must keep the byte-identical predicate",
  );
});

test("#816 UNKNOWN/BEHIND fall through to CI under polling memo path", async (t) => {
  for (const [mergeable, state] of [
    [null, "UNKNOWN"],
    [true, "BEHIND"],
    [true, "BLOCKED"],
  ] as const) {
    const { deps, rec } = makeHarness({
      checksBucket: "pending",
      mergeable: { current: mergeable },
      mergeableState: { current: state },
    });
    const pollingCtx: PreMergePollingContext = {};
    await quiet(t, async () => {
      const out = await runTick(makeCfg(), deps, rec, pollingCtx);
      assert.equal(
        out.reason,
        "CI still running",
        `${state}: must fall through to CI, not early-conflict`,
      );
      assert.equal(pollingCtx.entryGatesPassedForSha, SHA_H1);
    });
  }
});

// ---------------------------------------------------------------------------
// 3.8 One-shot advance without pollingCtx always runs full stack
// ---------------------------------------------------------------------------

test("#816 one-shot advance without pollingCtx never consults memo", async (t) => {
  const { deps, rec } = makeHarness({ checksBucket: "pending" });
  const cfg = makeCfg();

  await quiet(t, async () => {
    const o1 = await advance(cfg, ISSUE, {}, deps);
    const o2 = await advance(cfg, ISSUE, {}, deps);
    assert.equal(o1.reason, "CI still running");
    assert.equal(o2.reason, "CI still running");
  });
  // Both calls run head-bound gates (getIssueDetail + listPrHeadChangeDirs).
  assert.ok(rec.getIssueDetail >= 2, "each one-shot call runs SHA gate");
  assert.ok(
    rec.listPrHeadChangeDirs >= 2,
    "each one-shot call runs archive/active-change listing",
  );
  assert.ok(rec.getPrForIssue >= 2, "each one-shot call resolves PR identity");
});

// ---------------------------------------------------------------------------
// advancePolling shares context across ticks
// ---------------------------------------------------------------------------

test("#816 advancePolling amortizes entry gates across waiting ticks", async (t) => {
  const { deps, rec } = makeHarness({ checksBucket: "pending" });
  let now = 0;
  deps.nowMs = () => now;
  deps.sleepMs = async () => {
    now += 1000;
  };
  const cfg = makeCfg({
    ci_timeout: 10,
    ci_poll_interval: 1,
    ci_no_run_grace_s: 3600,
  } as Partial<PipelineConfig>);

  await quiet(t, async () => {
    const out = await advancePolling(cfg, ISSUE, {}, deps);
    assert.equal(out.status, "waiting");
  });

  // Multiple advance iterations; head-bound entry deps only on first proceed.
  assert.ok(rec.getPrChecks >= 2, "multiple CI polls in the session");
  assert.equal(
    rec.getIssueDetail,
    1,
    "SHA gate runs once across the whole advancePolling session",
  );
  // Archive + active-change guard each list once on the no-worktree path.
  assert.ok(
    rec.listPrHeadChangeDirs >= 1 && rec.listPrHeadChangeDirs <= 2,
    `archive/active-change listing amortized (got ${rec.listPrHeadChangeDirs})`,
  );
});
