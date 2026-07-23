// Pre-merge delta-round ceiling (#483): `review_policy.max_delta_rounds` caps
// how many pre-merge delta reviews an item can run, counted durably from its
// delta-review comment thread. At the ceiling, the reviewer seam is never
// invoked; `ceiling_action` disposes of the outstanding blocking findings
// instead. No real network/git/subprocess access — everything is a fake seam.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  enforceReviewShaGate,
  type DeltaReviewResult,
  type RunDeltaReviewFn,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import { computeDiffHash, formatDeltaReviewComment } from "../scripts/stages/review.ts";
import { findingKey, partitionFindings } from "../scripts/review-policy.ts";
import { buildPriorRoundDigest, settledFindings } from "../scripts/review-history.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";

const TEST_ACTOR = "pipeline-bot";
const renderCfg = { marker_footer: "*Automated by Claude Code Pipeline Skill*" } as unknown as PipelineConfig;

function padSha(prefix: string): string {
  return (prefix + "0".repeat(40)).slice(0, 40);
}

const SHA_1 = padSha("1");
const SHA_2 = padSha("2");
const SHA_3 = padSha("3");
const SHA_4 = padSha("4");
const SHA_HEAD = padSha("5");

function diffFor(n: number): string {
  return `diff --git a/foo.ts b/foo.ts\n+const x = ${n};`;
}

const MEDIUM_FINDING: ReviewFinding = {
  severity: "medium", title: "Minor churn finding", file: "foo.ts", category: "correctness",
  body: "b", confidence: 0.7, recommendation: "tidy up",
};
const CRITICAL_FINDING: ReviewFinding = {
  severity: "critical", title: "Unsafe cast introduced", file: "foo.ts", category: "correctness",
  body: "b", confidence: 0.95, recommendation: "validate before casting",
};

function deltaComment(sha: string, diffHash: string, blocking: ReviewFinding[] = []): string {
  const verdict = {
    verdict: (blocking.length ? "needs-attention" : "approve") as "needs-attention" | "approve",
    summary: "s", findings: blocking, next_steps: [] as string[], commitSha: sha,
  };
  const keys = new Set(blocking.map((f) => findingKey(f)));
  return formatDeltaReviewComment(renderCfg, verdict, "codex", keys.size ? keys : undefined, diffHash);
}

/** Four prior trusted delta-review comments — rounds 1-3 approve, round 4
 *  carries `finalBlocking` as its blocking finding(s). */
function fourPriorDeltaComments(finalBlocking: ReviewFinding[]): { author: string; body: string }[] {
  return [
    { author: TEST_ACTOR, body: deltaComment(SHA_1, computeDiffHash(diffFor(1))) },
    { author: TEST_ACTOR, body: deltaComment(SHA_2, computeDiffHash(diffFor(2))) },
    { author: TEST_ACTOR, body: deltaComment(SHA_3, computeDiffHash(diffFor(3))) },
    { author: TEST_ACTOR, body: deltaComment(SHA_4, computeDiffHash(diffFor(4)), finalBlocking) },
  ];
}

interface Rec {
  comments: string[];
  transitions: { from: string; to: string }[];
  blocked: { reason: string }[];
  createIssueCalls: { title: string; body: string }[];
  addIssueCommentCalls: { issueNumber: number; body: string }[];
}

