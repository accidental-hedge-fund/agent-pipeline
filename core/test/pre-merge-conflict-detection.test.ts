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
 */
function makeDeps(prDetail: Partial<PrDetailFake>): { deps: AdvancePreMergeDeps; rec: Rec } {
  const rec: Rec = { ciPolls: 0, rebaseCalls: 0, marked: [], blocked: [] };
  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [] }) as unknown as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () => ({ head_sha: SHA_HEAD, ...prDetail }) as PrDetailFake,
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
      return true;
    },
    rebaseAlreadyAttempted: () => false,
    markRebaseAttempted: (wtPath) => {
      rec.marked.push(wtPath);
    },
    // In CI, gh api user fails with machine tokens → inject mock so the SHA gate
    // doesn't hit the real gh CLI and return null (#229).
    getGhActor: async () => "test-actor",
  };
  return { deps, rec };
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
  assert.deepEqual(rec.marked, [WT_PATH], "rebase marked as attempted on success");
  assert.deepEqual(rec.blocked, []);
});

test("CONFLICTING PR with rebase already attempted blocks, no second rebase (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.rebaseAlreadyAttempted = () => true;
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "merge conflict" });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 0, "no second rebase attempt once the marker is set");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /merge conflict/);
  assert.match(rec.blocked[0], /manual rebase needed/);
});

test("CONFLICTING PR whose rebase fails blocks with a conflict-specific reason (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: false, mergeable_state: "DIRTY" });
  deps.tryRebaseAndPush = async () => {
    rec.rebaseCalls++;
    return false;
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "merge conflict" });
  assert.equal(rec.ciPolls, 0, "CI checks must never be polled for a conflicting PR");
  assert.equal(rec.rebaseCalls, 1);
  assert.deepEqual(rec.marked, [], "a failed rebase is not marked as attempted");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /merge conflict/);
  assert.match(rec.blocked[0], /manual rebase needed/);
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
  assert.deepEqual(rec.marked, [], "failed rebase must not mark as attempted");
  const blockedOut2 = out as { advanced: false; status: "blocked"; reason: string; blockerKind: string };
  assert.equal(blockedOut2.status, "blocked");
  assert.match(blockedOut2.reason, /behind/);
  assert.doesNotMatch(blockedOut2.reason, /merge conflict/);
  assert.equal(blockedOut2.blockerKind, "merge-conflict");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /behind/, "block message must name the root cause");
  assert.doesNotMatch(rec.blocked[0], /merge conflict/, "must not use merge-conflict wording for an out-of-date branch");
});

test("non-conflicting PR with zero checks (no CI workflow) still advances (#95)", async (t) => {
  const { deps, rec } = makeDeps({ mergeable: true, mergeable_state: "CLEAN" });
  deps.getPrChecks = async () => {
    rec.ciPolls++;
    return [];
  };
  let out;
  await quiet(t, async () => {
    out = await advance(makeCfg(), ISSUE, {}, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "ready-to-deploy",
    summary: `PR #${PR_NUMBER} pre-merge gates passed`,
  });
  assert.equal(rec.ciPolls, 1, "zero checks treated as passing, exactly one consult");
  assert.equal(rec.rebaseCalls, 0);
  assert.deepEqual(rec.blocked, []);
});
