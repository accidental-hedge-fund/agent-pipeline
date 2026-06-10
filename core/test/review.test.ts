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
  extractReviewedSha,
  formatReviewComment,
  parseStructuredVerdict,
  type AdvanceReviewDeps,
} from "../scripts/stages/review.ts";
import type { HarnessResult } from "../scripts/harness.ts";
import { REVIEW_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import { findingKey } from "../scripts/review-policy.ts";
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

// Parser drift guard (#56): `parseStructuredVerdict` reconstructs the verdict by
// hand (it does not blind-spread untrusted reviewer JSON). The schema-block drift
// guard keeps the prompts and the types in sync, but the *parser* is a third
// surface — if a top-level `ReviewVerdict` field is added to the schema/types and
// the hand-written reconstruction is not updated, the field would be silently
// dropped at runtime (the same data-loss class #56 exists to prevent), while the
// `--experimental-strip-types` test runner never type-checks the gap. This test
// fails in exactly that case, keeping the parser in the single-source guarantee.
test("parser drift guard: parseStructuredVerdict carries every REVIEW_SCHEMA_FIELDS.verdict field (#56)", () => {
  // Build a verdict JSON exercising every declared top-level field, derived from
  // the manifest so a newly-added field is automatically exercised here.
  const sample: Record<string, unknown> = {};
  for (const field of REVIEW_SCHEMA_FIELDS.verdict) {
    if (field === "verdict") sample[field] = "needs-attention";
    else if (field === "findings")
      sample[field] = [
        { severity: "low", title: "t", body: "b", confidence: 0.5, recommendation: "r" },
      ];
    else if (field === "next_steps") sample[field] = ["step"];
    else sample[field] = `__sentinel_${field}__`;
  }

  const parsed = parseStructuredVerdict(JSON.stringify(sample), "a".repeat(40)) as Record<
    string,
    unknown
  >;

  for (const field of REVIEW_SCHEMA_FIELDS.verdict) {
    assert.ok(
      field in parsed && parsed[field] !== undefined,
      `parseStructuredVerdict dropped verdict field "${field}". It reconstructs the verdict by ` +
        `hand, so when you add "${field}" to REVIEW_SCHEMA_FIELDS/ReviewVerdict you must also copy ` +
        `it in parseStructuredVerdict — otherwise the reviewer-emitted field is silently lost.`,
    );
  }
  // The findings array must survive as structured objects, not be flattened away.
  assert.ok(Array.isArray(parsed.findings) && (parsed.findings as unknown[]).length === 1);
});

// parseProseReview — Codex Markdown review (#50). Codex's standard `/codex:review`
// returns prose, not JSON; these assert real findings route to a fix instead of
// being dropped (the live failure on #48 → PR #49).

const CODEX_PROSE_FINDING = [
  "# Codex Review",
  "",
  "Target: branch diff against main",
  "",
  "The configured gate does not cover the full CI workflow.",
  "",
  "Review comment:",
  "",
  "- [P2] Include the install smoke step in the gate command — /repo/package.json:27-27",
  "  When the install path breaks, `npm run ci` can still pass because it only runs root tests and the build check.",
].join("\n");

test("parseStructuredVerdict: Codex prose review with a [P2] finding → needs-attention WITH findings (#50)", () => {
  const v = parseStructuredVerdict(CODEX_PROSE_FINDING);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 1, "the prose finding must be parsed, not dropped");
  assert.equal(v.findings[0].severity, "medium");
  assert.match(v.findings[0].title, /install smoke/i);
  assert.match(v.findings[0].file ?? "", /package\.json/);
  assert.equal(v.findings[0].line_start, 27);
  assert.equal(v.findings[0].line_end, 27);
  assert.equal(v._raw, undefined, "a parsed prose verdict must not carry _raw");
});

test("parseStructuredVerdict: clean Codex review with no findings approves (#50)", () => {
  const out = "# Codex Review\n\nTarget: branch diff against main\n\nNo issues found; the change looks good.";
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "approve");
  assert.equal(v.findings.length, 0);
  assert.equal(v._raw, undefined);
});

test("parseStructuredVerdict: Codex review recognized but unparseable still falls back, never silent-approves (#50)", (t) => {
  t.mock.method(console, "warn", () => {});
  const out = "# Codex Review\n\nReview comment:\n\nFreeform remarks without a structured finding line.";
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 0);
  assert.ok(v._raw, "ambiguous Codex review must fall back with _raw, not silent-approve");
});