function makeDeps(opts: {
  finalBlocking: ReviewFinding[];
  maxDeltaRounds: number;
  ceilingAction: "park" | "demote_and_advance";
  runDeltaReview?: RunDeltaReviewFn;
  getCommitDeltaDiff?: () => Promise<string>;
}): { deps: ShaGateDeps; rec: Rec; cfg: PipelineConfig } {
  const rec: Rec = { comments: [], transitions: [], blocked: [], createIssueCalls: [], addIssueCommentCalls: [] };
  const comments = fourPriorDeltaComments(opts.finalBlocking);
  const cfg = {
    review_policy: {
      block_threshold: "low", min_confidence: 0,
      max_delta_rounds: opts.maxDeltaRounds, ceiling_action: opts.ceilingAction,
    },
    harnesses: { reviewer: "claude" },
    marker_footer: renderCfg.marker_footer,
  } as unknown as PipelineConfig;

  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getIssueDetail"]>>>,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getPrDetail"]>>>,
    getPrCommits: async () => ([{ oid: SHA_HEAD, messageHeadline: "fix: address findings" }]) as Awaited<ReturnType<NonNullable<ShaGateDeps["getPrCommits"]>>>,
    getPrDiff: async () => diffFor(5),
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async (_cfg, _n, from, to) => { rec.transitions.push({ from, to }); },
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    createIssue: async (title: string, body: string) => {
      rec.createIssueCalls.push({ title, body });
      return 9001;
    },
    addIssueComment: async (issueNumber: number, body: string) => {
      rec.addIssueCommentCalls.push({ issueNumber, body });
    },
    ...(opts.runDeltaReview && { runDeltaReview: opts.runDeltaReview }),
    ...(opts.getCommitDeltaDiff && {
      getCommitDeltaDiff: async (_cfg, _n, _b, _h) => opts.getCommitDeltaDiff!(),
    }),
  };
  return { deps, rec, cfg };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

