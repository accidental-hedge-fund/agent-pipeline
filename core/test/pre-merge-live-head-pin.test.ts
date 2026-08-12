// #1010 — live-head pin helpers + residual SHA scope regressions.
// Pure unit tests for classifyRecordedShaAgainstLiveHead and SHA-scoped residual
// authority at pre-merge gate start. Injectable deps only (no network/git).

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  appendDualShaEscalationDisclosure,
  classifyRecordedShaAgainstLiveHead,
  recordedShaIsCurrentForLiveHead,
} from "../scripts/stages/pre-merge-shared.ts";
import {
  enforceReviewShaGate,
  type ShaGateDeps,
} from "../scripts/stages/pre-merge-sha-gate.ts";
import type { PipelineConfig, ReviewFinding, Stage } from "../scripts/types.ts";
import { DELTA_REVIEW_MARKER_PREFIX } from "../scripts/stages/review.ts";
import {
  loadTesterEvidenceForReviewSync,
  type TesterEvidence,
} from "../scripts/tester-evidence.ts";

const H_FAIL = "d8f2da7a8b322ec8dfa6843472adeddaa6a51642";
const H_GREEN = "d14ac0ac71f6a8758f886fe8e6c91c4bcddbbd81";
const TEST_ACTOR = "pipeline-bot";

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

test("classifyRecordedShaAgainstLiveHead: current when both full SHAs match (#1010)", () => {
  const c = classifyRecordedShaAgainstLiveHead(H_GREEN.toUpperCase(), H_GREEN);
  assert.equal(c.status, "current");
  assert.equal(recordedShaIsCurrentForLiveHead(H_GREEN, H_GREEN), true);
});

test("classifyRecordedShaAgainstLiveHead: stale when recorded differs from live head (#1010)", () => {
  const c = classifyRecordedShaAgainstLiveHead(H_FAIL, H_GREEN);
  assert.equal(c.status, "stale");
  assert.equal(c.recordedSha, H_FAIL);
  assert.equal(c.liveHead, H_GREEN);
  assert.equal(recordedShaIsCurrentForLiveHead(H_FAIL, H_GREEN), false);
});

test("classifyRecordedShaAgainstLiveHead: stale when recorded SHA absent/legacy (#1010)", () => {
  assert.equal(classifyRecordedShaAgainstLiveHead(null, H_GREEN).status, "stale");
  assert.equal(classifyRecordedShaAgainstLiveHead(undefined, H_GREEN).status, "stale");
  assert.equal(classifyRecordedShaAgainstLiveHead("not-a-sha", H_GREEN).status, "stale");
});

test("classifyRecordedShaAgainstLiveHead: unknown when live head pin is missing (#1010)", () => {
  assert.equal(classifyRecordedShaAgainstLiveHead(H_FAIL, null).status, "unknown");
  assert.equal(classifyRecordedShaAgainstLiveHead(H_FAIL, "short").status, "unknown");
});

test("appendDualShaEscalationDisclosure: names prior candidate and live head (#1010)", () => {
  const text = appendDualShaEscalationDisclosure(
    "Pre-merge residual findings remain.",
    H_GREEN,
    H_FAIL,
    true,
  );
  assert.match(text, new RegExp(H_FAIL));
  assert.match(text, new RegExp(H_GREEN));
  assert.match(text, /pipeline override/i);
  assert.match(text, /superseded/i);
});

// ---------------------------------------------------------------------------
// Tester evidence: mismatched fail is stale, not live-head fail authority
// ---------------------------------------------------------------------------

function baseEvidence(over: Partial<TesterEvidence> = {}): TesterEvidence {
  return {
    schema_version: 1,
    kind: "tester_evidence",
    candidate_sha: H_FAIL,
    overall_status: "failed",
    overall_reason: "suite failed",
    run_id: "r",
    issue: 1010,
    pr: 1009,
    worktree_id: "wt",
    produced_at: "2026-08-12T00:00:00Z",
    config_digest: "a".repeat(64),
    toolchain: {},
    commands: [],
    tests: [],
    ...over,
  } as TesterEvidence;
}

