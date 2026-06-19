// Review-SHA gate (#16): bind a verdict to the commit it evaluated and re-run
// review when HEAD has moved past it before the pre-merge gate acts.
//
// Two surfaces, all exercised without real I/O:
//   1. staleReviewNotice  — the notice text posted before a re-review.
//   2. enforceReviewShaGate — wiring: exact match proceeds; any mismatch
//      (including pipeline-internal commits) or missing sentinel bounces back
//      to the review round and posts the notice.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  diffUnchangedNotice,
  enforceReviewShaGate,
  isPipelineInternalCommit,
  staleReviewNotice,
  type DeltaReviewResult,
  type RunDeltaReviewFn,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import { computeDiffHash, countPriorRounds, DELTA_REVIEW_MARKER_PREFIX } from "../scripts/stages/review.ts";
import { overrideComment, scopedOverrideComment } from "../scripts/review-policy.ts";
import type { PipelineConfig, ReviewFinding, Stage } from "../scripts/types.ts";

const cfg = {} as unknown as PipelineConfig;
const SHA_REVIEWED = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";
const TEST_ACTOR = "pipeline-bot";

// ---------------------------------------------------------------------------
// isPipelineInternalCommit — pure (#98)
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: recognizes archive commits only, not developer commits", () => {
  assert.equal(isPipelineInternalCommit("chore: archive OpenSpec change(s) for #16"), true);
  // The pre-merge docs harness was removed (#91): a docs commit can only come
  // from a developer, so it must NOT be treated as pipeline-internal.
  assert.equal(isPipelineInternalCommit("docs: update documentation for #16"), false);
  // A developer's own docs/chore commit with different wording must NOT match.
  assert.equal(isPipelineInternalCommit("docs: rewrite the README intro"), false);
  assert.equal(isPipelineInternalCommit("chore: bump deps"), false);
  assert.equal(isPipelineInternalCommit("fix: address review 2 findings (#16)"), false);
  assert.equal(isPipelineInternalCommit("feat: add a thing"), false);
});

// ---------------------------------------------------------------------------
// isPipelineInternalCommit — auto-format commits (#228 spec alignment)
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: auto-format commit is NOT pipeline-internal (#228)", () => {
  // The spec (review-sha-gating/spec.md) now restricts the pipeline-internal
  // exemption to OpenSpec archive commits only. Auto-format commits proceed to the
  // diff-hash check; if the diff changed they trigger a delta review.
  assert.equal(isPipelineInternalCommit("chore: auto-format (#182)"), false);
  assert.equal(isPipelineInternalCommit("chore: auto-format (#1)"), false);
  assert.equal(isPipelineInternalCommit("chore: auto-format dependencies"), false);
  assert.equal(isPipelineInternalCommit("chore: auto-format"), false);
  assert.equal(isPipelineInternalCommit("fix: address review 1 findings (#182)"), false);
});

// ---------------------------------------------------------------------------
// staleReviewNotice — pure
// ---------------------------------------------------------------------------

test("staleReviewNotice: names both short SHAs when the reviewed SHA is known", () => {
  const notice = staleReviewNotice(SHA_REVIEWED, SHA_HEAD);
  assert.match(notice, /HEAD has moved from `1111111` to `2222222`/);
});

test("staleReviewNotice: explains the missing-sentinel case", () => {
  const notice = staleReviewNotice(null, SHA_HEAD);
  assert.match(notice, /did not record the commit it evaluated/);
  assert.match(notice, /`2222222`/);
});

// ---------------------------------------------------------------------------
// enforceReviewShaGate — wiring
// ---------------------------------------------------------------------------

interface Rec {
  comments: string[];
  transitions: { from: Stage; to: Stage }[];
  blocked: Array<{ reason: string }>;
}

