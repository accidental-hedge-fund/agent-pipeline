// Regression tests for fix-round commit message format verification (#68).
// Tests enforceFixCommitGate directly so the full advanceFix call chain (GitHub
// API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceFixCommitGate,
  enforceOpenspecSpecDeltaValidation,
  extractAllReviewFindingsHistory,
  extractBlockingReviewFindings,
  filterToBlockingFindings,
} from "../scripts/stages/fix.ts";
import { formatReviewComment } from "../scripts/stages/review.ts";
import { findingKey } from "../scripts/review-policy.ts";
import type { VerifyDeps } from "../scripts/verify-harness-commits.ts";
import type { ValidateResult } from "../scripts/openspec.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";

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

// Regression: advisory sentinel in reviewer body must NOT strip a blocking finding (#236 delta)
test("filterToBlockingFindings: advisory sentinel in reviewer body does NOT strip a blocking finding", () => {
  // A blocking finding whose body discusses the sentinel mechanism would previously
  // be classified as advisory because block.includes() scanned the entire block
  // including reviewer-controlled body text.
  const ADVISORY_MARKER = "<!-- pipeline-advisory-finding -->";
  const blockingWithSentinelInBody: ReviewFinding = {
    severity: "high",
    title: "Sentinel spoof vector",
    file: "core/scripts/stages/fix.ts",
    line_start: 426,
    // Body text that contains the sentinel string (e.g. a finding about the mechanism).
    body: `filterToBlockingFindings uses block.includes("${ADVISORY_MARKER}") which can be spoofed.`,
    confidence: 0.9,
    recommendation: `Do not use substring search; check only the header zone before reviewer prose.`,
  };

  const key = findingKey(blockingWithSentinelInBody);
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "blocking finding about the sentinel", findings: [blockingWithSentinelInBody], next_steps: [] },
    1, "codex",
    new Set([key]),
  );

  // Sanity: the sentinel string appears somewhere in the formatted body (inside the body text).
  assert.ok(body.includes(ADVISORY_MARKER), "sanity: sentinel string is in the formatted comment");

  const filtered = filterToBlockingFindings(body, new Set([key]));

  // Blocking finding must NOT be stripped (the sentinel was in reviewer prose, not the header zone).
  assert.ok(filtered.includes(blockingWithSentinelInBody.title), "blocking finding must survive even when body contains the sentinel string");
  assert.ok(!filtered.includes("advisory finding was omitted"), "no advisory omission note should appear — the finding is blocking");
});
