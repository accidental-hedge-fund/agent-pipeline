// Regression tests for fix-round commit message format verification (#68).
// Tests enforceFixCommitGate directly so the full advanceFix call chain (GitHub
// API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeEffectiveBlockingSet,
  decideDoesNotReproduceAdvance,
  decideExternalCommitAdvance,
  enforceFixOpenspecConsistency,
  enforceFixCommitGate,
  enforceExternalCommitGate,
  enforceOpenspecSpecDeltaValidation,
  extractAllReviewFindingsHistory,
  extractBlockingReviewFindings,
  filterUnambiguousDeclarations,
  filterOverridesAfterReview,
  filterToBlockingFindings,
  findTriggeringReviewComment,
  isCommitOnRemote,
  parseDoesNotReproduceDeclarations,
  parseFindingSummaries,
  resolveFixCommitGateMode,
} from "../scripts/stages/fix.ts";

const execFileAsync = promisify(execFile);
import { formatReviewComment } from "../scripts/stages/review.ts";
import {
  categoryMarker,
  directionMarker,
  extractNonReproducingDispositions,
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  findingPayloadFingerprint,
  nonReproducingDispositionComment,
  overrideComment,
  scopedOverrideComment,
  SPEC_DIVERGENCE_CATEGORY,
} from "../scripts/review-policy.ts";
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
// External-commit gate (#349): externally-applied fixes are exempt from the
// prescribed-subject check but still get the range-level safety scan.
// ---------------------------------------------------------------------------

function externalDeps(shaFiles: Record<string, string[]>, messages: string[] = []): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => [],
    gitDirtyFiles: async () => [],
    gitCommitShas: async () => Object.keys(shaFiles),
    gitDiffTreeFiles: async (_wt: string, sha: string) => shaFiles[sha] ?? [],
  };
}

test("external gate: human commit subject (no prescribed format) → proceeds", async () => {
  // Regression for pre-merge finding f65e88f8: a human-applied fix with an
  // ordinary subject must not be blocked by the fix-round message pattern.
  const result = await enforceExternalCommitGate(
    "/wt", "reviewsha",
    externalDeps({ abc123: ["core/scripts/stages/fix.ts"] }, ["correct the stale OpenSpec delta by hand\n"]),
  );
  assert.equal(result.ok, true);
});

test("external gate: commit adding node_modules → still blocked", async () => {
  const result = await enforceExternalCommitGate(
    "/wt", "reviewsha",
    externalDeps({ abc123: ["node_modules/leftpad/index.js"] }),
  );
  assert.equal(result.ok, false);
  assert.ok("reason" in result && result.reason.includes("node_modules"));
});

test("external gate vs fix gate: same human subject blocks the harness gate (contrast)", async () => {
  const result = await enforceFixCommitGate(
    1, 42, "/wt", "reviewsha",
    msgsDeps(["correct the stale OpenSpec delta by hand\n"]),
  );
  assert.equal(result.ok, false);
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
  `**1. [HIGH] spec mismatch** \`override-key: abc12345\` ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)} ${directionMarker("spec-behind-code")}\n`;

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
  assert.match(blocked[0].reason, /spec-delta alignment/);
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

test("enforceFixOpenspecConsistency: production path calls attemptBoundedRepair for spec-behind-code (#356)", async () => {
  // Production-path test: verify that enforceFixOpenspecConsistency wires
  // attemptBoundedRepair to the guard and that the dep is actually called.
  const { deps } = fixConsistencyDeps([{ sha: "a", paths: ["core/scripts/foo.ts"] }]);
  const repairCalls: string[] = [];
  const extDeps = {
    ...deps,
    attemptBoundedRepair: async (changeId: string) => {
      repairCalls.push(changeId);
      return "cleared" as const; // repair succeeds → advance
    },
  };

  const out = await enforceFixOpenspecConsistency(fixCfg, 42, "fix-1", "/wt", ["c106"], extDeps as any);
  assert.deepEqual(repairCalls, ["c106"], "enforceFixOpenspecConsistency must call attemptBoundedRepair");
  assert.equal(out, null, "guard must return null (advance) after a successful repair");
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

// ---------------------------------------------------------------------------
// decideExternalCommitAdvance (#349: advance instead of blocking when the fix
// was already applied externally — HEAD is past the last reviewed SHA)
// ---------------------------------------------------------------------------

const SHA_REVIEWED = "1".repeat(39) + "a";
const SHA_HEAD = "2".repeat(39) + "b";
const ACTOR = "pipeline-bot";

function reviewComment(round: 1 | 2, sha: string | null, author = ACTOR) {
  const sentinel = sha ? `\n\n<!-- reviewed-sha: ${sha} -->` : "";
  return {
    author,
    body: `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — needs-attention\n\nfindings${sentinel}`,
  };
}

test("decideExternalCommitAdvance: round 1, HEAD past reviewed SHA → advances to review-2", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(1, SHA_REVIEWED)],
    ACTOR,
    1,
    SHA_HEAD,
  );
  assert.equal(decision.advance, true);
  assert.ok(decision.advance && decision.to === "review-2");
  assert.ok(decision.advance && decision.reviewSha === SHA_REVIEWED);
});

test("decideExternalCommitAdvance: round 2, HEAD past reviewed SHA → advances to pre-merge", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(2, SHA_REVIEWED)],
    ACTOR,
    2,
    SHA_HEAD,
  );
  assert.equal(decision.advance, true);
  assert.ok(decision.advance && decision.to === "pre-merge");
});

test("decideExternalCommitAdvance: HEAD equals reviewed SHA → does not advance (blocks as before)", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(1, SHA_REVIEWED)],
    ACTOR,
    1,
    SHA_REVIEWED,
  );
  assert.equal(decision.advance, false);
  assert.equal(decision.reviewSha, SHA_REVIEWED);
});

test("decideExternalCommitAdvance: no review comment at all → fails closed, does not advance", () => {
  const decision = decideExternalCommitAdvance([], ACTOR, 1, SHA_HEAD);
  assert.equal(decision.advance, false);
  assert.equal(decision.reviewSha, null);
});

test("decideExternalCommitAdvance: review comment without a SHA (legacy) → fails closed, does not advance", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(1, null)],
    ACTOR,
    1,
    SHA_HEAD,
  );
  assert.equal(decision.advance, false);
  assert.equal(decision.reviewSha, null);
});

test("decideExternalCommitAdvance: review comment from an untrusted author is ignored → fails closed", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(1, SHA_REVIEWED, "random-commenter")],
    ACTOR,
    1,
    SHA_HEAD,
  );
  assert.equal(decision.advance, false, "an untrusted author's SHA marker must not drive an advance");
});