function makeDeps(opts: {
  commentBody: string | null;
  headSha: string;
  commits?: { oid: string; messageHeadline: string }[];
  getPrDiff?: () => Promise<string>;
  getCommitDeltaDiff?: () => Promise<string>;
  runDeltaReview?: RunDeltaReviewFn;
  getForIssue?: () => Promise<{ path: string } | null>;
  extraCommentBodies?: string[];
  /** Override the simulated gh actor (default: TEST_ACTOR; pass null to simulate auth failure). */
  ghActor?: string | null;
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const actor = opts.ghActor === undefined ? TEST_ACTOR : opts.ghActor;
  const comments = opts.commentBody === null
    ? []
    : [{ body: opts.commentBody, author: TEST_ACTOR }];
  for (const b of opts.extraCommentBodies ?? []) comments.push({ body: b, author: TEST_ACTOR });
  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({ comments }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getIssueDetail"]>>>,
    getPrDetail: async () =>
      ({ head_sha: opts.headSha }) as Awaited<
        ReturnType<NonNullable<ShaGateDeps["getPrDetail"]>>
      >,
    getPrCommits: async () =>
      (opts.commits ?? []) as Awaited<ReturnType<NonNullable<ShaGateDeps["getPrCommits"]>>>,
    postComment: async (_cfg, _n, body) => {
      rec.comments.push(body);
    },
    transition: async (_cfg, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push({ reason });
    },
    getForIssue: async (_cfg, _n) =>
      opts.getForIssue ? (await opts.getForIssue() as any) : null,
    getGhActor: async () => actor,
    ...(opts.getPrDiff && {
      getPrDiff: async (_cfg, _n) => opts.getPrDiff!(),
    }),
    ...(opts.getCommitDeltaDiff && {
      getCommitDeltaDiff: async (_cfg, _n, _b, _h) => opts.getCommitDeltaDiff!(),
    }),
    ...(opts.runDeltaReview && { runDeltaReview: opts.runDeltaReview }),
  };
  return { deps, rec };
}

// An archive commit the pipeline authors in pre-merge (matches the exact
// prefix isPipelineInternalCommit recognizes).
const ARCHIVE_COMMIT = {
  oid: "3333333333333333333333333333333333333333",
  messageHeadline: "chore: archive OpenSpec change(s) for #16",
};
const ARCHIVE_COMMIT_AT_HEAD = {
  oid: SHA_HEAD,
  messageHeadline: "chore: archive OpenSpec change(s) for #16",
};
// The old pre-merge docs harness prefix — no longer pipeline-internal (#91),
// so the gate must classify it as a developer commit.
const DOCS_COMMIT = { oid: SHA_HEAD, messageHeadline: "docs: update documentation for #16" };
const DEV_COMMIT = { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#16)" };

function reviewComment(round: 1 | 2, sha: string | null): string {
  const sentinel = sha ? `\n\n<!-- reviewed-sha: ${sha} -->` : "";
  return `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — approve\n\nLGTM${sentinel}`;
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

test("enforceReviewShaGate: SHA matches HEAD → proceeds, no re-review (6.4)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_REVIEWED,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "a fresh verdict lets pre-merge proceed");
  assert.deepEqual(rec.transitions, [], "no transition on a match");
  assert.deepEqual(rec.comments, [], "no notice on a match");
});

test("enforceReviewShaGate: SHA mismatch (developer commit) → bounces to review and posts notice (6.5)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement the thing" }, DEV_COMMIT],
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "review-2",
    summary: `re-review: HEAD moved to ${SHA_HEAD.slice(0, 7)}`,
  });
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }]);
  assert.equal(rec.comments.length, 1, "the stale-verdict notice must be posted");
  assert.match(rec.comments[0], /HEAD has moved from `1111111` to `2222222`/);
});

test("enforceReviewShaGate: ONLY pipeline-internal commits after review SHA → proceeds, no re-review (#98)", async (t) => {
  // The pipeline's own archive commits do not change the reviewed code, so
  // they must not invalidate the verdict. Re-reviewing them re-ran the reviewer
  // on the pipeline's own commits every run, causing a non-converging cascade.
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement the thing" },
      ARCHIVE_COMMIT,
      ARCHIVE_COMMIT_AT_HEAD, // oid === SHA_HEAD
    ],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "only archive commits landed since review → verdict is still valid");
  assert.deepEqual(rec.transitions, [], "no re-review for pipeline-internal commits");
  assert.deepEqual(rec.comments, [], "no stale notice");
});

test("enforceReviewShaGate: a docs-prefix commit since review → treated as developer commit, re-review (#91)", async (t) => {
  // The pre-merge docs step no longer exists, so a `docs: update documentation
  // for #N` commit is unreviewed developer work and must bounce to re-review.
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement the thing" },
      DOCS_COMMIT, // oid === SHA_HEAD
    ],
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }]);
  assert.equal(rec.comments.length, 1, "the stale-verdict notice must be posted");
});

test("enforceReviewShaGate: internal commits + a developer commit → re-review (#98)", async (t) => {
  // A mixed range that includes any non-internal commit must still bounce —
  // #16's value (catching unreviewed developer/fix commits) is preserved.
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement the thing" },
      ARCHIVE_COMMIT,
      DEV_COMMIT, // oid === SHA_HEAD; a developer fix commit
    ],
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }]);
});

test("enforceReviewShaGate: reviewed SHA absent from history (rebased) → re-review (#98)", async (t) => {
  // If the reviewed commit isn't in the PR's commit list (history was rewritten),
  // we cannot prove only internal commits landed → fall back to a safe re-review.
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [ARCHIVE_COMMIT_AT_HEAD], // reviewed SHA not present
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }]);
});

test("enforceReviewShaGate: review comment has no sentinel → treated as stale, re-review (6.6)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(1, null),
    headSha: SHA_HEAD,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.deepEqual(out, {
    advanced: true,
    from: "pre-merge",
    to: "review-1",
    summary: `re-review: HEAD moved to ${SHA_HEAD.slice(0, 7)}`,
  });
  assert.match(rec.comments[0], /did not record the commit it evaluated/);
});

test("enforceReviewShaGate: no prior review comment → proceeds (nothing to validate)", async (t) => {
  const { deps, rec } = makeDeps({ commentBody: null, headSha: SHA_HEAD });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null);
  assert.deepEqual(rec.transitions, []);
  assert.deepEqual(rec.comments, []);
});

// ---------------------------------------------------------------------------
// enforceReviewShaGate — diff-hash check + delta review (#228)
// ---------------------------------------------------------------------------

// A cfg with a valid review_policy, required when the delta-review partition path runs.
const cfgWithPolicy = {
  review_policy: { block_threshold: "low" as const, min_confidence: 0 },
  harnesses: { reviewer: "claude" },
} as unknown as PipelineConfig;

/** Review comment body that includes both the reviewed-sha and diff-hash sentinels. */
function reviewCommentWithHash(round: 1 | 2, sha: string | null, hash: string): string {
  return reviewComment(round, sha) + `\n<!-- verdict-diff-hash: ${hash} -->`;
}

