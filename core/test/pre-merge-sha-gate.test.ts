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
import { computeDiffHash } from "../scripts/stages/review.ts";
import type { PipelineConfig, ReviewFinding, Stage } from "../scripts/types.ts";

const cfg = {} as unknown as PipelineConfig;
const SHA_REVIEWED = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";

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
// isPipelineInternalCommit — auto-format commits (#182)
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: auto-format commit is pipeline-internal", () => {
  assert.equal(isPipelineInternalCommit("chore: auto-format (#182)"), true);
  assert.equal(isPipelineInternalCommit("chore: auto-format (#1)"), true);
  // Must be an exact prefix — a developer's own chore with different text must NOT match.
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
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = { comments: [], transitions: [], blocked: [] };
  const comments = opts.commentBody === null ? [] : [{ body: opts.commentBody }];
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
