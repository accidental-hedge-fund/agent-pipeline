// Regression tests for verdict normalization (#45).
//
// Two surfaces:
//   1. parseStructuredVerdict — prose falls back (sets `_raw`, warns); fenced
//      JSON parses cleanly (no `_raw`).
//   2. advanceReview routing — a `needs-attention` verdict with zero findings
//      must NEVER reach a fix stage: it re-reviews once, then blocks (surfacing
//      raw output) rather than burning a fix-harness invocation on nothing.
//
// advanceReview's external calls (GitHub, worktree, reviewer harness) are
// injected via AdvanceReviewDeps — the same dependency-injection seam used by
// testgate.ts — so routing is exercised without any real I/O.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advanceReview,
  parseStructuredVerdict,
  type AdvanceReviewDeps,
} from "../scripts/stages/review.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// parseStructuredVerdict — parse paths
// ---------------------------------------------------------------------------

test("parseStructuredVerdict: prose-only output falls back to needs-attention and sets _raw", () => {
  const out = "I skimmed the diff and have a few unstructured concerns about error handling.";
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 0);
  assert.ok(v._raw, "_raw should carry the unparsed reviewer output forward");
  assert.match(v._raw!, /unstructured concerns/);
});

test("parseStructuredVerdict: fenced JSON verdict approve parses cleanly and does NOT set _raw", () => {
  const out =
    'My review:\n```json\n{"verdict":"approve","summary":"LGTM","findings":[],"next_steps":[]}\n```\n';
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "approve");
  assert.equal(v.findings.length, 0);
  assert.equal(v._raw, undefined, "a structured verdict must not carry _raw");
});

test("parseStructuredVerdict: fenced JSON needs-attention with findings parses without _raw", () => {
  const out =
    'Findings below.\n```json\n{"verdict":"needs-attention","summary":"two issues","findings":' +
    '[{"severity":"high","title":"null deref","body":"x","confidence":0.9,"recommendation":"guard"}],' +
    '"next_steps":[]}\n```';
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 1);
  assert.equal(v._raw, undefined);
});