test("enforceReviewShaGate: SHA mismatch but diff hash unchanged → verdict reused, notice posted (5.5)", async (t) => {
  const DIFF = "diff --git a/foo.ts b/foo.ts\nindex 0000000..1234567 100644\n+++ b/foo.ts\n+const x = 1;";
  const hash = computeDiffHash(DIFF);
  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, hash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => DIFF,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "diff unchanged → verdict reused, pre-merge proceeds");
  assert.deepEqual(rec.transitions, [], "no re-review transition");
  assert.equal(rec.comments.length, 1, "diffUnchangedNotice must be posted");
  assert.match(rec.comments[0], /Diff unchanged since last review/);
  assert.match(rec.comments[0], /2222222/); // headSha short form
});

test("enforceReviewShaGate: SHA mismatch, diff changed, delta review approves → proceeds (5.6)", async (t) => {
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const deltaResult: DeltaReviewResult = {
    verdict: "approve",
    findings: [],
    summary: "Delta LGTM — no new issues",
  };
  const runDeltaReview: RunDeltaReviewFn = async () => deltaResult;
  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "delta approve → pre-merge proceeds");
  assert.deepEqual(rec.transitions, [], "must NOT transition to review-2");
  assert.equal(rec.comments.length, 1, "delta review comment posted");
  assert.match(rec.comments[0], /reviewed-sha:/, "new reviewed-sha sentinel embedded");
  assert.match(rec.comments[0], /verdict-diff-hash:/, "new diff-hash sentinel embedded");
  assert.deepEqual(rec.blocked, [], "no setBlocked call");
});

test("enforceReviewShaGate: SHA mismatch, diff changed, delta review blocks → pre-merge blocked, not review-2 (5.7)", async (t) => {
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const blockingFinding: ReviewFinding = {
    file: "foo.ts",
    title: "Unsafe cast introduced",
    description: "New code performs an unsafe cast without validation.",
    severity: "critical",
  };
  const deltaResult: DeltaReviewResult = {
    verdict: "needs-attention",
    findings: [blockingFinding],
    summary: "Delta review found critical issue",
  };
  const runDeltaReview: RunDeltaReviewFn = async () => deltaResult;
  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
    "returns blocked Outcome",
  );
  assert.deepEqual(rec.transitions, [], "must NOT route to review-2");
  assert.equal(rec.blocked.length, 1, "setBlocked called once");
  assert.match(rec.blocked[0].reason, /Pre-merge delta review found blocking findings/);
});

test("enforceReviewShaGate: only pipeline-internal commits → exempted before diff-hash check (5.8)", async (t) => {
  let getPrDiffCalled = false;
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
      ARCHIVE_COMMIT_AT_HEAD, // only pipeline-internal since reviewed SHA
    ],
    getPrDiff: async () => { getPrDiffCalled = true; return "irrelevant"; },
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "pipeline-internal exemption → proceeds");
  assert.equal(getPrDiffCalled, false, "diff-hash check must NOT run for pipeline-internal commits");
  assert.deepEqual(rec.transitions, [], "no transition");
  assert.deepEqual(rec.comments, [], "no notice");
});

// ---------------------------------------------------------------------------
// enforceReviewShaGate — regression tests for fix-round-1 findings (#228)
// ---------------------------------------------------------------------------

test("enforceReviewShaGate: delta review returns needs-attention+0-findings → falls back to full re-review (fix-2)", async (t) => {
  // Regression: an unparseable delta review output (needs-attention, zero findings)
  // must NOT be treated as an implicit approval. The gate should throw and fall
  // back to the conservative full re-review path.
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const unparseable: DeltaReviewResult = {
    verdict: "needs-attention",
    findings: [],
    summary: "prose output that could not be parsed into findings",
  };
  const runDeltaReview: RunDeltaReviewFn = async () => unparseable;
  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  // Expect full re-review (transition to review-2), not approval and not blocked.
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }], "falls back to full re-review");
  assert.deepEqual(rec.blocked, [], "must NOT call setBlocked on a parse failure");
});

test("enforceReviewShaGate: getCommitDeltaDiff throws → falls back to full re-review (fix-3)", async (t) => {
  // Regression: if local delta diff generation fails (git error or empty output),
  // the catch block must trigger the conservative full re-review rather than silently
  // reviewing an empty diff.
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => { throw new Error("git diff failed: object not found"); },
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(rec.transitions, [{ from: "pre-merge", to: "review-2" }], "delta diff failure → full re-review");
  assert.deepEqual(rec.blocked, [], "must NOT call setBlocked on a diff failure");
});

// ---------------------------------------------------------------------------
// enforceReviewShaGate — fix-round-2 findings (#228)
// ---------------------------------------------------------------------------

test("countPriorRounds: delta review comment does NOT count as review-2 round (Finding 1)", () => {
  // A delta review comment uses DELTA_REVIEW_MARKER_PREFIX, not "## Review 2 …".
  // advanceReview counts prior rounds by the "## Review 2" prefix; delta reviews
  // must be excluded so they do not consume the max_adversarial_rounds ceiling.
  const deltaBody = `${DELTA_REVIEW_MARKER_PREFIX} — approve (commit abc1234)\n**Reviewer**: codex\n\nLGTM`;
  const review2Body = "## Review 2 (Adversarial) — approve (commit def5678)\n**Reviewer**: codex\n\nLGTM";
  const comments = [
    { body: deltaBody },
    { body: review2Body },
    { body: deltaBody },
  ];
  // Only the actual Review 2 comment counts; delta review comments must not count.
  assert.equal(
    countPriorRounds(comments, 2),
    1,
    "only ## Review 2 comments count, not ## Pre-merge Delta Review comments",
  );
  // Verify countPriorRounds(comments, 1) also ignores delta reviews
  assert.equal(countPriorRounds(comments, 1), 0, "round-1 count must also ignore delta reviews");
});

