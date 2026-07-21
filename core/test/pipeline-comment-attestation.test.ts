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
//   3. A behavioral drift guard: every kind in PIPELINE_COMMENT_KINDS verifies
//      and self-excludes from findUnacknowledgedComments.
//   4. A source drift guard: every `## Pipeline…`-family heading literal in
//      core/scripts/ is represented in the registry (or a justified allowlist).
//   5. Negative cases proving the gate change added no new trust path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findUnacknowledgedComments } from "../scripts/issue-context-snapshot.ts";
import { buildTrustedOverrideComments } from "../scripts/review-policy.ts";
import { PIPELINE_COMMENT_KINDS } from "../scripts/gh.ts";
import {
  attestPipelineComment,
  encodePipelineAttestation,
  extractPipelineAttestation,
  hashReviewBody,
  isVerifiedPipelineAttestation,
  isVerifiedPipelineOutput,
} from "../scripts/stages/review-parsing.ts";
import { advisoryAdvanceComment, formatReviewComment } from "../scripts/stages/review-rendering.ts";
import type { PartitionResult } from "../scripts/review-policy.ts";
import type { PipelineConfig } from "../scripts/types.ts";

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
} as unknown as PipelineConfig;

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
// 3. Behavioral drift guard — every registry kind verifies + self-excludes
// ---------------------------------------------------------------------------

test("PIPELINE_COMMENT_KINDS behavioral drift guard: every kind attests and self-excludes from findUnacknowledgedComments", () => {
  for (const { kind } of PIPELINE_COMMENT_KINDS) {
    // Render a representative body for the kind: heading text + prose that
    // deliberately includes objection-shaped wording, so the test would fail
    // if the kind were NOT actually attested (the whole point of the guard).
    const rendered = `${kind} heading\n\nSome prose that says "instead" and "revert" and "wrong approach".`;
    const attested = attestPipelineComment(kind, rendered);
    assert.equal(isVerifiedPipelineOutput(attested), true, `kind "${kind}" must verify as pipeline output`);

    const comments = [
      makeComment(TEST_ACTOR, "## Implementation Plan\n\nDo X.", ts(0)),
      makeComment(TEST_ACTOR, attested, ts(1)),
    ];
    const trusted = buildTrustedOverrideComments(comments, TEST_ACTOR);
    const unacked = findUnacknowledgedComments(comments, trusted);
    assert.deepEqual(unacked, [], `kind "${kind}" must self-exclude from findUnacknowledgedComments`);
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

// Headings intentionally excluded from PIPELINE_COMMENT_KINDS, with justification.
// Each entry is a literal (or literal prefix) expected to appear in source.
const SOURCE_GUARD_ALLOWLIST: readonly { literal: string; reason: string }[] = [
  {
    literal: "## Pipeline: Finding override",
    reason:
      "Posted by the human operator directly via the `--override` CLI workflow (audited disposition), " +
      "not constructed/posted anywhere in core/scripts/ — not an engine-posted comment.",
  },
  {
    literal: "## Pipeline: Scope override",
    reason:
      "Posted by the human operator directly via the `--override`/scope-override workflow, " +
      "not constructed/posted anywhere in core/scripts/ — not an engine-posted comment.",
  },
  {
    literal: "## Pipeline: Finding does not reproduce",
    reason:
      "Machine-authored by the fix harness, but already trust-gated via its own SHA/fingerprint-anchored " +
      "`pipeline-non-reproducing` sentinel with a documented last-non-empty-line security invariant " +
      "(extractNonReproducingDispositions). Attesting it would require touching that invariant's ordering; " +
      "out of #471's audited scope — tracked as a follow-up.",
  },
  {
    literal: "## Pipeline: Unblocked",
    reason:
      "Embeds the human operator's verbatim --unblock answer text inline. Attesting the whole body would " +
      "immunize genuine embedded human objection language from the NEGATION_PATTERNS scan — the exact " +
      "forgery/bypass hole #390 and #471 close. Deliberately left unattested so embedded objection wording " +
      "still gates via the existing no-negation-language branch.",
  },
  {
    literal: "## Pre-Planning Context",
    reason:
      "Wraps untrusted human comment excerpts (buildContextSnapshot output) inline, posted BEFORE the plan " +
      "anchor so it is never in findUnacknowledgedComments' scan window. Attesting the wrapper would " +
      "immunize the embedded human excerpts it carries, same rationale as '## Pipeline: Unblocked'.",
  },
];

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

test("source drift guard: every '## Pipeline…' heading literal in core/scripts/ is in PIPELINE_COMMENT_KINDS or the justified allowlist", () => {
  const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  })(scriptsDir);

  const registryHeadings = PIPELINE_COMMENT_KINDS.map((k) => k.heading);
  const allowlistLiterals = SOURCE_GUARD_ALLOWLIST.map((a) => a.literal);
  const unrepresented: { file: string; literal: string }[] = [];

  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const literal of findHeadingLiterals(src)) {
      const covered =
        registryHeadings.some((h) => literal.startsWith(h) || h.startsWith(literal)) ||
        allowlistLiterals.some((a) => literal.startsWith(a) || a.startsWith(literal));
      if (!covered) {
        unrepresented.push({ file: path.relative(scriptsDir, file), literal });
      }
    }
  }

  assert.deepEqual(
    unrepresented,
    [],
    `Every '## Pipeline…' heading literal must be represented in PIPELINE_COMMENT_KINDS or ` +
      `SOURCE_GUARD_ALLOWLIST (with justification): ${JSON.stringify(unrepresented)}`,
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