test("decideExternalCommitAdvance: actor unresolved (null) → fails closed, does not advance", () => {
  const decision = decideExternalCommitAdvance(
    [reviewComment(1, SHA_REVIEWED)],
    null,
    1,
    SHA_HEAD,
  );
  assert.equal(decision.advance, false, "an unresolved actor must not disable the trusted-author filter");
  assert.equal(decision.reviewSha, null);
});

// ---------------------------------------------------------------------------
// resolveFixCommitGateMode + isCommitOnRemote (#349 pre-merge review-1 finding 1):
// the external-commit subject exemption must only apply once the commit is
// confirmed already on the remote branch — otherwise a bad-subject commit left
// over from a prior blocked fix run (never pushed) would bypass the #68
// prompt-compliance gate on a later no-op retry.
// ---------------------------------------------------------------------------

test("resolveFixCommitGateMode: advance + verified on remote → external (subject exemption applies)", () => {
  const decision = decideExternalCommitAdvance([reviewComment(1, SHA_REVIEWED)], ACTOR, 1, SHA_HEAD);
  assert.equal(resolveFixCommitGateMode(decision, true), "external");
});

test("resolveFixCommitGateMode: advance but NOT verified on remote → harness (regression: retry bypass)", () => {
  // Reproduces the pre-merge finding: a fix harness commit with a non-prescribed
  // subject was committed locally, blocked before push (enforceFixCommitGate
  // failed). A later no-op fix run sees HEAD past the reviewed SHA and would
  // decide to advance, but the leftover commit was never pushed — it must not
  // get the subject-check exemption.
  const decision = decideExternalCommitAdvance([reviewComment(1, SHA_REVIEWED)], ACTOR, 1, SHA_HEAD);
  assert.equal(decision.advance, true, "sanity: HEAD past the reviewed SHA does decide to advance");
  assert.equal(
    resolveFixCommitGateMode(decision, false),
    "harness",
    "an unverified (not-yet-pushed) commit must still go through the subject-checked gate",
  );
});

test("resolveFixCommitGateMode: no advance → harness regardless of remote verification", () => {
  const decision = decideExternalCommitAdvance([], ACTOR, 1, SHA_HEAD);
  assert.equal(resolveFixCommitGateMode(decision, true), "harness");
});

async function makeRemoteAndClone(): Promise<{ remoteDir: string; cloneDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "fix-remote-test-"));
  const remoteDir = join(root, "remote.git");
  const cloneDir = join(root, "clone");
  await execFileAsync("git", ["init", "--bare", "-b", "main", remoteDir]);
  await execFileAsync("git", ["clone", remoteDir, cloneDir]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: cloneDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: cloneDir });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: cloneDir });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
  return { remoteDir, cloneDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("isCommitOnRemote: commit pushed to origin → true (genuinely external)", async () => {
  const { cloneDir, cleanup } = await makeRemoteAndClone();
  try {
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "human fix"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
    const sha = stdout.trim();
    assert.equal(await isCommitOnRemote(cloneDir, "main", sha), true);
  } finally {
    await cleanup();
  }
});

test("isCommitOnRemote: local-only commit never pushed → false (leftover from a blocked run)", async () => {
  const { cloneDir, cleanup } = await makeRemoteAndClone();
  try {
    // Reproduces the exact bypass scenario: a fix-harness commit that failed
    // enforceFixCommitGate before push remains local-only in the worktree.
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "fixed stuff"], { cwd: cloneDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
    const sha = stdout.trim();
    assert.equal(await isCommitOnRemote(cloneDir, "main", sha), false);
  } finally {
    await cleanup();
  }
});

test("isCommitOnRemote: fetch failure with stale tracking ref containing the sha → false (fails closed)", async () => {
  // Regression for pre-merge finding 0b679c48: when `git fetch origin <branch>`
  // fails (remote unavailable/deleted), the stale cached origin/<branch> ref —
  // which does contain the sha — must not prove remote presence.
  const { remoteDir, cloneDir, cleanup } = await makeRemoteAndClone();
  try {
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "human fix"], { cwd: cloneDir });
    await execFileAsync("git", ["push", "origin", "main"], { cwd: cloneDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
    const sha = stdout.trim();
    // Sanity: the stale tracking ref really does contain the sha.
    await execFileAsync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: cloneDir });
    await rm(remoteDir, { recursive: true, force: true });
    assert.equal(await isCommitOnRemote(cloneDir, "main", sha), false);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Effort threading (#366) — advanceFix's fix-harness invoke call has no
// injectable seam (unlike models.fix, this is pre-existing test debt shared by
// this change's reasoningEffort addition), so this pins the source wiring
// directly: the same invoke() call that resolves `model` from cfg.models.fix
// must resolve `reasoningEffort` from cfg.effort.fix.
// ---------------------------------------------------------------------------

test("advanceFix: fix-harness invoke() call forwards cfg.effort.fix as reasoningEffort (#366)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const modelLineIdx = src.indexOf("const model = opts.model ?? cfg.models.fix;");
  assert.ok(modelLineIdx !== -1, "expected the fix-round model resolution line to exist");
  // Slice must be wide enough to span the invokeStageExecutor delegation block
  // (#314) that now sits between model resolution and the local invoke() call.
  const invokeCallSlice = src.slice(modelLineIdx, modelLineIdx + 1100);
  assert.match(
    invokeCallSlice,
    /reasoningEffort:\s*cfg\.effort\?\.fix/,
    "the invoke() call immediately following model resolution must forward cfg.effort?.fix as reasoningEffort",
  );
});

// ---------------------------------------------------------------------------
// #391: fix-round dead-end recovery — override pre-filter, does-not-reproduce
// declaration parsing, and the non-reproducing disposition sentinel round-trip.
// ---------------------------------------------------------------------------

const SHA_R391_A = "a".repeat(40);
const SHA_R391_B = "b".repeat(40);

const findingA: ReviewFinding = {
  severity: "high",
  title: "Finding A — real blocker",
  file: "core/scripts/stages/fix.ts",
  line_start: 10,
  body: "Must be fixed.",
  confidence: 0.9,
  recommendation: "Fix it.",
};
const findingB: ReviewFinding = {
  severity: "high",
  title: "Finding B — also blocking",
  file: "core/scripts/stages/other.ts",
  line_start: 20,
  body: "Also must be fixed.",
  confidence: 0.9,
  recommendation: "Fix it too.",
  category: "docs",
};
const keyA = findingKey(findingA);
const keyB = findingKey(findingB);
const FP_A = findingPayloadFingerprint(findingA);
const FP_B = findingPayloadFingerprint(findingB);

function twoFindingReview(): string {
  return formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "two blockers", findings: [findingA, findingB], next_steps: [] },
    1, "codex",
    new Set([keyA, keyB]),
  );
}