test("enforceReviewShaGate: HEAD moved during delta review → falls back to full re-review (Finding 2)", async (t) => {
  // Regression: a push landing while the delta reviewer is running means the
  // approval covers an old SHA. The gate must detect this and re-enter the SHA
  // gate (fall to full re-review) instead of proceeding to CI/ready-to-deploy.
  const SHA_NEW_HEAD = "3333333333333333333333333333333333333333";
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);

  let getPrDetailCalls = 0;
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const comments = [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }];
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments }) as any,
    getPrDetail: async () => {
      getPrDetailCalls++;
      // First call returns SHA_HEAD (gate's initial head read).
      // Second call (HEAD re-validation after delta review) returns SHA_NEW_HEAD.
      return ({ head_sha: getPrDetailCalls === 1 ? SHA_HEAD : SHA_NEW_HEAD }) as any;
    },
    getPrCommits: async () =>
      [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT] as any,
    getForIssue: async () => null,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview: async () => ({
      verdict: "approve" as const,
      findings: [],
      summary: "Delta LGTM",
    }),
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };

  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });

  // Delta approved but HEAD moved during review → must fall back to full re-review.
  assert.deepEqual(
    rec.transitions,
    [{ from: "pre-merge", to: "review-2" }],
    "HEAD moved during delta review → must fall back to full re-review, not proceed",
  );
  assert.deepEqual(rec.blocked, [], "must NOT call setBlocked — re-review handles it");
});

test("enforceReviewShaGate: delta review invoked with worktree path from getForIssue (Finding 3)", async (t) => {
  // The delta reviewer must run from the issue worktree (not cfg.repo_dir) so it
  // can inspect PR-branch files. Verify getForIssue output is plumbed through.
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const FAKE_WORKTREE_PATH = "/fake/worktrees/issue-16";

  const capturedArgs: { worktreePath: string; specContext: string }[] = [];
  const runDeltaReview: RunDeltaReviewFn = async (
    _cfg, _n, _d, _diff, worktreePath, specContext,
  ) => {
    capturedArgs.push({ worktreePath, specContext });
    return { verdict: "approve" as const, findings: [], summary: "Delta LGTM" };
  };

  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    getForIssue: async () => ({ path: FAKE_WORKTREE_PATH }),
  });

  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });

  assert.equal(capturedArgs.length, 1, "runDeltaReview should have been called once");
  assert.equal(
    capturedArgs[0].worktreePath,
    FAKE_WORKTREE_PATH,
    "delta reviewer must receive the issue worktree path, not cfg.repo_dir",
  );
});

test("enforceReviewShaGate: delta self-review disclosure applied in posted comment (Finding 4)", async (t) => {
  // When invokeReviewer falls back to the same implementing harness, the posted
  // delta comment must carry the selfReviewBanner disclosure. The DeltaReviewResult
  // now carries effectiveReviewer/selfReview fields for this purpose.
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const oldHash = computeDiffHash(OLD_DIFF);
  const selfReviewResult: DeltaReviewResult = {
    verdict: "approve",
    findings: [],
    summary: "Self-review: LGTM",
    effectiveReviewer: "claude",
    selfReview: true,
  };

  const { deps, rec } = makeDeps({
    commentBody: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview: async () => selfReviewResult,
  });

  const cfgWithTwoHarnesses = {
    review_policy: { block_threshold: "low" as const, min_confidence: 0 },
    harnesses: { reviewer: "codex", implementer: "claude" as const },
  } as unknown as PipelineConfig;

  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithTwoHarnesses, 16, 99, deps);
  });

  assert.equal(rec.comments.length, 1, "one delta comment posted");
  assert.match(
    rec.comments[0],
    /same-harness self-review/i,
    "self-review disclosure banner must appear in the delta review comment",
  );
  assert.match(
    rec.comments[0],
    /self-review\)/,
    "reviewer label must include (self-review) suffix",
  );
});

// ---------------------------------------------------------------------------
// enforceReviewShaGate — blocking review at matching HEAD must NOT be treated
// as a valid approval (#228 review-2 finding: gate-bypass on re-entry)
//
// A blocking pre-merge delta review posts its verdict carrying `reviewed-sha ==
// HEAD` and then setBlocks at pipeline:pre-merge. On re-entry the SHA matches, so
// the old `reviewed.sha === head → return null` advanced toward ready-to-deploy
// with unresolved blockers. The gate must re-check the recorded blocking keys
// against current overrides before accepting a matching SHA.
// ---------------------------------------------------------------------------

function blockingReviewComment(round: 1 | 2, sha: string, keys: string[]): string {
  return [
    `## Review ${round} (Adversarial) — needs-attention`,
    "",
    "No-ship: blocking findings remain.",
    "",
    `<!-- reviewed-sha: ${sha} -->`,
    `<!-- pipeline-blocking-keys: ${[...keys].sort().join(",")} -->`,
  ].join("\n");
}

