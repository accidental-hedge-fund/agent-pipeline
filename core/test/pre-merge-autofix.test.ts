// Pre-merge bounded auto-fix round (#359): regression tests for the
// category-gated, one-attempt-bounded auto-fix path in `enforceReviewShaGate`.
// All tests use DI seams — no real harness, git, or network.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
  allBlockingAutoFixable,
  enforceReviewShaGate,
  formatNoopStillBrokenReason,
  formatPartitionDispositionReason,
  hasPreMergeAutofixAttemptAtHead,
  hasPreMergeAutofixBoundMarkerAtHead,
  hasPreMergeAutofixNoopAtHead,
  isAutoFixableFinding,
  isPipelineInternalCommit,
  partitionBlockingForAutofix,
  performPreMergeAutoFix,
  preMergeAutofixAttemptComment,
  preMergeAutofixNoopComment,
  PRE_MERGE_AUTOFIX_ATTEMPT_HEADING,
  PRE_MERGE_AUTOFIX_NOOP_HEADING,
  PRE_MERGE_AUTOFIX_CATEGORIES,
  PRE_MERGE_AUTOFIX_CATEGORY_SET,
  PRE_MERGE_AUTOFIX_PREFIX,
  type AttemptPreMergeAutoFixFn,
  type DeltaReviewResult,
  type RunDeltaReviewFn,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import {
  applyNoopHeadClassificationEvidenceRule,
  citesExecutableFailureEvidence,
  citedRegionContent,
  extractClassificationTokens,
  extractKnownPipelineClassificationTokens,
  findingKey,
  HEAD_ALREADY_IMPLEMENTS_RECOMMENDATION,
  headImplementsRecommendedClassification,
  isClassificationOrControlFlowClaim,
} from "../scripts/review-policy.ts";
import { computeDiffHash, DELTA_REVIEW_MARKER_PREFIX, isVerifiedPipelineAttestation } from "../scripts/stages/review.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";
import type { InvokeFn } from "../scripts/openspec-consistency.ts";
import type { HeadFileState, PriorRoundDigest } from "../scripts/review-history.ts";
import type { TrySalvageResult } from "../scripts/salvage-harness-work.ts";

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

/**
 * Same finding re-raised on post-auto-fix re-delta with a prior-round
 * acknowledgment so the #389 reversal guard does not demote it to advisory.
 * Use for residual-still-blocks fixtures after a partition auto-fix (#747).
 */
function reRaisedBlockingFinding(f: ReviewFinding): ReviewFinding {
  return {
    ...f,
    prior_round_acknowledgment:
      "Re-raised after auto-fix: residual category still requires human disposition.",
  } as ReviewFinding;
}

interface Rec {
  comments: string[];
  blocked: Array<{ reason: string }>;
  autoFixCalls: number;
  deltaReviewCalls: number;
  /** Findings passed into the auto-fix seam (allowlisted subset only, #747). */
  autoFixFindings: ReviewFinding[];
  /** Review comment body passed into the auto-fix seam. */
  autoFixReviewComment: string | null;
}

/**
 * Build a ShaGateDeps that exercises the blocking delta-review → auto-fix path.
 * `runDeltaReview` is called once per delta review invocation.
 * `attemptPreMergeAutoFix` is the injectable seam under test.
 */
function makeDeps(opts: {
  findings: ReviewFinding[];
  reReviewFindings: ReviewFinding[];
  autoFixResult: "fix-committed" | "error" | "noop-clean";
  priorAutoFixCommit?: boolean;
  /** Prior durable noop-clean marker at SHA_HEAD (#698). */
  priorNoopCleanMarker?: boolean;
  /** Prior durable attempt-started marker at SHA_HEAD (#698 review-2). */
  priorAttemptMarker?: boolean;
  /**
   * When true, `postComment` throws on the first attempt to post a
   * pre-merge-autofix-noop completion marker (after harness). Attempt-started
   * posts still succeed so the one-attempt bound remains durable.
   */
  failNoopCompletionMarker?: boolean;
  /**
   * When true, `postComment` throws when posting the attempt-started marker
   * (before harness). Harness must not run.
   */
  failAttemptMarker?: boolean;
  reReviewPrHead?: string;
  extraCommitsBefore?: { oid: string; messageHeadline: string }[];
  /** Diagnostic attached to noop-clean / error outcomes. */
  diagnostic?: string;
  /**
   * HEAD file states returned by the injectable `readHeadFiles` seam.
   * Used by the post-noop classification demotion rule (#698/#683).
   */
  headFiles?: HeadFileState[];
}): { deps: ShaGateDeps; rec: Rec } {
  const rec: Rec = {
    comments: [],
    blocked: [],
    autoFixCalls: 0,
    deltaReviewCalls: 0,
    autoFixFindings: [],
    autoFixReviewComment: null,
  };

  // The authoritative post-fix head the auto-fix seam carries back (#371) —
  // must match what `getPrDetail` below reports post-fix so the post-approval
  // HEAD re-validation guard doesn't spuriously fire in these tests.
  const postFixHeadSha = opts.reReviewPrHead ?? SHA_AFTER_FIX;
  const noopDiagnostic =
    opts.diagnostic ??
    "pre-merge fix harness for #16 ran but left worktree /fake/worktree clean with no new " +
      "commit — no recoverable work was found there";

  const autoFix: AttemptPreMergeAutoFixFn = async (findings, _title, reviewComment) => {
    rec.autoFixCalls++;
    rec.autoFixFindings = findings;
    rec.autoFixReviewComment = reviewComment;
    if (opts.autoFixResult === "fix-committed") {
      return { status: "fix-committed", headSha: postFixHeadSha };
    }
    if (opts.autoFixResult === "noop-clean") {
      return { status: "noop-clean", headSha: SHA_HEAD, diagnostic: noopDiagnostic };
    }
    return { status: "error" };
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

  const initialComments: { author: string; body: string }[] = [
    { body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash), author: TEST_ACTOR },
  ];
  if (opts.priorNoopCleanMarker) {
    initialComments.push({
      author: TEST_ACTOR,
      body: preMergeAutofixNoopComment({
        issueNumber: 16,
        headSha: SHA_HEAD,
        diagnostic: noopDiagnostic,
        timestamp: "2026-07-29T00:00:00Z",
      }),
    });
  }
  if (opts.priorAttemptMarker) {
    initialComments.push({
      author: TEST_ACTOR,
      body: preMergeAutofixAttemptComment({
        issueNumber: 16,
        headSha: SHA_HEAD,
        timestamp: "2026-07-29T00:00:00Z",
      }),
    });
  }

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Test issue",
        body: "Body",
        // Include comments posted during the gate so the durable marker scan
        // and re-review digest see them (mirrors production postComment → issue).
        comments: [
          ...initialComments,
          ...rec.comments.map((body) => ({ author: TEST_ACTOR, body })),
        ],
      }) as any,
    getPrDetail: async () => {
      // After a successful fix push, return the new head. noop-clean / error
      // make no push, so the head must stay unchanged (#481 review 2 / #698).
      const fixPushed = opts.autoFixResult === "fix-committed" && rec.autoFixCalls > 0;
      return {
        head_sha: fixPushed ? (opts.reReviewPrHead ?? SHA_AFTER_FIX) : SHA_HEAD,
        head_ref: "pipeline/16-test",
      } as any;
    },
    getPrCommits: async () => commits as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview,
    postComment: async (_cfg, _n, body) => {
      if (
        opts.failAttemptMarker &&
        body.startsWith(PRE_MERGE_AUTOFIX_ATTEMPT_HEADING)
      ) {
        throw new Error("simulated GitHub failure posting attempt marker");
      }
      if (
        opts.failNoopCompletionMarker &&
        body.startsWith(PRE_MERGE_AUTOFIX_NOOP_HEADING)
      ) {
        throw new Error("simulated GitHub failure posting noop completion marker");
      }
      rec.comments.push(body);
    },
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason) => { rec.blocked.push({ reason }); },
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => [],
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: autoFix,
    // The live remote ref confirms the re-review head (#371 / #698).
    getRemoteHead: async () =>
      opts.autoFixResult === "fix-committed" ? postFixHeadSha : SHA_HEAD,
    // HEAD content for post-noop classification demotion (#698/#683).
    readHeadFiles: async (_worktree, _sha, paths) => {
      const supplied = opts.headFiles ?? [];
      return paths.map((p) => {
        const hit = supplied.find(
          (h) => h.path.toLowerCase() === p.toLowerCase(),
        );
        return (
          hit ??
          ({
            path: p,
            content: "",
            truncated: false,
            present: false,
            absenceReason: "not-found",
          } satisfies HeadFileState)
        );
      });
    },
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