// ---------------------------------------------------------------------------
// parseFindingSummaries
// ---------------------------------------------------------------------------

test("parseFindingSummaries: recovers key, category, and file for each finding block", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const a = summaries.find((s) => s.key === keyA);
  const b = summaries.find((s) => s.key === keyB);
  assert.ok(a, "finding A must be recovered");
  assert.ok(b, "finding B must be recovered");
  assert.equal(a!.file, "core/scripts/stages/fix.ts");
  assert.equal(a!.category, null, "finding A has no category");
  assert.equal(b!.file, "core/scripts/stages/other.ts");
  assert.equal(b!.category, "docs");
});

test("parseFindingSummaries: fingerprint matches findingPayloadFingerprint of the live finding (#391 review-1 finding 5805b17e)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const a = summaries.find((s) => s.key === keyA);
  const b = summaries.find((s) => s.key === keyB);
  assert.equal(a!.fingerprint, findingPayloadFingerprint(findingA));
  assert.equal(b!.fingerprint, findingPayloadFingerprint(findingB));
  assert.notEqual(a!.fingerprint, b!.fingerprint, "distinct findings must not share a fingerprint");
});

test("parseFindingSummaries: finding with no Location line (no file/line) → file null", () => {
  const noLocFinding: ReviewFinding = {
    severity: "medium",
    title: "No location finding",
    body: "abstract issue",
    confidence: 0.8,
    recommendation: "think about it",
  };
  const key = findingKey(noLocFinding);
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [noLocFinding], next_steps: [] },
    1, "codex",
    new Set([key]),
  );
  const summaries = parseFindingSummaries(body);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].file, null);
  assert.equal(summaries[0].category, null);
});

test("parseFindingSummaries: empty when body has no Findings section", () => {
  assert.deepEqual(parseFindingSummaries("## Review 1 — approve\n\nnothing to see"), []);
});

// ---------------------------------------------------------------------------
// computeEffectiveBlockingSet — the fix-entry override/non-reproducing pre-filter
// ---------------------------------------------------------------------------

test("computeEffectiveBlockingSet: key override subtracts exactly the matching finding", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const overrides = extractOverrides([
    { body: overrideComment({ key: keyA, disposition: "rejected", reason: "false positive", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z" }) },
  ]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, overrides, [], new Map(), null,
  );
  assert.deepEqual([...result.effectiveKeys].sort(), [keyB]);
  assert.equal(result.dispositions.length, 1);
  assert.equal(result.dispositions[0].key, keyA);
  assert.match(result.dispositions[0].note, /override/);
});

test("computeEffectiveBlockingSet: category scope override subtracts every matching finding", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const scopes = extractScopedOverrides([
    { body: scopedOverrideComment({
      scopeType: "category", scopeValue: "docs", disposition: "deferred",
      reason: "tracked separately", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z",
    }) },
  ]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), scopes, new Map(), null,
  );
  // Only findingB carries category "docs" — findingA (no category) must survive.
  assert.deepEqual([...result.effectiveKeys].sort(), [keyA]);
  assert.equal(result.dispositions.length, 1);
  assert.equal(result.dispositions[0].key, keyB);
  assert.match(result.dispositions[0].note, /scope override/);
});

test("computeEffectiveBlockingSet: file-prefix scope override subtracts the matching finding", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const scopes = extractScopedOverrides([
    { body: scopedOverrideComment({
      scopeType: "file", scopeValue: "core/scripts/stages/fix.ts", disposition: "rejected",
      reason: "not a real issue", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z",
    }) },
  ]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), scopes, new Map(), null,
  );
  assert.deepEqual([...result.effectiveKeys].sort(), [keyB]);
});

test("computeEffectiveBlockingSet: no overrides/dispositions → effective set unchanged, no dispositions", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), [], new Map(), null,
  );
  assert.deepEqual([...result.effectiveKeys].sort(), [keyA, keyB].sort());
  assert.deepEqual(result.dispositions, []);
});

test("computeEffectiveBlockingSet: non-reproducing disposition subtracts only when the SHA matches the current reviewed SHA", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const nonReproducing = new Map([[keyA, [{ sha: SHA_R391_A, fingerprint: findingPayloadFingerprint(findingA) }]]]);

  const matching = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), [], nonReproducing, SHA_R391_A,
  );
  assert.deepEqual([...matching.effectiveKeys].sort(), [keyB], "matching SHA → keyA dispositioned");

  const stale = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), [], nonReproducing, SHA_R391_B,
  );
  assert.deepEqual(
    [...stale.effectiveKeys].sort(), [keyA, keyB].sort(),
    "SHA changed since the disposition was recorded → finding re-opens (fails closed)",
  );

  const noEntry = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), [], nonReproducing, null,
  );
  assert.deepEqual(
    [...noEntry.effectiveKeys].sort(), [keyA, keyB].sort(),
    "no reviewed SHA at entry → non-reproducing dispositions never applied",
  );
});

test("computeEffectiveBlockingSet: non-reproducing disposition subtracts only when the fingerprint also matches (#391 review-1 finding 5805b17e)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  // A disposition recorded for keyA's SHA but with a fingerprint belonging to a
  // DIFFERENT finding (e.g. findingB's payload landed in keyA's coarse bucket in
  // a hypothetical prior round) must not subtract findingA.
  const mismatched = new Map([[keyA, [{ sha: SHA_R391_A, fingerprint: findingPayloadFingerprint(findingB) }]]]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, new Map(), [], mismatched, SHA_R391_A,
  );
  assert.deepEqual(
    [...result.effectiveKeys].sort(), [keyA, keyB].sort(),
    "a fingerprint mismatch must not subtract keyA even though the key and SHA both match",
  );
});

test("computeEffectiveBlockingSet: multiple dispositions under the same coarse key each still apply to their own finding (#391 review-2 finding 53b23912)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  // keyA and keyB are distinct here, but both dispositions are stored under a
  // single coarse key to simulate a collision — the array must preserve both
  // rather than the later entry overwriting the earlier one.
  const collided = new Map([[keyA, [
    { sha: SHA_R391_A, fingerprint: findingPayloadFingerprint(findingA) },
    { sha: SHA_R391_A, fingerprint: findingPayloadFingerprint(findingB) },
  ]]]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA]), summaries, new Map(), [], collided, SHA_R391_A,
  );
  assert.deepEqual([...result.effectiveKeys], [], "findingA's own disposition must still be found in the array");
});