function advisoryReviewComment(round: 1 | 2, sha: string): string {
  // Advisory-only round: an explicit but EMPTY blocking-keys marker.
  return [
    `## Review ${round} (Adversarial) — needs-attention`,
    "",
    "Advisory findings only.",
    "",
    `<!-- reviewed-sha: ${sha} -->`,
    `<!-- pipeline-blocking-keys:  -->`,
  ].join("\n");
}

function legacyBlockingReviewComment(round: 1 | 2, sha: string, keys: string[]): string {
  // Pre-marker format: override-key tokens in body, no pipeline-blocking-keys marker.
  const keyLines = keys.map((k) => `**[high] Finding title** \`override-key: ${k}\``);
  return [
    `## Review ${round} (Adversarial) — needs-attention`,
    "",
    "No-ship: blocking findings remain.",
    "",
    ...keyLines,
    "",
    `<!-- reviewed-sha: ${sha} -->`,
  ].join("\n");
}

function overrideSentinelComment(key: string): string {
  return `## Pipeline: Finding override\n\n<!-- pipeline-override: ${key} deferred -->`;
}

test("enforceReviewShaGate: blocking review at matching HEAD → kept blocked, does NOT proceed (#228)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487", "abcdef01"]),
    headSha: SHA_HEAD,
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "must not return null (proceed) when blockers remain at the reviewed HEAD");
  assert.equal((out as any)?.status, "blocked", "must report a blocked outcome");
  assert.equal(rec.blocked.length, 1, "must keep pre-merge blocked");
  assert.deepEqual(rec.transitions, [], "must not advance toward ready-to-deploy");
});

test("enforceReviewShaGate: blocking review at matching HEAD with ALL keys overridden → proceeds (#228)", async (t) => {
  const { deps } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487", "abcdef01"]),
    headSha: SHA_HEAD,
    extraCommentBodies: [overrideSentinelComment("953ac487"), overrideSentinelComment("abcdef01")],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = { advanced: false } as any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "every recorded blocker overridden → a matching SHA is a valid approval");
});

test("enforceReviewShaGate: blocking review at matching HEAD with PARTIAL override → still blocked (#228)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487", "abcdef01"]),
    headSha: SHA_HEAD,
    extraCommentBodies: [overrideSentinelComment("953ac487")], // only 1 of 2 dispositioned
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "a partial override must NOT unblock the remaining blocker");
  assert.equal((out as any)?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
});

test("enforceReviewShaGate: blocking review at matching HEAD with scoped override → forces re-review, does NOT block (#229)", async (t) => {
  // Regression (#229): an operator records a scoped override (category:rollback-safety)
  // after a blocking delta review. The pipeline clears `blocked` and re-enters pre-merge.
  // reuseBlockedBy must NOT block again — it must force a fresh review so partitionFindings
  // can apply the scoped disposition to the live findings.
  const scopeComment = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "deferred-#90",
    reason: "deferred #90",
    stage: "pre-merge",
    timestamp: "2026-06-19T00:00:00Z",
  });
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487", "abcdef01"]),
    headSha: SHA_HEAD,
    extraCommentBodies: [scopeComment],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "scoped override → must NOT return null (would skip verification)");
  assert.equal((out as any)?.advanced, true, "must transition to re-review, not block");
  assert.match((out as any)?.to, /review/, "must route back to a review stage");
  assert.deepEqual(rec.blocked, [], "must NOT call setBlocked with scoped overrides active");
  assert.equal(rec.transitions.length, 1, "one transition to review stage expected");
});

test("enforceReviewShaGate: scoped override from non-pipeline author is ignored (#229 Finding 1)", async (t) => {
  // Regression: before the fix, extractScopedOverrides in reuseBlockedBy used all
  // comments, so a forged scope sentinel from any commenter would trigger a re-review
  // that bypasses the blocker check. After the fix, only trustedComments (actor-filtered)
  // are passed; the attacker's sentinel must be invisible.
  const forgedScopeComment = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "rejected",
    reason: "forged by attacker",
    stage: "pre-merge",
    timestamp: "2026-06-19T00:00:00Z",
  });
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487"]),
    headSha: SHA_HEAD,
    extraCommentBodies: [],
  });
  // Override getIssueDetail to inject the forged comment authored by "attacker".
  const realGetIssueDetail = deps.getIssueDetail!;
  deps.getIssueDetail = async (cfg, n) => {
    const detail = await realGetIssueDetail(cfg, n);
    return {
      ...detail,
      comments: [
        ...detail.comments,
        { body: forgedScopeComment, author: "attacker" },
      ],
    } as any;
  };
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  // The forged scope must be ignored: the blocker must still be enforced.
  assert.notEqual(out, null, "forged scope override must not allow bypass");
  assert.equal((out as any)?.status, "blocked", "unresolved blocker must still block");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called");
  assert.deepEqual(rec.transitions, [], "must NOT transition to a review stage");
});

