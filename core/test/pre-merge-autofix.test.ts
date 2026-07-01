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

  const autoFix: AttemptPreMergeAutoFixFn = async () => {
    rec.autoFixCalls++;
    return opts.autoFixResult;
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
      // After fix committed, return the new head.
      return { head_sha: rec.autoFixCalls > 0 ? (opts.reReviewPrHead ?? SHA_AFTER_FIX) : SHA_HEAD } as any;
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

  assert.equal(result, "error", "dirty post-harness worktree must return error, not fix-committed");
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

  assert.equal(result, "fix-committed", "clean commit path must return fix-committed");
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

  assert.equal(result, "error", "failed reattach must return error");
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
    attemptPreMergeAutoFix: async () => { rec.autoFixCalls++; return "fix-committed"; },
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
    attemptPreMergeAutoFix: async () => { rec.autoFixCalls++; return "fix-committed"; },
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
});