test("PRE_MERGE_AUTOFIX_CATEGORIES is the single-sourced matrix allowlist (#680)", () => {
  assert.deepEqual([...PRE_MERGE_AUTOFIX_CATEGORIES].sort(), [
    "concurrency",
    "correctness",
    "missing-dep",
  ]);
  for (const cat of PRE_MERGE_AUTOFIX_CATEGORIES) {
    assert.equal(PRE_MERGE_AUTOFIX_CATEGORY_SET.has(cat), true);
    assert.equal(isAutoFixableFinding({ category: cat } as ReviewFinding), true);
  }
});

test("isAutoFixableFinding: correctness, missing-dep, concurrency → true; others → false (#680)", () => {
  assert.equal(isAutoFixableFinding({ category: "correctness" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "Correctness" } as ReviewFinding), true); // case-insensitive
  assert.equal(isAutoFixableFinding({ category: "missing-dep" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "concurrency" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "Concurrency" } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "  concurrency  " } as ReviewFinding), true);
  assert.equal(isAutoFixableFinding({ category: "security" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "scope" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "product-judgment-required" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "spec-divergence" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "data-loss" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "observability" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: "" } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({ category: undefined } as ReviewFinding), false);
  assert.equal(isAutoFixableFinding({} as ReviewFinding), false);
});

test("isAutoFixableFinding: code-behind-spec is auto-fixable; other directions residual", () => {
  assert.equal(
    isAutoFixableFinding({
      category: "spec-divergence",
      spec_divergence_direction: "code-behind-spec",
    } as ReviewFinding),
    true,
    "code-behind-spec is implementer work — must not first-hop to needs-human",
  );
  assert.equal(
    isAutoFixableFinding({
      category: "SPEC-DIVERGENCE",
      spec_divergence_direction: "code-behind-spec",
    } as ReviewFinding),
    true,
    "category match is case-insensitive",
  );
  assert.equal(
    isAutoFixableFinding({
      category: "spec-divergence",
      spec_divergence_direction: "spec-behind-code",
    } as ReviewFinding),
    false,
    "spec-behind-code stays residual (delta/spec repair, not implementer autofix)",
  );
  assert.equal(
    isAutoFixableFinding({ category: "spec-divergence" } as ReviewFinding),
    false,
    "direction-less spec-divergence stays residual (fail-closed)",
  );
  assert.equal(
    allBlockingAutoFixable([
      {
        severity: "high",
        title: "Missing title match",
        body: "x",
        confidence: 0.99,
        recommendation: "fetch title/body",
        category: "spec-divergence",
        spec_divergence_direction: "code-behind-spec",
      } as ReviewFinding,
    ]),
    true,
    "pure code-behind-spec batch is auto-fix eligible (#729 dogfood shape)",
  );
});

test("partitionBlockingForAutofix: code-behind-spec joins allowlisted subset", () => {
  const codeBehind = {
    severity: "high" as const,
    title: "Title refs never superseded",
    body: "x",
    confidence: 0.99,
    recommendation: "parse title/body",
    category: "spec-divergence",
    spec_divergence_direction: "code-behind-spec" as const,
  };
  const security = blockingFinding("security", "Auth gap");
  const p = partitionBlockingForAutofix([codeBehind, security]);
  assert.deepEqual(p.autoFixable, [codeBehind]);
  assert.deepEqual(p.residual, [security]);
});

test("allBlockingAutoFixable: allowlisted sets → true; mixed security / empty → false (#680)", () => {
  assert.equal(allBlockingAutoFixable([blockingFinding("correctness")]), true);
  assert.equal(allBlockingAutoFixable([blockingFinding("missing-dep")]), true);
  assert.equal(allBlockingAutoFixable([blockingFinding("concurrency")]), true);
  assert.equal(
    allBlockingAutoFixable([blockingFinding("correctness"), blockingFinding("missing-dep")]),
    true,
  );
  assert.equal(
    allBlockingAutoFixable([blockingFinding("concurrency"), blockingFinding("correctness")]),
    true,
    "mixed allowlisted → true",
  );
  assert.equal(
    allBlockingAutoFixable([blockingFinding("correctness"), blockingFinding("security")]),
    false,
    "mixed with security → false (all-or-nothing helper; attempt gate uses partition)",
  );
  assert.equal(
    allBlockingAutoFixable([blockingFinding("concurrency"), blockingFinding("security")]),
    false,
    "concurrency + security → false (all-or-nothing helper)",
  );
  assert.equal(allBlockingAutoFixable([]), false, "empty → false");
  assert.equal(allBlockingAutoFixable([blockingFinding("product-judgment-required")]), false);
});

// ---------------------------------------------------------------------------
// #747: category partition helpers (not all-or-nothing veto)
// ---------------------------------------------------------------------------

test("partitionBlockingForAutofix: splits allowlisted vs residual (#747)", () => {
  const concurrency = blockingFinding("concurrency", "TOCTOU on lock");
  const correctness = blockingFinding("correctness", "Off-by-one");
  const specDiv = blockingFinding("spec-divergence", "Partial list wiring");
  const security = blockingFinding("security", "Auth gap");
  const p = partitionBlockingForAutofix([concurrency, correctness, specDiv, security]);
  assert.deepEqual(p.autoFixable, [concurrency, correctness]);
  assert.deepEqual(p.residual, [specDiv, security]);
  assert.equal(partitionBlockingForAutofix([]).autoFixable.length, 0);
  assert.equal(partitionBlockingForAutofix([]).residual.length, 0);
  assert.equal(
    partitionBlockingForAutofix([specDiv, security]).autoFixable.length,
    0,
    "pure residual → empty autoFixable",
  );
  assert.equal(
    partitionBlockingForAutofix([concurrency, correctness]).residual.length,
    0,
    "pure allowlisted → empty residual",
  );
});

test("formatPartitionDispositionReason: residual no-attempt vs attempted (#747)", () => {
  const residual = [blockingFinding("spec-divergence", "Partial list")];
  const auto = [blockingFinding("concurrency", "TOCTOU")];
  const noAttempt = formatPartitionDispositionReason({
    residual,
    autoFixable: [],
    attempted: false,
  });
  assert.match(noAttempt, /no auto-fix attempt/);
  assert.match(noAttempt, /spec-divergence/);
  assert.doesNotMatch(noAttempt, /Auto-fix attempted/);

  const mixed = formatPartitionDispositionReason({
    residual,
    autoFixable: auto,
    attempted: true,
  });
  assert.match(mixed, /Human disposition required for residual non-allowlisted:/);
  assert.match(mixed, /Auto-fix attempted for allowlisted:/);
  assert.match(mixed, /concurrency/);
  assert.doesNotMatch(mixed, /no auto-fix attempt/);
});

test("formatPartitionDispositionReason: noop-still-broken lead keeps residual + attempted labels (#747 826962b1)", () => {
  const residual = [
    {
      ...blockingFinding("spec-divergence", "Partial list"),
      file: "core/scripts/stages/pre_merge.ts",
    } as ReviewFinding,
  ];
  const auto = [blockingFinding("concurrency", "TOCTOU")];
  const reason = formatPartitionDispositionReason({
    residual,
    autoFixable: auto,
    attempted: true,
    diagnostic: "worktree /x clean",
    noopStillBroken: [...auto, ...residual],
  });
  assert.match(reason, /auto-fix made no diff/);
  assert.match(reason, /core\/scripts\/stages\/pre_merge\.ts/);
  assert.match(reason, /Human disposition required for residual non-allowlisted:/);
  assert.match(reason, /spec-divergence/);
  assert.match(reason, /Auto-fix attempted for allowlisted:/);
  assert.match(reason, /concurrency/);
  assert.match(reason, /worktree \/x clean/);
  assert.doesNotMatch(reason, /no auto-fix attempt/);
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
  const deltaComments = rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX));
  assert.equal(deltaComments.length, 2, "initial delta comment + re-review delta comment both posted");
  assert.ok(
    rec.comments.some((c) => c.startsWith(PRE_MERGE_AUTOFIX_ATTEMPT_HEADING)),
    "attempt-started durable marker posted before harness",
  );
  assert.match(deltaComments[1], /reviewed-sha:/, "re-review comment embeds new reviewed-sha");
  assert.match(deltaComments[1], /verdict-diff-hash:/, "re-review comment embeds diff-hash");
});

// ---------------------------------------------------------------------------
// #682 9b5d8c51: post-auto-fix re-review approval must also emit delta-review/pass
// ---------------------------------------------------------------------------