test("enforceReviewShaGate: key override from non-review-actor author is ignored (#229 Findings 4+5)", async (t) => {
  // Regression: override sentinels from accounts that have never posted a pipeline
  // review-round comment (and are not the current actor) must be ignored.
  // buildTrustedOverrideComments trusts: (a) current actor, (b) any author of a
  // "## Review N" headed comment. "attacker" satisfies neither criterion.
  const forgedOverride = overrideSentinelComment("953ac487");
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_HEAD, ["953ac487"]),
    headSha: SHA_HEAD,
    extraCommentBodies: [],
  });
  const realGetIssueDetail = deps.getIssueDetail!;
  deps.getIssueDetail = async (cfg, n) => {
    const detail = await realGetIssueDetail(cfg, n);
    return {
      ...detail,
      comments: [...detail.comments, { body: forgedOverride, author: "attacker" }],
    } as any;
  };
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "forged key override must not allow bypass");
  assert.equal((out as any)?.status, "blocked", "unresolved blocker must still block");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called");
  assert.deepEqual(rec.transitions, [], "must NOT transition to a review stage");
});

test("enforceReviewShaGate: key override from a different authorized runner is honored via allowlist (#229 Finding 5)", async (t) => {
  // An operator recorded an override under identity "other-bot" (a prior pipeline
  // run). The current run uses TEST_ACTOR. "other-bot" is in trusted_override_actors,
  // so their override must apply and the gate must proceed. Body-prefix heuristics
  // are NOT used (they are forgeable per Finding 6).
  const OTHER_ACTOR = "other-bot";
  const cfgWithAllowlist = { ...cfg, trusted_override_actors: [OTHER_ACTOR] } as unknown as PipelineConfig;
  const blockingComment = { body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: TEST_ACTOR };
  const overrideByOther = { body: overrideSentinelComment("953ac487"), author: OTHER_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [blockingComment, overrideByOther] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithAllowlist, 16, 99, deps);
  });
  assert.equal(out, null, "allowlisted actor's override must be trusted → gate proceeds");
  assert.deepEqual(rec.blocked, [], "must not block when all keys are overridden by allowlisted actor");
});

test("enforceReviewShaGate: forged review-heading comment cannot self-authorize override (#229 Finding 6)", async (t) => {
  // Regression: buildTrustedOverrideComments must NOT use body-prefix heuristics
  // to infer trusted actors. An attacker can post a comment starting with
  // "## Review 2 ..." and then an override sentinel — this must be rejected even
  // though the body looks like a review-round comment.
  const forgedReviewHeading = {
    body: `## Review 2 (Adversarial) — approve\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`,
    author: "attacker",
  };
  const forgedOverride = { body: overrideSentinelComment("953ac487"), author: "attacker" };
  const legitimateReview = { body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: TEST_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [legitimateReview, forgedReviewHeading, forgedOverride] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "forged review-heading self-authorization must not bypass the blocker");
  assert.equal((out as any)?.status, "blocked", "unresolved blocker must still block");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called");
});

test("enforceReviewShaGate: allowlisted prior-runner review → routes to re-review, not silent proceed (#229 Finding 7)", async (t) => {
  // Multi-actor handoff: OTHER_ACTOR ran the review, current runner is TEST_ACTOR.
  // OTHER_ACTOR is in trusted_override_actors. SHA extraction is actor-only (Finding 8),
  // so the review is invisible → reviewed=null. When the prior runner is allowlisted,
  // the gate must NOT silently proceed (that skips blocker enforcement). Instead it
  // routes to re-review so the current actor establishes its own verified baseline.
  // Non-allowlisted commenters posting review-headed comments do NOT trigger this path.
  const OTHER_ACTOR = "other-bot";
  const cfgWithAllowlist = {
    ...cfg,
    trusted_override_actors: [OTHER_ACTOR],
    steps: { standard_review: true, adversarial_review: true, plan_review: false, docs: false },
  } as unknown as PipelineConfig;
  const blockingByOther = { body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: OTHER_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [blockingByOther] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithAllowlist, 16, 99, deps);
  });
  assert.notEqual(out, null, "allowlisted prior-runner review must NOT silently let pre-merge proceed");
  assert.equal((out as any)?.advanced, true, "must route to re-review, not block");
  assert.match((out as any)?.to, /review/, "must transition to a review stage");
  assert.deepEqual(rec.blocked, [], "must not setBlocked — re-review is the correct response");
  assert.equal(rec.transitions.length, 1, "exactly one transition to re-review stage");
});

test("enforceReviewShaGate: non-allowlisted forged review-heading → no spurious re-review (DoS guard)", async (t) => {
  // A non-allowlisted commenter posts a review-headed comment. Without the DoS guard,
  // this would trigger re-review on every run. The gate must treat it as invisible
  // (no trusted SHA found) and return null (proceed to CI checks).
  const forgedReview = {
    body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]),
    author: "random-commenter",
  };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [forgedReview] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);  // no allowlist configured
  });
  assert.equal(out, null, "non-allowlisted review-headed comment must not trigger re-review");
  assert.deepEqual(rec.transitions, [], "must not transition on non-allowlisted forged review");
  assert.deepEqual(rec.blocked, []);
});

test("enforceReviewShaGate: allowlisted prior-runner review with adversarial_review=false → no livelock (#229 Finding 9)", async (t) => {
  // Regression: when adversarial_review is disabled, routing to review-2 on a
  // multi-actor handoff causes a livelock (pre-merge → review-2 [skipped] → pre-merge → ...).
  // When no review stage is enabled, the gate must NOT transition — fall through to CI.
  const OTHER_ACTOR = "other-bot";
  const cfgReviewsDisabled = {
    ...cfg,
    trusted_override_actors: [OTHER_ACTOR],
    steps: { standard_review: false, adversarial_review: false, plan_review: false, docs: false },
  } as unknown as PipelineConfig;
  const reviewByOther = { body: reviewComment(1, SHA_HEAD), author: OTHER_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [reviewByOther] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgReviewsDisabled, 16, 99, deps);
  });
  assert.equal(out, null, "reviews fully disabled → must not route to review-2 (livelock)");
  assert.deepEqual(rec.transitions, [], "must not transition when no review stage is enabled");
  assert.deepEqual(rec.blocked, []);
});

