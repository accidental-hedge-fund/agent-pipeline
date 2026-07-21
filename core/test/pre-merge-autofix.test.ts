// Pre-merge bounded auto-fix round (#359): regression tests for the
// category-gated, one-attempt-bounded auto-fix path in `enforceReviewShaGate`.
// All tests use DI seams — no real harness, git, or network.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
  allBlockingAutoFixable,
  enforceReviewShaGate,
  isAutoFixableFinding,
  isPipelineInternalCommit,
  performPreMergeAutoFix,
  PRE_MERGE_AUTOFIX_PREFIX,
  type AttemptPreMergeAutoFixFn,
  type DeltaReviewResult,
  type RunDeltaReviewFn,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import { computeDiffHash, DELTA_REVIEW_MARKER_PREFIX } from "../scripts/stages/review.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";
import type { InvokeFn } from "../scripts/openspec-consistency.ts";
import type { PriorRoundDigest } from "../scripts/review-history.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SHA_REVIEWED = "1111111111111111111111111111111111111111";
const SHA_HEAD = "2222222222222222222222222222222222222222";
const SHA_AFTER_FIX = "3333333333333333333333333333333333333333";
const TEST_ACTOR = "pipeline-bot";

// Config with a review policy that blocks high-severity findings.
const cfgWithPolicy = {
  review_policy: { block_threshold: "low" as const, min_confidence: 0 },
  harnesses: { reviewer: "claude", implementer: "claude" },
} as unknown as PipelineConfig;

const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
const oldHash = computeDiffHash(OLD_DIFF);

/** A review comment body that embeds both sentinels so the diff-hash check fires. */
function reviewCommentWithHash(round: 1 | 2, sha: string, hash: string): string {
  return `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${sha} -->\n<!-- verdict-diff-hash: ${hash} -->`;
}

/** ReviewFinding that blocks under cfgWithPolicy. */
function blockingFinding(category: string, title = "Finding"): ReviewFinding {
  return {
    severity: "high",
    title,
    body: "Details",
    confidence: 0.9,
    recommendation: "Fix it",
    category,
  } as ReviewFinding;
}

interface Rec {
  comments: string[];
  blocked: Array<{ reason: string }>;
  autoFixCalls: number;
  deltaReviewCalls: number;
}

/**
 * Build a ShaGateDeps that exercises the blocking delta-review → auto-fix path.
 * `runDeltaReview` is called once per delta review invocation.
 * `attemptPreMergeAutoFix` is the injectable seam under test.
 */
function makeDeps(opts: {
  findings: ReviewFinding[];
  reReviewFindings: ReviewFinding[];
  autoFixResult: "fix-committed" | "error";
  priorAutoFixCommit?: boolean;
  reReviewPrHead?: string;
  extraCommitsBefore?: { oid: string; messageHeadline: string }[];
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };

  // The authoritative post-fix head the auto-fix seam carries back (#371) —
  // must match what `getPrDetail` below reports post-fix so the post-approval
  // HEAD re-validation guard doesn't spuriously fire in these tests.
  const postFixHeadSha = opts.reReviewPrHead ?? SHA_AFTER_FIX;

  const autoFix: AttemptPreMergeAutoFixFn = async () => {
    rec.autoFixCalls++;
    return opts.autoFixResult === "fix-committed"
      ? { status: "fix-committed", headSha: postFixHeadSha }
      : { status: "error" };
  };

  let deltaCallCount = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    deltaCallCount++;
    const isReReview = deltaCallCount > 1;
    const findings = isReReview ? opts.reReviewFindings : opts.findings;
    const verdict = findings.length === 0 ? "approve" : "needs-attention";
    rec.deltaReviewCalls++;
    return { verdict, findings, summary: isReReview ? "re-review" : "initial" } as DeltaReviewResult;
  };

  // The commit list: reviewed SHA + a dev commit at HEAD.
  // Optionally, a prior auto-fix commit between them.
  const priorFixCommit = {
    oid: "aaaa111111111111111111111111111111111111",
    messageHeadline: `${PRE_MERGE_AUTOFIX_PREFIX} for #16`,
  };
  const commits = [
    { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
    ...(opts.extraCommitsBefore ?? []),
    ...(opts.priorAutoFixCommit ? [priorFixCommit] : []),
    { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#16)" },
  ];

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Test issue",
        body: "Body",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => {
      // After a successful fix push, return the new head. An errored auto-fix
      // attempt makes no push, so the head must stay unchanged (#481 review 2).
      const fixPushed = opts.autoFixResult === "fix-committed" && rec.autoFixCalls > 0;
      return { head_sha: fixPushed ? (opts.reReviewPrHead ?? SHA_AFTER_FIX) : SHA_HEAD } as any;
    },
    getPrCommits: async () => commits as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: autoFix,
    // The live remote ref confirms the auto-fix head, as it would in the
    // real one-attempt happy path (#371 review 1 finding 1: the ls-remote
    // confirmation now always runs after an approving re-review).
    getRemoteHead: async () => postFixHeadSha,
  };
  return { deps, rec };
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

// ---------------------------------------------------------------------------
// 5.7: developer classification — PRE_MERGE_AUTOFIX_PREFIX is NOT pipeline-internal
// ---------------------------------------------------------------------------

test("isPipelineInternalCommit: PRE_MERGE_AUTOFIX_PREFIX subject → false (developer commit)", () => {
  assert.equal(
    isPipelineInternalCommit(`${PRE_MERGE_AUTOFIX_PREFIX} for #359`),
    false,
    "auto-fix commits must NOT be classified as pipeline-internal so the SHA gate re-reviews them",
  );
  assert.equal(isPipelineInternalCommit(PRE_MERGE_AUTOFIX_PREFIX), false);
});

// ---------------------------------------------------------------------------
// isAutoFixableFinding + allBlockingAutoFixable (pure helpers)
// ---------------------------------------------------------------------------

test("isAutoFixableFinding: correctness and missing-dep → true; others → false", () => {
  assert.equal(isAutoFixableFinding({ category: "correctness" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "Correctness" } as ReviewFinding), true); // case-insensitive
  assert.equal(isAutoFixableFinding({ category: "missing-dep" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "security" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "scope" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "product-judgment-required" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "spec-divergence" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: undefined } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({} as ReviewFinding), false);
});

test("allBlockingAutoFixable: non-empty all-correctness → true; mixed or empty → false", () => {
  assert.equal(allBlockingAutoFixable([blockingFinding("correctness")]), true);
  assert.equal(allBlockingAutoFixable([blockingFinding("missing-dep")]), true);
  assert.equal(
    allBlockingAutoFixable([blockingFinding("correctness"), blockingFinding("missing-dep")]),
    true,
  );
  assert.equal(
    allBlockingAutoFixable([blockingFinding("correctness"), blockingFinding("security")]),
    false,
    "mixed with security → false",
  );
  assert.equal(allBlockingAutoFixable([]), false, "empty → false");
  assert.equal(allBlockingAutoFixable([blockingFinding("product-judgment-required")]), false);
});

// ---------------------------------------------------------------------------
// 5.1: all-correctness → auto-fix → re-review approves → proceeds
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.1: all-correctness blocks → auto-fix → re-review approves → return null", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [], // re-review approves
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "auto-fix + re-review approved → pre-merge proceeds");
  assert.equal(rec.autoFixCalls, 1, "fix seam called exactly once");
  assert.deepEqual(rec.blocked, [], "setBlocked must NOT be called");
  assert.equal(rec.comments.length, 2, "initial delta comment + re-review delta comment both posted");
  assert.match(rec.comments[1], /reviewed-sha:/, "re-review comment embeds new reviewed-sha");
  assert.match(rec.comments[1], /verdict-diff-hash:/, "re-review comment embeds diff-hash");
});