test("pre-merge auto-fix #682: approving re-review records delta-review pass gate_result after autofix pass", async (t) => {
  const appended: string[] = [];
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  deps.runDir = "/runs/682-autofix";
  deps.runStoreDeps = {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p, data) => {
      appended.push(data);
    },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "auto-fix + re-review approved → pre-merge proceeds");
  assert.equal(rec.autoFixCalls, 1);

  const gateResults = appended
    .map((line) => JSON.parse(line) as { type?: string; gate?: string; result?: string })
    .filter((e) => e.type === "gate_result")
    .map((e) => `${e.gate}/${e.result}`);
  // Initial delta blocks, autofix is attempted and lands, then the approving
  // re-review must append delta-review/pass — not only pre-merge-autofix/pass.
  assert.ok(
    gateResults.includes("delta-review/fail"),
    `expected initial delta fail; got ${gateResults.join(",")}`,
  );
  assert.ok(
    gateResults.includes("pre-merge-autofix/partial"),
    `expected autofix attempted; got ${gateResults.join(",")}`,
  );
  assert.ok(
    gateResults.includes("pre-merge-autofix/pass"),
    `expected autofix pass; got ${gateResults.join(",")}`,
  );
  assert.ok(
    gateResults.includes("delta-review/pass"),
    `expected delta-review pass after autofix re-review approval (#682 9b5d8c51); got ${gateResults.join(",")}`,
  );
  const autofixPassIdx = gateResults.lastIndexOf("pre-merge-autofix/pass");
  const deltaPassIdx = gateResults.lastIndexOf("delta-review/pass");
  assert.ok(
    deltaPassIdx > autofixPassIdx,
    "delta-review/pass must be recorded after pre-merge-autofix/pass on the approve path",
  );
});

// ---------------------------------------------------------------------------
// #680: concurrency-only (and mixed allowlisted) → auto-fix once, not first-hop needs-human
// ---------------------------------------------------------------------------

test("pre-merge auto-fix #680: concurrency-only blocks → auto-fix once → re-review approves → return null", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("concurrency", "Lock ownership race on PID probe")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "#668-class concurrency findings must auto-fix + re-review, not first-hop needs-human");
  assert.equal(rec.autoFixCalls, 1, "auto-fix seam called exactly once");
  assert.equal(rec.deltaReviewCalls, 2, "initial delta + post-fix re-review");
  assert.deepEqual(rec.blocked, [], "setBlocked must NOT be called on successful fix path");
});

test("pre-merge auto-fix #680: mixed concurrency + correctness → auto-fix once", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [
      blockingFinding("concurrency", "Race on lock ownership"),
      blockingFinding("correctness", "Off-by-one in probe"),
    ],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null);
  assert.equal(rec.autoFixCalls, 1);
  assert.deepEqual(rec.blocked, []);
});

test("pre-merge auto-fix #747: concurrency + security → partition auto-fixes concurrency only", async (t) => {
  const concurrency = blockingFinding("concurrency", "Lock race");
  const security = blockingFinding("security", "Auth boundary");
  const { deps, rec } = makeDeps({
    findings: [concurrency, security],
    // Re-delta still blocks on residual security (allowlisted fixed).
    reReviewFindings: [reRaisedBlockingFinding(security)],
    autoFixResult: "fix-committed",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 1, "security residual must NOT veto concurrency auto-fix (#747)");
  assert.equal(rec.autoFixFindings.length, 1);
  assert.equal(rec.autoFixFindings[0].category, "concurrency");
  assert.equal(rec.autoFixFindings[0].title, "Lock race");
  assert.ok(rec.autoFixReviewComment, "fix prompt body must be passed");
  assert.match(rec.autoFixReviewComment!, /Lock race/);
  assert.doesNotMatch(rec.autoFixReviewComment!, /Auth boundary/, "security residual excluded from prompt");
  assert.equal(rec.blocked.length, 1, "residual security still needs human after re-delta");
  assert.match(rec.blocked[0].reason, /Human disposition required for residual non-allowlisted/);
  assert.match(rec.blocked[0].reason, /security/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted/);
  assert.match(rec.blocked[0].reason, /concurrency/);
});

test("pre-merge auto-fix #680: concurrency with prior auto-fix commit → exhausted, no second attempt", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("concurrency", "Lock ownership still races")],
    reReviewFindings: [blockingFinding("concurrency")],
    autoFixResult: "fix-committed",
    priorAutoFixCommit: true,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out?.advanced, false);
  assert.equal(out?.status, "blocked");
  assert.equal(out?.reason, "pre-merge delta review: blocking findings");
  // #683 attaches blockerKind / offrampPathTag for scoreboard offramp_class
  assert.equal(out?.blockerKind, "needs-human");
  assert.equal(out?.offrampPathTag, "delta-review");
  assert.equal(rec.autoFixCalls, 0, "one-attempt bound: no second concurrency auto-fix");
  assert.equal(rec.blocked.length, 1);
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
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0, autoFixFindings: [], autoFixReviewComment: null };
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
    listPrHeadChangeDirs: async () => [],
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
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
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
// 5.4 variant / #747: mixed correctness + non-allowlisted → partition auto-fix
// ---------------------------------------------------------------------------

test("pre-merge auto-fix 5.4b / #747: mixed correctness + scope → auto-fix correctness subset", async (t) => {
  const correctness = blockingFinding("correctness", "Null deref");
  const scope = blockingFinding("scope", "Out of plan");
  const { deps, rec } = makeDeps({
    findings: [correctness, scope],
    reReviewFindings: [reRaisedBlockingFinding(scope)],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 1, "mixed with scope still attempts auto-fix for correctness (#747)");
  assert.equal(rec.autoFixFindings.length, 1);
  assert.equal(rec.autoFixFindings[0].category, "correctness");
  assert.doesNotMatch(rec.autoFixReviewComment ?? "", /Out of plan/);
  assert.equal(out?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /scope/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted/);
});

// ---------------------------------------------------------------------------
// #747: mixed concurrency + spec-divergence partition (incl. #729-shaped)
// ---------------------------------------------------------------------------

test("pre-merge auto-fix #747: mixed concurrency + spec-divergence → auto-fix allowlisted subset", async (t) => {
  const concurrency = blockingFinding("concurrency", "TOCTOU on shared marker");
  const specDiv = blockingFinding("spec-divergence", "Partial-list AC unwired");
  const { deps, rec } = makeDeps({
    findings: [concurrency, specDiv],
    reReviewFindings: [], // both cleared after fix (optimistic path)
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "re-delta clean → proceed");
  assert.equal(rec.autoFixCalls, 1);
  assert.equal(rec.deltaReviewCalls, 2);
  assert.deepEqual(
    rec.autoFixFindings.map((f) => f.category),
    ["concurrency"],
  );
  assert.match(rec.autoFixReviewComment ?? "", /TOCTOU on shared marker/);
  assert.doesNotMatch(
    rec.autoFixReviewComment ?? "",
    /Partial-list AC unwired/,
    "residual spec-divergence excluded from fix prompt",
  );
  assert.deepEqual(rec.blocked, []);
});

test("pre-merge auto-fix #747 / #729-shaped: HIGH concurrency + HIGH spec-divergence does not skip auto-fix", async (t) => {
  // Dogfood #729: shared-style batch; old all-or-nothing gate would skip.
  const concurrency = blockingFinding("concurrency", "TOCTOU race on PID probe");
  const specDiv = blockingFinding("spec-divergence", "Partial list wiring for AC field");
  // Prove the old all-or-nothing helper would have vetoed this batch:
  assert.equal(
    allBlockingAutoFixable([concurrency, specDiv]),
    false,
    "bite: old all-or-nothing eligibility would skip this #729-shaped batch",
  );
  const p = partitionBlockingForAutofix([concurrency, specDiv]);
  assert.equal(p.autoFixable.length, 1);
  assert.equal(p.autoFixable[0].category, "concurrency");
  assert.equal(p.residual.length, 1);
  assert.equal(p.residual[0].category, "spec-divergence");

  const { deps, rec } = makeDeps({
    findings: [concurrency, specDiv],
    reReviewFindings: [reRaisedBlockingFinding(specDiv)], // residual still blocks after concurrency fix
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 1, "must attempt auto-fix despite co-batched spec-divergence");
  assert.equal(rec.autoFixFindings.length, 1);
  assert.equal(rec.autoFixFindings[0].category, "concurrency");
  assert.equal(rec.deltaReviewCalls, 2, "initial + post-fix re-delta");
  assert.equal(out?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /Human disposition required for residual/);
  assert.match(rec.blocked[0].reason, /spec-divergence/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted/);
  assert.match(rec.blocked[0].reason, /concurrency/);
  // One attempt only — residual does not unlock a second harness call.
  assert.equal(rec.autoFixCalls, 1);
});

test("pre-merge auto-fix #747: pure residual-only (spec-divergence) skips harness", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("spec-divergence", "AC mismatch")],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0, "pure residual skips harness");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /no auto-fix attempt/);
  assert.match(rec.blocked[0].reason, /spec-divergence/);
  assert.doesNotMatch(rec.blocked[0].reason, /Auto-fix attempted/);
});