test("enforceReviewShaGate: allowlisted prior-runner blocking review + reviews disabled → blocks, not silent proceed (#229 Finding 10)", async (t) => {
  // When all reviews are disabled (livelock guard) but the allowlisted prior runner's
  // comment carried unresolved blocking keys, the gate must block rather than silently
  // skip blocker enforcement. The Finding 9 test covers the advisory-only case.
  const OTHER_ACTOR = "other-bot";
  const cfgReviewsDisabled = {
    ...cfg,
    trusted_override_actors: [OTHER_ACTOR],
    steps: { standard_review: false, adversarial_review: false, plan_review: false, docs: false },
  } as unknown as PipelineConfig;
  const blockingByOther = { body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: OTHER_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [blockingByOther] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgReviewsDisabled, 16, 99, deps);
  });
  assert.notEqual(out, null, "blocking prior review must NOT silently proceed when reviews are disabled");
  assert.equal((out as any)?.status, "blocked", "must block on unresolved keys from prior runner");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called once");
  assert.deepEqual(rec.transitions, [], "must not transition — block, not re-review");
});

test("enforceReviewShaGate: allowlisted prior-runner blocking review + all keys overridden + reviews disabled → proceeds (#229 Finding 10)", async (t) => {
  // Same scenario as above but with the key fully overridden. All keys accounted for →
  // fall through as if no blockers (Finding 10 approve/override path).
  const OTHER_ACTOR = "other-bot";
  const cfgReviewsDisabled = {
    ...cfg,
    trusted_override_actors: [OTHER_ACTOR],
    steps: { standard_review: false, adversarial_review: false, plan_review: false, docs: false },
  } as unknown as PipelineConfig;
  const blockingByOther = { body: blockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: OTHER_ACTOR };
  // Override posted by TEST_ACTOR (current actor), covering the blocking key
  const overrideByActor = { body: overrideSentinelComment("953ac487"), author: TEST_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [blockingByOther, overrideByActor] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgReviewsDisabled, 16, 99, deps);
  });
  assert.equal(out, null, "all blocking keys overridden → must proceed (fall through)");
  assert.deepEqual(rec.blocked, [], "must not block when all keys are overridden");
  assert.deepEqual(rec.transitions, [], "must not transition");
});

test("enforceReviewShaGate: legacy markerless blocking review from allowlisted prior runner + reviews disabled → blocks (#229 Finding 11)", async (t) => {
  // Regression: comments that predate the pipeline-blocking-keys marker carry
  // override-key tokens in the body. extractBlockingKeysMarker returns null
  // for those; only the legacy-aware extractBlockingKeysFromComment finds the keys.
  // The disabled-review path must use the legacy-aware extractor.
  const OTHER_ACTOR = "other-bot";
  const cfgReviewsDisabled = {
    ...cfg,
    trusted_override_actors: [OTHER_ACTOR],
    steps: { standard_review: false, adversarial_review: false, plan_review: false, docs: false },
  } as unknown as PipelineConfig;
  const legacyBlocking = { body: legacyBlockingReviewComment(2, SHA_HEAD, ["953ac487"]), author: OTHER_ACTOR };
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [legacyBlocking] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgReviewsDisabled, 16, 99, deps);
  });
  assert.notEqual(out, null, "legacy blocking comment must NOT silently proceed");
  assert.equal((out as any)?.status, "blocked", "must block on legacy override-key tokens");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called once");
  assert.deepEqual(rec.transitions, [], "must not transition");
});

test("enforceReviewShaGate: advisory-only review at matching HEAD (empty marker) → proceeds, no false block (#228)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: advisoryReviewComment(2, SHA_HEAD),
    headSha: SHA_HEAD,
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = { advanced: false } as any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "an advisory-only round records an empty marker → no blockers → proceed");
  assert.deepEqual(rec.blocked, [], "must not block on an advisory-only verdict");
});

// ---------------------------------------------------------------------------
// Reuse guard applies to ALL three verdict-reuse paths, not just exact-SHA
// (#228 review-2 round 4): diff-hash-unchanged and pipeline-internal-only
// short-circuits must also re-check recorded blockers, or a no-op / archive
// commit that preserves the verdict could bypass unresolved blocking findings.
// ---------------------------------------------------------------------------

function blockingReviewCommentWithHash(round: 1 | 2, sha: string, hash: string, keys: string[]): string {
  return blockingReviewComment(round, sha, keys) + `\n<!-- verdict-diff-hash: ${hash} -->`;
}

test("enforceReviewShaGate: diff-hash reuse path re-checks blockers — no-op commit cannot bypass (#228)", async (t) => {
  const DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const hash = computeDiffHash(DIFF);
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewCommentWithHash(2, SHA_REVIEWED, hash, ["c8091c93"]),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => DIFF,
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "diff-hash reuse must NOT proceed while a blocker is unresolved");
  assert.equal((out as any)?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
  assert.deepEqual(rec.transitions, []);
});