// ---------------------------------------------------------------------------
// #389 review 1 finding 3: post-auto-fix re-review must rebuild the digest
// from freshly fetched comments (including the just-posted initial delta
// review), not reuse the pre-review snapshot.
// ---------------------------------------------------------------------------

test("pre-merge auto-fix / delta review: post-fix re-review digest is rebuilt from freshly posted comments, not the stale pre-review snapshot (#389 R1 F3)", async (t) => {
  const commentsList: { author: string; body: string }[] = [
    { body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR },
  ];
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  // The initial delta review and the post-fix re-review both surface the SAME
  // finding — the fix doesn't change the reviewer's mind, an unacknowledged
  // reversal against the initial round's own (just-posted) verdict.
  const recurringFinding: ReviewFinding = {
    severity: "high", title: "Missing rate cap", file: "src/limiter.ts", category: "correctness",
    body: "Details", confidence: 0.9, recommendation: "add a cap",
  };
  const digestsSeen: (PriorRoundDigest | undefined)[] = [];
  let deltaCallCount = 0;
  const runDeltaReview: RunDeltaReviewFn = async (_cfg, _issue, _detail, _diff, _wt, _spec, accounting) => {
    deltaCallCount++;
    digestsSeen.push(accounting?.priorRoundsDigest);
    return { verdict: "needs-attention", findings: [recurringFinding], summary: `round ${deltaCallCount}` } as DeltaReviewResult;
  };
  const deps: ShaGateDeps = {
    getIssueDetail: async () => ({ title: "T", body: "B", comments: [...commentsList] }) as any,
    getPrDetail: async () => ({ head_sha: rec.autoFixCalls > 0 ? SHA_AFTER_FIX : SHA_HEAD }) as any,
    getPrCommits: async () =>
      ([
        { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
        { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#16)" },
      ]) as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => {
      rec.comments.push(body);
      commentsList.push({ author: TEST_ACTOR, body });
    },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => {
      rec.autoFixCalls++;
      return { status: "fix-committed", headSha: SHA_AFTER_FIX };
    },
    getRemoteHead: async () => SHA_AFTER_FIX,
  };
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(deltaCallCount, 2, "initial delta review + post-fix re-review both ran");
  assert.equal(
    digestsSeen[0]?.rounds.length,
    1,
    "before the first delta review, only the round-2 review comment is a prior round",
  );
  assert.equal(
    digestsSeen[1]?.rounds.length,
    2,
    "the re-review's digest must also include the just-posted initial delta-review round, not the stale pre-review snapshot",
  );
  assert.equal(
    out,
    null,
    "the unacknowledged repeat of the just-settled finding must be demoted (reversal-unacknowledged), not re-blocked",
  );
  assert.deepEqual(rec.blocked, [], "setBlocked must NOT be called — the reversal is demoted, not re-blocked");
});

// ---------------------------------------------------------------------------
// 5.2: product-judgment-required → no auto-fix → immediate needs-human
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.2: product-judgment-required finding → escalate without auto-fix", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("product-judgment-required")],
    reReviewFindings: [],
    autoFixResult: "fix-committed", // would succeed if called, but must NOT be called
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
  );
  assert.equal(rec.autoFixCalls, 0, "auto-fix seam must NOT be called for product-judgment-required");
  assert.equal(rec.blocked.length, 1, "setBlocked called once");
  assert.match(rec.blocked[0].reason, /Pre-merge delta review found blocking findings/);
});

