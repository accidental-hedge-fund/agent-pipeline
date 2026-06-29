// Regression tests for fix-round commit message format verification (#68).
// Tests enforceFixCommitGate directly so the full advanceFix call chain (GitHub
// API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceFixOpenspecConsistency,
  enforceFixCommitGate,
  enforceOpenspecSpecDeltaValidation,
  extractAllReviewFindingsHistory,
  extractBlockingReviewFindings,
  filterToBlockingFindings,
} from "../scripts/stages/fix.ts";
import { formatReviewComment } from "../scripts/stages/review.ts";
import { categoryMarker, findingKey, SPEC_DIVERGENCE_CATEGORY } from "../scripts/review-policy.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";
import type { ValidateResult } from "../scripts/openspec.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";
import type { FixCommit } from "../scripts/openspec-consistency.ts";

function msgsDeps(messages: string[]): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Cross-round finding history (1.0.1 convergence: stop the fixer reverting prior fixes)
// ---------------------------------------------------------------------------

const r2 = (n: number) => ({
  body: `## Review 2 (Adversarial) — needs-attention\n\n### Findings\n\nfinding ${n}`,
});

test("extractAllReviewFindingsHistory: empty when fewer than two matching rounds", () => {
  assert.equal(extractAllReviewFindingsHistory([], 2), "");
  assert.equal(extractAllReviewFindingsHistory([r2(1)], 2), "", "only the current round → no prior history");
  assert.equal(
    extractAllReviewFindingsHistory([{ body: "## Implementation Plan" }, r2(1)], 2),
    "",
  );
});

test("extractAllReviewFindingsHistory: joins prior rounds, excluding the most recent (current) one", () => {
  const out = extractAllReviewFindingsHistory([r2(1), r2(2), r2(3)], 2);
  assert.match(out, /Prior review 2 attempt 1/);
  assert.match(out, /Prior review 2 attempt 2/);
  assert.match(out, /finding 1/);
  assert.match(out, /finding 2/);
  assert.doesNotMatch(out, /finding 3/); // the latest is supplied verbatim as current findings
});

// ---------------------------------------------------------------------------
// Fix round 1 (4.3 / 4.4)
// ---------------------------------------------------------------------------

test("fix round 1: matching commit message → proceeds (ok)", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#42)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 1: case-insensitive match → proceeds", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["Fix: Address Review 1 Findings (#42)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 1: non-matching commit message → blocked (4.3)", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fixed stuff\n"]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("Fix round 1 commit message does not match prescribed format"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

test("fix round 1: completely unrelated commit message → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["feat: add new feature (#42)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: empty commit range → blocked (harness produced nothing, finding 1)", async () => {
  const result = await enforceFixCommitGate(1, 42, "/wt", "abc", msgsDeps([]));
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("at least one commit"));
});

test("fix round 1: correct format for wrong round number → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 2 findings (#42)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: wrong issue number → blocked", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#99)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 1: multiple commits — at least one matches → proceeds", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "abc",
    msgsDeps([
      "chore: minor cleanup\n",
      "fix: address review 1 findings (#42)\n",
    ]),
  );
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Fix round 2 (4.3 / 4.4 equivalent)
// ---------------------------------------------------------------------------

test("fix round 2: matching commit message → proceeds (4.4)", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["fix: address review 2 findings (#7)\n"]),
  );
  assert.equal(result.ok, true);
});

test("fix round 2: round 1 message → blocked for round 2", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["fix: address review 1 findings (#7)\n"]),
  );
  assert.equal(result.ok, false);
});

test("fix round 2: non-matching message → blocked (4.3)", async () => {
  const result = await enforceFixCommitGate(
    2, 7, "/wt", "abc",
    msgsDeps(["wip: fixing things\n"]),
  );
  assert.equal(result.ok, false);
  assert.ok(
    "reason" in result && result.reason.includes("Fix round 2 commit message does not match prescribed format"),
  );
});

// ---------------------------------------------------------------------------
// enforceOpenspecSpecDeltaValidation — spec-delta validation gate (#106)
// ---------------------------------------------------------------------------

