// Regression tests for #95: a CONFLICTING PR creates no pull_request check
// runs (GitHub cannot build the merge ref), so pre-merge must detect the
// conflict BEFORE the CI poll and route to the rebase path — not poll for
// checks that can never appear until ci_timeout. Deps are injected via
// AdvancePreMergeDeps, the same DI pattern as pre-merge-single-ci-cycle.test.ts.
//
// #1065: first clean auto-rebase miss escalates to bounded conflict resolve —
// never parks with BlockerKind `merge-conflict` / “manual rebase needed”.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  type AdvancePreMergeDeps,
  MERGE_CONFLICT_MANUAL_REBASE_TERMINAL,
  CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND,
  tryResolveAdditiveUnionContent,
  buildConflictResolveExhaustedReason,
  isIllegalMergeConflictManualRebaseTerminal,
  reconcileConflictRebaseState,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const SHA_HEAD = "3333333333333333333333333333333333333333";
const SHA_AFTER_REBASE = "4444444444444444444444444444444444444444";
const PR_NUMBER = 83;
const ISSUE = 95;
// Path that does not exist on disk: openspec.isActive() auto-detection finds
// no openspec/ workspace there, so the archive and spec-validation steps skip.
const WT_PATH = "/nonexistent/pipeline-95-wt";

function makeCfg(): PipelineConfig {
  return { eval_gate: { enabled: false } } as unknown as PipelineConfig;
}

interface Rec {
  ciPolls: number;
  rebaseCalls: number;
  resolveCalls: number;
  marked: string[];
  blocked: string[];
  blockedKinds: string[];
}

type PrDetailFake = Awaited<ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>>;

/**
 * Deps where everything up to the conflict pre-check passes: PR found, no
 * prior review comment (SHA gate skips), worktree present, rebase marker
 * absent and rebase succeeding unless overridden.
 *
 * Default tryRebaseAndPush advances head_sha so #771 HEAD-moved rules allow
 * `rebased; CI re-running` / `rebase-resolved; CI re-running`.
 */
function makeDeps(prDetail: Partial<PrDetailFake>): { deps: AdvancePreMergeDeps; rec: Rec; headSha: { current: string } } {
  const rec: Rec = { ciPolls: 0, rebaseCalls: 0, resolveCalls: 0, marked: [], blocked: [], blockedKinds: [] };
  const headSha = { current: (prDetail.head_sha as string | undefined) ?? SHA_HEAD };
  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [] }) as unknown as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      ({ ...prDetail, head_sha: headSha.current } as PrDetailFake),
    getPrCommits: async () => [],
    getPrChecks: async () => {
      rec.ciPolls++;
      return [{ name: "ci", bucket: "pass" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    },
    getForIssue: async () => ({ path: WT_PATH, slug: "conflict-detection" }),
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason, _stage, kind) => {
      rec.blocked.push(reason);
      rec.blockedKinds.push(kind ?? "needs-human");
    },
    tryRebaseAndPush: async () => {
      rec.rebaseCalls++;
      // Simulate authoritative PR head movement after a successful rebase (#771).
      headSha.current = SHA_AFTER_REBASE;
      return true;
    },
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: (wtPath) => {
      rec.marked.push(wtPath);
    },
    // In CI, gh api user fails with machine tokens → inject mock so the SHA gate
    // doesn't hit the real gh CLI and return null (#229).
    getGhActor: async () => "test-actor",
    // Head-side OpenSpec active-change guard (#467) always fetches the PR diff;
    // an empty diff means no openspec/changes/ path, so the guard is a no-op here.
    getPrDiff: async () => "",
  };
  return { deps, rec, headSha };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

test("CONFLICTING PR skips the CI poll and rebases (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "rebase-resolved; CI re-running",
  });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1, "rebase attempted exactly once");
  // #759: markRebaseAttempted is a no-op / spy; durable authority is the ledger.
  // Injectable spy may still be invoked for call-site compatibility.
  assert.deepEqual(rec.marked, [WT_PATH], "markRebaseAttempted spy still invoked (writer is no-op)");
  assert.deepEqual(rec.blocked, []);
});

