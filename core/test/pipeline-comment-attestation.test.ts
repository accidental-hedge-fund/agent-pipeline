// Unit tests for the generic pipeline comment attestation (#471).
//
// #390 made review verdicts exempt from the human-input objection scan by
// binding them to a verifiable `bodyHash` artifact. #471 is the first
// recurrence: `advisoryAdvanceComment` ("... advances instead of routing to
// a fix round") trips `NEGATION_PATTERNS` and has no verification artifact,
// so the very next stage boundary self-blocks on the pipeline's own comment.
//
// This file covers:
//   1. The attestation primitive (encode/verify) in isolation.
//   2. The #429 regression this issue was filed against.
//   3. A behavioral drift guard: every non-exempt kind in PIPELINE_COMMENT_KINDS
//      is exercised through its REAL renderer, which must verify and
//      self-exclude from findUnacknowledgedComments.
//   4. A source drift guard: every `## Pipeline…`-family heading literal in
//      core/scripts/ is represented in the single PIPELINE_COMMENT_KINDS registry.
//   5. Negative cases proving the gate change added no new trust path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNewHumanInputWarningComment,
  findUnacknowledgedComments,
} from "../scripts/issue-context-snapshot.ts";
import {
  buildTrustedOverrideComments,
  humanDecisionComment,
  nonReproducingDispositionComment,
  overrideComment,
  scopedOverrideComment,
} from "../scripts/review-policy.ts";
import {
  PIPELINE_COMMENT_KINDS,
  buildAttestedBlockedComment,
  buildTransitionComment,
  isVerifiedOperatorSurfaceComment,
} from "../scripts/gh.ts";
import { buildUnblockedComment } from "../scripts/pipeline.ts";
import {
  attestPipelineComment,
  encodePipelineAttestation,
  extractPipelineAttestation,
  hashReviewBody,
  isVerifiedPipelineAttestation,
  isVerifiedPipelineOutput,
} from "../scripts/stages/review-parsing.ts";
import {
  advisoryAdvanceComment,
  deltaRoundCeilingComment,
  deltaRoundCeilingDemotionComment,
  formatDeltaReviewComment,
  formatReviewComment,
  reviewCeilingComment,
  reviewCeilingDemotionComment,
  type DeltaCeilingFinding,
} from "../scripts/stages/review-rendering.ts";
import {
  diffUnchangedNotice,
  preMergeRerunIdentityNotice,
  preMergeRerunScopeNotice,
  staleReviewNotice,
} from "../scripts/stages/pre_merge.ts";
import { buildAutoRecoveryComment, buildAutoRecoveryLimitComment } from "../scripts/stages/auto_recover.ts";
import { buildPipelineCompleteComment } from "../scripts/stages/deploy_ready.ts";
import { formatEvidenceCommentBody } from "../scripts/evidence-bundle.ts";
import {
  buildAuditRepairBlockedComment,
  buildAuditRepairComment,
  buildAutoLoopContinuationComment,
  buildAutoLoopExhaustedComment,
} from "../scripts/pipeline-run.ts";
import type { PartitionResult } from "../scripts/review-policy.ts";
import type { EvidenceBundle, PipelineConfig, ReviewFinding } from "../scripts/types.ts";

const TEST_ACTOR = "pipeline-bot";

function makeComment(author: string, body: string, createdAt = "2026-01-01T00:00:00Z") {
  return { author, body, createdAt };
}

function ts(offset = 0): string {
  return `2026-01-0${1 + offset}T00:00:00Z`;
}

const EMPTY_PARTITION: PartitionResult = { blocking: [], advisory: [], overridden: [] };

const advanceCfg = {
  review_policy: { block_threshold: "high", min_confidence: 0.5 },
  marker_footer: "*Automated by Claude Code Pipeline Skill*",
  base_branch: "main",
  auto_recovery_max_retries: 2,
  auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] },
  harnesses: { implementer: "claude", reviewer: "codex" },
} as unknown as PipelineConfig;

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "high",
    title: "Something is wrong",
    body: "Detailed explanation.",
    confidence: 0.9,
    recommendation: "Fix it.",
    ...overrides,
  };
}

function emptyEvidenceBundle(): EvidenceBundle {
  return {
    schema_version: 1,
    schemaVersion: 1,
    runId: "471/2026-01-01T00:00:00Z",
    issue: 471,
    pr: null,
    branch: null,
    harnesses: [],
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState: null,
    finalizedAt: null,
    notifiedAt: null,
  } as unknown as EvidenceBundle;
}