test("enforceReviewShaGate: diff-hash reuse path proceeds once the blocker is overridden (#228)", async (t) => {
  const DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const hash = computeDiffHash(DIFF);
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewCommentWithHash(2, SHA_REVIEWED, hash, ["c8091c93"]),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, DEV_COMMIT],
    getPrDiff: async () => DIFF,
    extraCommentBodies: [overrideSentinelComment("c8091c93")],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = { advanced: false } as any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "blocker overridden → diff-hash reuse is a valid approval");
  assert.match(rec.comments[0], /Diff unchanged since last review/);
});

test("enforceReviewShaGate: pipeline-internal-only commits cannot reuse a blocking verdict (#228)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: blockingReviewComment(2, SHA_REVIEWED, ["953ac487"]),
    headSha: SHA_HEAD,
    commits: [{ oid: SHA_REVIEWED, messageHeadline: "feat: implement" }, ARCHIVE_COMMIT_AT_HEAD],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.notEqual(out, null, "an archive commit must NOT let a blocking verdict be reused");
  assert.equal((out as any)?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// Self-review banner placement (#228 Finding 5): the banner must appear AFTER
// the heading so isDeltaReviewComment (startsWith) still recognizes the comment
// on subsequent pre-merge re-entries. A banner prepended before the heading
// made the self-review delta comment invisible — the gate fell back to an
// older Review 2 comment and triggered a spurious re-review or stale-blocker
// re-check.
// ---------------------------------------------------------------------------

test("enforceReviewShaGate: self-review delta approval is recognized on re-entry (Finding 5)", async (t) => {
  // Build a correctly-formatted self-review delta approval: banner AFTER heading.
  // This mirrors what the fixed code posts (heading first, banner second line).
  const selfReviewDeltaApproval = [
    `${DELTA_REVIEW_MARKER_PREFIX} — approve (commit ${SHA_HEAD.slice(0, 7)})`,
    "",
    "> ⚠️ **Same-harness self-review (#39).** The cross-harness reviewer `codex` is not installed.",
    "",
    "**Reviewer**: claude (self-review)",
    "",
    "Delta LGTM: no new issues introduced.",
    "",
    `<!-- reviewed-sha: ${SHA_HEAD} -->`,
    `<!-- verdict-diff-hash: abcd1234abcd1234 -->`,
  ].join("\n");

  // Older Review 2 blocking comment — must NOT be selected if the delta comment is visible.
  const olderBlockingR2 = blockingReviewComment(2, SHA_REVIEWED, ["stalekey"]);

  const { deps, rec } = makeDeps({
    commentBody: olderBlockingR2,
    headSha: SHA_HEAD,
    extraCommentBodies: [selfReviewDeltaApproval],
  });

  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "self-review delta approval covers SHA_HEAD → gate must proceed");
  assert.deepEqual(rec.blocked, [], "must not block based on the older Review 2 comment");
  assert.deepEqual(rec.transitions, [], "must not re-review when delta approval covers current HEAD");
});

// ---------------------------------------------------------------------------
// Comment-provenance gate (#228 Finding 9): the SHA gate must only trust review
// comments authored by the authenticated pipeline actor. A forged comment from
// a different commenter — with a matching SHA sentinel — must be ignored, and
// the gate must fall through to a full re-review. If the actor lookup fails
// (gh unavailable), fail-closed: treat all review comments as untrusted (#228 Finding 8).
// ---------------------------------------------------------------------------

test("enforceReviewShaGate: forged review comment (wrong author) is ignored — gate re-reviews (Finding 9)", async (t) => {
  // Build an approval comment that the pipeline would normally trust, but authored
  // by a different user. The gate must not proceed on the basis of this comment.
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const forgedComment = { body: reviewComment(2, SHA_HEAD), author: "attacker" };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [forgedComment] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
      DEV_COMMIT,
    ] as any,
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };

  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  // No trusted review comment found → gate treats it as "no prior review" → proceeds.
  // (enforceReviewShaGate returns null when there is no trusted reviewed SHA.)
  assert.equal(out, null, "forged comment from wrong author → no trusted SHA found → gate proceeds (no re-review attempted)");
  assert.deepEqual(rec.transitions, [], "must not attempt a spurious re-review transition");
});

test("enforceReviewShaGate: actor lookup failure (gh unavailable) → blocked with needs-human, NOT proceed (Finding 8)", async (t) => {
  // If getGhActor() returns null (expired token, network error), the gate must
  // fail-closed by blocking with needs-human — NOT by silently returning null (which
  // would disable stale-verdict and unresolved-blocker enforcement for the run).
  // A transient auth failure must never open the gate.
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const approvalComment = { body: reviewComment(2, SHA_HEAD), author: TEST_ACTOR };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments: [approvalComment] }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => [] as any,
    getForIssue: async () => null,
    getGhActor: async () => null, // ← simulates auth failure
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
  };

  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  // Actor unavailable → must block, not proceed.
  assert.notEqual(out, null, "actor lookup failure must NOT return null (proceed)");
  assert.equal((out as any)?.status, "blocked", "must return blocked outcome");
  assert.equal(rec.blocked.length, 1, "setBlocked must be called");
  assert.match(rec.blocked[0].reason, /actor/, "block reason must mention actor");
  assert.deepEqual(rec.transitions, [], "must not transition on auth failure");
});