test("enforceReviewShaGate: at the delta-round cap, the reviewer seam is never invoked", async (t) => {
  let reviewerCalls = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    reviewerCalls++;
    return { verdict: "approve", findings: [], summary: "should not run" } as DeltaReviewResult;
  };
  const { deps, cfg } = makeDeps({
    finalBlocking: [MEDIUM_FINDING], maxDeltaRounds: 4, ceilingAction: "park", runDeltaReview,
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal(reviewerCalls, 0, "the delta reviewer must NOT be invoked at the ceiling");
});

test("enforceReviewShaGate: ceiling_action park routes to needs-human with the unresolved-blocker punch list", async (t) => {
  const { deps, rec, cfg } = makeDeps({
    finalBlocking: [MEDIUM_FINDING], maxDeltaRounds: 4, ceilingAction: "park",
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.deepEqual(out, {
    advanced: false, status: "blocked",
    reason: "pre-merge delta-round ceiling: 1 unresolved blocking finding(s)",
  });
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /4-round ceiling/);
  assert.equal(rec.comments.length, 1, "a ceiling comment must be posted");
  assert.match(rec.comments[0], /Pre-merge delta round ceiling reached/);
  assert.match(rec.comments[0], new RegExp(findingKey(MEDIUM_FINDING)));
  assert.equal(rec.createIssueCalls.length, 0, "park does not file a follow-up issue");
});

test("enforceReviewShaGate: ceiling_action demote_and_advance demotes below-high findings and proceeds", async (t) => {
  const { deps, rec, cfg } = makeDeps({
    finalBlocking: [MEDIUM_FINDING], maxDeltaRounds: 4, ceilingAction: "demote_and_advance",
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal(out, null, "demote_and_advance with only below-high findings proceeds");
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.createIssueCalls.length, 1, "a single tracked follow-up issue is filed");
  assert.match(rec.createIssueCalls[0].title, /Pre-merge delta review ceiling/);
  assert.ok(rec.comments.some((c) => /demoted and deferred/.test(c)));
  assert.ok(rec.comments.some((c) => /Finding override/.test(c)), "an audited override comment must be recorded for the demoted finding");
});

test("enforceReviewShaGate: a critical outstanding finding hard-parks even under demote_and_advance", async (t) => {
  const { deps, rec, cfg } = makeDeps({
    finalBlocking: [CRITICAL_FINDING], maxDeltaRounds: 4, ceilingAction: "demote_and_advance",
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal(out!.status, "blocked", "critical severity must hard-park regardless of ceiling_action");
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.createIssueCalls.length, 0);
});

test("enforceReviewShaGate: a critical outstanding finding hard-parks under park too", async (t) => {
  const { deps, cfg } = makeDeps({
    finalBlocking: [CRITICAL_FINDING], maxDeltaRounds: 4, ceilingAction: "park",
  });
  let out;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal(out!.status, "blocked");
});

test("enforceReviewShaGate: below the cap, the existing delta-review path is unchanged (reviewer IS invoked)", async (t) => {
  let reviewerCalls = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    reviewerCalls++;
    return { verdict: "approve", findings: [], summary: "ok" } as DeltaReviewResult;
  };
  const { deps, cfg } = makeDeps({
    finalBlocking: [MEDIUM_FINDING], maxDeltaRounds: 10, ceilingAction: "park", runDeltaReview,
    getCommitDeltaDiff: async () => diffFor(5),
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal(reviewerCalls, 1, "below the cap, the delta reviewer runs exactly as before");
});

test("enforceReviewShaGate: hitting the delta-round ceiling never consumes max_adversarial_rounds budget", async (t) => {
  // max_adversarial_rounds is a review-2 concept, entirely separate from the
  // ShaGateDeps surface — there is nothing in the delta-ceiling path that
  // reads or writes it. This test documents that independence: the cfg's
  // max_adversarial_rounds is left at its default and never referenced.
  const { deps, cfg } = makeDeps({
    finalBlocking: [MEDIUM_FINDING], maxDeltaRounds: 4, ceilingAction: "park",
  });
  (cfg.review_policy as unknown as { max_adversarial_rounds: number }).max_adversarial_rounds = 3;
  await quiet(t, async () => {
    await enforceReviewShaGate(cfg, 483, 99, deps);
  });
  assert.equal((cfg.review_policy as unknown as { max_adversarial_rounds: number }).max_adversarial_rounds, 3, "unchanged");
});

// ---------------------------------------------------------------------------
// Regression replay: PraxisIQ/fuseiq-core#95 (#483 task 9)
//
// Five delta rounds: rounds 1-4 real (round 2 required removing a design —
// "hold the connection lock across remote fetches" — round 3 an identity-map
// aliasing bug at 0.96 confidence, round 4 a clean approve). Round 5 re-raises
// the settled snapshot-ordering axis under a FRESH finding key, a re-worded
// title, DECLINING confidence (0.82 vs round 2's 0.90), and a recommendation
// that reinstates exactly the design round 2 required removed.
// ---------------------------------------------------------------------------

const CONNECTION_LOCK_FINDING: ReviewFinding = {
  severity: "high", title: "Snapshot read races with a concurrent write on the connection pool",
  file: "src/pool.ts", category: "correctness", body: "b", confidence: 0.9,
  recommendation: "hold the connection lock across remote fetches",
  rejected_alternatives: ["hold the connection lock across remote fetches"],
};
const IDENTITY_MAP_FINDING: ReviewFinding = {
  severity: "high", title: "fresh is connection identity-map aliasing corrupts pooled state",
  file: "src/identity-map.ts", category: "correctness", body: "b", confidence: 0.96,
  recommendation: "clone the entry before mutating it",
};
// Round 5: fresh key (different title/location framing), declining confidence,
// and a recommendation that reinstates round 2's rejected alternative.
const ROUND_5_REINSTATEMENT_FINDING: ReviewFinding = {
  severity: "high", title: "Concurrent remote fetches on one connection can interleave admin writes",
  file: "src/pool.ts", category: "correctness", body: "b", confidence: 0.82,
  recommendation: "serialize remote fetches per connection under the connection lock",
};

function fuseiqCore95PriorComments(): { author: string; body: string }[] {
  return [
    // Round 1: approve, establishes a baseline.
    { author: TEST_ACTOR, body: deltaComment(SHA_1, computeDiffHash(diffFor(1))) },
    // Round 2: requires removing the connection-lock-across-remote-fetches design.
    {
      author: TEST_ACTOR,
      body: deltaComment(SHA_2, computeDiffHash(diffFor(2)), [CONNECTION_LOCK_FINDING]),
    },
    // Round 3: genuine identity-map aliasing bug, resolved by a fix (absent from round 4).
    {
      author: TEST_ACTOR,
      body: deltaComment(SHA_3, computeDiffHash(diffFor(3)), [IDENTITY_MAP_FINDING]),
    },
    // Round 4: clean approve — everything from rounds 2 and 3 is now settled.
    { author: TEST_ACTOR, body: deltaComment(SHA_4, computeDiffHash(diffFor(4))) },
  ];
}

test("fuseiq-core#95 replay: at the default cap, the fifth delta round is never reviewed", async (t) => {
  let reviewerCalls = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    reviewerCalls++;
    return { verdict: "needs-attention", findings: [ROUND_5_REINSTATEMENT_FINDING], summary: "should not run" } as DeltaReviewResult;
  };
  const comments = fuseiqCore95PriorComments();
  const cfg = {
    review_policy: { block_threshold: "low", min_confidence: 0, max_delta_rounds: 4, ceiling_action: "park" },
    harnesses: { reviewer: "claude" },
    marker_footer: renderCfg.marker_footer,
  } as unknown as PipelineConfig;
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ comments }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getIssueDetail"]>>>,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as Awaited<ReturnType<NonNullable<ShaGateDeps["getPrDetail"]>>>,
    getPrCommits: async () => ([{ oid: SHA_HEAD, messageHeadline: "fix: address findings" }]) as Awaited<ReturnType<NonNullable<ShaGateDeps["getPrCommits"]>>>,
    getPrDiff: async () => diffFor(5),
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    runDeltaReview,
  };
  await quiet(t, async () => {
    await enforceReviewShaGate(cfg, 95, 134, deps);
  });
  assert.equal(reviewerCalls, 0, "the fifth round's reviewer invocation must never happen under the default cap");
});

test("fuseiq-core#95 replay: round-5 findings, partitioned against the settled entries, land advisory (not blocking)", () => {
  const comments = fuseiqCore95PriorComments();
  const digest = buildPriorRoundDigest(comments, { actor: TEST_ACTOR });
  const settled = settledFindings(digest);

  // Sanity: round 2's rejected alternative rode into the digest.
  const poolEntry = settled.find((e) => e.surface === "src/pool.ts|correctness");
  assert.ok(poolEntry, "the connection-lock finding must be settled");
  assert.deepEqual(poolEntry!.rejectedAlternatives, ["hold the connection lock across remote fetches"]);

  const partition = partitionFindings(
    [ROUND_5_REINSTATEMENT_FINDING],
    { block_threshold: "low", min_confidence: 0 },
    new Map(), [], new Map(), null, settled,
  );
  assert.equal(partition.blocking.length, 0, "round 5's reinstatement must NOT block — fresh key and re-worded title would defeat matchSettledFinding alone");
  assert.equal(partition.advisory[0]?.reason, "settled-alternative-reinstated");
  assert.equal(partition.advisory[0]?.alternativeMatch?.matchedAlternative, "hold the connection lock across remote fetches");

  // This test BITES: without the settled-alternative-reinstated guard, the fresh
  // key and re-worded title mean matchSettledFinding reports no match at all,
  // and the finding would block per policy.
  const partitionWithoutAlternativeMatching = partitionFindings(
    [ROUND_5_REINSTATEMENT_FINDING],
    { block_threshold: "low", min_confidence: 0 },
    new Map(), [], new Map(), null,
    settled.map((s) => ({ ...s, rejectedAlternatives: [] })), // simulate the guard being absent
  );
  assert.equal(partitionWithoutAlternativeMatching.blocking.length, 1, "proves the guard is what demotes this finding, not the reversal guard alone");
});