// ---------------------------------------------------------------------------
// #747 review 1: disposition accounting (exhausted prior + final residual labels)
// ---------------------------------------------------------------------------

test("pre-merge auto-fix #747: mixed + prior attempt marker reports exhaustion, not no-attempt (5f4a751f)", async (t) => {
  // Bite: without autoFixAttemptRecognized, prior marker suppression left
  // attempted=false so residual text said "no auto-fix attempt".
  const concurrency = blockingFinding("concurrency", "TOCTOU still races");
  const specDiv = blockingFinding("spec-divergence", "Partial list still unwired");
  const { deps, rec } = makeDeps({
    findings: [concurrency, specDiv],
    reReviewFindings: [specDiv],
    autoFixResult: "fix-committed",
    priorAttemptMarker: true,
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0, "prior durable marker exhausts the one-attempt bound");
  assert.equal(rec.deltaReviewCalls, 1, "no post-fix re-delta when harness is skipped");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /Human disposition required for residual non-allowlisted:/);
  assert.match(rec.blocked[0].reason, /spec-divergence/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted:/);
  assert.match(rec.blocked[0].reason, /concurrency/);
  assert.doesNotMatch(
    rec.blocked[0].reason,
    /no auto-fix attempt/,
    "exhausted prior must not be mislabeled as unattempted",
  );
});

test("pre-merge auto-fix #747: mixed + prior auto-fix commit reports exhaustion, not no-attempt (5f4a751f)", async (t) => {
  const concurrency = blockingFinding("concurrency", "Lock ownership still races");
  const security = blockingFinding("security", "Auth gap remains");
  const { deps, rec } = makeDeps({
    findings: [concurrency, security],
    reReviewFindings: [security],
    autoFixResult: "fix-committed",
    priorAutoFixCommit: true,
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 0);
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /security/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted/);
  assert.doesNotMatch(rec.blocked[0].reason, /no auto-fix attempt/);
});

test("pre-merge auto-fix #747: post-fix re-delta residual labels final blocking findings (3d396927)", async (t) => {
  // Bite: categoryPartition retained from the initial delta meant the block
  // reason named the original residual key even when re-delta returned a
  // different residual finding that actually still blocks.
  const concurrency = blockingFinding("concurrency", "TOCTOU on shared marker");
  const originalResidual = blockingFinding("spec-divergence", "Original partial-list wiring");
  const differentResidual = reRaisedBlockingFinding(
    blockingFinding("spec-divergence", "Different residual after auto-fix"),
  );
  // Distinct finding keys: different titles without file/line → different findingKey.
  assert.notEqual(
    originalResidual.title,
    differentResidual.title,
    "fixture requires distinct residual titles so keys differ",
  );
  const { deps, rec } = makeDeps({
    findings: [concurrency, originalResidual],
    reReviewFindings: [differentResidual],
    autoFixResult: "fix-committed",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 1);
  assert.equal(rec.deltaReviewCalls, 2);
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /spec-divergence/);
  // Disposition labels are `findingKey (category)` — assert the final residual
  // key is present and the initial residual key is not retained after re-delta.
  const finalKey = findingKey(differentResidual);
  const originalKey = findingKey(originalResidual);
  assert.notEqual(finalKey, originalKey, "fixture keys must differ");
  assert.match(
    rec.blocked[0].reason,
    new RegExp(finalKey),
    "block reason must name the final residual finding key, not only the initial partition",
  );
  assert.doesNotMatch(
    rec.blocked[0].reason,
    new RegExp(originalKey),
    "stale initial residual key must not appear after re-delta replaced it",
  );
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted/);
  assert.match(rec.blocked[0].reason, /concurrency/);
});

test("pre-merge auto-fix #747: after partition attempt, residual still blocking → no second attempt", async (t) => {
  const concurrency = blockingFinding("concurrency", "Race remains");
  const product = blockingFinding("product-judgment-required", "Product call");
  const { deps, rec } = makeDeps({
    findings: [concurrency, product],
    reReviewFindings: [
      reRaisedBlockingFinding(concurrency),
      reRaisedBlockingFinding(product),
    ],
    autoFixResult: "fix-committed",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(rec.autoFixCalls, 1, "exactly one attempt");
  assert.equal(rec.deltaReviewCalls, 2);
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /product-judgment-required/);
  assert.match(rec.blocked[0].reason, /Auto-fix attempted for allowlisted/);
});

test("pre-merge auto-fix #747: all-allowlisted still attempts once (no regression)", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [
      blockingFinding("correctness", "Bug A"),
      blockingFinding("missing-dep", "Missing import"),
      blockingFinding("concurrency", "Race B"),
    ],
    reReviewFindings: [],
    autoFixResult: "fix-committed",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null);
  assert.equal(rec.autoFixCalls, 1);
  assert.equal(rec.autoFixFindings.length, 3);
  assert.deepEqual(
    rec.autoFixFindings.map((f) => f.category).sort(),
    ["concurrency", "correctness", "missing-dep"],
  );
  assert.deepEqual(rec.blocked, []);
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
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
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
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
  );
  assert.equal(rec.autoFixCalls, 1, "seam was called");
  assert.equal(rec.blocked.length, 1, "blocked after error");
  const deltaComments = rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX));
  assert.equal(deltaComments.length, 1, "only the initial delta comment; no re-review comment");
  assert.ok(
    rec.comments.some((c) => c.startsWith(PRE_MERGE_AUTOFIX_ATTEMPT_HEADING)),
    "attempt-started marker still posted before the failed harness",
  );
});

test("pre-merge auto-fix #553/#698: non-noop error with a diagnostic still surfaces it on hard block", async (t) => {
  // Generic error (dirty/timeout/unsalvaged) still hard-blocks with disclosure.
  // Clean no-commit is noop-clean and re-verifies (#698) — covered separately.
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "error",
  });
  deps.attemptPreMergeAutoFix = async () => ({
    status: "error",
    diagnostic:
      "pre-merge fix harness for #16 left worktree /fake/worktree in an unrecoverable dirty state",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out.status, "blocked");
  assert.equal(rec.blocked.length, 1, "blocked after error");
  assert.match(
    rec.blocked[0].reason,
    /\/fake\/worktree/,
    "the diagnostic naming the inspected worktree must reach the block reason",
  );
});

// ---------------------------------------------------------------------------
// one-attempt bound: fix committed but re-review still blocks → blocked, no 2nd attempt
// ---------------------------------------------------------------------------

test("pre-merge auto-fix: fix committed, re-review still blocks → needs-human, no second attempt", async (t) => {
  // Distinct title/file from the initial finding so re-review is not demoted as
  // an unacknowledged reversal of the just-posted delta (#389). A same-key
  // re-assert would become advisory and the gate would proceed.
  const residual: ReviewFinding = {
    ...blockingFinding("correctness", "Residual after fix"),
    file: "core/scripts/stages/other.ts",
    body: "A different residual defect that the auto-fix did not address",
  } as ReviewFinding;
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [residual],
    autoFixResult: "fix-committed",
    priorAutoFixCommit: false,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
  );
  assert.equal(rec.autoFixCalls, 1, "seam called exactly once");
  assert.equal(rec.blocked.length, 1, "blocked after re-review still blocks");
  // Initial delta + re-review delta (both use DELTA_REVIEW_MARKER_PREFIX).
  assert.equal(
    rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX)).length,
    2,
    "both initial and re-review delta comments posted",
  );
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
  const deltaComments = rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX));
  assert.equal(deltaComments.length, 2, "two delta comments posted");
  // Both delta comments must use the delta review marker prefix (not "## Review 2") so
  // countPriorRounds does not count them against the max_adversarial_rounds ceiling.
  for (const c of deltaComments) {
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
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0, autoFixFindings: [], autoFixReviewComment: null };
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
    listPrHeadChangeDirs: async () => [],
    getGhActor: async () => TEST_ACTOR,
    // No attemptPreMergeAutoFix seam.
  };

  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, depsNoFix);
  });
  assert.deepEqual(
    out,
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
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

test("performPreMergeAutoFix #553: harness cwd equals the salvage-inspected worktree path (worktree-locality invariant)", async () => {
  const { fn: gitFn } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — SAME as headBefore: no new commit)
    { code: 0, stdout: "sha1" },
    // reset --hard sha1 (rollback, since salvage found nothing)
    { code: 0, stdout: "" },
    // clean -fd (rollback)
    { code: 0, stdout: "" },
  ]);

  let invokeCwd: string | undefined;
  const invokeFn: InvokeFn = async (_harness, cwd) => {
    invokeCwd = cwd;
    return { success: false, stdout: "", stderr: "", exit_code: 1, duration: 1, timed_out: false };
  };
  let salvageCwd: string | undefined;
  const salvageFn = async (wtPath: string) => {
    salvageCwd = wtPath;
    return { salvaged: false } as TrySalvageResult;
  };

  await performPreMergeAutoFix(
    autoFixCfg, 42, "run-id", "finding: need fix", "Test issue", autoFixWt, gitFn, invokeFn, salvageFn,
  );

  assert.equal(invokeCwd, autoFixWt.path, "the fix harness must be invoked with the issue's managed worktree path");
  assert.equal(salvageCwd, autoFixWt.path, "salvage must inspect the exact same worktree path the harness ran in");
  assert.equal(
    invokeCwd, salvageCwd,
    "worktree-locality invariant: harness cwd and salvage-inspected path must never diverge",
  );
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
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0, autoFixFindings: [], autoFixReviewComment: null };

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
    listPrHeadChangeDirs: async () => [],
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
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
    "getPrCommits failure must block, not attempt auto-fix",
  );
  assert.equal(rec.autoFixCalls, 0, "auto-fix seam must NOT be called when commit scan fails");
  assert.equal(rec.blocked.length, 1, "must block pre-merge");
});