function makeValidateDeps(opts: {
  changedFiles: string[];
  validateResult?: ValidateResult;
}): {
  gitDiffFiles: (wt: string, from: string, to: string) => Promise<string[]>;
  openspecValidateItem: (wt: string, id: string) => Promise<ValidateResult>;
  validateCalls: string[];
} {
  const validateCalls: string[] = [];
  return {
    gitDiffFiles: async () => opts.changedFiles,
    openspecValidateItem: async (_wt, id) => {
      validateCalls.push(id);
      return opts.validateResult ?? { valid: true, issues: [], unavailable: false, raw: "" };
    },
    validateCalls,
  };
}

test("enforceOpenspecSpecDeltaValidation: no spec files changed → ok, validateItem not called", async () => {
  const deps = makeValidateDeps({ changedFiles: ["core/scripts/foo.ts", "plugin/scripts/foo.ts"] });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, [], "validateItem must not be called when no spec files changed");
});

test("enforceOpenspecSpecDeltaValidation: spec files changed + validation passes → ok", async () => {
  const deps = makeValidateDeps({
    changedFiles: ["core/scripts/foo.ts", "openspec/changes/c106/specs/cap/spec.md"],
    validateResult: { valid: true, issues: [], unavailable: false, raw: "" },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, ["c106"], "validateItem must be called for the changed change");
});

test("enforceOpenspecSpecDeltaValidation: spec files changed + validation fails → blocked", async () => {
  const deps = makeValidateDeps({
    changedFiles: ["openspec/changes/c106/specs/cap/spec.md"],
    validateResult: {
      valid: false,
      issues: [{ message: "Requirement is missing SHALL keyword" }],
      unavailable: false,
      raw: "Requirement is missing SHALL keyword",
    },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("c106"), "block reason must name the failing change");
  assert.ok(!result.ok && result.reason.includes("SHALL"), "block reason must include the validation issue");
});

test("enforceOpenspecSpecDeltaValidation: validation unavailable (binary missing) → ok (non-blocking)", async () => {
  const deps = makeValidateDeps({
    changedFiles: ["openspec/changes/c106/specs/cap/spec.md"],
    validateResult: { valid: false, issues: [], unavailable: true, raw: "openspec not found" },
  });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "sha1", "sha2", deps);
  assert.equal(result.ok, true, "missing openspec binary must not block the fix round");
});

test("enforceOpenspecSpecDeltaValidation: headBefore === headAfter → ok without calling validateItem", async () => {
  const deps = makeValidateDeps({ changedFiles: ["openspec/changes/c106/specs/cap/spec.md"] });
  const result = await enforceOpenspecSpecDeltaValidation("/wt", "same", "same", deps);
  assert.equal(result.ok, true);
  assert.deepEqual(deps.validateCalls, [], "no diff when SHAs are equal");
});

// ---------------------------------------------------------------------------
// enforceFixOpenspecConsistency — stale spec-delta guard before fix push
// ---------------------------------------------------------------------------

const fixCfg = { base_branch: "main", repo: "acme/x", repo_dir: "/repo" } as unknown as PipelineConfig;
const specDivergenceReview =
  `## Review 1 — needs-attention\n\n### Findings\n\n` +
  `**1. [HIGH] spec mismatch** \`override-key: abc12345\` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)}\n`;

function fixConsistencyDeps(commits: FixCommit[]) {
  const blocked: Array<{ reason: string; stage: string; kind: string }> = [];
  return {
    blocked,
    deps: {
      branchDeveloperCommits: async () => commits,
      getIssueDetail: async () => ({
        comments: [{ author: "reviewer", body: specDivergenceReview, createdAt: "2026-06-28T00:00:00Z" }],
      }),
      setBlocked: async (_cfg: PipelineConfig, _issue: number, reason: string, stage: string, kind: string) => {
        blocked.push({ reason, stage, kind });
      },
    },
  };
}

test("enforceFixOpenspecConsistency: stale delta + spec-divergence marker blocks at fix stage", async () => {
  const { deps, blocked } = fixConsistencyDeps([
    { sha: "a", paths: ["core/scripts/foo.ts"] },
  ]);
  const out = await enforceFixOpenspecConsistency(fixCfg, 42, "fix-1", "/wt", ["c106"], deps as any);

  assert.ok(out && !out.advanced && out.status === "blocked");
  assert.equal(out?.blockerKind, "openspec-stale-delta");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].stage, "fix-1");
  assert.equal(blocked[0].kind, "openspec-stale-delta");
  assert.match(blocked[0].reason, /stale spec delta/);
});