// Adversarial review format (#50 follow-up): "# Codex Adversarial Review" /
// "Verdict:" / "Findings:" with parenthesized locations — distinct from the
// standard review's "Review comment:" / em-dash form. Both must parse.

const CODEX_ADVERSARIAL = [
  "# Codex Adversarial Review",
  "",
  "Target: branch diff against main",
  "Verdict: needs-attention",
  "",
  "No-ship: the change still lets CI-only failures escape.",
  "",
  "Findings:",
  "- [high] Configured gate omits an actual CI workflow step (package.json:27)",
  "  The branch points the test gate at `npm run ci`, but that script only runs tests and the build check.",
  "  Recommendation: Make the configured CI script execute every step from the workflow.",
  "- [medium] OpenSpec requires raw compound commands, but the gate runs without shell semantics (core/scripts/testgate.ts:211-228)",
  "  The OpenSpec delta says a compound command must run both steps.",
  "",
  "Next steps:",
  "- Update `npm run ci` to match the real workflow.",
].join("\n");

test("parseStructuredVerdict: Codex adversarial review (Findings: / parens loc) parses BOTH findings (#50 follow-up)", () => {
  const v = parseStructuredVerdict(CODEX_ADVERSARIAL);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.findings.length, 2, "both adversarial findings must be parsed, not dropped");
  assert.equal(v.findings[0].severity, "high");
  assert.match(v.findings[0].title, /omits an actual CI workflow step/i);
  assert.equal(v.findings[0].file, "package.json");
  assert.equal(v.findings[0].line_start, 27);
  assert.equal(v.findings[1].severity, "medium");
  assert.equal(v.findings[1].file, "core/scripts/testgate.ts");
  assert.equal(v.findings[1].line_start, 211);
  assert.equal(v.findings[1].line_end, 228);
  assert.ok(!v.findings[1].body.includes("Next steps"), "trailing sections must not bleed into a finding body");
  assert.equal(v._raw, undefined);
});

test("parseStructuredVerdict: Codex adversarial review with `Verdict: approve` and no findings approves (#50 follow-up)", () => {
  const out = "# Codex Adversarial Review\n\nTarget: branch diff against main\nVerdict: approve\n\nFindings:\n\n(none)";
  const v = parseStructuredVerdict(out);
  assert.equal(v.verdict, "approve");
  assert.equal(v.findings.length, 0);
  assert.equal(v._raw, undefined);
});

// ---------------------------------------------------------------------------
// commitSha binding + reviewed-SHA sentinel (#16)
// ---------------------------------------------------------------------------

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";

test("parseStructuredVerdict: stamps the supplied commitSha onto a JSON verdict (#16)", () => {
  const out = '```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```';
  const v = parseStructuredVerdict(out, SHA_A);
  assert.equal(v.commitSha, SHA_A);
});

test("parseStructuredVerdict: stamps commitSha onto a prose verdict (#16)", () => {
  const v = parseStructuredVerdict(CODEX_PROSE_FINDING, SHA_A);
  assert.equal(v.verdict, "needs-attention");
  assert.equal(v.commitSha, SHA_A, "the prose path must carry the supplied SHA");
});

test("parseStructuredVerdict: stamps commitSha onto the text-fallback verdict (#16)", (t) => {
  t.mock.method(console, "warn", () => {});
  const v = parseStructuredVerdict("freeform prose with no verdict json", SHA_A);
  assert.equal(v.commitSha, SHA_A);
});

test("formatReviewComment: embeds the short SHA in the header and full SHA sentinel last (#16)", () => {
  const md = formatReviewComment(
    { verdict: "approve", summary: "ok", findings: [], next_steps: [], commitSha: SHA_A },
    1,
    "codex",
  );
  assert.match(md, new RegExp(`\\(commit ${SHA_A.slice(0, 7)}\\)`));
  assert.match(md, new RegExp(`<!-- reviewed-sha: ${SHA_A} -->\\s*$`), "sentinel must be the last line");
});

test("formatReviewComment: omits the sentinel when no SHA was resolved (#16)", () => {
  const md = formatReviewComment(
    { verdict: "approve", summary: "ok", findings: [], next_steps: [], commitSha: "" },
    1,
    "codex",
  );
  assert.ok(!md.includes("reviewed-sha:"), "no sentinel when commitSha is empty");
  assert.ok(!md.includes("(commit "), "no short SHA in header when commitSha is empty");
});

