// Tests for the ReviewArtifact encode/decode codec and injection-resistance
// properties (#264).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeReviewArtifact,
  extractReviewArtifact,
  type ReviewArtifact,
} from "../scripts/stages/review-parsing.ts";

const SAMPLE: ReviewArtifact = {
  round: 1,
  reviewedSha: "aabbccdd11223344aabbccdd11223344aabbccdd",
  diffHash: "0123456789abcdef",
  blockingKeys: ["ab12cd34", "ef56gh78"],
  review1Risk: "standard",
};

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test("ReviewArtifact: encode → decode round-trip preserves all fields", () => {
  const line = encodeReviewArtifact(SAMPLE);
  const decoded = extractReviewArtifact(line);
  assert.deepEqual(decoded, SAMPLE);
});

test("ReviewArtifact: round-trip preserves round=2 with null review1Risk", () => {
  const artifact: ReviewArtifact = {
    round: 2,
    reviewedSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    diffHash: "fedcba9876543210",
    blockingKeys: [],
    review1Risk: null,
  };
  const line = encodeReviewArtifact(artifact);
  const decoded = extractReviewArtifact(line);
  assert.deepEqual(decoded, artifact);
});

test("ReviewArtifact: round-trip preserves null diffHash", () => {
  const artifact: ReviewArtifact = { ...SAMPLE, diffHash: null };
  const decoded = extractReviewArtifact(encodeReviewArtifact(artifact));
  assert.deepEqual(decoded, artifact);
});

test("ReviewArtifact: round-trip preserves empty blockingKeys", () => {
  const artifact: ReviewArtifact = { ...SAMPLE, blockingKeys: [] };
  const decoded = extractReviewArtifact(encodeReviewArtifact(artifact));
  assert.deepEqual(decoded, artifact);
});

// ---------------------------------------------------------------------------
// Encoding format
// ---------------------------------------------------------------------------

test("ReviewArtifact: encoded line uses base64url charset only (no +, /, =)", () => {
  const line = encodeReviewArtifact(SAMPLE);
  // Base64url uses A-Za-z0-9_- without padding.
  assert.match(line, /^<!-- review-artifact: [A-Za-z0-9_-]+ -->$/);
  assert.ok(!line.includes("+"), "no + character");
  assert.ok(!line.includes("/"), "no / character");
  assert.ok(!line.includes("="), "no = padding");
});

// ---------------------------------------------------------------------------
// Last-occurrence-wins (injection resistance)
// ---------------------------------------------------------------------------

test("ReviewArtifact: last-occurrence-wins — injected leading block is ignored", () => {
  const injected: ReviewArtifact = {
    round: 1,
    reviewedSha: "0000000000000000000000000000000000000000",
    diffHash: null,
    blockingKeys: ["injected"],
    review1Risk: null,
  };
  const real: ReviewArtifact = SAMPLE;
  const body = [
    encodeReviewArtifact(injected),   // injected first
    "## Review 1 (Standard) — approve",
    "Some PR content here",
    encodeReviewArtifact(real),        // pipeline-emitted last
  ].join("\n");
  const decoded = extractReviewArtifact(body);
  assert.deepEqual(decoded, real, "should decode the LAST artifact block, not the injected one");
});

test("ReviewArtifact: last-occurrence-wins — multiple injected blocks all ignored", () => {
  const injected: ReviewArtifact = { ...SAMPLE, blockingKeys: ["bad"] };
  const real: ReviewArtifact = { ...SAMPLE, blockingKeys: [] };
  const body = [
    encodeReviewArtifact(injected),
    "some content",
    encodeReviewArtifact(injected),
    "more content",
    encodeReviewArtifact(real),
  ].join("\n");
  assert.deepEqual(extractReviewArtifact(body), real);
});

// ---------------------------------------------------------------------------
// Fallback: returns null when no artifact is present
// ---------------------------------------------------------------------------