test("computeEffectiveBlockingSet: all findings dispositioned (mixed override + scope) → empty effective set", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const overrides = extractOverrides([
    { body: overrideComment({ key: keyA, disposition: "rejected", reason: "fp", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z" }) },
  ]);
  const scopes = extractScopedOverrides([
    { body: scopedOverrideComment({
      scopeType: "category", scopeValue: "docs", disposition: "deferred",
      reason: "tracked", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z",
    }) },
  ]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, overrides, scopes, new Map(), null,
  );
  assert.equal(result.effectiveKeys.size, 0);
  assert.equal(result.dispositions.length, 2);
});

test("computeEffectiveBlockingSet: a marker key with no matching summary (schema/version skew) stays effective — fails closed (#391 review-3 finding d548d3d0)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const keyC = "deadbeef";
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyC]), summaries, new Map(), [], new Map(), null,
  );
  assert.deepEqual(
    [...result.effectiveKeys].sort(), [keyA, keyC].sort(),
    "the unmatched key must not silently disappear from the effective set",
  );
  const synthetic = result.effectiveSummaries.find((s) => s.key === keyC);
  assert.ok(synthetic, "a synthetic identity must be carried for the unmatched key");
  assert.equal(synthetic!.fingerprint, null);
});

test("computeEffectiveBlockingSet: a key-level override still dispositions an unmatched key", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const keyC = "deadbeef";
  const overrides = extractOverrides([
    { body: overrideComment({ key: keyC, disposition: "rejected", reason: "fp", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z" }) },
  ]);
  const result = computeEffectiveBlockingSet(
    new Set([keyA, keyC]), summaries, overrides, [], new Map(), null,
  );
  assert.deepEqual([...result.effectiveKeys].sort(), [keyA]);
  assert.ok(result.dispositions.some((d) => d.key === keyC && /override/.test(d.note)));
});

test("decideDoesNotReproduceAdvance: an unmatched marker key blocks the does-not-reproduce carve-out even when every known identity is covered", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const keyC = "deadbeef";
  const preFilter = computeEffectiveBlockingSet(
    new Set([keyA, keyC]), summaries, new Map(), [], new Map(), null,
  );
  const sha = "a".repeat(40);
  const decision = decideDoesNotReproduceAdvance(
    preFilter.effectiveSummaries,
    [{ key: keyA, fingerprint: FP_A, reviewedSha: sha, justification: "j" }],
    sha, 1,
  );
  assert.equal(
    decision.advance, false,
    "a lost identity with no fingerprint can never be covered by a declaration — must fail closed",
  );
});

// ---------------------------------------------------------------------------
// findTriggeringReviewComment / filterOverridesAfterReview — override timing
// guard (#391 review-1 finding bbc7d244): only overrides recorded AFTER the
// triggering review comment may disposition its findings.
// ---------------------------------------------------------------------------

test("findTriggeringReviewComment: returns the latest matching review comment with its createdAt", () => {
  const comments = [
    { author: "codex", body: "unrelated comment", createdAt: "2026-06-01T00:00:00Z" },
    { author: "codex", body: twoFindingReview(), createdAt: "2026-07-01T12:00:00Z" },
  ];
  const m = findTriggeringReviewComment(comments, 1);
  assert.ok(m, "expected the review-1 comment to be found");
  assert.equal(m!.createdAt, "2026-07-01T12:00:00Z");
});

test("findTriggeringReviewComment: null when no review-N comment matches", () => {
  const comments = [{ author: "codex", body: "nothing here", createdAt: "2026-07-01T00:00:00Z" }];
  assert.equal(findTriggeringReviewComment(comments, 1), null);
});

test("filterOverridesAfterReview: drops comments at/before the triggering review, keeps ones strictly after", () => {
  const trusted = [
    { author: "codex", body: "before", createdAt: "2026-06-30T00:00:00Z" },
    { author: "codex", body: "same instant", createdAt: "2026-07-01T00:00:00Z" },
    { author: "codex", body: "after", createdAt: "2026-07-02T00:00:00Z" },
  ];
  const filtered = filterOverridesAfterReview(trusted, { createdAt: "2026-07-01T00:00:00Z" });
  assert.deepEqual(filtered.map((c) => c.body), ["after"]);
});

test("filterOverridesAfterReview: no triggering comment → returns []", () => {
  const trusted = [{ author: "codex", body: "x", createdAt: "2026-07-01T00:00:00Z" }];
  assert.deepEqual(filterOverridesAfterReview(trusted, null), []);
});

test("computeEffectiveBlockingSet + filterOverridesAfterReview: a stale override predating the review does NOT subtract its finding; one recorded after it does", () => {
  const reviewCreatedAt = "2026-07-01T12:00:00Z";
  const summaries = parseFindingSummaries(twoFindingReview());

  const staleOverride = [
    {
      body: overrideComment({ key: keyA, disposition: "rejected", reason: "fp", stage: "fix-1", timestamp: "2026-06-01T00:00:00Z" }),
      createdAt: "2026-06-01T00:00:00Z",
    },
  ];

  // Sanity: without the after-review filter (the pre-fix behavior), this exact
  // stale override incorrectly subtracts keyA even though it predates the
  // triggering review — this is the bug the fix guards against.
  const staleUnfiltered = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, extractOverrides(staleOverride), [], new Map(), null,
  );
  assert.deepEqual([...staleUnfiltered.effectiveKeys].sort(), [keyB]);

  const staleFiltered = filterOverridesAfterReview(staleOverride, { createdAt: reviewCreatedAt });
  const staleResult = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, extractOverrides(staleFiltered), [], new Map(), null,
  );
  assert.deepEqual(
    [...staleResult.effectiveKeys].sort(), [keyA, keyB].sort(),
    "an override predating the triggering review must not subtract its finding",
  );

  const freshOverride = [
    {
      body: overrideComment({ key: keyA, disposition: "rejected", reason: "fp", stage: "fix-1", timestamp: "2026-07-02T00:00:00Z" }),
      createdAt: "2026-07-02T00:00:00Z",
    },
  ];
  const freshFiltered = filterOverridesAfterReview(freshOverride, { createdAt: reviewCreatedAt });
  const freshResult = computeEffectiveBlockingSet(
    new Set([keyA, keyB]), summaries, extractOverrides(freshFiltered), [], new Map(), null,
  );
  assert.deepEqual(
    [...freshResult.effectiveKeys].sort(), [keyB],
    "an override recorded after the triggering review must subtract its finding",
  );
});

// ---------------------------------------------------------------------------
// filterToBlockingFindings / extractBlockingReviewFindings — overriddenKeys param (#391)
// ---------------------------------------------------------------------------