// Finding 2 regression: re-review returns needs-attention + zero findings → blocks
test("pre-merge auto-fix finding-2: re-review needs-attention + zero findings → blocks (not approved)", async (t) => {
  const rec: Rec = { comments: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0, autoFixFindings: [], autoFixReviewComment: null };

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
    listPrHeadChangeDirs: async () => [],
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
    { advanced: false, status: "blocked", reason: "pre-merge delta review: blocking findings", blockerKind: "needs-human", offrampPathTag: "delta-review" },
    "re-review needs-attention with zero findings must block, not approve",
  );
  assert.equal(rec.autoFixCalls, 1, "auto-fix was attempted once");
  assert.equal(rec.deltaReviewCalls, 2, "initial + re-review both ran");
  assert.equal(rec.blocked.length, 1, "must block on unparseable re-review output");
  // R2 Finding 2: the re-review comment must NOT embed a reviewed-sha sentinel when unparseable,
  // so the reuse path cannot treat it as a clean approval on the next re-entry.
  const deltaComments = rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX));
  assert.equal(deltaComments.length, 2, "initial + re-review comments both posted");
  assert.ok(
    !deltaComments[1].includes("<!-- reviewed-sha:"),
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
    listPrHeadChangeDirs: async () => [],
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
    listPrHeadChangeDirs: async () => [],
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
      listPrHeadChangeDirs: async () => [],
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
    const deltaComments = comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX));
    assert.equal(deltaComments.length, 2, "initial + re-review delta comments both posted");
    assert.match(
      deltaComments[1]!,
      new RegExp(`reviewed-sha: ${SHA_AFTER_FIX}`),
      "re-review comment's reviewed-sha must equal the post-fix head (auto-fix commit SHA)",
    );
    assert.ok(
      !deltaComments[1]!.includes(`reviewed-sha: ${SHA_HEAD}`),
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
      listPrHeadChangeDirs: async () => [],
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
        listPrHeadChangeDirs: async () => [],
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
      listPrHeadChangeDirs: async () => [],
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

// ---------------------------------------------------------------------------
// #547: pre-merge auto-fix salvage — no new commit + dirty worktree gets
// salvaged into a commit instead of discarded via reset --hard / clean -fd.
// ---------------------------------------------------------------------------

function makeFailInvoke(timedOut = false): InvokeFn {
  return async () => ({
    success: false,
    stdout: "",
    stderr: "",
    exit_code: timedOut ? 124 : 1,
    duration: 1,
    timed_out: timedOut,
  });
}

function makeSalvageFn(result: TrySalvageResult): {
  fn: (wtPath: string, issueNumber: number, pipelineRunId: string, stageLabel: string) => Promise<TrySalvageResult>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    fn: async (_wtPath, _issueNumber, _pipelineRunId, stageLabel) => {
      calls.push(stageLabel);
      return result;
    },
    calls,
  };
}

test("performPreMergeAutoFix #547: harness times out with a dirty worktree → salvaged, amended, pushed (not discarded)", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — SAME as headBefore: no new commit)
    { code: 0, stdout: "sha1" },
    // commit --amend -m ... (amend succeeds, over the salvaged commit)
    { code: 0, stdout: "" },
    // rev-parse HEAD (postFixHead, read after the amend — #371)
    { code: 0, stdout: "sha3" },
    // push origin <branch> (push succeeds)
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: true });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: dirty state",
    "Test issue",
    autoFixWt,
    gitFn,
    makeFailInvoke(true),
    salvageFn,
  );

  assert.deepEqual(
    result,
    { status: "fix-committed", headSha: "sha3" },
    "a crashed/timed-out harness's uncommitted work must be salvaged and pushed, not discarded",
  );
  assert.equal(salvageCalls.length, 1, "salvage must be attempted exactly once");
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.equal(resetCall, undefined, "a successful salvage must NOT roll back the worktree");
});

test("performPreMergeAutoFix #547: harness reports success without committing, worktree dirty → salvaged, amended, pushed", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — SAME as headBefore: no new commit)
    { code: 0, stdout: "sha1" },
    // commit --amend -m ... (amend succeeds, over the salvaged commit)
    { code: 0, stdout: "" },
    // rev-parse HEAD (postFixHead, read after the amend — #371)
    { code: 0, stdout: "sha3" },
    // push origin <branch> (push succeeds)
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: true });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
    salvageFn,
  );

  assert.deepEqual(
    result,
    { status: "fix-committed", headSha: "sha3" },
    "harness work left uncommitted must be salvaged and pushed, not discarded (issue #547, run 648)",
  );
  assert.equal(salvageCalls.length, 1, "salvage must be attempted exactly once");
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.equal(resetCall, undefined, "a successful salvage must NOT roll back the worktree");
});

test("performPreMergeAutoFix #547/#698: genuinely clean worktree (nothing to salvage) → noop-clean with #553 disclosure", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — SAME as headBefore: no new commit)
    { code: 0, stdout: "sha1" },
    // reset --hard sha1 (no-op rollback after clean tree)
    { code: 0, stdout: "" },
    // clean -fd
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: false });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeFailInvoke(true),
    salvageFn,
  );

  assert.equal(
    result.status,
    "noop-clean",
    "a clean worktree (nothing salvageable) is noop-clean for re-verify, not an immediate hard-block error",
  );
  // #553: the disclosed clean/no-commit outcome names the inspected
  // worktree so the operator can tell "harness ran, nothing recoverable"
  // apart from a silent no-op.
  assert.match(
    (result as { diagnostic?: string }).diagnostic ?? "",
    /\/fake\/worktree/,
    "the #553 disclosure must name the inspected worktree path",
  );
  assert.equal(
    (result as { headSha?: string }).headSha,
    "sha1",
    "noop-clean carries the unchanged head for re-verify",
  );
  assert.equal(salvageCalls.length, 1, "salvage is attempted (and finds nothing) before rollback");
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.ok(resetCall, "git reset --hard must still be called when nothing was salvaged");
});

test("performPreMergeAutoFix #553/#698: harness reports success with a genuinely clean worktree (no commit) → noop-clean names the worktree", async () => {
  const { fn: gitFn } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — SAME as headBefore: no new commit)
    { code: 0, stdout: "sha1" },
    // status --porcelain (post-harness: also clean)
    { code: 0, stdout: "" },
    // reset --hard sha1 (no-op rollback)
    { code: 0, stdout: "" },
    // clean -fd
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: false });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
    salvageFn,
  );

  assert.equal(result.status, "noop-clean", "clean no-commit is noop-clean for re-verify (#698)");
  assert.match(
    (result as { diagnostic?: string }).diagnostic ?? "",
    /\/fake\/worktree/,
    "a harness that reports success but leaves the worktree clean must still disclose the inspected worktree path",
  );
  assert.equal(salvageCalls.length, 1, "salvage is attempted (and finds nothing) before rollback");
});

test("performPreMergeAutoFix #547: harness committed AND left extra dirt → ambiguous case stays out of scope, existing rollback unchanged", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — DIFFERENT: a commit was made)
    { code: 0, stdout: "sha2" },
    // status --porcelain (post-harness: extra dirt remains)
    { code: 0, stdout: "M  core/scripts/foo.ts" },
    // reset --hard sha1 (rollback)
    { code: 0, stdout: "" },
    // clean -fd (rollback)
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: true });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
    salvageFn,
  );

  assert.deepEqual(
    result,
    { status: "error" },
    "a commit alongside extra leftover dirt is out of scope (design decision 2) — must still roll back",
  );
  assert.equal(
    salvageCalls.length, 0,
    "salvage must NOT be attempted when the harness already produced a commit",
  );
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.ok(resetCall, "git reset --hard must still be called for the ambiguous commit+dirt case");
});