test("CONFLICTING PR with clean rebase already attempted escalates resolve — no second clean rebase (#95/#1065)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.rebaseAlreadyAttempted = () => true;
  // Inject exhausted resolve so we see product failure without real git.
  deps.conflictResolveAttemptedForHead = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  const blocked = out as { advanced: false; status: "blocked"; reason: string; blockerKind: string };
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockerKind, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  assert.notEqual(blocked.blockerKind, "merge-conflict");
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 0, "no second clean rebase once the marker is set");
  assert.equal(rec.blocked.length, 1);
  assert.equal(isIllegalMergeConflictManualRebaseTerminal(rec.blocked[0]!), false);
  assert.notEqual(rec.blocked[0], MERGE_CONFLICT_MANUAL_REBASE_TERMINAL);
});

test("CONFLICTING PR whose clean rebase fails escalates to resolve — not merge-conflict park (#95/#1065)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  // Exhaust immediately on resolve (simulates budget miss after clean fail).
  deps.resolveMergeConflicts = async () => {
    rec.resolveCalls++;
    return {
      status: "exhausted",
      conflictPaths: ["core/scripts/pipeline.ts"],
      reason: "injected resolve exhaust",
    };
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  const blocked = out as { advanced: false; status: "blocked"; reason: string; blockerKind: string };
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockerKind, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  assert.notEqual(blocked.blockerKind, "merge-conflict");
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1);
  assert.equal(rec.resolveCalls, 1, "must enter bounded conflict resolve after clean miss");
  // Clean miss + resolve both invoke the mark spy (writer is still a no-op).
  assert.ok(rec.marked.includes(WT_PATH), "conflict path still records markRebaseAttempted spy");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0]!, /core\/scripts\/pipeline\.ts/);
  assert.equal(isIllegalMergeConflictManualRebaseTerminal(rec.blocked[0]!), false);
  assert.equal(rec.blockedKinds[0], CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
});

test("UNKNOWN mergeability does not enter the early-conflict path; CI poll proceeds (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  // CI was consulted (green), and the gate then waits on mergeability — the
  // normal pre-#95 flow, with no rebase or conflict block.
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "GitHub still computing mergeability",
  });
  assert.equal(rec.ciPolls, 1, "UNKNOWN mergeability still polls CI as before");
  assert.equal(rec.rebaseCalls, 0);
  assert.deepEqual(rec.blocked, []);
});

test("BLOCKED mergeable_state does not trigger early-conflict path; post-CI gate returns waiting (#95)", async (t) => {
  // mergeable: null + mergeable_state: BLOCKED → branch protection or required reviews,
  // not a merge conflict. Must not bypass CI and must not consume the rebase marker.
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BLOCKED" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(rec.ciPolls, 1, "BLOCKED state must still poll CI — not bypassed by the early-conflict check");
  assert.deepEqual(
    out,
    { advanced: false, status: "waiting", reason: "GitHub mergeability: blocked" },
    "post-CI gate must return waiting for BLOCKED, not trigger conflict recovery",
  );
  assert.equal(rec.rebaseCalls, 0, "BLOCKED must not consume the rebase slot");
  assert.deepEqual(rec.marked, [], "BLOCKED must not set the rebase-attempted marker");
  assert.deepEqual(rec.blocked, []);
});

test("BEHIND mergeable_state does not trigger early-conflict path; post-CI gate attempts auto-update (#95)", async (t) => {
  // mergeable: null + mergeable_state: BEHIND → branch is out of date with base,
  // not a merge conflict. Must not bypass CI (early-conflict path) but post-CI
  // Step 2 must attempt one auto-rebase to converge, not return waiting indefinitely.
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BEHIND" });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(rec.ciPolls, 1, "BEHIND state must still poll CI — not bypassed by the early-conflict check");
  assert.deepEqual(
    out,
    { advanced: false, status: "waiting", reason: "rebased; CI re-running" },
    "post-CI BEHIND must attempt auto-rebase and return waiting while CI re-runs",
  );
  assert.equal(rec.rebaseCalls, 1, "BEHIND must invoke tryRebaseAndPush once");
  assert.deepEqual(rec.marked, [WT_PATH], "BEHIND rebase success must set the attempted marker");
  assert.deepEqual(rec.blocked, []);
});

test("BLOCKED with rebase marker present does not set merge-conflict block reason (#95)", async (t) => {
  // Regression for Review 2 finding: BLOCKED was mapped to "conflict" by parseMergeable(),
  // which caused recoverFromMergeConflict to be called. On a subsequent poll with the marker
  // present, the PR would block with "merge conflict — manual rebase needed" — wrong message
  // for a PR that only needs branch protection to clear.
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BLOCKED" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "waiting", reason: "GitHub mergeability: blocked" },
    "marker-present BLOCKED must still return waiting, not a conflict block",
  );
  assert.deepEqual(rec.blocked, [], "must not call setBlocked for a BLOCKED-state PR");
  assert.equal(rec.rebaseCalls, 0, "must not attempt a second rebase");
});