// ---------------------------------------------------------------------------
// 5.3: security finding → no auto-fix → immediate needs-human
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.3: security finding → escalate without auto-fix", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("security")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0, "auto-fix seam must NOT be called for security");
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// 5.4: absent/unknown category → no auto-fix → needs-human (fail-closed)
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.4: absent category → fail-closed, no auto-fix", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [{ severity: "high", title: "Unknown", body: "x", confidence: 0.9, recommendation: "y" } as ReviewFinding],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0, "absent category must fail-closed");
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// 5.4 variant: mixed correctness + non-allowlisted → no auto-fix
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.4b: mixed correctness + scope → no auto-fix", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness"), blockingFinding("scope")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0, "mixed with scope → no auto-fix");
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// 5.5: one-attempt bound — prior auto-fix commit in branch → no second attempt
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.5: prior auto-fix commit in branch → needs-human, seam NOT called again", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [blockingFinding("correctness")], // still blocking
    autoFixResult: "fix-committed",
    priorAutoFixCommit: true, // pre-merge auto-fix commit already in history
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
  );
  assert.equal(rec.autoFixCalls, 0, "one-attempt bound: seam must NOT be called when prior attempt detected");
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// 5.6: auto-fix returns error → rollback implied, needs-human
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.6: auto-fix returns error → blocked, no partial push", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "error",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
  );
  assert.equal(rec.autoFixCalls, 1, "seam was called");
  assert.equal(rec.blocked.length, 1, "blocked after error");
  assert.equal(rec.comments.length, 1, "only the initial delta comment; no re-review comment");
});

// ---------------------------------------------------------------------------
// one-attempt bound: fix committed but re-review still blocks → blocked, no 2nd attempt
// ---------------------------------------------------------------------------

test("pre-merge auto-fix: fix committed, re-review still blocks → needs-human, no second attempt", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [blockingFinding("correctness")], // still blocking after fix
    autoFixResult: "fix-committed",
    priorAutoFixCommit: false,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
  );
  assert.equal(rec.autoFixCalls, 1, "seam called exactly once");
  assert.equal(rec.blocked.length, 1, "blocked after re-review still blocks");
  assert.equal(rec.comments.length, 2, "both initial and re-review delta comments posted");
});

// ---------------------------------------------------------------------------
// 5.8: re-review comment does NOT count against review-2 ceiling
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.8: re-review comment uses delta marker prefix, not review-2 prefix", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.comments.length, 2, "two delta comments posted");
  // Both comments must use the delta review marker prefix (not "## Review 2") so
  // countPriorRounds does not count them against the max_adversarial_rounds ceiling.
  for (const c of rec.comments) {
    assert.ok(
      c.startsWith(DELTA_REVIEW_MARKER_PREFIX),
      `comment must start with DELTA_REVIEW_MARKER_PREFIX, got: ${c.slice(0, 60)}`,
    );
    assert.ok(!c.startsWith("## Review 2"), "comment must NOT start with '## Review 2'");
  }
});

// ---------------------------------------------------------------------------
// 5.9: prove tests bite — with auto-fix branch removed, 5.1 fails
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.9 (bite check): without auto-fix seam, correctness findings → blocked not null", async (t) => {
  // Reproduces the 5.1 scenario but omits the attemptPreMergeAutoFix seam.
  // Without the auto-fix round, the gate returns blocked (not null).
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const runDeltaReview: RunDeltaReviewFn = async () => ({
    verdict: "needs-attention",
    findings: [blockingFinding("correctness")],
    summary: "blocking",
  } as DeltaReviewResult);

  const depsNoFix: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "T",
        body: "B",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () =>
      ([
        { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
        { oid: SHA_HEAD, messageHeadline: "fix: stuff" },
      ]) as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    // No attemptPreMergeAutoFix seam.
  };

  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsNoFix);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
    "without the auto-fix seam, correctness findings must block (proves 5.1 bites when seam is absent)",
  );
  assert.equal(rec.blocked.length, 1);
});

// ---------------------------------------------------------------------------
// performPreMergeAutoFix unit tests (findings 1, 3)
// ---------------------------------------------------------------------------

// Minimal cfg for performPreMergeAutoFix — repo_dir points to a non-existent path
// so readConventions returns the "no conventions file" placeholder (no real I/O).
const autoFixCfg = {
  repo_dir: os.tmpdir(),
  harnesses: { implementer: "claude" },
} as unknown as PipelineConfig;

const autoFixWt = { path: "/fake/worktree", slug: "test-slug" };

function makeSucceedInvoke(): InvokeFn {
  return async () => ({
    success: true,
    stdout: "",
    stderr: "",
    exit_code: 0,
    duration: 0,
    timed_out: false,
  });
}