test("performPreMergeAutoFix R1-F1: post-harness HEAD read fails/empty → fail-closed rollback, salvage NOT called", async () => {
  const { fn: gitFn, calls } = makeSeqGitFn([
    // rev-parse HEAD (headBefore)
    { code: 0, stdout: "sha1" },
    // status --porcelain (pre-fix: clean)
    { code: 0, stdout: "" },
    // checkout -B <branch> (reattach succeeds)
    { code: 0, stdout: "" },
    // rev-parse HEAD (headAfterHarness — read fails/empty: cannot prove no new commit)
    { code: 1, stdout: "" },
    // reset --hard sha1 (rollback)
    { code: 0, stdout: "" },
    // clean -fd (rollback)
    { code: 0, stdout: "" },
  ]);
  const { fn: salvageFn, calls: salvageCalls } = makeSalvageFn({ salvaged: true });

  const result = await performPreMergeAutoFix(
    autoFixCfg,
    42,
    "run-id",
    "finding: need fix",
    "Test issue",
    autoFixWt,
    gitFn,
    makeSucceedInvoke(),
    salvageFn,
  );

  assert.deepEqual(
    result,
    { status: "error" },
    "an unreadable/empty post-harness HEAD must NOT be treated as no-new-commit — fail closed",
  );
  assert.equal(
    salvageCalls.length, 0,
    "salvage must NOT be attempted when we cannot prove HEAD is unchanged",
  );
  const resetCall = calls.find((a) => a[0] === "reset" && a[1] === "--hard");
  assert.ok(resetCall, "git reset --hard must still be called when the HEAD read is inconclusive");
});

// Bite check: without the #547 salvage wiring (i.e. the pre-change code),
// the "harness times out with a dirty worktree" scenario above would instead
// hit the unconditional `!result.success` rollback (never calling salvageFn,
// never checking hasNewCommitHarness) and return `{ status: "error" }` — the
// exact behavior observed on lyric-utils run 648/2026-07-23 that this change
// fixes. This is proven by the assertions above: `salvageCalls.length === 1`
// only holds because the fix calls `salvageFn` before rolling back on the
// crash path, and `result.status === "fix-committed"` only holds because a
// successful salvage is no longer discarded.

// ---------------------------------------------------------------------------
// #698: clean no-op auto-fix → re-verify against HEAD (not immediate hard block)
// ---------------------------------------------------------------------------

test("preMergeAutofixNoopComment: attested durable marker at head SHA", () => {
  const body = preMergeAutofixNoopComment({
    issueNumber: 16,
    headSha: SHA_HEAD,
    diagnostic: "worktree /fake clean",
    timestamp: "2026-07-29T00:00:00Z",
  });
  assert.ok(body.startsWith(PRE_MERGE_AUTOFIX_NOOP_HEADING));
  assert.ok(isVerifiedPipelineAttestation(body), "marker must carry a verified pipeline attestation");
  assert.equal(
    hasPreMergeAutofixNoopAtHead(
      [{ author: TEST_ACTOR, body }],
      SHA_HEAD,
      TEST_ACTOR,
    ),
    true,
  );
  assert.equal(
    hasPreMergeAutofixNoopAtHead(
      [{ author: TEST_ACTOR, body }],
      SHA_AFTER_FIX,
      TEST_ACTOR,
    ),
    false,
    "marker is head-SHA specific",
  );
  assert.equal(
    hasPreMergeAutofixNoopAtHead(
      [{ author: "attacker", body }],
      SHA_HEAD,
      TEST_ACTOR,
    ),
    false,
    "untrusted author must not satisfy the durable marker",
  );
});

test("formatNoopStillBrokenReason: names path and no-diff recipe", () => {
  const reason = formatNoopStillBrokenReason(
    [blockingFinding("correctness", "stale class"), {
      ...blockingFinding("correctness"),
      file: "core/scripts/stages/pre_merge.ts",
      title: "misclassified off-ramp",
    } as ReviewFinding],
    "worktree /x clean",
  );
  assert.match(reason, /auto-fix made no diff/);
  assert.match(reason, /core\/scripts\/stages\/pre_merge\.ts/);
  assert.match(reason, /human fix required/);
  assert.match(reason, /worktree \/x clean/);
});

test("pre-merge auto-fix #698: noop-clean → re-verify approve → proceeds (no setBlocked)", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [], // re-verify clean: finding gone / already fixed
    autoFixResult: "noop-clean",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "noop-clean + re-verify approve → pre-merge proceeds");
  assert.equal(rec.autoFixCalls, 1, "auto-fix seam called exactly once");
  assert.equal(rec.deltaReviewCalls, 2, "initial delta + re-verify both ran (bites if re-verify skipped)");
  assert.deepEqual(rec.blocked, [], "setBlocked must NOT be called on re-verify clean");
  // Durable marker + re-verify delta comment (and initial delta).
  assert.ok(
    rec.comments.some((c) => c.startsWith(PRE_MERGE_AUTOFIX_NOOP_HEADING)),
    "must post durable noop-clean marker",
  );
  assert.ok(
    rec.comments.filter((c) => c.startsWith(DELTA_REVIEW_MARKER_PREFIX)).length >= 2,
    "initial + re-verify delta comments",
  );
});

test("pre-merge auto-fix #698: noop-clean → re-verify still blocks → needs-human once with recipe", async (t) => {
  // Distinct residual finding (not a same-key re-assert) so it stays blocking
  // under the #389 reversal demotion rules — models a true still-broken case.
  const stillBroken: ReviewFinding = {
    ...blockingFinding("correctness", "Still broken after noop"),
    file: "core/scripts/stages/pre_merge.ts",
    body: "HEAD still implements the incorrect control-flow for this off-ramp",
  } as ReviewFinding;
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [stillBroken],
    autoFixResult: "noop-clean",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out?.advanced, false);
  assert.equal(out?.status, "blocked");
  assert.equal(out?.reason, "pre-merge delta review: blocking findings");
  assert.equal(out?.blockerKind, "needs-human");
  assert.equal(out?.offrampPathTag, "delta-review");
  assert.equal(rec.autoFixCalls, 1, "exactly one auto-fix attempt");
  assert.equal(rec.deltaReviewCalls, 2, "initial + re-verify; no second fix");
  assert.equal(rec.blocked.length, 1, "exactly one needs-human");
  assert.match(rec.blocked[0].reason, /auto-fix made no diff/);
  assert.match(rec.blocked[0].reason, /core\/scripts\/stages\/pre_merge\.ts/);
  assert.match(rec.blocked[0].reason, /\/fake\/worktree/);
});

test("pre-merge auto-fix #747: mixed noop-clean re-verify still blocks keeps residual + attempted labels (826962b1)", async (t) => {
  // Bite: autoFixBlockReason = formatNoopStillBrokenReason alone discarded
  // partition disposition naming on the clean-noop re-verify block path.
  const concurrency = blockingFinding("concurrency", "TOCTOU on shared marker");
  const residualStill: ReviewFinding = {
    ...reRaisedBlockingFinding(
      blockingFinding("spec-divergence", "Partial list still unwired after noop"),
    ),
    file: "core/scripts/stages/pre_merge.ts",
  } as ReviewFinding;
  const allowlistedStill: ReviewFinding = {
    ...reRaisedBlockingFinding(
      blockingFinding("concurrency", "TOCTOU still races after noop"),
    ),
    file: "core/scripts/lock.ts",
  } as ReviewFinding;
  const { deps, rec } = makeDeps({
    findings: [concurrency, blockingFinding("spec-divergence", "Partial list AC")],
    reReviewFindings: [allowlistedStill, residualStill],
    autoFixResult: "noop-clean",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out?.status, "blocked");
  assert.equal(rec.autoFixCalls, 1, "one bounded auto-fix on allowlisted subset");
  assert.equal(rec.deltaReviewCalls, 2, "initial delta + post-noop re-verify");
  assert.equal(rec.autoFixFindings.length, 1);
  assert.equal(rec.autoFixFindings[0].category, "concurrency");
  assert.equal(rec.blocked.length, 1);
  // Noop recipe preserved.
  assert.match(rec.blocked[0].reason, /auto-fix made no diff/);
  assert.match(rec.blocked[0].reason, /human fix required/i);
  // Partition disposition labels must survive the noop block-reason path.
  assert.match(
    rec.blocked[0].reason,
    /Human disposition required for residual non-allowlisted:/,
    "residual human-required subset must be named",
  );
  assert.match(rec.blocked[0].reason, /spec-divergence/);
  assert.match(
    rec.blocked[0].reason,
    /Auto-fix attempted for allowlisted:/,
    "allowlisted attempt scope must be named",
  );
  assert.match(rec.blocked[0].reason, /concurrency/);
  assert.match(rec.blocked[0].reason, /\/fake\/worktree/);
  assert.doesNotMatch(rec.blocked[0].reason, /no auto-fix attempt/);
});

test("pre-merge auto-fix #698: prior durable noop-clean marker exhausts attempt without second harness invoke", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "noop-clean", // would re-verify if called — must NOT be called
    priorNoopCleanMarker: true,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out.status, "blocked");
  assert.equal(rec.autoFixCalls, 0, "prior noop-clean marker must prevent a second auto-fix");
  assert.equal(rec.deltaReviewCalls, 1, "only the initial delta review; no re-verify after skipped fix");
  assert.equal(rec.blocked.length, 1);
});