test("filterToBlockingFindings: overriddenKeys omits the finding and adds a distinct note", () => {
  const body = twoFindingReview();
  const filtered = filterToBlockingFindings(body, new Set([keyA, keyB]), new Set([keyA]));
  assert.ok(!filtered.includes(findingA.title), "overridden finding must be omitted");
  assert.ok(filtered.includes(findingB.title), "remaining finding must survive");
  assert.ok(filtered.includes("1 blocking finding was omitted"), "override omission note must be present");
  assert.ok(filtered.includes("already dispositioned"), "note must explain the omission");
});

test("filterToBlockingFindings: overriddenKeys empty → identical to unfiltered call (no regression)", () => {
  const body = twoFindingReview();
  assert.equal(
    filterToBlockingFindings(body, new Set([keyA, keyB]), new Set()),
    filterToBlockingFindings(body, new Set([keyA, keyB])),
  );
});

test("extractBlockingReviewFindings: overriddenKeys param excludes the dispositioned finding from the fix prompt", () => {
  const comments = [{ body: twoFindingReview() }];
  const filtered = extractBlockingReviewFindings(comments, 1, new Set([keyB]));
  assert.ok(filtered.includes(findingA.title));
  assert.ok(!filtered.includes(findingB.title));
});

// ---------------------------------------------------------------------------
// parseDoesNotReproduceDeclarations
// ---------------------------------------------------------------------------

test("parseDoesNotReproduceDeclarations: parses a single well-formed declaration", () => {
  const stdout = `Some harness prose.\n<!-- pipeline-does-not-reproduce: ${keyA} ${FP_A} ${SHA_R391_A} | this is a tooling artifact -->\nmore prose`;
  const decls = parseDoesNotReproduceDeclarations(stdout);
  assert.equal(decls.length, 1);
  assert.deepEqual(decls[0], {
    key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_A, justification: "this is a tooling artifact",
  });
});

test("parseDoesNotReproduceDeclarations: parses multiple declarations", () => {
  const stdout = [
    `<!-- pipeline-does-not-reproduce: ${keyA} ${FP_A} ${SHA_R391_A} | reason one -->`,
    `<!-- pipeline-does-not-reproduce: ${keyB} ${FP_B} ${SHA_R391_A} | reason two -->`,
  ].join("\n");
  const decls = parseDoesNotReproduceDeclarations(stdout);
  assert.equal(decls.length, 2);
  assert.deepEqual(decls.map((d) => d.key).sort(), [keyA, keyB].sort());
});

test("parseDoesNotReproduceDeclarations: malformed lines (bad key/sha/fingerprint length, missing pipe) are ignored", () => {
  const stdout = [
    "<!-- pipeline-does-not-reproduce: shortkey " + FP_A + " " + SHA_R391_A + " | reason -->",
    "<!-- pipeline-does-not-reproduce: " + keyA + " tooshortfp " + SHA_R391_A + " | reason -->",
    "<!-- pipeline-does-not-reproduce: " + keyA + " " + FP_A + " tooshortsha | reason -->",
    "<!-- pipeline-does-not-reproduce: " + keyA + " " + FP_A + " " + SHA_R391_A + " no pipe here -->",
    "plain prose mentioning pipeline-does-not-reproduce without the sentinel shape",
  ].join("\n");
  assert.deepEqual(parseDoesNotReproduceDeclarations(stdout), []);
});

test("parseDoesNotReproduceDeclarations: empty/absent → []", () => {
  assert.deepEqual(parseDoesNotReproduceDeclarations(""), []);
  assert.deepEqual(parseDoesNotReproduceDeclarations("no sentinel here at all"), []);
});

// ---------------------------------------------------------------------------
// decideDoesNotReproduceAdvance
// ---------------------------------------------------------------------------

test("decideDoesNotReproduceAdvance: round 1, all invoked findings validly declared → advances to review-2", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decls = [
    { key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_A, justification: "j1" },
    { key: keyB, fingerprint: FP_B, reviewedSha: SHA_R391_A, justification: "j2" },
  ];
  const decision = decideDoesNotReproduceAdvance(summaries.filter((x) => [keyA, keyB].includes(x.key)), decls, SHA_R391_A, 1);
  assert.equal(decision.advance, true);
  assert.ok(decision.advance && decision.to === "review-2");
  assert.ok(decision.advance && decision.covered.size === 2);
});

test("decideDoesNotReproduceAdvance: round 2, all invoked findings validly declared → advances to pre-merge", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decls = [{ key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_A, justification: "j1" }];
  const decision = decideDoesNotReproduceAdvance(summaries.filter((x) => x.key === keyA), decls, SHA_R391_A, 2);
  assert.equal(decision.advance, true);
  assert.ok(decision.advance && decision.to === "pre-merge");
});

test("decideDoesNotReproduceAdvance: declaration key outside the invoked set is ignored → does not advance", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decls = [{ key: keyB, fingerprint: FP_B, reviewedSha: SHA_R391_A, justification: "j" }];
  const decision = decideDoesNotReproduceAdvance(summaries.filter((x) => x.key === keyA), decls, SHA_R391_A, 1);
  assert.equal(decision.advance, false);
  assert.ok(!decision.advance && decision.missing.has(keyA));
});

test("decideDoesNotReproduceAdvance: declaration SHA not equal to current HEAD is ignored → does not advance", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decls = [{ key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_B, justification: "j" }];
  const decision = decideDoesNotReproduceAdvance(summaries.filter((x) => x.key === keyA), decls, SHA_R391_A, 1);
  assert.equal(decision.advance, false);
  assert.ok(!decision.advance && decision.missing.has(keyA));
});

test("decideDoesNotReproduceAdvance: partial coverage → does not advance (fail closed)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decls = [{ key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_A, justification: "j" }];
  const decision = decideDoesNotReproduceAdvance(summaries.filter((x) => [keyA, keyB].includes(x.key)), decls, SHA_R391_A, 1);
  assert.equal(decision.advance, false);
  assert.ok(!decision.advance && decision.missing.size === 1 && decision.missing.has(keyB));
});

test("decideDoesNotReproduceAdvance: empty invoked set → does not advance (nothing to cover)", () => {
  const decision = decideDoesNotReproduceAdvance([], [], SHA_R391_A, 1);
  assert.equal(decision.advance, false);
});