// Build a gitFn that responds to calls in sequence.
function makeSeqGitFn(
  responses: Array<{ code?: number; stdout?: string; stderr?: string }>,
): { fn: typeof import("../scripts/worktree.ts").gitInWorktree; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const fn = async (
    _cwd: string,
    args: string[],
    _opts?: { ignoreFailure?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    calls.push([...args]);
    const resp = responses[i++] ?? { code: 0, stdout: "", stderr: "" };
    return { code: resp.code ?? 0, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
  };
  return { fn: fn as any, calls };
}

// Finding 1 regression: dirty post-harness worktree → "error", not "fix-committed"
test("performPreMergeAutoFix finding-1: dirty post-harness worktree → rollback and return error", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfter — different = hasNewCommit)
    { code: 0, stdout: "sha2" },
    // status --porcelain (post-harness: DIRTY)
    { code: 0, stdout: "M  core/scripts/foo.ts" },
    // reset --hard sha1 (rollback)
    { code: 0, stdout: "" },
    // clean -fd (rollback)
    { code: 0, stdout: "" },
  ]);

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: dirty state",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
  );

  assert.deepEqual(
    result,
    { status: "error" },
    "dirty post-harness worktree must return error, not fix-committed",
  );
  // Verify rollback was called (reset --hard sha1)
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.ok(resetCall, "git reset --hard must be called to roll back the dirty worktree");
});

// Finding 1 regression (bite check): WITHOUT the dirty-is-failure fix, the old
// code would attempt git add -A + commit (not return error on dirty state).
// This test documents that dirty state must NOT be committed.
test("performPreMergeAutoFix finding-1 (bite): clean commit path → fix-committed (no rollback)", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfter — different = hasNewCommit)
    { code: 0, stdout: "sha2" },
    // status --porcelain (post-harness: clean)
    { code: 0, stdout: "" },
    // commit --amend -m ... (amend succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (postFixHead, read after the amend — #371)
    { code: 0, stdout: "sha3" },
    // push origin <branch> (push succeeds)
    { code: 0, stdout: "" },
  ]);

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
  );

  assert.deepEqual(
    result,
    { status: "fix-committed", headSha: "sha3" },
    "clean commit path must return fix-committed with the post-amend local head",
  );
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.equal(resetCall, undefined, "clean path must NOT call reset --hard");
});

// Finding 3 regression: reattach failure → "error" (harness never invoked)
test("performPreMergeAutoFix finding-3: reattach detached worktree fails → return error", async () => {
  let invokeCalled = false;
  const { fn: gitFn } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach FAILS)
    { code: 1, stdout: "", stderr: "fatal: could not checkout" },
  ]);

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: x",
    "Test issue",
    autoFixWt,
    gitFn,
    async () => {
      invokeCalled = true;
      return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 0, timed_out: false };
    },
  );

  assert.deepEqual(result, { status: "error" }, "failed reattach must return error");
  assert.equal(invokeCalled, false, "harness must NOT be invoked when reattach fails");
});

// Finding 4 regression: getPrCommits throws → fail closed (auto-fix NOT called)
test("pre-merge auto-fix finding-4: getPrCommits throws → fail closed, no auto-fix attempted", async (t) => {
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };

  const runDeltaReview: RunDeltaReviewFn = async () => ({
    verdict: "needs-attention",
    findings: [blockingFinding("correctness")],
    summary: "blocking correctness finding",
  } as DeltaReviewResult);

  const depsWithThrowingCommits: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Test issue",
        body: "Body",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
    getPrCommits: async () => { throw new Error("network failure reading PR commits"); },
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => {
      rec.autoFixCalls++;
      return { status: "fix-committed", headSha: SHA_AFTER_FIX };
    },
  };

  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsWithThrowingCommits);
  });

  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
    "getPrCommits failure must block, not attempt auto-fix",
  );
  assert.equal(rec.autoFixCalls, 0, "auto-fix seam must NOT be called when commit scan fails");
  assert.equal(rec.blocked.length, 1, "must block pre-merge");
});

// Finding 2 regression: re-review returns needs-attention + zero findings → blocks
test("pre-merge auto-fix finding-2: re-review needs-attention + zero findings → blocks (not approved)", async (t) => {
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };

  let deltaCallCount = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    deltaCallCount++;
    rec.deltaReviewCalls++;
    if (deltaCallCount === 1) {
      // Initial review: blocking correctness finding
      return {
        verdict: "needs-attention",
        findings: [blockingFinding("correctness")],
        summary: "initial blocking",
      } as DeltaReviewResult;
    }
    // Re-review: needs-attention with ZERO findings (unparseable output)
    return {
      verdict: "needs-attention",
      findings: [],
      summary: "re-review with empty findings",
    } as DeltaReviewResult;
  };

  const commits = [
    { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
    { oid: SHA_HEAD, messageHeadline: "fix: review 2" },
  ];

  const depsReReviewUnparseable: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Test issue",
        body: "Body",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => ({
      head_sha: rec.autoFixCalls > 0 ? SHA_AFTER_FIX : SHA_HEAD,
    }) as any,
    getPrCommits: async () => commits as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => { rec.comments.push(body); },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => {
      rec.autoFixCalls++;
      return { status: "fix-committed", headSha: SHA_AFTER_FIX };
    },
  };

  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsReReviewUnparseable);
  });

  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings" },
    "re-review needs-attention with zero findings must block, not approve",
  );
  assert.equal(rec.autoFixCalls, 1, "auto-fix was attempted once");
  assert.equal(rec.deltaReviewCalls, 2, "initial + re-review both ran");
  assert.equal(rec.blocked.length, 1, "must block on unparseable re-review output");
  // R2 Finding 2: the re-review comment must NOT embed a reviewed-sha sentinel when unparseable,
  // so the reuse path cannot treat it as a clean approval on the next re-entry.
  assert.equal(rec.comments.length, 2, "initial + re-review comments both posted");
  assert.ok(
    !rec.comments[1].includes("<!-- reviewed-sha:"),
    "re-review comment for unparseable output must NOT embed reviewed-sha sentinel",
  );
});