// ---------------------------------------------------------------------------
// 1. Attestation primitive
// ---------------------------------------------------------------------------

test("attestPipelineComment: round-trips through isVerifiedPipelineAttestation", () => {
  const body = "## Pipeline: Something\n\nsome rendered text";
  const attested = attestPipelineComment("some-kind", body);
  assert.ok(attested.endsWith(encodePipelineAttestation({ kind: "some-kind", bodyHash: hashReviewBody(body) })));
  assert.equal(isVerifiedPipelineAttestation(attested), true);
  assert.equal(isVerifiedPipelineOutput(attested), true);
});

test("isVerifiedPipelineAttestation: no marker → false", () => {
  assert.equal(isVerifiedPipelineAttestation("plain text, no marker"), false);
});

test("isVerifiedPipelineAttestation: trailing text after the marker fails verification", () => {
  const attested = attestPipelineComment("k", "body text");
  const tampered = attested + "\nOne more line appended after the marker.";
  assert.equal(isVerifiedPipelineAttestation(tampered), false);
  assert.equal(isVerifiedPipelineOutput(tampered), false);
});

test("isVerifiedPipelineAttestation: tampered body (bodyHash mismatch) fails verification", () => {
  const attested = attestPipelineComment("k", "original body");
  const tampered = attested.replace("original body", "edited body");
  assert.equal(isVerifiedPipelineAttestation(tampered), false);
});

test("extractPipelineAttestation: malformed base64url payload → null", () => {
  const body = "text\n<!-- pipeline-attest: %%%not-base64%%% -->";
  assert.equal(extractPipelineAttestation(body), null);
  assert.equal(isVerifiedPipelineAttestation(body), false);
});

test("extractPipelineAttestation: undecodable JSON payload → null", () => {
  const b64 = Buffer.from("not json").toString("base64url");
  const body = `text\n<!-- pipeline-attest: ${b64} -->`;
  assert.equal(extractPipelineAttestation(body), null);
});

test("extractPipelineAttestation: payload missing required fields → null", () => {
  const b64 = Buffer.from(JSON.stringify({ kind: "x" })).toString("base64url"); // no bodyHash
  const body = `text\n<!-- pipeline-attest: ${b64} -->`;
  assert.equal(extractPipelineAttestation(body), null);
});

test("isVerifiedPipelineAttestation: last-occurrence-wins — a forged earlier marker with a bogus hash does not defeat verification", () => {
  // A forged marker with a bogus bodyHash appears BEFORE the real content; the
  // pipeline then attests the whole thing (forged line included) as the last
  // step. Only the LAST marker is decoded/checked, and its bodyHash correctly
  // covers everything before it (including the forged line) — so this must
  // still verify true.
  const forgedLine = encodePipelineAttestation({ kind: "k", bodyHash: "deadbeef" });
  const prefixWithForgedMarker = forgedLine + "\nreal body";
  const attested = attestPipelineComment("k", prefixWithForgedMarker);
  assert.equal(isVerifiedPipelineAttestation(attested), true, "the LAST marker (the real one) is what's checked");

  // And an attacker who crafts a body ending in a forged marker whose hash
  // does NOT match the real preceding text must fail.
  const bogusButLast = "some content" + "\n" + encodePipelineAttestation({ kind: "k", bodyHash: "deadbeef" });
  assert.equal(isVerifiedPipelineAttestation(bogusButLast), false, "a last marker with a non-matching bodyHash must fail");
});

test("isVerifiedPipelineOutput: verified review-artifact form still verifies without an attestation marker", () => {
  // Sanity check that the OR composition didn't regress the existing review path.
  const verdict = { verdict: "approve" as const, summary: "ok", findings: [], next_steps: [], commitSha: "a".repeat(40) };
  const body = formatReviewComment(
    { marker_footer: "*footer*" } as unknown as PipelineConfig,
    verdict,
    1,
    "codex",
  );
  assert.equal(isVerifiedPipelineOutput(body), true);
});

// ---------------------------------------------------------------------------
// 2. #429 regression — advisoryAdvanceComment no longer self-blocks
// ---------------------------------------------------------------------------

