// Regression tests for #95: a CONFLICTING PR creates no pull_request check
// runs (GitHub cannot build the merge ref), so pre-merge must detect the
// conflict BEFORE the CI poll and route to the rebase path — not poll for
// checks that can never appear until ci_timeout. Deps are injected via
// AdvancePreMergeDeps, the same DI pattern as pre-merge-single-ci-cycle.test.ts.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { advance, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
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
  marked: string[];
  blocked: string[];
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
  const rec: Rec = { ciPolls: 0, rebaseCalls: 0, marked: [], blocked: [] };
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
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push(reason);
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

test("CONFLICTING PR with rebase already attempted stays waiting — never parks merge-conflict (#1065)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(out?.advanced, false);
  assert.equal(out?.status, "waiting");
  assert.match(String(out?.reason ?? ""), /conflict-rebase-unresolved/);
  assert.notEqual((out as { blockerKind?: string }).blockerKind, "merge-conflict");
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.deepEqual(rec.blocked, [], "merge-conflict must not setBlocked as a human gate");
});

test("CONFLICTING PR whose rebase fails stays waiting — never parks merge-conflict (#1065)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(out?.advanced, false);
  assert.equal(out?.status, "waiting");
  assert.match(String(out?.reason ?? ""), /conflict-rebase-unresolved/);
  assert.notEqual((out as { blockerKind?: string }).blockerKind, "merge-conflict");
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1);
  assert.deepEqual(rec.blocked, [], "failed auto-rebase is not a human merge-conflict park");
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

test("BEHIND with rebase marker present waits — never parks merge-conflict (#1065)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BEHIND" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.equal(out?.status, "waiting");
  assert.match(String(out?.reason ?? ""), /conflict-rebase-unresolved|behind/);
  assert.notEqual((out as { blockerKind?: string }).blockerKind, "merge-conflict");
  assert.deepEqual(rec.blocked, [], "must not setBlocked for BEHIND");
  assert.equal(rec.rebaseCalls, 0, "must not attempt a second rebase");
});

test("post-CI BEHIND invokes tryRebaseAndPush instead of returning waiting indefinitely (#95 review-2 regression)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: null, mergeable_state: "BEHIND" });
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
  assert.equal(out?.status, "waiting");
  assert.match(String(out?.reason ?? ""), /conflict-rebase-unresolved/);
  assert.deepEqual(rec.blocked, [], "failed BEHIND rebase is not a human park (#1065)");
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