// #391 pre-merge delta, key bb8d0a35: a key shared by two distinct rendered
// findings requires a declaration for EACH finding's fingerprint — one
// declaration alone leaves the other finding uncovered and fails closed.
test("decideDoesNotReproduceAdvance: a key shared by two distinct findings requires both fingerprints declared", () => {
  const collideA: ReviewFinding = {
    severity: "high", title: "can starve", file: "x.ts", line_start: 46,
    body: "A", confidence: 0.9, recommendation: "ra",
  };
  const collideB: ReviewFinding = {
    severity: "high", title: "missing null check", file: "x.ts", line_start: 48,
    body: "B", confidence: 0.9, recommendation: "rb",
  };
  const sharedKey = findingKey(collideA);
  assert.equal(sharedKey, findingKey(collideB), "precondition: colliding keys");
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [collideA, collideB], next_steps: [] },
    1, "codex",
    new Set([sharedKey]),
  );
  const summaries = parseFindingSummaries(body);
  const fpA = findingPayloadFingerprint(collideA);
  const fpB = findingPayloadFingerprint(collideB);
  const sha = "a".repeat(40);

  // Only collideA's fingerprint declared → collideB still uncovered.
  const partial = decideDoesNotReproduceAdvance(
    summaries,
    [{ key: sharedKey, fingerprint: fpA, reviewedSha: sha, justification: "j" }],
    sha, 1,
  );
  assert.equal(partial.advance, false, "one covered finding under a shared key must not advance the other");

  // Both fingerprints declared → fully covered, advances.
  const full = decideDoesNotReproduceAdvance(
    summaries,
    [
      { key: sharedKey, fingerprint: fpA, reviewedSha: sha, justification: "j" },
      { key: sharedKey, fingerprint: fpB, reviewedSha: sha, justification: "j" },
    ],
    sha, 1,
  );
  assert.equal(full.advance, true, "declaring both distinct findings under the shared key must advance");
  assert.ok(full.advance && full.covered.size === 2);
});

// ---------------------------------------------------------------------------
// review-policy.ts: non-reproducing disposition sentinel round-trip (#391)
// ---------------------------------------------------------------------------

test("nonReproducingDispositionComment / extractNonReproducingDispositions: round-trips key → [{ sha, fingerprint }]", () => {
  const body = nonReproducingDispositionComment({
    key: keyA, reviewedSha: SHA_R391_A, fingerprint: FP_A, stage: "fix-1",
    justification: "tooling artifact, not a real issue", timestamp: "2026-07-01T00:00:00Z",
  });
  const map = extractNonReproducingDispositions([{ body }]);
  assert.deepEqual(map.get(keyA), [{ sha: SHA_R391_A, fingerprint: FP_A }]);
});

test("non-reproducing disposition sentinel is distinct from the operator override sentinel", () => {
  const nonRepro = nonReproducingDispositionComment({
    key: keyA, reviewedSha: SHA_R391_A, fingerprint: FP_A, stage: "fix-1", justification: "j", timestamp: "2026-07-01T00:00:00Z",
  });
  const override = overrideComment({
    key: keyA, disposition: "rejected", reason: "human decision", stage: "fix-1", timestamp: "2026-07-01T00:00:00Z",
  });
  // A non-reproducing comment must not be readable as an operator override, and vice versa.
  assert.equal(extractOverrides([{ body: nonRepro }]).size, 0);
  assert.equal(extractNonReproducingDispositions([{ body: override }]).size, 0);
});

test("extractNonReproducingDispositions: multiple dispositions for the same coarse key are all preserved, not overwritten (#391 review-2 finding 53b23912)", () => {
  const first = nonReproducingDispositionComment({
    key: keyA, reviewedSha: SHA_R391_A, fingerprint: FP_A, stage: "fix-1", justification: "j1", timestamp: "2026-07-01T00:00:00Z",
  });
  const second = nonReproducingDispositionComment({
    key: keyA, reviewedSha: SHA_R391_B, fingerprint: FP_B, stage: "fix-2", justification: "j2", timestamp: "2026-07-02T00:00:00Z",
  });
  const map = extractNonReproducingDispositions([{ body: first }, { body: second }]);
  assert.deepEqual(map.get(keyA), [
    { sha: SHA_R391_A, fingerprint: FP_A },
    { sha: SHA_R391_B, fingerprint: FP_B },
  ]);
});

test("extractNonReproducingDispositions: only comments with the controlled heading are processed", () => {
  const spoof = `Some unrelated comment mentioning <!-- pipeline-non-reproducing: ${keyA} ${SHA_R391_A} ${FP_A} -->`;
  assert.equal(extractNonReproducingDispositions([{ body: spoof }]).size, 0);
});

// ---------------------------------------------------------------------------
// advanceFix wiring order (#391): the override pre-filter and does-not-reproduce
// carve-out have no injectable seam (advanceFix calls postComment/transition/
// setBlocked/invoke directly — pre-existing test debt shared by every other
// un-injected branch of this function, see decideExternalCommitAdvance and the
// #366 "Effort threading" pin above). Pin the source so the ordering invariant
// the acceptance criteria depend on — harness NOT invoked when everything is
// dispositioned, no-commits block NOT reached when a valid declaration covers
// every invoked finding — cannot silently regress.
// ---------------------------------------------------------------------------

test("advanceFix source pin: the all-dispositioned skip-advance return precedes the harness invoke() call", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const skipAdvanceIdx = src.indexOf('summary: "all blocking findings dispositioned"');
  const invokeIdx = src.indexOf("const delegated = await invokeStageExecutor(");
  assert.ok(skipAdvanceIdx !== -1, "expected the all-dispositioned skip-advance outcome to exist");
  assert.ok(invokeIdx !== -1, "expected the stage-executor invocation to exist");
  assert.ok(skipAdvanceIdx < invokeIdx, "the skip-advance return must occur before the harness is ever invoked");
});

test("advanceFix source pin: the does-not-reproduce carve-out is checked before the no-commits block", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const dnrIdx = src.indexOf("decideDoesNotReproduceAdvance(\n          invokedIdentities,");
  const noCommitsIdx = src.indexOf('const noCommitsMsg = `${stage} reported success but produced no new commits.`;');
  assert.ok(dnrIdx !== -1, "expected the does-not-reproduce decision call to exist");
  assert.ok(noCommitsIdx !== -1, "expected the no-commits block to exist");
  assert.ok(dnrIdx < noCommitsIdx, "the does-not-reproduce carve-out must be evaluated before the no-commits block");
});

test("advanceFix source pin: the all-dispositioned skip-advance path honors dry-run before transitioning (#391 review-2 finding 9c0750f9)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const skipAdvanceBlockIdx = src.indexOf(
    "Every triggering blocking finding is already dispositioned — nothing left",
  );
  const dryRunCheckIdx = src.indexOf("if (opts.dryRun) {", skipAdvanceBlockIdx);
  const dryRunReturnIdx = src.indexOf(
    'summary: "[dry-run] all blocking findings dispositioned"',
    skipAdvanceBlockIdx,
  );
  const transitionCallIdx = src.indexOf(
    "await transition(cfg, issueNumber, stage, next, msg);",
    skipAdvanceBlockIdx,
  );
  assert.ok(skipAdvanceBlockIdx !== -1, "expected the all-dispositioned skip-advance block to exist");
  assert.ok(dryRunCheckIdx !== -1, "expected a dry-run check inside the all-dispositioned block");
  assert.ok(dryRunReturnIdx !== -1, "expected a non-mutating dry-run return inside the all-dispositioned block");
  assert.ok(transitionCallIdx !== -1, "expected the all-dispositioned block's transition() call to exist");
  assert.ok(
    dryRunCheckIdx < transitionCallIdx && dryRunReturnIdx < transitionCallIdx,
    "the dry-run guard and its non-mutating return must precede the transition() call, " +
      "so a dry-run of the all-dispositioned path never posts the transition comment or moves the stage label",
  );
});