test("#471/#429 regression: advisoryAdvanceComment is attested and does not gate the next stage boundary", () => {
  const comment = advisoryAdvanceComment(advanceCfg, 1, "codex", EMPTY_PARTITION);
  // Prove this test exercises the real trip hazard: the rendered prose really
  // does contain objection-shaped wording that would trip NEGATION_PATTERNS
  // absent verification.
  assert.match(comment, /\badvances instead of routing to a fix round\b/);
  assert.equal(isVerifiedPipelineOutput(comment), true, "advisoryAdvanceComment output must verify");

  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, comment, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.deepEqual(unacked, [], "the severity-policy advance comment must not be counted as unacknowledged human input");
});

// ---------------------------------------------------------------------------
// 3. Behavioral drift guard — every registry kind's REAL renderer verifies
//    and self-excludes from findUnacknowledgedComments (#471 review 1: the
//    guard must exercise actual engine output, not a synthetic re-attested
//    stand-in — otherwise a builder that stops calling attestPipelineComment
//    would not be caught).
// ---------------------------------------------------------------------------

const CEILING_PARTITION: PartitionResult = { blocking: [makeFinding()], advisory: [], overridden: [] };
const DELTA_CEILING_FINDINGS: DeltaCeilingFinding[] = [
  { key: "abcd1234", surface: "src/x.ts|correctness", severity: "medium", title: "test finding" },
];

// One real-renderer invocation per "pipeline-attest" kind, using minimal
// representative arguments. If a builder stops calling attestPipelineComment,
// the corresponding entry's output fails isVerifiedPipelineOutput below.
const KIND_RENDERERS: Record<string, () => string> = {
  "stage-transition": () =>
    buildTransitionComment({ fromStage: "review-1", toStage: "fix-1", harness: "claude", ts: ts(0), summary: "", runId: "run-1" }),
  blocked: () =>
    buildAttestedBlockedComment({
      issueNumber: 1,
      stageStr: "review-1",
      harness: "claude",
      ts: ts(0),
      reason: "test",
      kind: "worktree-missing",
      runId: "run-1",
    }),
  "audit-repair": () => buildAuditRepairComment("review-1", "run-1"),
  "audit-repair-blocked": () => buildAuditRepairBlockedComment("run-1"),
  "review-advance-severity": () => advisoryAdvanceComment(advanceCfg, 1, "codex", EMPTY_PARTITION),
  "review-ceiling": () => reviewCeilingComment(advanceCfg, 1, "codex", CEILING_PARTITION, 3, []),
  "review-ceiling-demotion": () => reviewCeilingDemotionComment(advanceCfg, 1, "codex", CEILING_PARTITION, 3, [], 999),
  "delta-round-ceiling": () => deltaRoundCeilingComment(advanceCfg, 4, 4, "park", DELTA_CEILING_FINDINGS),
  "delta-round-ceiling-demotion": () => deltaRoundCeilingDemotionComment(advanceCfg, 4, 4, DELTA_CEILING_FINDINGS, 999),
  "new-human-input-warning": () =>
    buildNewHumanInputWarningComment([{ author: "human1", createdAt: ts(0) }], "review-1"),
  "pipeline-complete": () => buildPipelineCompleteComment(advanceCfg, 471, "Some issue", "PR #1", 0),
  "auto-recovery": () => buildAutoRecoveryComment(advanceCfg, 0),
  "auto-recovery-limit": () => buildAutoRecoveryLimitComment(advanceCfg, 2),
  "auto-loop-continuation": () => buildAutoLoopContinuationComment(advanceCfg, 1, "review-1", "transient failure", 2, 30),
  "auto-loop-exhausted": () => buildAutoLoopExhaustedComment(advanceCfg, 3, "review-1", "blocked", "transient failure", 45),
  "evidence-bundle": () => formatEvidenceCommentBody(emptyEvidenceBundle(), "/tmp/bundle.json", "pipeline summary 471"),
  "pre-merge-rerun-identity": () => preMergeRerunIdentityNotice("codex"),
  "pre-merge-rerun-scope": () => preMergeRerunScopeNotice(2),
  "pre-merge-diff-unchanged": () => diffUnchangedNotice("a".repeat(40), "b".repeat(40)),
  "pre-merge-stale-review": () => staleReviewNotice("a".repeat(40), "b".repeat(40)),
  "finding-does-not-reproduce": () =>
    nonReproducingDispositionComment({
      key: "abcd1234",
      reviewedSha: "a".repeat(40),
      fingerprint: "b".repeat(16),
      stage: "fix-1",
      justification: "does not reproduce at this SHA",
      timestamp: ts(0),
    }),
  "needs-human-decision": () =>
    humanDecisionComment({
      category: "product-decision",
      key: "abcd1234",
      fingerprint: "b".repeat(16),
      reviewedSha: "a".repeat(40),
      request: "should we drop this API instead of enforcing it?",
      stage: "fix-1",
      timestamp: ts(0),
    }),
  unblocked: () =>
    buildUnblockedComment({ stage: "fix-2", ts: ts(0), answer: "don't retry the call — batch it instead" }),
  "finding-override": () =>
    overrideComment({
      key: "abcd1234",
      disposition: "rejected",
      reason: "revert this — wrong approach, do it instead differently",
      stage: "review-1",
      timestamp: ts(0),
    }),
  "scope-override": () =>
    scopedOverrideComment({
      scopeType: "category",
      scopeValue: "testing",
      disposition: "rejected",
      reason: "please don't flag this category — instead defer it",
      stage: "review-1",
      timestamp: ts(0),
    }),
};