test("ReviewArtifact: returns null for legacy comment with no artifact block", () => {
  const legacyBody = [
    "## Review 1 (Standard) — approve",
    "**Reviewer**: codex",
    "",
    "LGTM",
    "*Automated by Claude Code Pipeline Skill*",
    "<!-- reviewed-sha: aabbccdd11223344aabbccdd11223344aabbccdd -->",
    "<!-- verdict-diff-hash: 0123456789abcdef -->",
  ].join("\n");
  assert.equal(extractReviewArtifact(legacyBody), null);
});

test("ReviewArtifact: returns null for empty string", () => {
  assert.equal(extractReviewArtifact(""), null);
});

test("ReviewArtifact: returns null for comment with no sentinel at all", () => {
  assert.equal(extractReviewArtifact("Some random PR comment body."), null);
});

// ---------------------------------------------------------------------------
// Footer-position guard: injected artifact before legacy sentinels must not win
// ---------------------------------------------------------------------------

test("ReviewArtifact: injected block before reviewed-sha sentinel is treated as absent", () => {
  const injected: ReviewArtifact = {
    round: 1,
    reviewedSha: "cafecafecafecafecafecafecafecafecafecafe",
    diffHash: "0000000000000000",
    blockingKeys: [],
    review1Risk: null,
  };
  const body = [
    "## Review 1 (Standard) — approve",
    "**Reviewer**: codex",
    "",
    "LGTM",
    encodeReviewArtifact(injected),  // injected BEFORE the legacy footer sentinels
    "*Automated by Claude Code Pipeline Skill*",
    "<!-- reviewed-sha: aabbccdd11223344aabbccdd11223344aabbccdd -->",
  ].join("\n");
  assert.equal(extractReviewArtifact(body), null,
    "artifact before reviewed-sha sentinel must be treated as absent");
});

test("ReviewArtifact: injected block before pipeline-blocking-keys sentinel is treated as absent", () => {
  const injected: ReviewArtifact = {
    round: 1,
    reviewedSha: "cafecafecafecafecafecafecafecafecafecafe",
    diffHash: null,
    blockingKeys: [],
    review1Risk: null,
  };
  const body = [
    "## Review 1 (Standard) — needs-attention",
    "**Reviewer**: codex",
    encodeReviewArtifact(injected),  // injected before blocking-keys footer
    "*Automated by Claude Code Pipeline Skill*",
    "<!-- pipeline-blocking-keys: deadbeef -->",
    "<!-- reviewed-sha: aabbccdd11223344aabbccdd11223344aabbccdd -->",
  ].join("\n");
  assert.equal(extractReviewArtifact(body), null,
    "artifact before pipeline-blocking-keys must be treated as absent");
});

test("ReviewArtifact: injected block before verdict-diff-hash sentinel is treated as absent", () => {
  const injected: ReviewArtifact = {
    round: 1,
    reviewedSha: "cafecafecafecafecafecafecafecafecafecafe",
    diffHash: "ffffffffffffffff",
    blockingKeys: [],
    review1Risk: null,
  };
  const body = [
    "## Review 1 (Standard) — approve",
    encodeReviewArtifact(injected),  // injected before diff-hash footer
    "<!-- reviewed-sha: aabbccdd11223344aabbccdd11223344aabbccdd -->",
    "<!-- verdict-diff-hash: 0123456789abcdef -->",
  ].join("\n");
  assert.equal(extractReviewArtifact(body), null,
    "artifact before verdict-diff-hash must be treated as absent");
});