test("BEHIND with rebase marker present blocks with a behind-specific reason, not merge-conflict reason (#95)", async (t) => {
  // Regression for Review 2 finding: BEHIND was mapped to "conflict" by parseMergeable(),
  // which on a second poll (marker present) would block with "merge conflict — manual rebase
  // needed" — wrong message for a PR that is just behind the base branch.
  // After the fix: BEHIND+marker blocks with "branch behind base", not "merge conflict".
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BEHIND" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  const blockedOut = out as { advanced: false; status: "blocked"; reason: string; blockerKind: string };
  assert.equal(blockedOut.status, "blocked", "marker-present BEHIND must block");
  assert.match(blockedOut.reason, /behind/, "blocked reason must mention 'behind'");
  assert.doesNotMatch(blockedOut.reason, /merge conflict/, "blocked reason must NOT say 'merge conflict'");
  assert.equal(blockedOut.blockerKind, "merge-conflict", "blockerKind must be merge-conflict");
  assert.equal(rec.blocked.length, 1, "must call setBlocked exactly once");
  assert.match(rec.blocked[0], /behind/, "block reason must mention 'behind'");
  assert.doesNotMatch(rec.blocked[0], /merge conflict/, "block reason must NOT mention 'merge conflict'");
  assert.equal(rec.rebaseCalls, 0, "must not attempt a second rebase");
});

test("post-CI BEHIND invokes tryRebaseAndPush instead of returning waiting indefinitely (#95 review-2 regression)", async (t) => {
  // Regression: Review 2 found that Step 2 passively returned "waiting" for
  // BEHIND PRs, leaving repos that require branches to be up-to-date stuck in
  // pre-merge until ci_timeout. BEHIND must attempt one auto-rebase, not stall.
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BEHIND" });
  // Rebase fails (e.g. network issue) — confirm we don't return a waiting outcome.
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(rec.ciPolls, 1, "must still poll CI — BEHIND does not bypass early-conflict check");
  assert.equal(rec.rebaseCalls, 1, "BEHIND must invoke tryRebaseAndPush");
  // #771: consume one-shot budget on fail so the next poll does not thrash rebase.
  assert.deepEqual(rec.marked, [WT_PATH], "failed BEHIND rebase still consumes the one-shot marker");
  const blockedOut2 = out as { advanced: false; status: "blocked"; reason: string; blockerKind: string };
  assert.equal(blockedOut2.status, "blocked");
  assert.match(blockedOut2.reason, /behind/);
  assert.doesNotMatch(blockedOut2.reason, /merge conflict/);
  assert.equal(blockedOut2.blockerKind, "merge-conflict");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /behind/, "block message must name the root cause");
  assert.doesNotMatch(rec.blocked[0], /merge conflict/, "must not use merge-conflict wording for an out-of-date branch");
});

test("non-conflicting PR with zero checks (no CI workflow) still advances after grace (#95)", async (t) => {
  // Empty rollup is only passable after the check-start grace window (#882 review).
  // Polling session with grace already elapsed → no-CI pass (#95).
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    return [];
  };
  deps.nowMs = () => 60_000;
  const cfg = { ...makeCfg(), ci_no_run_grace_s: 60 } as ReturnType<typeof makeCfg>;
  const pollingCtx = { ciGateEnteredAt: 0 };
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "visual-gate",
    summary: `PR #${PR_NUMBER} pre-merge gates passed`,
  });
  assert.equal(rec.ciPolls, 1, "zero checks treated as passing after grace, exactly one consult");
  assert.equal(rec.rebaseCalls, 0);
  assert.deepEqual(rec.blocked, []);
});

test("empty check rollup within grace window waits — does not advance as green CI (#882)", async (t) => {
  // First "no checks reported" / [] observation must not greenlight pre-merge
  // before Actions can attach check-runs for the reviewed SHA.
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    return [];
  };
  deps.nowMs = () => 0;
  const cfg = { ...makeCfg(), ci_no_run_grace_s: 60 } as ReturnType<typeof makeCfg>;
  const pollingCtx: { ciGateEnteredAt?: number } = {};
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "waiting for CI checks to appear",
  });
  assert.equal(rec.ciPolls, 1);
  assert.equal(pollingCtx.ciGateEnteredAt, 0, "grace timer starts on first empty observation");
  assert.deepEqual(rec.blocked, []);
});