// "review-artifact" kinds verify via the review-artifact record instead of the
// generic attestation marker — rendered through their own real formatters.
const REVIEW_ARTIFACT_RENDERERS: Record<string, () => string> = {
  "review-verdict": () =>
    formatReviewComment(
      advanceCfg,
      { verdict: "approve", summary: "ok", findings: [], next_steps: [], commitSha: "a".repeat(40) },
      1,
      "codex",
    ),
  "pre-merge-delta-review": () =>
    formatDeltaReviewComment(
      advanceCfg,
      { verdict: "approve", summary: "ok", findings: [], next_steps: [], commitSha: "a".repeat(40) },
      "codex",
    ),
};

test("PIPELINE_COMMENT_KINDS behavioral drift guard: every registered kind is covered by a real-renderer fixture", () => {
  for (const entry of PIPELINE_COMMENT_KINDS) {
    if (entry.verify === "exempt") {
      assert.ok(entry.reason && entry.reason.length > 0, `exempt kind "${entry.kind}" must carry a reason`);
      continue;
    }
    const renderer =
      entry.verify === "pipeline-attest" ? KIND_RENDERERS[entry.kind] : REVIEW_ARTIFACT_RENDERERS[entry.kind];
    assert.ok(renderer, `kind "${entry.kind}" (verify: ${entry.verify}) has no real-renderer fixture in this test`);
  }
});

test("PIPELINE_COMMENT_KINDS behavioral drift guard: every 'pipeline-attest'/'review-artifact' kind's real renderer verifies and self-excludes from findUnacknowledgedComments", () => {
  for (const entry of PIPELINE_COMMENT_KINDS) {
    if (entry.verify === "exempt") continue;
    const renderer =
      entry.verify === "pipeline-attest" ? KIND_RENDERERS[entry.kind] : REVIEW_ARTIFACT_RENDERERS[entry.kind];
    const body = renderer();
    assert.equal(isVerifiedPipelineOutput(body), true, `kind "${entry.kind}"'s real rendered output must verify as pipeline output`);

    const comments = [
      makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
      makeComment(TEST_ACTOR, body, ts(1)),
    ];
    const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
    const unacked = findUnacknowledgedComments(comments, trusted);
    assert.deepEqual(unacked, [], `kind "${entry.kind}" must self-exclude from findUnacknowledgedComments`);
  }
});

test("PIPELINE_COMMENT_KINDS behavioral drift guard: an unattested body of a would-be new kind still gates (proves the guard bites)", () => {
  // A comment that merely LOOKS like pipeline output (heading + no attestation)
  // but happens to carry objection language must still gate — this is the
  // exact shape of the #471 bug before the fix.
  const rendered = "## Pipeline: Some new comment type\n\nThis advances instead of routing to a fix round.";
  assert.equal(isVerifiedPipelineOutput(rendered), false);
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, rendered, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "unattested pipeline-styled body with objection wording must still gate");
});

// ---------------------------------------------------------------------------
// 4. Source drift guard — every heading literal in core/scripts/ is registered
// ---------------------------------------------------------------------------