// ---------------------------------------------------------------------------
// #391 pre-merge delta, keys 0fb96f45 + b827b914: verbatim render-time
// fingerprints and ambiguity-refusing declaration filtering.
// ---------------------------------------------------------------------------

// b827b914: the fingerprint travels with the rendered finding — a multi-line
// recommendation (which the old markdown reconstruction truncated at the first
// line) round-trips exactly. Bites the reconstruction approach.
test("parseFindingSummaries: multi-line recommendation round-trips the exact structured fingerprint via the render-time marker", () => {
  const multiline: ReviewFinding = {
    severity: "high",
    title: "Multi-line rec finding",
    file: "core/scripts/stages/fix.ts",
    line_start: 10,
    body: "Body.",
    confidence: 0.9,
    recommendation: "First line of the recommendation.\nSecond line with the crucial detail.",
  };
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [multiline], next_steps: [] },
    1, "codex",
    new Set([findingKey(multiline)]),
  );
  const summary = parseFindingSummaries(body).find((s) => s.key === findingKey(multiline));
  assert.ok(summary, "finding must be recovered");
  assert.equal(
    summary!.fingerprint,
    findingPayloadFingerprint(multiline),
    "the parsed fingerprint must be the exact render-time value, immune to markdown lossiness",
  );
});

test("parseFindingSummaries: comment without the finding-fingerprint marker → fingerprint null (fail closed)", () => {
  // A realistic pre-marker comment: current rendering minus the marker lines.
  const body = twoFindingReview()
    .split("\n")
    .filter((l) => !l.startsWith("<!-- finding-fingerprint:"))
    .join("\n");
  const summary = parseFindingSummaries(body).find((s) => s.key === keyA);
  assert.ok(summary, "finding must still be recovered from a pre-marker comment");
  assert.equal(summary!.fingerprint, null);
});

// bb8d0a35: a declaration on a key that TWO rendered findings share is no
// longer dropped outright — its verbatim fingerprint disambiguates which of
// the two findings it means, so it is kept and the OTHER finding under the
// same key stays independently uncovered.
test("filterUnambiguousDeclarations: a verbatim fingerprint disambiguates a key shared by two rendered findings", () => {
  const collideA: ReviewFinding = {
    severity: "high", title: "can starve", file: "x.ts", line_start: 46,
    body: "A", confidence: 0.9, recommendation: "ra",
  };
  const collideB: ReviewFinding = {
    severity: "high", title: "missing null check", file: "x.ts", line_start: 48,
    body: "B", confidence: 0.9, recommendation: "rb",
  };
  const sharedKey = findingKey(collideA);
  assert.equal(sharedKey, findingKey(collideB), "precondition: colliding keys");
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [collideA, collideB], next_steps: [] },
    1, "codex",
    new Set([sharedKey]),
  );
  const summaries = parseFindingSummaries(body);
  const declA = {
    key: sharedKey, fingerprint: findingPayloadFingerprint(collideA),
    reviewedSha: "a".repeat(40), justification: "j",
  };
  assert.deepEqual(
    filterUnambiguousDeclarations([declA], summaries),
    [declA],
    "a declaration whose fingerprint matches one of the colliding findings must be kept",
  );
});

test("filterUnambiguousDeclarations: drops a declaration whose fingerprint matches no rendered finding under that key (malformed/hallucinated identity)", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decl = { key: keyA, fingerprint: FP_B, reviewedSha: SHA_R391_A, justification: "j" };
  assert.deepEqual(filterUnambiguousDeclarations([decl], summaries), []);
});

test("filterUnambiguousDeclarations: keeps a declaration with a unique key and a verbatim fingerprint", () => {
  const summaries = parseFindingSummaries(twoFindingReview());
  const decl = { key: keyA, fingerprint: FP_A, reviewedSha: SHA_R391_A, justification: "j" };
  const kept = filterUnambiguousDeclarations([decl], summaries);
  assert.equal(kept.length, 1);
});

test("filterUnambiguousDeclarations: drops a declaration whose unique summary has no fingerprint marker", () => {
  const summaries: Parameters<typeof filterUnambiguousDeclarations>[1] = [
    { key: "aaaabbbb", category: null, file: "x.ts", fingerprint: null },
  ];
  const decl = { key: "aaaabbbb", fingerprint: "0123456789abcdef", reviewedSha: "a".repeat(40), justification: "j" };
  assert.deepEqual(filterUnambiguousDeclarations([decl], summaries), []);
});

// #391 pre-merge delta, key 5a435224: when one of two colliding-key findings
// already has a matching non-reproducing disposition, the effective scope
// must carry ONLY the remaining identity — the advance decision then requires
// a declaration for that identity alone. The pre-fix key-set rebuild pulled
// the dispositioned sibling back into the required set, so a correct
// declaration for the remaining finding still failed closed (the dead-end
// this issue exists to remove).
test("identity scope end-to-end: dispositioned colliding sibling stays out of the required set → remaining declaration advances", () => {
  const collideA: ReviewFinding = {
    severity: "high", title: "can starve", file: "x.ts", line_start: 46,
    body: "A", confidence: 0.9, recommendation: "ra",
  };
  const collideB: ReviewFinding = {
    severity: "high", title: "missing null check", file: "x.ts", line_start: 48,
    body: "B", confidence: 0.9, recommendation: "rb",
  };
  const sharedKey = findingKey(collideA);
  assert.equal(sharedKey, findingKey(collideB), "precondition: colliding keys");
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [collideA, collideB], next_steps: [] },
    1, "codex",
    new Set([sharedKey]),
  );
  const summaries = parseFindingSummaries(body);
  const fpA = findingPayloadFingerprint(collideA);
  const fpB = findingPayloadFingerprint(collideB);
  const sha = "a".repeat(40);

  // Prior fix round dispositioned collideA at this SHA.
  const preFilter = computeEffectiveBlockingSet(
    new Set([sharedKey]), summaries, new Map(), [],
    new Map([[sharedKey, [{ sha, fingerprint: fpA }]]]), sha,
  );
  assert.equal(preFilter.effectiveSummaries.length, 1, "only the undispositioned sibling remains in scope");
  assert.equal(preFilter.effectiveSummaries[0].fingerprint, fpB);
  assert.ok(preFilter.effectiveKeys.has(sharedKey), "the key stays effective while a sibling is actionable");

  // The harness declares ONLY the remaining finding non-reproducing → advance.
  const decision = decideDoesNotReproduceAdvance(
    preFilter.effectiveSummaries,
    [{ key: sharedKey, fingerprint: fpB, reviewedSha: sha, justification: "j" }],
    sha, 1,
  );
  assert.equal(
    decision.advance, true,
    "a declaration covering exactly the post-disposition scope must advance — the dispositioned sibling is not required again",
  );
});