test("non-conflicting PR: getPrChecks throws 'no checks reported' advances after grace (#882)", async (t) => {
  // Live gh exits non-zero with this message when a PR has zero check-runs.
  // Normalize to empty, then apply the same check-start grace as [] (#882 review).
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    throw new Error(
      "gh pr checks 883 failed: no checks reported on the 'pipeline/882-x' branch",
    );
  };
  deps.nowMs = () => 60_000;
  const cfg = { ...makeCfg(), ci_no_run_grace_s: 60 } as ReturnType<typeof makeCfg>;
  const pollingCtx = { ciGateEnteredAt: 0 };
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "visual-gate",
    summary: `PR #${PR_NUMBER} pre-merge gates passed`,
  });
  assert.equal(rec.ciPolls, 1, "exactly one consult after grace — no ci_timeout spin");
  assert.deepEqual(rec.blocked, []);
});

test("getPrChecks throws 'no checks reported' within grace window waits (#882)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    throw new Error(
      "gh pr checks 883 failed: no checks reported on the 'pipeline/882-x' branch",
    );
  };
  deps.nowMs = () => 1_000;
  const cfg = { ...makeCfg(), ci_no_run_grace_s: 60 } as ReturnType<typeof makeCfg>;
  const pollingCtx: { ciGateEnteredAt?: number } = {};
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "waiting for CI checks to appear",
  });
  assert.equal(rec.ciPolls, 1);
  assert.equal(pollingCtx.ciGateEnteredAt, 1_000);
  assert.deepEqual(rec.blocked, []);
});

// ---------------------------------------------------------------------------
// #1065 — never park first-conflict as human merge-conflict
// ---------------------------------------------------------------------------

test("#1065: first clean auto-rebase miss never setBlocked merge-conflict / manual rebase", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  deps.resolveMergeConflicts = async () => {
    rec.resolveCalls++;
    return {
      status: "exhausted",
      conflictPaths: ["core/scripts/pipeline.ts"],
      reason: "budget",
    };
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(rec.rebaseCalls, 1);
  assert.equal(rec.resolveCalls, 1);
  assert.equal(rec.blockedKinds.includes("merge-conflict"), false);
  for (const reason of rec.blocked) {
    assert.equal(
      isIllegalMergeConflictManualRebaseTerminal(reason),
      false,
      `illegal terminal reintroduced: ${reason}`,
    );
    assert.notEqual(reason, MERGE_CONFLICT_MANUAL_REBASE_TERMINAL);
  }
  const blocked = out as { blockerKind?: string; status: string };
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockerKind, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
});

test("#1065: additive help-string union fixture resolves and pushes without blocked", async (t) => {
  // Models the #1061 / #1064 class: dual-side additive CLI help-string unions.
  const fixture = [
    "  pipeline train    Advance base-eligible frontiers",
    "<<<<<<< HEAD",
    "  pipeline lineage  Intent lineage and drift-impact graph",
    "=======",
    "  pipeline recover-parked  One senior pass then reflow",
    ">>>>>>> origin/main",
    "  pipeline status   Read-only status",
  ].join("\n");
  const resolved = tryResolveAdditiveUnionContent(fixture);
  assert.ok(resolved !== null);
  assert.ok(resolved!.includes("pipeline lineage"));
  assert.ok(resolved!.includes("pipeline recover-parked"));
  assert.equal(resolved!.includes("<<<<<<<"), false);

  const { deps, rec, headSha } = makeDeps({ mergeable: false, mergeable_state: "CONFLICTING" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  deps.resolveMergeConflicts = async () => {
    rec.resolveCalls++;
    // Simulate successful resolve + push: advance authoritative head.
    headSha.current = SHA_AFTER_REBASE;
    return { status: "resolved_and_pushed", afterSha: SHA_AFTER_REBASE };
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "rebase-resolved; CI re-running",
  });
  assert.equal(rec.rebaseCalls, 1);
  assert.equal(rec.resolveCalls, 1);
  assert.deepEqual(rec.blocked, []);
  assert.deepEqual(rec.blockedKinds, []);
});

test("#1065: successful resolve returns waiting / CI re-running without blocked label", async (t) => {
  const { deps, rec, headSha } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  deps.resolveMergeConflicts = async () => {
    rec.resolveCalls++;
    headSha.current = SHA_AFTER_REBASE;
    return { status: "resolved_and_pushed", afterSha: SHA_AFTER_REBASE };
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: false,
    status: "waiting",
    reason: "rebase-resolved; CI re-running",
  });
  assert.equal(rec.blocked.length, 0);
});