/** Strip `//` line comments and `/* ... *\/` block comments so the source scan only
 *  sees string/template literals that are actual code, not documentation prose
 *  that happens to quote a heading. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      // Best-effort: drop a trailing `// ...` that isn't inside a string. Good
      // enough for this codebase's style (no `//` occurs inside the relevant
      // string literals below).
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function findHeadingLiterals(src: string): string[] {
  const literals: string[] = [];
  // Matches a quoted/backtick string literal that starts with "## Pipeline"
  // (covers "## Pipeline:", "## Pipeline Complete", etc.) up to the closing
  // quote, a `${`, or a literal newline escape.
  const re = /["'`](## Pipeline[^"'`\n]*?)(?:\$\{|["'`\\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    literals.push(m[1]);
  }
  return literals;
}

/**
 * A literal is covered by a registry entry when it exactly equals the
 * entry's heading, or is a strictly SHORTER fragment of it (`heading.startsWith(literal)`
 * — always safe: a short literal can't hide a distinct new comment type).
 * The reverse direction (`literal.startsWith(heading)`, a LONGER literal
 * extending a short registry heading) is only allowed when the entry is NOT
 * `exactOnly` — `exactOnly` entries (the generic `## Pipeline: ` transition
 * prefix, and the bare `## Pipeline:` classifier literal) are structurally
 * generic enough that this direction would silently absorb any future
 * `## Pipeline: <unrelated new kind>` literal (#471 review 1).
 */
function coveredByEntry(literal: string, entry: (typeof PIPELINE_COMMENT_KINDS)[number]): boolean {
  if (literal === entry.heading) return true;
  if (entry.heading.startsWith(literal)) return true;
  if (entry.exactOnly) return false;
  return literal.startsWith(entry.heading);
}

test("source drift guard: every '## Pipeline…' heading literal in core/scripts/ is represented in PIPELINE_COMMENT_KINDS", () => {
  const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  })(scriptsDir);

  const unrepresented: { file: string; literal: string }[] = [];

  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const literal of findHeadingLiterals(src)) {
      const covered = PIPELINE_COMMENT_KINDS.some((entry) => coveredByEntry(literal, entry));
      if (!covered) {
        unrepresented.push({ file: path.relative(scriptsDir, file), literal });
      }
    }
  }

  assert.deepEqual(
    unrepresented,
    [],
    `Every '## Pipeline…' heading literal must be represented in PIPELINE_COMMENT_KINDS (with a 'reason' ` +
      `for kinds deliberately left verify: "exempt"): ${JSON.stringify(unrepresented)}`,
  );
});

// ---------------------------------------------------------------------------
// 5. Negative cases — no new trust path
// ---------------------------------------------------------------------------

test("negative: attested body from a non-trusted author is still counted as unacknowledged", () => {
  const comment = advisoryAdvanceComment(advanceCfg, 1, "codex", EMPTY_PARTITION);
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment("random-third-party", comment, ts(1)),
  ];
  // Trusted set built only for TEST_ACTOR — the third party is not trusted.
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "attested body from an untrusted author must still gate");
  assert.equal(unacked[0].author, "random-third-party");
});

test("negative: attested body with human text appended after the attestation still gates", () => {
  const comment = advisoryAdvanceComment(advanceCfg, 1, "codex", EMPTY_PARTITION);
  const tampered = comment + "\n\nActually, wait — don't do this, revert instead.";
  assert.equal(isVerifiedPipelineOutput(tampered), false);
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, tampered, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "human text appended after the attestation marker must still gate");
});

test("negative: tampered bodyHash still gates (subject to the objection scan)", () => {
  const comment = advisoryAdvanceComment(advanceCfg, 1, "codex", EMPTY_PARTITION);
  const tampered = comment.replace("codex", "codex-tampered");
  assert.equal(isVerifiedPipelineOutput(tampered), false);
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, tampered, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "a body whose bodyHash no longer matches must still gate");
});

test("negative: NEGATION_PATTERNS objection-detection surface is unchanged by this feature", () => {
  // Pin the set of phrases that must still be detected as objections when
  // UNVERIFIED — this feature must not loosen the scan itself, only widen
  // which VERIFIED bodies are exempt from it.
  const mustStillGate = [
    "don't do that",
    "do not proceed",
    "please avoid this approach",
    "should not merge",
    "shouldn't ship this",
    "won't work in prod",
    "I disagree with this",
    "please revert",
    "that's the wrong approach",
    "do this instead",
  ];
  for (const phrase of mustStillGate) {
    const comments = [
      makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
      makeComment(TEST_ACTOR, `## Pipeline: Unattested styled comment\n\n${phrase}`, ts(1)),
    ];
    const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
    const unacked = findUnacknowledgedComments(comments, trusted);
    assert.equal(unacked.length, 1, `phrase "${phrase}" must still be detected as an objection when unverified`);
  }
});