test("extractReviewedSha: reads the sentinel from the most recent review comment (#16)", () => {
  const comments = [
    { body: `## Review 1 (Standard) — approve (commit ${SHA_A.slice(0, 7)})\n\nok\n\n<!-- reviewed-sha: ${SHA_A} -->` },
  ];
  const r = extractReviewedSha(comments);
  assert.deepEqual(r, { sha: SHA_A, round: 1 });
});

test("extractReviewedSha: reports round 2 and the latest comment wins (#16)", () => {
  const older = "b".repeat(40);
  const comments = [
    { body: `## Review 1 (Standard) — approve\n\n<!-- reviewed-sha: ${older} -->` },
    { body: `## Review 2 (Adversarial) — approve\n\n<!-- reviewed-sha: ${SHA_A} -->` },
  ];
  assert.deepEqual(extractReviewedSha(comments), { sha: SHA_A, round: 2 });
  // Scoping to round 1 returns the round-1 SHA, not the latest.
  assert.deepEqual(extractReviewedSha(comments, 1), { sha: older, round: 1 });
});

test("extractReviewedSha: legacy review comment with no sentinel → sha null (#16)", () => {
  const comments = [{ body: "## Review 2 (Adversarial) — approve\n\nLGTM, no sentinel here." }];
  assert.deepEqual(extractReviewedSha(comments), { sha: null, round: 2 });
});

test("extractReviewedSha: no review comment at all → null (#16)", () => {
  assert.equal(extractReviewedSha([{ body: "## Pipeline: review-2\n\nunrelated" }]), null);
});

test("extractReviewedSha: injected sentinel in comment body cannot override real footer sentinel (#16)", () => {
  // Attack: model-authored review body contains a sentinel-shaped line for
  // commit B (e.g. from a quoted diff or fabricated text), placed before the
  // pipeline-written footer sentinel for commit A. The extractor must use the
  // LAST sentinel (the pipeline footer), not the first (the injected one).
  const commitA = "a".repeat(40);
  const commitB = "b".repeat(40);
  const body = [
    "## Review 2 (Adversarial) — approve",
    "",
    "See the diff excerpt which references:",
    `<!-- reviewed-sha: ${commitB} -->`,
    "This was from an earlier build.",
    "",
    `<!-- reviewed-sha: ${commitA} -->`,
  ].join("\n");
  // Footer sentinel (last) wins; injected sentinel (earlier) is ignored.
  assert.deepEqual(extractReviewedSha([{ body }]), { sha: commitA, round: 2 });
});

test("advanceReview: posted review comment carries the bound SHA sentinel (#16)", async (t) => {
  const { deps, rec } = makeDeps([APPROVE]);
  await quiet(t, async () => {
    await advanceReview(cfg, 1, 1, {}, 0, deps);
  });
  // makeDeps' getPrDetail returns head_sha = 40 'f's.
  assert.ok(
    rec.comments.some((c) => c.includes(`<!-- reviewed-sha: ${"f".repeat(40)} -->`)),
    "the review comment must embed the reviewed-sha sentinel",
  );
});

test("advanceReview: SHA resolution failure → blocked, no review posted (#16)", async (t) => {
  // Regression for review finding #2: SHA resolution must be mandatory.
  const { deps, rec } = makeDeps([APPROVE]);
  const throwingDeps: AdvanceReviewDeps = {
    ...deps,
    getPrDetail: async () => {
      throw new Error("GitHub API unavailable");
    },
  };
  let out;
  await quiet(t, async () => {
    out = await advanceReview(cfg, 1, 1, {}, 0, throwingDeps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "SHA resolution failed" });
  assert.ok(
    rec.blocked.some((b) => b.includes("Could not resolve PR head SHA")),
    "must post a blocked comment when SHA resolution throws",
  );
  assert.equal(rec.comments.length, 0, "no review comment may be posted without a valid SHA");
});

test("advanceReview: HEAD moves between SHA capture and diff fetch → blocked (#16)", async (t) => {
  // Regression for review finding #3: diff/SHA race — stamped SHA must match
  // the diff that was reviewed.
  let callCount = 0;
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const { deps, rec } = makeDeps([APPROVE]);
  const racingDeps: AdvanceReviewDeps = {
    ...deps,
    getPrDetail: async () => {
      callCount += 1;
      // First call (pre-diff): return sha1; second call (post-diff): return sha2.
      const sha = callCount === 1 ? sha1 : sha2;
      return { head_sha: sha } as Awaited<ReturnType<NonNullable<AdvanceReviewDeps["getPrDetail"]>>>;
    },
  };
  let out;
  await quiet(t, async () => {
    out = await advanceReview(cfg, 1, 1, {}, 0, racingDeps);
  });
  assert.deepEqual(out, { advanced: false, status: "blocked", reason: "HEAD moved during diff fetch" });
  assert.ok(
    rec.blocked.some((b) => b.includes("PR HEAD moved while fetching diff")),
    "must block with a clear message when HEAD moves between SHA capture and diff fetch",
  );
  assert.equal(rec.comments.length, 0, "no review comment may be posted when the diff/SHA race is detected");
});

// ---------------------------------------------------------------------------
// advanceReview — verdict normalization gate
// ---------------------------------------------------------------------------

const cfg = {
  review_mode: "prompt-harness",
  harnesses: { reviewer: "codex", implementer: "claude" },
  repo_dir: "/tmp/repo",
  models: { review: "opus" },
  // Default policy: block on every finding (block_threshold "low", min_confidence 0)
  // — reproduces pre-#17 behavior so existing routing assertions hold.
  review_policy: { block_threshold: "low", min_confidence: 0 },
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
    getPrDetail: async () =>
      ({ head_sha: "f".repeat(40) }) as Awaited<
        ReturnType<NonNullable<AdvanceReviewDeps["getPrDetail"]>>
      >,
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
    // Under the default policy (block_threshold "low") the finding blocks, so the
    // item still routes to fix-1; the summary now distinguishes blocking findings.
    summary: "1 blocking findings",
  });
});