test("pre-merge auto-fix #698 review-2: prior attempt-started marker exhausts attempt without second harness invoke", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "noop-clean",
    priorAttemptMarker: true,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out.status, "blocked");
  assert.equal(rec.autoFixCalls, 0, "prior attempt-started marker must prevent a second auto-fix");
  assert.equal(rec.blocked.length, 1);
});

test("pre-merge auto-fix #698 review-2: noop completion marker post fails — re-verify continues; second entry does not re-invoke harness", async (t) => {
  // Entry 1: harness runs, noop-clean, completion marker post fails, re-verify
  // still blocks. Attempt-started was posted first so the bound is durable.
  const residual: ReviewFinding = {
    ...blockingFinding("correctness", "Still broken after noop"),
    file: "core/scripts/stages/pre_merge.ts",
  } as ReviewFinding;
  const first = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [residual],
    autoFixResult: "noop-clean",
    failNoopCompletionMarker: true,
  });
  let out1: any;
  await quiet(t, async () => {
    out1 = await enforceReviewShaGate(cfgWithPolicy, 16, 99, first.deps);
  });
  assert.equal(out1.status, "blocked");
  assert.equal(first.rec.autoFixCalls, 1, "first entry runs harness once");
  assert.equal(first.rec.deltaReviewCalls, 2, "re-verify still runs despite completion-marker failure");
  assert.ok(
    first.rec.comments.some((c) => c.startsWith(PRE_MERGE_AUTOFIX_ATTEMPT_HEADING)),
    "attempt-started marker must be posted",
  );
  assert.ok(
    !first.rec.comments.some((c) => c.startsWith(PRE_MERGE_AUTOFIX_NOOP_HEADING)),
    "noop completion marker must not be present when post fails",
  );

  // Entry 2: only the attempt-started marker is durable — must NOT re-invoke harness.
  const second = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "noop-clean",
    priorAttemptMarker: true,
  });
  let out2: any;
  await quiet(t, async () => {
    out2 = await enforceReviewShaGate(cfgWithPolicy, 16, 99, second.deps);
  });
  assert.equal(out2.status, "blocked");
  assert.equal(
    second.rec.autoFixCalls,
    0,
    "second entry must not re-invoke auto-fix when attempt-started marker is present",
  );
});

test("pre-merge auto-fix #698 review-2: attempt-started marker post fails — harness not invoked", async (t) => {
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [],
    autoFixResult: "noop-clean",
    failAttemptMarker: true,
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out.status, "blocked");
  assert.equal(rec.autoFixCalls, 0, "must not invoke harness when attempt marker cannot be recorded");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /attempt marker/i);
});

test("pre-merge auto-fix #698: #683-class stale classification already correct on HEAD does not hard-block", async (t) => {
  // Models dogfood #683: delta claims openspec-invalid misclassification, but
  // HEAD already routes that off-ramp to needs-human. Auto-fix correctly makes
  // no commit; re-verify approves (finding not reproducible).
  const staleClassification: ReviewFinding = {
    severity: "high",
    title: "dirty-worktree still classified as openspec-invalid",
    body: "Archive cleanliness path should not inflate openspec-invalid",
    confidence: 0.9,
    recommendation: "Use needs-human for archive cleanliness failure",
    category: "correctness",
    file: "core/scripts/stages/pre_merge.ts",
  } as ReviewFinding;
  const { deps, rec } = makeDeps({
    findings: [staleClassification],
    reReviewFindings: [], // re-verify: not reproducible / already fixed on HEAD
    autoFixResult: "noop-clean",
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out, null, "#683-class stale finding must not hard-block when re-verify is clean");
  assert.deepEqual(rec.blocked, [], "no needs-human when HEAD already correct");
  assert.equal(rec.autoFixCalls, 1);
  assert.equal(rec.deltaReviewCalls, 2, "re-verify must run (would fail if hard-blocked on clean no-commit alone)");
});

test("pre-merge auto-fix #698: re-raised #683-class finding demoted when HEAD already implements recommendation", async (t) => {
  // Failure mode the review required: after noop-clean, re-verify returns a
  // *new* pure classification claim (distinct from the initial delta finding so
  // #389/#496 settled-surface/reversal demotion cannot swallow it) asserting
  // HEAD is still wrong, while the cited region already implements the
  // recommended `needs-human` routing. Without the classification HEAD filter
  // the finding stays blocking and needs-human strands the item.
  const initialDeltaFinding = blockingFinding("correctness", "unrelated auto-fixable claim");
  const staleClassification: ReviewFinding = {
    severity: "high",
    title: "dirty-worktree still classified as openspec-invalid",
    body:
      "Archive cleanliness path is still misclassified as openspec-invalid " +
      "instead of the correct off-ramp.",
    confidence: 0.94,
    recommendation: "Use `needs-human` for archive cleanliness failure",
    category: "correctness",
    file: "core/scripts/stages/pre_merge.ts",
    line_start: 1,
    line_end: 5,
  } as ReviewFinding;
  const headAlreadyCorrect: HeadFileState = {
    path: "core/scripts/stages/pre_merge.ts",
    content:
      "// archive cleanliness off-ramp\n" +
      "if (archiveDirty) {\n" +
      '  await setBlocked(cfg, n, reason, "pre-merge", "needs-human");\n' +
      '  return { advanced: false, status: "blocked" };\n' +
      "}\n",
    truncated: false,
    present: true,
  };
  const { deps, rec } = makeDeps({
    findings: [initialDeltaFinding],
    reReviewFindings: [staleClassification],
    autoFixResult: "noop-clean",
    headFiles: [headAlreadyCorrect],
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(
    out,
    null,
    "unsupported classification claim against already-correct HEAD must not hard-block",
  );
  assert.deepEqual(rec.blocked, [], "must demote via HEAD classification filter, not setBlocked");
  assert.equal(rec.autoFixCalls, 1, "exactly one auto-fix; demotion is not a second fix");
  assert.equal(rec.deltaReviewCalls, 2, "initial delta + re-verify both ran");
});

test("pre-merge auto-fix #698: re-raised classification with current-file evidence stays blocking", async (t) => {
  // When HEAD is still wrong and the finding quotes current file lines, demotion
  // must NOT fire — still-broken with evidence remains needs-human. Distinct
  // from the initial delta finding so reversal/settled-surface cannot demote it
  // before the HEAD classification filter sees the evidence.
  const stillWrongLine =
    'return { status: "openspec-invalid", reason: "archive dirty" }; // still wrong off-ramp';
  const withEvidence: ReviewFinding = {
    severity: "high",
    title: "dirty-worktree still classified as openspec-invalid",
    body:
      "HEAD still implements the incorrect classification. Current file shows:\n" +
      stillWrongLine,
    confidence: 0.94,
    recommendation: "Use `needs-human` for archive cleanliness failure",
    category: "correctness",
    file: "core/scripts/stages/pre_merge.ts",
    line_start: 1,
    line_end: 3,
  } as ReviewFinding;
  const headStillWrong: HeadFileState = {
    path: "core/scripts/stages/pre_merge.ts",
    content:
      "function classifyArchive(dirty: boolean) {\n" +
      `  ${stillWrongLine}\n` +
      "}\n",
    truncated: false,
    present: true,
  };
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness", "unrelated auto-fixable claim")],
    reReviewFindings: [withEvidence],
    autoFixResult: "noop-clean",
    headFiles: [headStillWrong],
  });
  let out: any;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(out?.status, "blocked", "current-file evidence of still-wrong behavior must block");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0].reason, /auto-fix made no diff/);
});

// ---------------------------------------------------------------------------
// Pure helpers: post-noop classification HEAD evidence rule (#698/#683)
// ---------------------------------------------------------------------------

test("applyNoopHeadClassificationEvidenceRule: demotes pure claim when cited region has recommendation token", () => {
  const f: ReviewFinding = {
    severity: "high",
    title: "misclassified as openspec-invalid",
    body: "This off-ramp is still classified as openspec-invalid",
    confidence: 0.9,
    recommendation: "Route to `needs-human` instead",
    category: "correctness",
    file: "core/scripts/stages/pre_merge.ts",
    line_start: 1,
    line_end: 1,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "core/scripts/stages/pre_merge.ts",
      content: 'await setBlocked(cfg, n, r, "pre-merge", "needs-human");\n',
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [], "must demote when cited region implements recommendation");
  assert.equal(result.demoted.length, 1);
  assert.equal(result.demoted[0].reason, HEAD_ALREADY_IMPLEMENTS_RECOMMENDATION);
});