test("enforceFixOpenspecConsistency: spec delta updated after impl change passes", async () => {
  const { deps, blocked } = fixConsistencyDeps([
    { sha: "a", paths: ["core/scripts/foo.ts"] },
    { sha: "b", paths: ["openspec/changes/c106/specs/cap/spec.md"] },
  ]);

  const out = await enforceFixOpenspecConsistency(fixCfg, 42, "fix-2", "/wt", ["c106"], deps as any);

  assert.equal(out, null);
  assert.deepEqual(blocked, []);
});

// ---------------------------------------------------------------------------
// Mixed-verdict filtering: advisory (non-blocking) findings (#236)
// ---------------------------------------------------------------------------

const minCfg = {
  review_policy: { block_threshold: "high", min_confidence: 0 },
  marker_footer: "*Automated by Claude Code Pipeline Skill*",
} as unknown as PipelineConfig;

const blockingFinding: ReviewFinding = {
  severity: "high",
  title: "Real blocking issue",
  file: "core/scripts/stages/review.ts",
  line_start: 513,
  body: "This needs fixing.",
  confidence: 0.9,
  recommendation: "Fix it.",
};
const advisoryFinding: ReviewFinding = {
  severity: "high",
  title: "Advisory out-of-scope observation",
  file: "core/scripts/foo.ts",
  line_start: 1,
  body: "Informational only.",
  confidence: 0.9,
  recommendation: "Consider later.",
  blocking: false,
};
const blockingKey = findingKey(blockingFinding);
const advisoryKey = findingKey(advisoryFinding);

test("filterToBlockingFindings: all blocking → body returned unchanged", () => {
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "issues", findings: [blockingFinding], next_steps: [] },
    1, "codex",
    new Set([blockingKey]),
  );
  const result = filterToBlockingFindings(body, new Set([blockingKey]));
  assert.equal(result, body, "no advisory findings — body must be identical");
});

test("filterToBlockingFindings: mixed verdict — advisory finding removed from Findings, note added (#236)", () => {
  // Regression: before this fix, the advisory finding appeared in the Findings
  // section and the fix prompt would present it as mandatory work.
  const body = formatReviewComment(
    minCfg,
    {
      verdict: "needs-attention",
      summary: "one blocker one advisory",
      findings: [blockingFinding, advisoryFinding],
      next_steps: [],
    },
    1, "codex",
    new Set([blockingKey]),  // only blockingFinding is actually blocking
  );

  // Without the fix: advisoryFinding appears in the Findings section
  assert.ok(body.includes(advisoryFinding.title), "sanity: advisory title is in the original comment");
  assert.ok(body.includes(`override-key: ${advisoryKey}`), "sanity: advisory key is in the original comment");

  const filtered = filterToBlockingFindings(body, new Set([blockingKey]));

  // Blocking finding must survive in the Findings section
  assert.ok(filtered.includes(blockingFinding.title), "blocking finding must be present in filtered body");
  assert.ok(filtered.includes(`override-key: ${blockingKey}`), "blocking override-key must survive");

  // Advisory finding must NOT appear in the Findings section
  assert.ok(!filtered.includes(advisoryFinding.title), "advisory title must be absent from the filtered Findings");
  assert.ok(!filtered.includes(`override-key: ${advisoryKey}`), "advisory override-key must be absent");

  // Advisory omission note must be present
  assert.ok(filtered.includes("1 advisory finding was omitted"), "omission note must be present");
  assert.ok(filtered.includes("not required work"), "note must clarify these are not required work");
});

test("extractBlockingReviewFindings: no pipeline-blocking-keys marker → body returned unchanged (legacy)", () => {
  // A legacy comment without the marker falls back to the unfiltered body.
  const bodyNoMarker =
    "## Review 1 (Standard) — needs-attention\n**Reviewer**: codex\n\nsummary\n\n### Findings\n\n" +
    `**1. [HIGH] ${advisoryFinding.title}** \`override-key: ${advisoryKey}\`\nsome body\n\n` +
    "*Automated by Claude Code Pipeline Skill*";
  const comments = [{ body: bodyNoMarker }];
  const result = extractBlockingReviewFindings(comments, 1);
  assert.equal(result, bodyNoMarker, "legacy body (no marker) must be returned unchanged");
});