test("tester evidence: mismatched fail at H_fail with live head H_green is stale (#1010)", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "ok", evidence: baseEvidence({ candidate_sha: H_FAIL, overall_status: "failed" }) },
    H_GREEN,
    "fail_closed",
  );
  assert.equal(acq.classification, "stale");
  assert.equal(acq.withholdInvoke, true);
  assert.match(acq.reason, /fail|test-gate-exhausted|MUST NOT supply fail/i);
  assert.equal(acq.artifact?.overall_status, "failed");
  // Stale artifact is present for diagnostics but not current fail authority.
  assert.notEqual(acq.classification, "current");
});

test("tester evidence: matching fail at live head remains current/authoritative (#1010)", () => {
  const acq = loadTesterEvidenceForReviewSync(
    { status: "ok", evidence: baseEvidence({ candidate_sha: H_GREEN, overall_status: "failed" }) },
    H_GREEN,
    "fail_closed",
  );
  assert.equal(acq.classification, "current");
  assert.equal(acq.withholdInvoke, false);
  assert.equal(acq.artifact?.overall_status, "failed");
});

test("tester evidence: matching pass at live head remains current (#1010)", () => {
  const acq = loadTesterEvidenceForReviewSync(
    {
      status: "ok",
      evidence: baseEvidence({ candidate_sha: H_GREEN, overall_status: "passed" }),
    },
    H_GREEN,
    "fail_closed",
  );
  assert.equal(acq.classification, "current");
  assert.equal(acq.artifact?.overall_status, "passed");
});

// ---------------------------------------------------------------------------
// SHA-gate residual: prior-head keys re-eval; same-head residual still blocks
// ---------------------------------------------------------------------------

const cfg = {
  review_policy: { block_threshold: "low" as const, min_confidence: 0 },
  harnesses: { reviewer: "claude" },
} as unknown as PipelineConfig;

interface Rec {
  comments: string[];
  transitions: { from: Stage; to: Stage }[];
  blocked: Array<{ reason: string }>;
  autoFixCalls: number;
  deltaReviewCalls: number;
}

function blockingComment(sha: string, key: string): string {
  return (
    `## Review 2 (Adversarial) — needs-attention\n\n` +
    `Blocking finding.\n\n` +
    `<!-- pipeline-blocking-keys: ${key} -->\n\n` +
    `<!-- reviewed-sha: ${sha} -->`
  );
}

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

test("enforceReviewShaGate #1010: prior-head residual keys do not auto-block; re-eval at live head", async (t) => {
  const rec: Rec = { comments: [], transitions: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const key = "33f23af4";
  // Diff-unchanged path: keys at H_fail, live head H_green, same diff hash.
  const DIFF = "diff --git a/CHANGELOG.md b/CHANGELOG.md\n+entry";
  const { computeDiffHash } = await import("../scripts/stages/review.ts");
  const hash = computeDiffHash(DIFF);
  const body =
    blockingComment(H_FAIL, key) + `\n<!-- verdict-diff-hash: ${hash} -->`;
  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({ comments: [{ body, author: TEST_ACTOR }] }) as any,
    getPrDetail: async () => ({ head_sha: H_GREEN }) as any,
    getPrCommits: async () =>
      [
        { oid: H_FAIL, messageHeadline: "feat: work" },
        { oid: H_GREEN, messageHeadline: "fix: address CI / docs (#927)" },
      ] as any,
    getPrDiff: async () => DIFF,
    getGhActor: async () => TEST_ACTOR,
    getForIssue: async () => null,
    postComment: async (_c, _n, b) => {
      rec.comments.push(b);
    },
    transition: async (_c, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_c, _n, reason) => {
      rec.blocked.push({ reason });
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 1010, 1009, deps);
  });

  assert.equal(rec.blocked.length, 0, "must not setBlocked solely from H_fail keys");
  assert.equal((out as any)?.advanced, true);
  assert.equal((out as any)?.to, "review-2");
  assert.ok(
    rec.comments.some((c) => /prior-head|stale-blocking-keys|#1010/i.test(c)),
    "must disclose prior-head residual withholding",
  );
});