test("applyNoopHeadClassificationEvidenceRule: keeps blocking when recommendation token is only outside cited region", () => {
  // Review-2 finding: whole-file token match demoted a valid blocking claim on
  // one branch because another branch elsewhere in the same file already had
  // the recommended token.
  const f: ReviewFinding = {
    severity: "high",
    title: "branch B still misclassified as openspec-invalid",
    body: "The archive off-ramp on branch B is still classified as openspec-invalid",
    confidence: 0.95,
    recommendation: "Route branch B to `needs-human`",
    category: "correctness",
    file: "a.ts",
    line_start: 5,
    line_end: 7,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "a.ts",
      content:
        "// branch A (correct, unrelated)\n" +
        'if (other) { return "needs-human"; }\n' +
        "\n" +
        "// branch B (still wrong — cited region)\n" +
        "if (archiveDirty) {\n" +
        '  return { status: "openspec-invalid" };\n' +
        "}\n",
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(
    result.blocking,
    [f],
    "token elsewhere in the file must not demote a finding about a different cited region",
  );
  assert.equal(result.demoted.length, 0);
});

test("applyNoopHeadClassificationEvidenceRule: keeps blocking when line_start is absent (no region)", () => {
  const f: ReviewFinding = {
    severity: "high",
    title: "misclassified as openspec-invalid",
    body: "This off-ramp is still classified as openspec-invalid",
    confidence: 0.9,
    recommendation: "Route to `needs-human` instead",
    category: "correctness",
    file: "a.ts",
    // no line_start — whole-file match is insufficient
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "a.ts",
      content: 'await setBlocked(..., "needs-human");\n',
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [f], "missing cited region fails closed to blocking");
  assert.equal(result.demoted.length, 0);
});

test("applyNoopHeadClassificationEvidenceRule: keeps blocking when body quotes HEAD evidence", () => {
  const quoted =
    'return { status: "openspec-invalid", reason: "archive cleanliness failed" };';
  const f: ReviewFinding = {
    severity: "high",
    title: "misclassified as openspec-invalid",
    body: `Current HEAD still has the wrong control-flow:\n${quoted}`,
    confidence: 0.9,
    recommendation: "Use `needs-human`",
    category: "correctness",
    file: "a.ts",
    line_start: 1,
    line_end: 3,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "a.ts",
      content: `${quoted}\n// also mentions needs-human elsewhere\nconst x = "needs-human";\n`,
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [f], "quoted HEAD evidence of still-wrong behavior stays blocking");
  assert.equal(result.demoted.length, 0);
});

test("applyNoopHeadClassificationEvidenceRule: keeps non-classification findings blocking", () => {
  const f: ReviewFinding = {
    severity: "high",
    title: "null deref in parser",
    body: "Missing null check causes crash",
    confidence: 0.9,
    recommendation: "Add a null guard",
    category: "correctness",
    file: "parser.ts",
    line_start: 1,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "parser.ts",
      content: "export function parse(x) { return x.value; }\n",
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [f]);
  assert.equal(result.demoted.length, 0);
});

test("applyNoopHeadClassificationEvidenceRule: keeps blocking when HEAD cannot prove recommendation", () => {
  const f: ReviewFinding = {
    severity: "high",
    title: "misclassified as openspec-invalid",
    body: "Off-ramp classification is wrong",
    confidence: 0.9,
    recommendation: "Use `needs-human`",
    category: "correctness",
    file: "a.ts",
    line_start: 1,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "a.ts",
      content: 'return { status: "openspec-invalid" };\n',
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [f], "cannot prove HEAD implements recommendation → keep blocking");
});

test("applyNoopHeadClassificationEvidenceRule: executable failure evidence keeps finding blocking", () => {
  const f: ReviewFinding = {
    severity: "high",
    title: "misclassified as openspec-invalid",
    body: "npm test still fails with exit code 1 when archive is dirty",
    confidence: 0.9,
    recommendation: "Use `needs-human`",
    category: "correctness",
    file: "a.ts",
    line_start: 1,
  } as ReviewFinding;
  const headFiles: HeadFileState[] = [
    {
      path: "a.ts",
      content: 'await setBlocked(..., "needs-human");\n',
      truncated: false,
      present: true,
    },
  ];
  const result = applyNoopHeadClassificationEvidenceRule([f], headFiles);
  assert.deepEqual(result.blocking, [f], "executable failure evidence must keep finding blocking");
});

test("isClassificationOrControlFlowClaim / extractClassificationTokens / headImplements helpers", () => {
  assert.equal(
    isClassificationOrControlFlowClaim({
      title: "null deref",
      body: "crash",
      recommendation: "guard",
    }),
    false,
  );
  assert.equal(
    isClassificationOrControlFlowClaim({
      title: "misclassified off-ramp",
      body: "classified as openspec-invalid",
      recommendation: "Use needs-human",
    }),
    true,
  );
  // Arbitrary backticks in claim+recommendation are NOT enough without
  // classification language + a known pipeline recommendation token.
  assert.equal(
    isClassificationOrControlFlowClaim({
      title: "missing `parseFoo` call",
      body: "Should invoke `parseFoo` here",
      recommendation: "Call `parseFoo` first",
    }),
    false,
    "arbitrary backticks must not classify a finding as pure classification",
  );
  assert.ok(extractClassificationTokens("Use `needs-human` please").includes("needs-human"));
  assert.deepEqual(
    extractKnownPipelineClassificationTokens("Use `parseFoo` and needs-human"),
    ["needs-human"],
    "known tokens only — ignore arbitrary backticks",
  );
  assert.equal(
    citedRegionContent("a\nb\nc\n", 2, 3),
    "b\nc",
  );
  assert.equal(citedRegionContent("a\nb\n", undefined, undefined), null);
  assert.equal(
    headImplementsRecommendedClassification(
      { file: "a.ts", recommendation: "Use `needs-human`", line_start: 1, line_end: 1 },
      [{ path: "a.ts", content: 'status: "needs-human"', truncated: false, present: true }],
    ),
    true,
  );
  assert.equal(
    headImplementsRecommendedClassification(
      { file: "a.ts", recommendation: "Use `needs-human`" }, // no line range
      [{ path: "a.ts", content: 'status: "needs-human"', truncated: false, present: true }],
    ),
    false,
    "whole-file presence without cited region must not prove recommendation",
  );
  assert.equal(citesExecutableFailureEvidence("assert.equal(x, y) failed"), true);
  assert.equal(citesExecutableFailureEvidence("looks wrong to me"), false);
});

test("preMergeAutofixAttemptComment / hasPreMergeAutofixBoundMarkerAtHead", () => {
  const body = preMergeAutofixAttemptComment({
    issueNumber: 16,
    headSha: SHA_HEAD,
    timestamp: "2026-07-29T00:00:00Z",
  });
  assert.ok(body.startsWith(PRE_MERGE_AUTOFIX_ATTEMPT_HEADING));
  assert.ok(isVerifiedPipelineAttestation(body));
  assert.equal(
    hasPreMergeAutofixAttemptAtHead([{ author: TEST_ACTOR, body }], SHA_HEAD, TEST_ACTOR),
    true,
  );
  assert.equal(
    hasPreMergeAutofixBoundMarkerAtHead([{ author: TEST_ACTOR, body }], SHA_HEAD, TEST_ACTOR),
    true,
  );
  assert.equal(
    hasPreMergeAutofixAttemptAtHead([{ author: TEST_ACTOR, body }], SHA_AFTER_FIX, TEST_ACTOR),
    false,
  );
});

test("pre-merge auto-fix #698 (bite): if re-verify skipped, noop-clean must not silently approve", async (t) => {
  // Guard: a seam that returns noop-clean without the gate re-verifying would
  // either hard-block (pre-#698) or wrongly proceed. Our path always re-verifies;
  // this test locks that re-verify is invoked by asserting deltaReviewCalls === 2
  // when re-verify itself still blocks (cannot be confused with "skip → block").
  const residual: ReviewFinding = {
    ...blockingFinding("correctness", "Residual bite"),
    file: "core/scripts/stages/other.ts",
  } as ReviewFinding;
  const { deps, rec } = makeDeps({
    findings: [blockingFinding("correctness")],
    reReviewFindings: [residual],
    autoFixResult: "noop-clean",
  });
  await quiet(t, async () => {
    await enforceReviewShaGate(cfgWithPolicy, 16, 99, deps);
  });
  assert.equal(
    rec.deltaReviewCalls,
    2,
    "regression: removing the re-verify branch would leave deltaReviewCalls at 1",
  );
  assert.equal(rec.blocked.length, 1, "still-broken re-verify must escalate");
});