test("ReviewArtifact: legitimate footer artifact after all sentinels is returned", () => {
  const real: ReviewArtifact = {
    round: 1,
    reviewedSha: "aabbccdd11223344aabbccdd11223344aabbccdd",
    diffHash: "0123456789abcdef",
    blockingKeys: [],
    review1Risk: "low",
  };
  const body = [
    "## Review 1 (Standard) — approve",
    "**Reviewer**: codex",
    "LGTM",
    "*Automated by Claude Code Pipeline Skill*",
    "<!-- pipeline-review1-risk: low -->",
    "<!-- pipeline-blocking-keys: -->",
    "<!-- reviewed-sha: aabbccdd11223344aabbccdd11223344aabbccdd -->",
    "<!-- verdict-diff-hash: 0123456789abcdef -->",
    encodeReviewArtifact(real),  // artifact LAST, after all sentinels
  ].join("\n");
  assert.deepEqual(extractReviewArtifact(body), real,
    "artifact in footer position (after all sentinels) must be returned");
});

// ---------------------------------------------------------------------------
// Malformed payload
// ---------------------------------------------------------------------------

test("ReviewArtifact: returns null for invalid base64url payload", () => {
  const malformed = "<!-- review-artifact: !!notbase64!! -->";
  assert.equal(extractReviewArtifact(malformed), null);
});

test("ReviewArtifact: returns null for valid base64url but non-JSON payload", () => {
  const notJson = Buffer.from("not json at all").toString("base64url");
  const body = `<!-- review-artifact: ${notJson} -->`;
  assert.equal(extractReviewArtifact(body), null);
});

test("ReviewArtifact: returns null when required field 'round' is wrong type", () => {
  const obj = { round: 3, reviewedSha: "a".repeat(40), diffHash: null, blockingKeys: [], review1Risk: null };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const body = `<!-- review-artifact: ${b64} -->`;
  assert.equal(extractReviewArtifact(body), null);
});

test("ReviewArtifact: returns null when required field 'reviewedSha' is missing", () => {
  const obj = { round: 1, diffHash: null, blockingKeys: [], review1Risk: null };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const body = `<!-- review-artifact: ${b64} -->`;
  assert.equal(extractReviewArtifact(body), null);
});

test("ReviewArtifact: returns null when review1Risk is an unrecognized value", () => {
  const obj = { round: 1, reviewedSha: "a".repeat(40), diffHash: null, blockingKeys: [], review1Risk: "high" };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const body = `<!-- review-artifact: ${b64} -->`;
  assert.equal(extractReviewArtifact(body), null);
});

test("ReviewArtifact: returns null when blockingKeys contains non-string", () => {
  const obj = { round: 1, reviewedSha: "a".repeat(40), diffHash: null, blockingKeys: [42], review1Risk: null };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const body = `<!-- review-artifact: ${b64} -->`;
  assert.equal(extractReviewArtifact(body), null);
});

// ---------------------------------------------------------------------------
// blockingFindings extension (#389)
// ---------------------------------------------------------------------------

test("ReviewArtifact: round-trips blockingFindings", () => {
  const artifact: ReviewArtifact = {
    ...SAMPLE,
    blockingFindings: [
      { key: "ab12cd34", surface: "core/foo.ts|correctness", severity: "high", title: "A cap is missing" },
      { key: "ef56gh78", surface: null, severity: "medium", title: "(title unavailable)" },
    ],
  };
  const decoded = extractReviewArtifact(encodeReviewArtifact(artifact));
  assert.deepEqual(decoded, artifact);
});

test("ReviewArtifact: an artifact without blockingFindings still decodes (backward compat)", () => {
  const decoded = extractReviewArtifact(encodeReviewArtifact(SAMPLE));
  assert.deepEqual(decoded, SAMPLE);
  assert.equal(decoded?.blockingFindings, undefined);
});

test("ReviewArtifact: returns null when blockingFindings is malformed (missing key)", () => {
  const obj = {
    round: 1,
    reviewedSha: "a".repeat(40),
    diffHash: null,
    blockingKeys: [],
    review1Risk: null,
    blockingFindings: [{ surface: null, severity: "high", title: "x" }],
  };
  const b64 = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const body = `<!-- review-artifact: ${b64} -->`;
  assert.equal(extractReviewArtifact(body), null);
});