// ---------------------------------------------------------------------------
// R2 Finding 4: post-harness git status exits non-zero → fail closed
// ---------------------------------------------------------------------------

test("performPreMergeAutoFix R2-F4: post-harness git status exits non-zero (empty stdout) → rollback and return error", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfter — different = hasNewCommit)
    { code: 0, stdout: "sha2" },
    // status --porcelain (post-harness: exits code 1, empty stdout — cannot prove clean)
    { code: 1, stdout: "", stderr: "fatal: not a git repository" },
    // reset --hard sha1 (rollback)
    { code: 0, stdout: "" },
    // clean -fd (rollback)
    { code: 0, stdout: "" },
  ]);

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: status failure",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
  );

  assert.deepEqual(
    result,
    { status: "error" },
    "non-zero git-status exit must return error even when stdout is empty",
  );
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.ok(resetCall, "git reset --hard must be called to roll back when status exits non-zero");
});

// ---------------------------------------------------------------------------
// R2 Finding 1: getCommitDeltaDiff failure in post-fix re-review → conservative
// full re-review (no stale diff fallback, no approved-head recorded)
// ---------------------------------------------------------------------------

test("pre-merge auto-fix R2-F1: getCommitDeltaDiff fails post-fix → full re-review, no stale head recorded", async (t) => {
  const transitions: Array<{ to: string }> = [];
  let deltaCallCount = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    deltaCallCount++;
    return {
      verdict: "needs-attention",
      findings: [blockingFinding("correctness")],
      summary: "blocking",
    } as DeltaReviewResult;
  };

  let diffCallCount = 0;
  const depsF1: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "T",
        body: "B",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => ({ head_sha: SHA_AFTER_FIX }) as any,
    getPrCommits: async () =>
      [
        { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
        { oid: SHA_HEAD, messageHeadline: "fix: review 2" },
      ] as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => {
      diffCallCount++;
      if (diffCallCount >= 2) throw new Error("transient git diff failure");
      return NEW_DIFF;
    },
    runDeltaReview,
    postComment: async () => {},
    transition: async (_cfg, _n, _from, to) => { transitions.push({ to: to as string }); },
    setBlocked: async () => {},
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => ({ status: "fix-committed", headSha: SHA_AFTER_FIX }),
  };

  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsF1);
  });

  // The failure in getCommitDeltaDiff propagates to the outer catch, which routes
  // to a conservative full re-review instead of either proceeding or blocking.
  assert.ok(
    out?.advanced === true && (out?.to === "review-2" || out?.to === "review-1"),
    `getCommitDeltaDiff failure must route to full re-review, got: ${JSON.stringify(out)}`,
  );
  // The post-fix re-review must NOT have run (diff fetch failed before it started).
  assert.equal(deltaCallCount, 1, "only the initial delta review ran; re-review errored before start");
  // Must NOT have transitioned to needs-human (that would record the stale head).
  assert.ok(
    !transitions.some((t) => t.to === "needs-human"),
    "must NOT transition to needs-human when diff fetch fails — would leave stale head recorded",
  );
});

// ---------------------------------------------------------------------------
// R2 Finding 3: fix prompt contains only blocking findings, not advisory findings
// ---------------------------------------------------------------------------

test("pre-merge auto-fix R2-F3: fix prompt scoped to blocking findings only, not advisory findings", async (t) => {
  let capturedFindingsText = "";
  const advisoryTitle = "Advisory: non-blocking security note";
  const blockingTitle = "Blocking correctness bug";

  let deltaCallCount = 0;
  const runDeltaReview: RunDeltaReviewFn = async () => {
    deltaCallCount++;
    if (deltaCallCount === 1) {
      return {
        verdict: "needs-attention",
        findings: [
          { ...blockingFinding("correctness"), title: blockingTitle },
          // Advisory finding: same severity but explicitly non-blocking.
          { severity: "high", title: advisoryTitle, body: "Details", confidence: 0.9,
            recommendation: "Consider fixing", category: "security", blocking: false } as ReviewFinding,
        ],
        summary: "one blocking, one advisory",
      } as DeltaReviewResult;
    }
    // Re-review approves.
    return { verdict: "approve", findings: [], summary: "approved" } as DeltaReviewResult;
  };

  const commits = [
    { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
    { oid: SHA_HEAD, messageHeadline: "fix: review 2" },
  ];

  const depsF3: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "T",
        body: "B",
        comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () => ({ head_sha: rec3.autoFixCalls > 0 ? SHA_AFTER_FIX : SHA_HEAD }) as any,
    getPrCommits: async () => commits as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async (_blocking, _title, findingsText) => {
      capturedFindingsText = findingsText;
      rec3.autoFixCalls++;
      return { status: "fix-committed", headSha: SHA_AFTER_FIX };
    },
    getRemoteHead: async () => SHA_AFTER_FIX,
  };

  const rec3 = { autoFixCalls: 0 };
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsF3);
  });

  assert.equal(out, null, "fix + re-review approve → should proceed");
  assert.equal(rec3.autoFixCalls, 1, "auto-fix seam called once");
  assert.ok(
    capturedFindingsText.includes(blockingTitle),
    "fix prompt must include the blocking finding title",
  );
  assert.ok(
    !capturedFindingsText.includes(advisoryTitle),
    "fix prompt must NOT include the advisory (non-blocking) finding title",
  );
});