test("enforceReviewShaGate #1010: pipeline-internal head advance re-evals prior-head residual keys", async (t) => {
  // Residual keys recorded at H_fail + only OpenSpec archive commits to H_green
  // must not setBlocked from the prior-head marker (review finding 2064c9f2).
  const rec: Rec = { comments: [], transitions: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const key = "2064c9f2";
  const body = blockingComment(H_FAIL, key);
  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({ comments: [{ body, author: TEST_ACTOR }] }) as any,
    getPrDetail: async () => ({ head_sha: H_GREEN }) as any,
    getPrCommits: async () =>
      [
        { oid: H_FAIL, messageHeadline: "feat: implement" },
        {
          oid: H_GREEN,
          messageHeadline: "chore: archive OpenSpec change(s) for #1010",
        },
      ] as any,
    getGhActor: async () => TEST_ACTOR,
    getForIssue: async () => null,
    postComment: async (_c, _n, b) => {
      rec.comments.push(b);
    },
    transition: async (_c, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_c, _n, reason) => {
      rec.blocked.push({ reason });
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 1010, 1009, deps);
  });

  assert.equal(rec.blocked.length, 0, "pipeline-internal advance must not setBlocked from H_fail keys");
  assert.equal((out as any)?.advanced, true);
  assert.equal((out as any)?.to, "review-2");
  assert.ok(
    rec.comments.some((c) => /prior-head|stale-blocking-keys|#1010/i.test(c)),
    "must disclose prior-head residual withholding",
  );
});

test("enforceReviewShaGate #1010 control: same-head residual keys still block", async (t) => {
  const rec: Rec = { comments: [], transitions: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const key = "33f23af4";
  const body = blockingComment(H_GREEN, key);
  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({ comments: [{ body, author: TEST_ACTOR }] }) as any,
    getPrDetail: async () => ({ head_sha: H_GREEN }) as any,
    getPrCommits: async () => [] as any,
    getGhActor: async () => TEST_ACTOR,
    getForIssue: async () => null,
    postComment: async (_c, _n, b) => {
      rec.comments.push(b);
    },
    transition: async (_c, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_c, _n, reason) => {
      rec.blocked.push({ reason });
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 1010, 1009, deps);
  });

  assert.equal((out as any)?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0]!.reason, new RegExp(H_GREEN));
  assert.match(rec.blocked[0]!.reason, /pipeline override/i);
});