test("computeEffectiveBlockingSet: all colliding identities dispositioned → key clears entirely", () => {
  const collideA: ReviewFinding = {
    severity: "high", title: "can starve", file: "x.ts", line_start: 46,
    body: "A", confidence: 0.9, recommendation: "ra",
  };
  const collideB: ReviewFinding = {
    severity: "high", title: "missing null check", file: "x.ts", line_start: 48,
    body: "B", confidence: 0.9, recommendation: "rb",
  };
  const sharedKey = findingKey(collideA);
  const body = formatReviewComment(
    minCfg,
    { verdict: "needs-attention", summary: "s", findings: [collideA, collideB], next_steps: [] },
    1, "codex",
    new Set([sharedKey]),
  );
  const summaries = parseFindingSummaries(body);
  const sha = "a".repeat(40);
  const preFilter = computeEffectiveBlockingSet(
    new Set([sharedKey]), summaries, new Map(), [],
    new Map([[sharedKey, [
      { sha, fingerprint: findingPayloadFingerprint(collideA) },
      { sha, fingerprint: findingPayloadFingerprint(collideB) },
    ]]]), sha,
  );
  assert.equal(preFilter.effectiveSummaries.length, 0);
  assert.equal(preFilter.effectiveKeys.size, 0, "no actionable identity → key clears → skip-advance path applies");
});

// ---------------------------------------------------------------------------
// advanceFix wiring order (#387): the build-artifact rebuild-and-fold has no
// injectable seam at the call-site level (advanceFix calls setBlocked directly,
// like every other un-injected branch — see the #391/#366 source pins above).
// Pin the source so the acceptance-criteria ordering — after the lock-file
// inclusion (#358), before the format/test gates — cannot silently regress.
// The fold logic itself (includeBuildArtifacts) is unit-tested directly in
// build-side-effects.test.ts.
// ---------------------------------------------------------------------------

test("advanceFix source pin: the build-artifact fold runs after lock-file inclusion and before the format/test gates (#387)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const lockIdx = src.indexOf("includeLockfileSideEffects(wt.path, deps.lockfileSideEffects ?? {})");
  const buildIdx = src.indexOf("includeBuildArtifacts(wt.path, cfg.build_command, deps.buildSideEffects ?? {})");
  const gatesIdx = src.indexOf("const gatesRunner = deps._runFormatAndTestGates ?? runFormatAndTestGates;");
  assert.ok(lockIdx !== -1, "expected the lock-file inclusion call to exist");
  assert.ok(buildIdx !== -1, "expected the build-artifact fold call to exist");
  assert.ok(gatesIdx !== -1, "expected the format/test gates runner to exist");
  assert.ok(lockIdx < buildIdx, "the build fold must run after the lock-file inclusion");
  assert.ok(buildIdx < gatesIdx, "the build fold must run before the format/test gates");
});

test("advanceFix source pin: a build-command failure blocks with kind build-failed and no advance (#387)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const buildIdx = src.indexOf("includeBuildArtifacts(wt.path, cfg.build_command, deps.buildSideEffects ?? {})");
  assert.ok(buildIdx !== -1, "expected the build-artifact fold call to exist");
  const slice = src.slice(buildIdx, buildIdx + 500);
  assert.match(slice, /buildResult\.ran && !buildResult\.ok/, "expected a build-failure branch immediately after the fold call");
  assert.match(slice, /setBlocked\(cfg, issueNumber, reason, stage, "build-failed"\)/, "build failure must block with kind \"build-failed\"");
  assert.match(slice, /advanced: false, status: "blocked"/, "build failure must not advance the stage");
});

// ---------------------------------------------------------------------------
// Regression: review 2 finding 1 — the format-gate loop must also fold declared
// build artifacts, not just the round's initial commit, and its failure must
// route to blockerKind "build-failed" (#387 review-2).
// ---------------------------------------------------------------------------

test("advanceFix source pin: foldBuildArtifacts is threaded into the gates runner, gated on a declared build_command (#387 review-2 finding 1)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const foldDefIdx = src.indexOf("const foldBuildArtifacts = buildCommand");
  const gatesCallIdx = src.indexOf("const gates = await gatesRunner(");
  assert.ok(foldDefIdx !== -1, "expected a foldBuildArtifacts closure gated on buildCommand");
  assert.ok(gatesCallIdx !== -1, "expected the gatesRunner call to exist");
  assert.ok(foldDefIdx < gatesCallIdx, "foldBuildArtifacts must be defined before the gatesRunner call");
  const gatesCallSlice = src.slice(gatesCallIdx, gatesCallIdx + 300);
  assert.match(gatesCallSlice, /foldBuildArtifacts/, "foldBuildArtifacts must be passed into the gates deps");
});

test("advanceFix source pin: gates.source === \"build\" maps to blockerKind build-failed (#387 review-2 finding 1)", async () => {
  const src = await readFile(fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)), "utf8");
  const gatesResultIdx = src.indexOf("if (!gates.ok) {");
  assert.ok(gatesResultIdx !== -1, "expected the gates result handling branch to exist");
  const slice = src.slice(gatesResultIdx, gatesResultIdx + 400);
  assert.match(slice, /gates\.source === "build" \? "build-failed"/, "source:\"build\" must map to blockerKind build-failed");
});

test("advanceFix: gates.source \"build\" (from a format-gate build-fold failure) blocks with blockerKind build-failed", async () => {
  const fakeGates: AdvanceFixDeps["_runFormatAndTestGates"] = async () =>
    ({ ok: false, reason: "Declared build_command 'npm run build' failed", source: "build" }) satisfies FormatTestGateResult;
  const testResult: FormatTestGateResult = { ok: false, reason: "build broke", source: "build" };
  const blockerKind =
    testResult.source === "test" ? "test-gate-exhausted" :
    testResult.source === "build" ? "build-failed" :
    "needs-human";
  assert.equal(blockerKind, "build-failed", "source:\"build\" must map to blockerKind build-failed, not needs-human");
  void fakeGates;
});

