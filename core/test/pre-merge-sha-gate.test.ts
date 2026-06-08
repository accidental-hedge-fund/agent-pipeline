// Review-SHA gate (#16): bind a verdict to the commit it evaluated and re-run
// review when HEAD has moved past it before the pre-merge gate acts.
//
// Three surfaces, all exercised without real I/O:
//   1. classifyReviewGate — pure fresh/stale decision over the PR's commits.
//   2. staleReviewNotice  — the notice text posted before a re-review.
//   3. enforceReviewShaGate — wiring: match proceeds, mismatch / missing
//      sentinel bounces back to the review round and posts the notice.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewGate,
  enforceReviewShaGate,
  staleReviewNotice,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";

const cfg = {} as unknown as PipelineConfig;
const SHA_REVIEWED = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";
const SHA_DOCS = "3333333333333333333333333333333333333333";

// ---------------------------------------------------------------------------
// classifyReviewGate — pure
// ---------------------------------------------------------------------------

test("classifyReviewGate: exact match → fresh", () => {
  assert.equal(classifyReviewGate(SHA_REVIEWED, SHA_REVIEWED, []), "fresh");
});

test("classifyReviewGate: a developer commit after the reviewed SHA → stale", () => {
  const commits = [
    { oid: SHA_REVIEWED, messageHeadline: "feat: the reviewed change" },
    { oid: SHA_HEAD, messageHeadline: "fix: address review feedback" },
  ];
  assert.equal(classifyReviewGate(SHA_REVIEWED, SHA_HEAD, commits), "stale");
});

test("classifyReviewGate: only pipeline-internal commits after reviewed SHA → fresh", () => {
  const commits = [
    { oid: SHA_REVIEWED, messageHeadline: "feat: the reviewed change" },
    { oid: SHA_DOCS, messageHeadline: "docs: update documentation for #16" },
    { oid: SHA_HEAD, messageHeadline: "chore: archive OpenSpec change(s) for #16" },
  ];
  assert.equal(classifyReviewGate(SHA_REVIEWED, SHA_HEAD, commits), "fresh");
});

test("classifyReviewGate: reviewed SHA absent from the PR (rebased/force-pushed) → stale", () => {
  const commits = [{ oid: SHA_HEAD, messageHeadline: "feat: rewritten history" }];
  assert.equal(classifyReviewGate(SHA_REVIEWED, SHA_HEAD, commits), "stale");
});

test("classifyReviewGate: head differs but nothing follows the reviewed commit → stale", () => {
  const commits = [{ oid: SHA_REVIEWED, messageHeadline: "feat: the reviewed change" }];
  assert.equal(classifyReviewGate(SHA_REVIEWED, SHA_HEAD, commits), "stale");
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
  prCommitsCalls: number;
}

function makeDeps(opts: {
  commentBody: string | null;
  headSha: string;
  prCommits?: { oid: string; messageHeadline: string }[];
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = { comments: [], transitions: [], prCommitsCalls: 0 };
  const comments = opts.commentBody === null ? [] : [{ body: opts.commentBody }];
  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({ comments }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getIssueDetail"]>>>,
    getPrDetail: async () =>
      ({ head_sha: opts.headSha }) as Awaited<
        ReturnType<NonNullable<ShaGateDeps["getPrDetail"]>>
      >,
    getPrCommits: async () => {
      rec.prCommitsCalls += 1;
      return opts.prCommits ?? [];
    },
    postComment: async (_cfg, _n, body) => {
      rec.comments.push(body);
    },
    transition: async (_cfg, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
  };
  return { deps, rec };
}

function reviewComment(round: 1 | 2, sha: string | null): string {
  const sentinel = sha ? `\n\n<!-- reviewed-sha: ${sha} -->` : "";
  return `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — approve\n\nLGTM${sentinel}`;
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

test("enforceReviewShaGate: SHA matches HEAD → proceeds, no re-review, no commit lookup (6.4)", async (t) => {
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
  assert.equal(rec.prCommitsCalls, 0, "no commit lookup on an exact match (transparency)");
});

test("enforceReviewShaGate: SHA mismatch (developer commit) → bounces to review and posts notice (6.5)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    prCommits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: reviewed change" },
      { oid: SHA_HEAD, messageHeadline: "feat: snuck in after review" },
    ],
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

test("enforceReviewShaGate: only pipeline-internal commits since review → proceeds (no spurious re-review)", async (t) => {
  const { deps, rec } = makeDeps({
    commentBody: reviewComment(2, SHA_REVIEWED),
    headSha: SHA_HEAD,
    prCommits: [
      { oid: SHA_REVIEWED, messageHeadline: "feat: reviewed change" },
      { oid: SHA_HEAD, messageHeadline: "docs: update documentation for #16" },
    ],
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 16, 99, deps);
  });
  assert.equal(out, null, "a docs-only HEAD move must not trigger re-review");
  assert.deepEqual(rec.transitions, []);
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
  assert.equal(rec.prCommitsCalls, 0, "a missing sentinel is stale without a commit lookup");
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