test("enforceReviewShaGate #1010: noop-clean re-verify clear at H_green does not park on prior-head exhaustion", async (t) => {
  // Fail→green regression: review at H_fail, developer fix to H_green, delta at
  // H_green finds allowlisted docs finding, autofix noop-clean, re-verify clears.
  const rec: Rec = { comments: [], transitions: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const { computeDiffHash } = await import("../scripts/stages/review.ts");
  const oldHash = computeDiffHash(OLD_DIFF);
  const priorBody =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n` +
    `<!-- reviewed-sha: ${H_FAIL} -->\n` +
    `<!-- verdict-diff-hash: ${oldHash} -->`;

  const docsFinding: ReviewFinding = {
    file: "CHANGELOG.md",
    title: "CHANGELOG / generate-docs stale",
    description: "generate-docs --check fails",
    severity: "high",
    category: "correctness",
  };

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Ship milestone",
        body: "",
        comments: [{ body: priorBody, author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () =>
      ({ head_sha: H_GREEN, head_ref: "pipeline/927" }) as any,
    getPrCommits: async () =>
      [
        { oid: H_FAIL, messageHeadline: "feat: work" },
        { oid: H_GREEN, messageHeadline: "fix: green tip (#927)" },
      ] as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    getRemoteHead: async () => H_GREEN,
    getGhActor: async () => TEST_ACTOR,
    getForIssue: async () => ({ path: "/fake/wt" }) as any,
    runDeltaReview: async () => {
      rec.deltaReviewCalls++;
      // First call: blocking docs-stale; re-verify (2nd) clears at H_green.
      if (rec.deltaReviewCalls === 1) {
        return {
          verdict: "needs-attention" as const,
          findings: [docsFinding],
          summary: "docs stale",
        };
      }
      return {
        verdict: "approve" as const,
        findings: [],
        summary: "does-not-reproduce at green tip",
      };
    },
    attemptPreMergeAutoFix: async () => {
      rec.autoFixCalls++;
      return {
        status: "noop-clean" as const,
        headSha: H_GREEN,
        diagnostic: "generate-docs --check ok; does-not-reproduce",
      };
    },
    postComment: async (_c, _n, b) => {
      rec.comments.push(b);
    },
    transition: async (_c, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_c, _n, reason) => {
      rec.blocked.push({ reason });
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 1010, 1009, deps);
  });

  assert.equal(out, null, "noop-clean + clean re-verify at H_green must proceed");
  assert.equal(rec.blocked.length, 0, "must not needs-human on prior-head/stale narrative");
  assert.equal(rec.autoFixCalls, 1);
  assert.equal(rec.deltaReviewCalls, 2, "initial delta + re-verify");
});

test("enforceReviewShaGate #1010 control: residual at H_green after noop still escalates with dual-SHA reason", async (t) => {
  const rec: Rec = { comments: [], transitions: [], blocked: [], autoFixCalls: 0, deltaReviewCalls: 0 };
  const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
  const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
  const { computeDiffHash } = await import("../scripts/stages/review.ts");
  const oldHash = computeDiffHash(OLD_DIFF);
  const priorBody =
    `## Review 2 (Adversarial) — approve\n\nLGTM\n\n` +
    `<!-- reviewed-sha: ${H_FAIL} -->\n` +
    `<!-- verdict-diff-hash: ${oldHash} -->`;

  const residual: ReviewFinding = {
    file: "core/scripts/stages/pre_merge.ts",
    title: "Real residual defect",
    description: "Still broken at green tip",
    severity: "critical",
    category: "correctness",
  };

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Ship milestone",
        body: "",
        comments: [{ body: priorBody, author: TEST_ACTOR }],
      }) as any,
    getPrDetail: async () =>
      ({ head_sha: H_GREEN, head_ref: "pipeline/927" }) as any,
    getPrCommits: async () =>
      [
        { oid: H_FAIL, messageHeadline: "feat: work" },
        { oid: H_GREEN, messageHeadline: "fix: green tip (#927)" },
      ] as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    getRemoteHead: async () => H_GREEN,
    getGhActor: async () => TEST_ACTOR,
    getForIssue: async () => ({ path: "/fake/wt" }) as any,
    runDeltaReview: async () => {
      rec.deltaReviewCalls++;
      return {
        verdict: "needs-attention" as const,
        findings: [residual],
        summary: "still broken",
      };
    },
    attemptPreMergeAutoFix: async () => {
      rec.autoFixCalls++;
      return {
        status: "noop-clean" as const,
        headSha: H_GREEN,
        diagnostic: "noop; residual remains",
      };
    },
    postComment: async (_c, _n, b) => {
      rec.comments.push(b);
    },
    transition: async (_c, _n, from, to) => {
      rec.transitions.push({ from, to });
    },
    setBlocked: async (_c, _n, reason) => {
      rec.blocked.push({ reason });
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfg, 1010, 1009, deps);
  });

  assert.equal((out as any)?.status, "blocked");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0]!.reason, new RegExp(H_GREEN));
  assert.match(rec.blocked[0]!.reason, new RegExp(H_FAIL));
  assert.match(rec.blocked[0]!.reason, /pipeline override/i);
  // Sanity: delta marker prefix still used in comments path
  assert.ok(DELTA_REVIEW_MARKER_PREFIX.length > 0);
});