// ---------------------------------------------------------------------------
// 6. Operator-surface comments (#484) — pipeline unblock / pipeline override
//    are self-acknowledging: the operator has been heard by construction, so
//    their embedded free text does not gate the run it was meant to resume.
// ---------------------------------------------------------------------------

test("#484: operator-surface set is exactly unblocked/finding-override/scope-override", () => {
  const operatorSurfaceKinds = PIPELINE_COMMENT_KINDS.filter((e) => e.operatorSurface).map((e) => e.kind).sort();
  assert.deepEqual(operatorSurfaceKinds, ["finding-override", "scope-override", "unblocked"]);
  for (const entry of PIPELINE_COMMENT_KINDS) {
    if (entry.operatorSurface) {
      assert.equal(entry.verify, "pipeline-attest", `operator-surface kind "${entry.kind}" must be verify: "pipeline-attest"`);
    }
  }
});

test("#484: unblock answer containing change-request wording does not gate the resume", () => {
  const unblocked = buildUnblockedComment({
    stage: "fix-2",
    ts: ts(0),
    answer: "don't retry the call — batch it instead",
  });
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, unblocked, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  assert.equal(findUnacknowledgedComments(comments, trusted).length, 0);
});

test("#484: override reason containing change-request wording does not gate the resume (finding-override and scope-override)", () => {
  const findingOverride = overrideComment({
    key: "abcd1234",
    disposition: "rejected",
    reason: "revert this — instead leave it as is",
    stage: "review-1",
    timestamp: ts(0),
  });
  const scopeOverride = scopedOverrideComment({
    scopeType: "file",
    scopeValue: "src/x.ts",
    disposition: "rejected",
    reason: "please don't flag this file — instead skip it",
    stage: "review-1",
    timestamp: ts(0),
  });
  for (const body of [findingOverride, scopeOverride]) {
    const comments = [
      makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
      makeComment(TEST_ACTOR, body, ts(1)),
    ];
    const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
    assert.equal(findUnacknowledgedComments(comments, trusted).length, 0);
  }
});

test("#484: operator-surface comment dismisses an earlier unacknowledged human comment", () => {
  const unblocked = buildUnblockedComment({ stage: "fix-2", ts: ts(1), answer: "batch it instead" });
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment("alice", "Please also handle Y.", ts(0)),
    makeComment(TEST_ACTOR, unblocked, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  assert.deepEqual(
    findUnacknowledgedComments(comments, trusted),
    [],
    "the earlier human comment must no longer be counted once a verified operator-surface anchor follows it",
  );
});

test("#484: a genuine third-party comment posted after the unblock still gates", () => {
  const unblocked = buildUnblockedComment({ stage: "fix-2", ts: ts(1), answer: "batch it instead" });
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, unblocked, ts(1)),
    makeComment("bob", "Wait, that's the wrong approach.", ts(2)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1);
  assert.equal(unacked[0].author, "bob");
});

test("#484: forged operator-surface heading from a non-trusted author still gates", () => {
  const unblocked = buildUnblockedComment({ stage: "fix-2", ts: ts(1), answer: "batch it instead" });
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment("random-third-party", unblocked, ts(1)),
  ];
  // Trusted set built only for TEST_ACTOR — the forger is not trusted.
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  assert.equal(isVerifiedOperatorSurfaceComment(unblocked), true, "the body itself verifies");
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "a verified operator-surface body from an untrusted author must still gate");
  assert.equal(unacked[0].author, "random-third-party");
});

test("#484: text appended after an operator-surface attestation marker breaks verification and still gates", () => {
  const unblocked = buildUnblockedComment({ stage: "fix-2", ts: ts(1), answer: "batch it instead" });
  const tampered = unblocked + "\nActually, don't do that — revert instead.";
  assert.equal(isVerifiedOperatorSurfaceComment(tampered), false);
  const comments = [
    makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
    makeComment(TEST_ACTOR, tampered, ts(1)),
  ];
  const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
  const unacked = findUnacknowledgedComments(comments, trusted);
  assert.equal(unacked.length, 1, "tampered operator-surface body must still gate");
});