test("parseStructuredVerdict: fallback path emits a warning naming the fallback", (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  parseStructuredVerdict("plain prose, no json verdict here");
  assert.ok(
    warnings.some((w) => /fallback/i.test(w) && /no structured json/i.test(w)),
    `expected a fallback warning, saw: ${warnings.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// advanceReview — verdict normalization gate
// ---------------------------------------------------------------------------

const cfg = {
  review_mode: "prompt-harness",
  harnesses: { reviewer: "codex", implementer: "claude" },
  repo_dir: "/tmp/repo",
  models: { review: "opus" },
} as unknown as PipelineConfig;

interface Recorder {
  runReviewCalls: number;
  transitions: { to: Stage }[];
  blocked: string[];
  comments: string[];
}

/**
 * Build AdvanceReviewDeps that short-circuit all I/O. `stdouts[i]` is the
 * reviewer output returned on the i-th review invocation (the last entry is
 * reused if more invocations occur than entries provided).
 */
function makeDeps(stdouts: string[]): { deps: AdvanceReviewDeps; rec: Recorder } {
  const rec: Recorder = { runReviewCalls: 0, transitions: [], blocked: [], comments: [] };
  const result = (stdout: string): HarnessResult => ({
    success: true,
    stdout,
    stderr: "",
    exit_code: 0,
    duration: 0.1,
    timed_out: false,
  });
  const deps: AdvanceReviewDeps = {
    getPrForIssue: async () => 123,
    getPrDiff: async () => "diff --git a/x.ts b/x.ts\n+const a = 1;",
    getIssueDetail: async () =>
      ({
        number: 1,
        type: "issue",
        title: "Title",
        body: "Body",
        state: "open",
        url: "https://example.test/1",
        labels: [],
        comments: [],
      }) as Awaited<ReturnType<NonNullable<AdvanceReviewDeps["getIssueDetail"]>>>,
    getForIssue: async () => null,
    postComment: async (_cfg, _n, body) => {
      rec.comments.push(body);
    },
    transition: async (_cfg, _n, _from, to) => {
      rec.transitions.push({ to });
    },
    setBlocked: async (_cfg, _n, reason) => {
      rec.blocked.push(reason);
    },
    runReview: async () => {
      const stdout = stdouts[Math.min(rec.runReviewCalls, stdouts.length - 1)];
      rec.runReviewCalls += 1;
      return result(stdout);
    },
  };
  return { deps, rec };
}

/** Suppress and capture console.log/console.warn for the duration of `fn`. */
async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  await fn();
}

const NA_ZERO = '{"verdict":"needs-attention","summary":"vague","findings":[],"next_steps":[]}';
const APPROVE = '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';
const NA_WITH_FINDING =
  '{"verdict":"needs-attention","summary":"one issue","findings":' +
  '[{"severity":"high","title":"bug","body":"b","confidence":0.8,"recommendation":"fix it"}],' +
  '"next_steps":[]}';

test("advanceReview: needs-attention+0 findings on first attempt re-reviews instead of routing to fix", async (t) => {
  // First review yields needs-attention with no findings; the re-review approves.
  const { deps, rec } = makeDeps([NA_ZERO, APPROVE]);
  let outcome;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 1, 1, {}, 0, deps);
  });

  assert.equal(rec.runReviewCalls, 2, "a re-review invocation must be made");
  assert.ok(
    !rec.transitions.some((x) => x.to === "fix-1"),
    "must never transition to a fix stage on a zero-findings verdict",
  );
  assert.deepEqual(rec.blocked, [], "should not block when the re-review approves");
  // Re-review approved → advanced to review-2.
  assert.deepEqual(rec.transitions, [{ to: "review-2" }]);
  assert.deepEqual(outcome, {
    advanced: true,
    from: "review-1",
    to: "review-2",
    summary: "approved (0 findings)",
  });
});

test("advanceReview: re-review (retryCount=1) with needs-attention+0 findings blocks, never fixes", async (t) => {
  const { deps, rec } = makeDeps([NA_ZERO]);
  let outcome;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 7, 1, {}, 1, deps);
  });

  assert.equal(rec.runReviewCalls, 1, "retryCount=1 is already the re-review; no further recursion");
  assert.equal(rec.blocked.length, 1, "must block on the second zero-findings verdict");
  assert.match(rec.blocked[0], /zero enumerated findings/i);
  assert.ok(
    !rec.transitions.some((x) => x.to === "fix-1" || x.to === "fix-2"),
    "must never transition to a fix stage",
  );
  assert.deepEqual(outcome, {
    advanced: false,
    status: "blocked",
    reason: "needs-attention with 0 findings on re-review",
  });
});

test("advanceReview: zero findings on both attempts blocks with the raw output, fix stage unreachable", async (t) => {
  // Prose both times → fallback path sets _raw; the block comment must surface it.
  const prose = "Looks risky around the auth path but I can't pin down a specific line.";
  const { deps, rec } = makeDeps([prose, prose]);
  let outcome;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 34, 1, {}, 0, deps);
  });

  assert.equal(rec.runReviewCalls, 2, "first attempt + one re-review");
  assert.equal(rec.blocked.length, 1);
  assert.match(rec.blocked[0], /auth path/, "block comment must include the raw reviewer output");
  assert.ok(
    !rec.transitions.some((x) => x.to === "fix-1" || x.to === "fix-2"),
    "the fix stage must be unreachable from a zero-findings needs-attention",
  );
  assert.deepEqual(outcome, {
    advanced: false,
    status: "blocked",
    reason: "needs-attention with 0 findings on re-review",
  });
});

test("advanceReview: structured zero-findings re-review includes raw stdout in block reason (not _raw fallback)", async (t) => {
  // Reviewer returns valid structured JSON (no _raw set) on both invocations.
  // The block comment must still carry the raw stdout so operators can diagnose.
  const structuredZero =
    '{"verdict":"needs-attention","summary":"","findings":[],' +
    '"next_steps":["investigate the auth path thoroughly"]}';
  const { deps, rec } = makeDeps([structuredZero, structuredZero]);
  let outcome;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 55, 1, {}, 0, deps);
  });

  assert.equal(rec.runReviewCalls, 2, "first attempt + one re-review");
  assert.equal(rec.blocked.length, 1);
  assert.match(
    rec.blocked[0],
    /investigate the auth path/,
    "block comment must include the raw stdout even when the structured JSON has no _raw",
  );
  assert.ok(
    !rec.transitions.some((x) => x.to === "fix-1" || x.to === "fix-2"),
    "must never transition to a fix stage",
  );
  assert.deepEqual(outcome, {
    advanced: false,
    status: "blocked",
    reason: "needs-attention with 0 findings on re-review",
  });
});

test("advanceReview: needs-attention WITH findings still routes to fix (no re-review)", async (t) => {
  const { deps, rec } = makeDeps([NA_WITH_FINDING]);
  let outcome;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 9, 1, {}, 0, deps);
  });

  assert.equal(rec.runReviewCalls, 1, "a verdict with findings is actionable — no re-review");
  assert.deepEqual(rec.blocked, []);
  assert.deepEqual(rec.transitions, [{ to: "fix-1" }]);
  assert.deepEqual(outcome, {
    advanced: true,
    from: "review-1",
    to: "fix-1",
    summary: "1 findings",
  });
});