test("extractBlockingReviewFindings: mixed verdict — fix prompt receives only blocking findings (#236)", () => {
  const verdictComment = formatReviewComment(
    minCfg,
    {
      verdict: "needs-attention",
      summary: "one real blocker, one advisory",
      findings: [blockingFinding, advisoryFinding],
      next_steps: [],
    },
    1, "codex",
    new Set([blockingKey]),
  );
  const comments = [{ body: verdictComment }];

  // extractBlockingReviewFindings must strip the advisory finding
  const filtered = extractBlockingReviewFindings(comments, 1);

  assert.ok(filtered.includes(blockingFinding.title), "blocking finding must survive");
  assert.ok(!filtered.includes(advisoryFinding.title), "advisory finding must be stripped from fix prompt");
  assert.ok(filtered.includes("advisory finding was omitted"), "omission note must be present");
});

// Regression: same-key blocking + blocking:false sibling — advisory must still be excluded (#236 fix 2)
test("filterToBlockingFindings: same-key blocking + blocking:false sibling — advisory excluded despite shared key (#236)", () => {
  // Both findings share the same findingKey (HIGH + same file + same 5-line bucket).
  // Lines 46 and 48 both fall in bucket 46 (Math.floor((L-1)/5)*5+1 = 46).
  const sameKeyBlocker: ReviewFinding = {
    severity: "high",
    title: "Blocking issue at same location",
    file: "core/x.ts",
    line_start: 46,
    body: "Must be fixed.",
    confidence: 0.9,
  };
  const sameKeyAdvisory: ReviewFinding = {
    severity: "high",
    title: "Advisory sibling at same location",
    file: "core/x.ts",
    line_start: 48,
    body: "Out of scope — informational only.",
    confidence: 0.9,
    blocking: false,
  };

  // Precondition: keys must collide
  assert.equal(
    findingKey(sameKeyBlocker),
    findingKey(sameKeyAdvisory),
    "precondition: same bucket → same key",
  );

  const sharedKey = findingKey(sameKeyBlocker);
  const body = formatReviewComment(
    minCfg,
    {
      verdict: "needs-attention",
      summary: "one blocker, one advisory sibling sharing the same key",
      findings: [sameKeyBlocker, sameKeyAdvisory],
      next_steps: [],
    },
    1, "codex",
    new Set([sharedKey]),
  );

  // Both keys are the same — the key-set check alone cannot distinguish them.
  // The per-finding marker (<!-- pipeline-advisory-finding -->) is the tiebreaker.
  const filtered = filterToBlockingFindings(body, new Set([sharedKey]));

  assert.ok(filtered.includes(sameKeyBlocker.title), "blocking finding must be present");
  assert.ok(!filtered.includes(sameKeyAdvisory.title), "advisory sibling must be excluded despite shared key");
  assert.ok(filtered.includes("1 advisory finding was omitted"), "omission note must be present");
});

// Regression: reviewer body containing advisory machinery strings must NOT strip a blocking finding (#236 delta)
test("filterToBlockingFindings: advisory ordinal marker in reviewer body does NOT strip a blocking finding", () => {
  // A blocking finding whose body text contains the advisory-ordinals marker string
  // must NOT be classified as advisory. The ordinal match must search only the
  // formatter-controlled footer, not the entire comment body.
  const ORDINAL_MARKER = "<!-- pipeline-advisory-ordinals: 1 -->";
  const blockingWithOrdinalInBody: ReviewFinding = {
    severity: "high",
    title: "Ordinal footer spoof vector",
    file: "core/scripts/stages/fix.ts",
    line_start: 440,
    // Body discusses the advisory mechanism and contains the ordinal string.
    body: `filterToBlockingFindings must not match ${ORDINAL_MARKER} from reviewer body.`,
    confidence: 0.9,
    recommendation: "Search only the footer section, not the whole comment.",
  };

  const key = findingKey(blockingWithOrdinalInBody);
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "blocking finding that mentions the ordinal marker", findings: [blockingWithOrdinalInBody], next_steps: [] },
    1, "codex",
    new Set([key]),
  );

  // Sanity: the ordinal marker string appears in the comment body (inside reviewer text).
  assert.ok(body.includes(ORDINAL_MARKER), "sanity: ordinal string is present in the formatted comment (in the body text)");

  const filtered = filterToBlockingFindings(body, new Set([key]));

  // Blocking finding must survive — the marker in reviewer text must not affect filtering.
  assert.ok(filtered.includes(blockingWithOrdinalInBody.title), "blocking finding must survive even when body contains the ordinal marker string");
  assert.ok(!filtered.includes("advisory finding was omitted"), "no advisory omission note should appear");
});