// ---------------------------------------------------------------------------
// #371: the post-auto-fix re-review must evaluate the diff INCLUDING the
// auto-fix commit, anchored to the authoritative post-fix head carried back
// from `attemptPreMergeAutoFix` — not a GitHub-API PR-head read, which can
// still return the pre-fix head immediately after the push.
// ---------------------------------------------------------------------------

test(
  "pre-merge auto-fix #371: re-review evaluates the post-fix diff and anchors reviewed-sha to the auto-fix commit SHA",
  async (t) => {
    const PRE_FIX_DELTA_DIFF = "diff --git a/foo.ts b/foo.ts\n+const bug = true;";
    const POST_FIX_DELTA_DIFF = "diff --git a/foo.ts b/foo.ts\n+const bug = false; // fixed";

    const receivedDeltaDiffs: string[] = [];
    const comments: string[] = [];
    let autoFixCalls = 0;
    // Flips true once the second (re-review) delta-review invocation begins —
    // modeling that a whole review round-trip's worth of real time has elapsed
    // by then, so a GitHub-API PR-head read has settled. Before that point
    // (i.e. immediately after the auto-fix push) the read is still racy and
    // returns the pre-fix head, reproducing the observed bug window.
    let secondReviewStarted = false;

    const commits = [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
      { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#371)" },
    ];

    const runDeltaReview: RunDeltaReviewFn = async (_cfg, _issue, _detail, deltaDiff) => {
      receivedDeltaDiffs.push(deltaDiff);
      if (receivedDeltaDiffs.length === 1) {
        return {
          verdict: "needs-attention",
          findings: [blockingFinding("correctness")],
          summary: "initial: blocking correctness finding",
        } as DeltaReviewResult;
      }
      secondReviewStarted = true;
      if (deltaDiff === POST_FIX_DELTA_DIFF) {
        return { verdict: "approve", findings: [], summary: "post-fix: resolved" } as DeltaReviewResult;
      }
      // Regression scenario: the re-review received the pre-fix diff again
      // (byte-identical to the first review) → the finding recurs.
      return {
        verdict: "needs-attention",
        findings: [blockingFinding("correctness")],
        summary: "re-review saw the pre-fix diff again",
      } as DeltaReviewResult;
    };

    const deps: ShaGateDeps = {
      getIssueDetail: async () =>
        ({
          title: "Test issue",
          body: "Body",
          comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
        }) as any,
      getPrDetail: async () => ({
        head_sha: secondReviewStarted ? SHA_AFTER_FIX : SHA_HEAD,
      }) as any,
      getPrCommits: async () => commits as any,
      getPrDiff: async () => NEW_DIFF,
      getCommitDeltaDiff: async (_cfg, _pr, _base, headSha) => {
        if (headSha === SHA_HEAD) return PRE_FIX_DELTA_DIFF;
        if (headSha === SHA_AFTER_FIX) return POST_FIX_DELTA_DIFF;
        throw new Error(`unexpected delta-diff head ${headSha}`);
      },
      runDeltaReview,
      postComment: async (_cfg, _n, body) => { comments.push(body); },
      transition: async () => {},
      setBlocked: async () => {},
      getForIssue: async () => null,
      getGhActor: async () => TEST_ACTOR,
      attemptPreMergeAutoFix: async () => {
        autoFixCalls++;
        return { status: "fix-committed", headSha: SHA_AFTER_FIX };
      },
      getRemoteHead: async () => SHA_AFTER_FIX,
    };

    let out: any;
    await quiet(t, async () => {
      out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
    });

    assert.equal(out, null, "post-fix diff no longer exhibits the finding → pre-merge proceeds");
    assert.equal(autoFixCalls, 1, "auto-fix seam called exactly once");
    assert.equal(receivedDeltaDiffs.length, 2, "initial delta review + one re-review");
    assert.notEqual(
      receivedDeltaDiffs[0],
      receivedDeltaDiffs[1],
      "the re-review must receive a diff distinct from the first review's diff",
    );
    assert.equal(
      receivedDeltaDiffs[1],
      POST_FIX_DELTA_DIFF,
      "the re-review must evaluate the post-fix diff (reviewed-sha...auto-fix-commit-sha), " +
        "not the pre-fix diff a stale GitHub-API PR-head read would produce",
    );
    assert.equal(comments.length, 2, "initial + re-review delta comments both posted");
    assert.match(
      comments[1]!,
      new RegExp(`reviewed-sha: ${SHA_AFTER_FIX}`),
      "re-review comment's reviewed-sha must equal the post-fix head (auto-fix commit SHA)",
    );
    assert.ok(
      !comments[1]!.includes(`reviewed-sha: ${SHA_HEAD}`),
      "re-review comment must NOT anchor reviewed-sha to the pre-fix head",
    );

    // Bite check (#371 task 3.2): these assertions only hold because
    // `enforceReviewShaGate` uses the auto-fix result's authoritative `headSha`
    // directly for `newPrHead`. `getPrDetail` above is deliberately stubbed to
    // return the STALE pre-fix head (`SHA_HEAD`) for any call made before the
    // second review invocation begins — exactly the window in which a
    // regressed implementation (re-deriving `newPrHead` from
    // `getPrDetailFn(cfg, prNumber)` right after the auto-fix, as the pre-#371
    // code did) would read it. Under that regression, `newPrHead` resolves to
    // `SHA_HEAD`, the re-review diff becomes `getCommitDeltaDiff(reviewed.sha,
    // SHA_HEAD)` — byte-identical to the first review's diff — the stub above
    // receives the pre-fix diff and re-emits the blocking finding, and every
    // assertion above (`out === null`, distinct diffs, the post-fix
    // reviewed-sha) fails instead.
  },
);

// ---------------------------------------------------------------------------
// #371 review 2: the FINAL post-approval HEAD revalidation must not veto an
// approving re-review when the GitHub-API PR-head read is still stale at that
// exact call (not just during the re-review invocation itself).
// ---------------------------------------------------------------------------

test(
  "pre-merge auto-fix #371 review 2: stale GitHub-API PR-head read at the final revalidation does not re-block a resolved auto-fix",
  async (t) => {
    const comments: string[] = [];
    let autoFixCalls = 0;
    let deltaReviewCalls = 0;
    let lsRemoteCalls = 0;

    const commits = [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
      { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#371)" },
    ];

    const runDeltaReview: RunDeltaReviewFn = async () => {
      deltaReviewCalls++;
      if (deltaReviewCalls === 1) {
        return {
          verdict: "needs-attention",
          findings: [blockingFinding("correctness")],
          summary: "initial: blocking correctness finding",
        } as DeltaReviewResult;
      }
      return { verdict: "approve", findings: [], summary: "post-fix: resolved" } as DeltaReviewResult;
    };

    const deps: ShaGateDeps = {
      getIssueDetail: async () =>
        ({
          title: "Test issue",
          body: "Body",
          comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
        }) as any,
      // Deliberately never catches up to the post-fix head (SHA_AFTER_FIX) —
      // models a GitHub-API read that is still stale at the FINAL
      // revalidation call following the approving re-review, not just during
      // the re-review invocation itself (the gap the review-2 finding flagged).
      getPrDetail: async () => ({ head_sha: SHA_HEAD, head_ref: "pipeline/16-test" }) as any,
      getPrCommits: async () => commits as any,
      getPrDiff: async () => NEW_DIFF,
      getCommitDeltaDiff: async () => NEW_DIFF,
      runDeltaReview,
      postComment: async (_cfg, _n, body) => { comments.push(body); },
      transition: async () => {},
      setBlocked: async () => {},
      getForIssue: async () => null,
      getGhActor: async () => TEST_ACTOR,
      attemptPreMergeAutoFix: async () => {
        autoFixCalls++;
        return { status: "fix-committed", headSha: SHA_AFTER_FIX };
      },
      // The live remote ref confirms the auto-fix head — the API read really
      // was mere staleness (#371 delta review, key 8ad8b7f0).
      getRemoteHead: async () => {
        lsRemoteCalls++;
        return SHA_AFTER_FIX;
      },
    };

    let out: any;
    await quiet(t, async () => {
      out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
    });

    assert.equal(
      out,
      null,
      "a stale GitHub-API PR-head read that still echoes the known pre-fix head must not " +
        "veto an approving post-fix re-review",
    );
    assert.equal(autoFixCalls, 1, "auto-fix seam called exactly once");
    assert.equal(deltaReviewCalls, 2, "initial delta review + one re-review");
    assert.equal(
      lsRemoteCalls, 1,
      "the pre-fix-echo read must be confirmed against the live remote ref, not trusted outright",
    );

    // Bite check: WITHOUT the fix, `postFixHead !== newPrHead` alone would
    // throw here (SHA_HEAD !== SHA_AFTER_FIX), routing to the conservative
    // fallback (a stale-review comment + transition back to review-2) instead
    // of returning null.
    assert.ok(
      !comments.some((c) => /HEAD has moved/.test(c)),
      "must not fall back to the stale-review path on a known-stale (not genuinely new) PR-head read",
    );
  },
);

// ---------------------------------------------------------------------------
// #371 pre-merge delta review (key 8ad8b7f0): a stale GitHub-API read that
// echoes the pre-fix head is NOT proof of harmless staleness — the same read
// can mask a genuinely newer concurrent push landing during the post-fix
// re-review. The guard must confirm the auto-fix head via the live remote ref
// and fail closed to the SHA gate when it cannot.
// ---------------------------------------------------------------------------

for (const [label, remoteHead] of [
  ["a concurrent push landed during the re-review", "4444444444444444444444444444444444444444"],
  ["the remote ref cannot be read", null],
] as const) {
  test(
    `pre-merge auto-fix #371 delta review 8ad8b7f0: pre-fix-echo API read + ${label} → re-enter SHA gate, not advance`,
    async (t) => {
      const comments: string[] = [];
      let deltaReviewCalls = 0;
      let transitions: string[] = [];

      const commits = [
        { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
        { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#371)" },
      ];

      const runDeltaReview: RunDeltaReviewFn = async () => {
        deltaReviewCalls++;
        if (deltaReviewCalls === 1) {
          return {
            verdict: "needs-attention",
            findings: [blockingFinding("correctness")],
            summary: "initial: blocking correctness finding",
          } as DeltaReviewResult;
        }
        return { verdict: "approve", findings: [], summary: "post-fix: resolved" } as DeltaReviewResult;
      };

      const deps: ShaGateDeps = {
        getIssueDetail: async () =>
          ({
            title: "Test issue",
            body: "Body",
            comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
          }) as any,
        // API read echoes the known pre-fix head throughout.
        getPrDetail: async () => ({ head_sha: SHA_HEAD, head_ref: "pipeline/16-test" }) as any,
        getPrCommits: async () => commits as any,
        getPrDiff: async () => NEW_DIFF,
        getCommitDeltaDiff: async () => NEW_DIFF,
        runDeltaReview,
        postComment: async (_cfg, _n, body) => { comments.push(body); },
        transition: async (_cfg, _n, from, to) => { transitions.push(`${from}->${to}`); },
        setBlocked: async () => {},
        getForIssue: async () => null,
        getGhActor: async () => TEST_ACTOR,
        attemptPreMergeAutoFix: async () =>
          ({ status: "fix-committed", headSha: SHA_AFTER_FIX }) as any,
        // The live remote ref does NOT confirm the auto-fix head: either a
        // third SHA (concurrent push) or unreadable. Both must fail closed.
        getRemoteHead: async () => remoteHead,
      };

      let out: any;
      await quiet(t, async () => {
        out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
      });

      // Bite check: WITHOUT the fix, the pre-fix-echo read was accepted as
      // harmless staleness and the gate returned null (advance) — letting an
      // unreviewed concurrent commit through pre-merge.
      assert.notEqual(
        out, null,
        "an unconfirmed pre-fix-echo PR-head read must not advance pre-merge",
      );
      assert.equal(out.advanced, true, "fail-closed path bounces to the review stage");
      assert.equal(out.to, "review-2", "re-enters the recorded review round");
      assert.ok(
        transitions.includes("pre-merge->review-2"),
        "must transition back to review-2 via the SHA gate's conservative path",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// #371 pre-merge delta review (key 9943b2af): a stale GitHub-API read that
// echoes the AUTO-FIX head (not the pre-fix head) is likewise not proof the
// auto-fix head is still the true remote head — a further concurrent push can
// land during the re-review while the API read still reports newPrHead. The
// guard must confirm via the live remote ref in this case too, not just when
// the read echoes the pre-fix head.
// ---------------------------------------------------------------------------

test(
  "pre-merge auto-fix #371 delta review 9943b2af: auto-fix-echo API read + concurrent push landed → re-enter SHA gate, not advance",
  async (t) => {
    const comments: string[] = [];
    let deltaReviewCalls = 0;
    const transitions: string[] = [];
    let lsRemoteCalls = 0;

    const commits = [
      { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
      { oid: SHA_HEAD, messageHeadline: "fix: address review 2 findings (#371)" },
    ];

    const runDeltaReview: RunDeltaReviewFn = async () => {
      deltaReviewCalls++;
      if (deltaReviewCalls === 1) {
        return {
          verdict: "needs-attention",
          findings: [blockingFinding("correctness")],
          summary: "initial: blocking correctness finding",
        } as DeltaReviewResult;
      }
      return { verdict: "approve", findings: [], summary: "post-fix: resolved" } as DeltaReviewResult;
    };

    const deps: ShaGateDeps = {
      getIssueDetail: async () =>
        ({
          title: "Test issue",
          body: "Body",
          comments: [{ body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR }],
        }) as any,
      // The API read already echoes the auto-fix head — the condition the
      // pre-#371-review-1 guard treated as trustworthy without confirmation.
      getPrDetail: async () => ({ head_sha: SHA_AFTER_FIX, head_ref: "pipeline/16-test" }) as any,
      getPrCommits: async () => commits as any,
      getPrDiff: async () => NEW_DIFF,
      getCommitDeltaDiff: async () => NEW_DIFF,
      runDeltaReview,
      postComment: async (_cfg, _n, body) => { comments.push(body); },
      transition: async (_cfg, _n, from, to) => { transitions.push(`${from}->${to}`); },
      setBlocked: async () => {},
      getForIssue: async () => null,
      getGhActor: async () => TEST_ACTOR,
      attemptPreMergeAutoFix: async () =>
        ({ status: "fix-committed", headSha: SHA_AFTER_FIX }) as any,
      // The live remote ref shows a genuinely newer, different commit landed
      // during the re-review — proof the auto-fix head is stale, even though
      // the API read matched it exactly.
      getRemoteHead: async () => {
        lsRemoteCalls++;
        return "5555555555555555555555555555555555555555";
      },
    };

    let out: any;
    await quiet(t, async () => {
      out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
    });

    // Bite check: WITHOUT the fix, `postFixHead !== newPrHead` is false here
    // (both equal SHA_AFTER_FIX), so ls-remote is never consulted and the
    // gate returns null (advance) — letting an unreviewed concurrent commit
    // through pre-merge.
    assert.equal(
      lsRemoteCalls, 1,
      "an auto-fix-echo API read must still be confirmed against the live remote ref",
    );
    assert.notEqual(
      out, null,
      "an unconfirmed auto-fix-echo PR-head read must not advance pre-merge",
    );
    assert.equal(out.advanced, true, "fail-closed path bounces to the review stage");
    assert.equal(out.to, "review-2", "re-enters the recorded review round");
    assert.ok(
      transitions.includes("pre-merge->review-2"),
      "must transition back to review-2 via the SHA gate's conservative path",
    );
  },
);
