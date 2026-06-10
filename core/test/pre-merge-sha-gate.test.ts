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
  enforceReviewShaGate,
  isPipelineInternalCommit,
  staleReviewNotice,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";

const cfg = {} as unknown as PipelineConfig;
const SHA_REVIEWED = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";

// ---------------------------------------------------------------------------
// isPipelineInternalCommit — pure (#98)
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: recognizes pre-merge docs + archive commits, not developer commits", () => {
  assert.equal(isPipelineInternalCommit("docs: update documentation for #16"), true);
  assert.equal(isPipelineInternalCommit("chore: archive OpenSpec change(s) for #16"), true);
  // A developer's own docs/chore commit with different wording must NOT match.
  assert.equal(isPipelineInternalCommit("docs: rewrite the README intro"), false);
  assert.equal(isPipelineInternalCommit("chore: bump deps"), false);
  assert.equal(isPipelineInternalCommit("fix: address review 2 findings (#16)"), false);
  assert.equal(isPipelineInternalCommit("feat: add a thing"), false);
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
}

function makeDeps(opts: {
  commentBody: string | null;
  headSha: string;
  commits?: { oid: string; messageHeadline: string }[];
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = { comments: [], transitions: [] };
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
  };
  return { deps, rec };
}

// A docs/archive commit the pipeline authors in pre-merge (matches the exact
// prefixes isPipelineInternalCommit recognizes).
const DOCS_COMMIT = { oid: SHA_HEAD, messageHeadline: "docs: update documentation for #16" };
const ARCHIVE_COMMIT = {
  oid: "3333333333333333333333333333333333333333",
  messageHeadline: "chore: archive OpenSpec change(s) for #16",
};
const DEV_COMMIT = { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#16)" };

function reviewComment(round: 1 | 2, sha: string | null): string {
  const sentinel = sha ? `\n\n<!-- reviewed-sha: ${sha} -->` : "";
  return `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — approve\n\nLGTM${sentinel}`;
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
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
  // The pipeline's own docs/archive commits do not change the reviewed code, so
  // they must not invalidate the verdict. Re-reviewing them re-ran the reviewer
  // on the pipeline's own commits every run, causing a non-converging cascade.
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    commits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement the thing" },
      ARCHIVE_COMMIT,
      DOCS_COMMIT, // oid === SHA_HEAD
    ],
  });
  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "only docs/archive landed since review → verdict is still valid");
  assert.deepEqual(rec.transitions, [], "no re-review for pipeline-internal commits");
  assert.deepEqual(rec.comments, [], "no stale notice");
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
    commits: [DOCS_COMMIT], // reviewed SHA not present
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
