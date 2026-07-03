// Regression tests for fix-round commit message format verification (#68).
// Tests enforceFixCommitGate directly so the full advanceFix call chain (GitHub
// API, git, harness) does not need to be mocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideExternalCommitAdvance,
  enforceFixOpenspecConsistency,
  enforceFixCommitGate,
  enforceExternalCommitGate,
  enforceOpenspecSpecDeltaValidation,
  extractAllReviewFindingsHistory,
  extractBlockingReviewFindings,
  filterToBlockingFindings,
  isCommitOnRemote,
  resolveFixCommitGateMode,
} from "../scripts/stages/fix.ts";

const execFileAsync = promisify(execFile);
import { formatReviewComment } from "../scripts/stages/review.ts";
import { categoryMarker, directionMarker, findingKey, SPEC_DIVERGENCE_CATEGORY } from "../scripts/review-policy.ts";
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