// ---------------------------------------------------------------------------
// Severity policy + audited overrides (#17)
// ---------------------------------------------------------------------------

const NA_MEDIUM =
  '{"verdict":"needs-attention","summary":"minor","findings":' +
  '[{"severity":"medium","title":"nit","body":"b","confidence":0.9,"recommendation":"tidy"}],' +
  '"next_steps":[]}';

const policyHighCfg = {
  ...cfg,
  review_policy: { block_threshold: "high", min_confidence: 0 },
} as unknown as PipelineConfig;

test("advanceReview (#17): review-1 with only sub-threshold findings advances to review-2, not fix-1", async (t) => {
  const { deps, rec } = makeDeps([NA_MEDIUM]);
  let outcome: any;
  await quiet(t, async () => {
    outcome = await advanceReview(policyHighCfg, 9, 1, {}, 0, deps);
  });
  assert.deepEqual(rec.blocked, []);
  assert.deepEqual(rec.transitions, [{ to: "review-2" }], "all-advisory → advance, not fix-1");
  assert.equal(outcome.advanced, true);
  assert.equal(outcome.to, "review-2");
  assert.match(outcome.summary, /below policy/);
  assert.ok(
    rec.comments.some((c) => c.startsWith("## Pipeline: Review 1 advanced under severity policy")),
    "an audited advisory-advance comment must be posted",
  );
});

test("advanceReview (#17): review-2 with only sub-threshold findings advances to pre-merge", async (t) => {
  const { deps, rec } = makeDeps([NA_MEDIUM]);
  let outcome: any;
  await quiet(t, async () => {
    outcome = await advanceReview(policyHighCfg, 9, 2, {}, 0, deps);
  });
  assert.deepEqual(rec.transitions, [{ to: "pre-merge" }]);
  assert.equal(outcome.to, "pre-merge");
});

test("advanceReview (#17): an operator override on a blocking finding advances instead of routing to fix", async (t) => {
  // Default policy blocks every finding; NA_WITH_FINDING is a high-severity bug.
  // An override sentinel on its content-addressed key makes it non-blocking, so
  // the item advances even though nothing was re-implemented — the #56 escape hatch.
  const key = findingKey({ severity: "high", title: "bug" });
  const { deps, rec } = makeDeps([NA_WITH_FINDING]);
  deps.getIssueDetail = async () =>
    ({
      number: 1,
      type: "issue",
      title: "Title",
      body: "Body",
      state: "open",
      url: "https://example.test/1",
      labels: [],
      comments: [{ body: `<!-- pipeline-override: ${key} rejected -->` }],
    }) as Awaited<ReturnType<NonNullable<AdvanceReviewDeps["getIssueDetail"]>>>;
  let outcome: any;
  await quiet(t, async () => {
    outcome = await advanceReview(cfg, 9, 2, {}, 0, deps);
  });
  assert.deepEqual(rec.blocked, []);
  assert.deepEqual(rec.transitions, [{ to: "pre-merge" }], "overridden finding → advance, not fix-2");
  assert.match(outcome.summary, /below policy/);
});