test("#1065: budget exhaust with residual conflicts is product failure with paths", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  deps.resolveMergeConflicts = async () => ({
    status: "exhausted",
    conflictPaths: ["core/scripts/pipeline.ts", "core/scripts/types.ts"],
    reason: "implementer could not finish",
  });
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  const blocked = out as { status: string; blockerKind: string; reason: string };
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockerKind, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  assert.match(blocked.reason, /pipeline\.ts/);
  assert.match(blocked.reason, /types\.ts/);
  assert.notEqual(blocked.reason, MERGE_CONFLICT_MANUAL_REBASE_TERMINAL);
  assert.equal(isIllegalMergeConflictManualRebaseTerminal(blocked.reason), false);
  assert.equal(rec.blockedKinds[0], "review-findings");
  assert.equal(isIllegalMergeConflictManualRebaseTerminal(rec.blocked[0]!), false);
});

test("#1065 regression: #1061 18:07Z terminal text is not a legal first-conflict terminal", async (t) => {
  // Pure invariant: the recovery path builders and first-conflict outcomes must
  // never produce the exact legal terminal used in the #1061 park comment.
  assert.equal(
    isIllegalMergeConflictManualRebaseTerminal(MERGE_CONFLICT_MANUAL_REBASE_TERMINAL),
    true,
  );
  const product = buildConflictResolveExhaustedReason(["core/scripts/pipeline.ts"]);
  assert.equal(isIllegalMergeConflictManualRebaseTerminal(product), false);
  assert.notEqual(product, MERGE_CONFLICT_MANUAL_REBASE_TERMINAL);

  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => false;
  deps.resolveMergeConflicts = async () => ({
    status: "failed",
    reason: "could not be automatically rebased — manual rebase needed", // hostile inject
    conflictPaths: ["x.ts"],
  });
  await quiet(t, async () => {
    await advance(makeCfg(), ISSUE, {}, deps);
  });
  // Even if a resolver mis-reports manual-rebase wording, setBlocked kind must
  // not be merge-conflict and the emitted terminal must not equal the #1061 string
  // under merge-conflict (product path sanitizes / uses exhausted builder).
  assert.equal(rec.blockedKinds.includes("merge-conflict"), false);
  for (const r of rec.blocked) {
    assert.notEqual(r, MERGE_CONFLICT_MANUAL_REBASE_TERMINAL);
  }
});

test("#1065: reconcileConflictRebaseState escalates resolve instead of block_manual_rebase", () => {
  const first = reconcileConflictRebaseState({ headSha: SHA_HEAD, ledgerAttempted: false });
  assert.deepEqual(first.actions, [{ kind: "attempt_rebase" }]);

  const afterClean = reconcileConflictRebaseState({ headSha: SHA_HEAD, ledgerAttempted: true });
  assert.deepEqual(afterClean.actions, [{ kind: "escalate_resolve" }]);
  assert.equal(
    afterClean.actions.some((a) => a.kind === "block_manual_rebase"),
    false,
  );

  const exhausted = reconcileConflictRebaseState({
    headSha: SHA_HEAD,
    ledgerAttempted: true,
    resolveBudgetExhausted: true,
  });
  assert.deepEqual(exhausted.actions, [{ kind: "block_product_failure" }]);
});

test("#1065: first-conflict recovery waiting does not free wave via false human park", async (t) => {
  // Multi-item / train: while resolve is in progress (or succeeds to waiting),
  // the outcome must not be blocked merge-conflict — so disposition cannot treat
  // a false human park as completed solely because that park fired.
  const { deps, rec, headSha } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  deps.resolveMergeConflicts = async () => {
    rec.resolveCalls++;
    return { status: "in_progress", reason: "conflict-resolve in progress; re-entering pre-merge" };
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal((out as { status: string }).status, "waiting");
  assert.deepEqual(rec.blocked, []);
  assert.equal(rec.blockedKinds.includes("merge-conflict"), false);

  // Success path also non-blocked.
  deps.resolveMergeConflicts = async () => {
    headSha.current = SHA_AFTER_REBASE;
    return { status: "resolved_and_pushed", afterSha: SHA_AFTER_REBASE };
  };
  deps.tryRebaseAndPush = async () => false;
  deps.rebaseAlreadyAttempted = () => false;
  let out2;
  await quiet(t, async () => {
    out2 = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal((out2 as { status: string }).status, "waiting");
  assert.deepEqual(rec.blocked, []);
});
