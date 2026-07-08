// Parsing utilities, sentinel extractors, and ReviewArtifact codec for review comments.
// All functions here are pure over string/comment-array inputs — no network or subprocess calls.

import { createHash } from "node:crypto";
import { findLatestCommentMatching } from "../gh.ts";
import type { Review1Risk } from "../review-policy.ts";
import type { ReviewFinding, ReviewVerdict } from "../types.ts";

// ---------------------------------------------------------------------------
// Marker constants (shared across review-parsing, review-rendering, review-routing)
// ---------------------------------------------------------------------------

export const REVIEW_MARKER_PREFIX_R1 = "## Review 1";
export const REVIEW_MARKER_PREFIX_R2 = "## Review 2";
// Distinct heading for pre-merge delta reviews (#228 fix-2). Must NOT start with
// "## Review 1" or "## Review 2" so delta comments are excluded from ceiling/recurrence
// accounting while still carrying the SHA and diff-hash sentinels.
export const DELTA_REVIEW_MARKER_PREFIX = "## Pre-merge Delta Review";
// Controlled heading prefix that every pipeline-authored demotion comment starts with.
// Used to restrict follow-up marker extraction to trusted comments only.
export const CEILING_DEMOTION_HEADING = "## Pipeline: Review ceiling — findings demoted and deferred";

// ---------------------------------------------------------------------------
// Regex constants
// ---------------------------------------------------------------------------

// Machine-readable SHA sentinel (#16). Anchored full-line + global flag so
// extractReviewedSha picks the LAST occurrence, guarding against injected content.
const REVIEWED_SHA_RE = /^<!-- reviewed-sha: ([0-9a-fA-F]{40}) -->$/gm;
// Machine-readable blocking-keys marker (#133). Anchored full-line + global flag;
// last-occurrence guards against injected marker content.
const PIPELINE_BLOCKING_KEYS_RE = /^<!-- pipeline-blocking-keys: ([0-9a-f,]*) -->$/gm;
// Machine-readable diff-hash sentinel (#228). Anchored full-line + global flag.
const VERDICT_DIFF_HASH_RE = /^<!-- verdict-diff-hash: ([0-9a-f]{16}) -->$/gm;
// Machine-readable review-1 risk tier sentinel (#232). Anchored full-line + global flag.
const REVIEW1_RISK_RE = /^<!-- pipeline-review1-risk: (low|standard) -->$/gm;
// ReviewArtifact structured JSON block sentinel (#264). Base64url charset [A-Za-z0-9_-].
// Anchored full-line + global flag; last-occurrence guards against injection.
const REVIEW_ARTIFACT_RE = /^<!-- review-artifact: ([A-Za-z0-9_-]+) -->$/gm;
// Follow-up issue marker for the demote-and-advance ceiling path (#233).
export const CEILING_FOLLOWUP_LINE_RE = /^<!-- pipeline-ceiling-followup: #(\d+) -->$/;

// ---------------------------------------------------------------------------
// ReviewArtifact — structured representation of per-comment review state (#264)
// ---------------------------------------------------------------------------

/**
 * Typed JSON struct that holds every machine-readable field a review comment
 * currently writes as individual HTML-comment sentinels. Embedded as a single
 * hidden `<!-- review-artifact: <base64url(JSON)> -->` block at the end of every
 * review/delta comment, after the individual sentinels (for backward compat).
 */
export interface ReviewArtifact {
  /** Review round (1 or 2). Delta reviews use round 2. */
  round: 1 | 2;
  /** Full 40-character HEAD commit SHA evaluated in this review. */
  reviewedSha: string;
  /** 16-char hex SHA-256 prefix of the reviewed PR diff, or null when unavailable. */
  diffHash: string | null;
  /** Sorted deduplicated blocking finding keys from the blocking partition. */
  blockingKeys: string[];
  /** Review-1 risk tier, set on round-1 comments; null for round-2 and delta. */
  review1Risk: "low" | "standard" | null;
  /**
   * SHA-256 hex digest of the rendered comment body preceding this artifact
   * line (#390 review 1). Optional for backward compat with artifacts encoded
   * before this field existed. Lets `isVerifiedPipelineReviewOutput` prove the
   * text before the artifact is exactly the pipeline-generated body, not just
   * that a trailing artifact can be decoded.
   */
  bodyHash?: string;
}

/**
 * Encode a ReviewArtifact as a hidden HTML-comment sentinel line.
 * Uses base64url encoding (no padding) for safe embedding in Markdown.
 */
export function encodeReviewArtifact(artifact: ReviewArtifact): string {
  const json = JSON.stringify(artifact);
  const b64 = Buffer.from(json).toString("base64url");
  return `<!-- review-artifact: ${b64} -->`;
}

/** SHA-256 hex digest of `text`, used for the artifact's `bodyHash` field. */
export function hashReviewBody(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** True when `re` has at least one match starting after `pos` in `body`. */
function hasMatchAfterPos(re: RegExp, body: string, pos: number): boolean {
  re.lastIndex = 0;
  let cur: RegExpExecArray | null;
  let found = false;
  while ((cur = re.exec(body)) !== null) {
    if (cur.index > pos) { found = true; break; }
  }
  re.lastIndex = 0;
  return found;
}

/**
 * Decode the ReviewArtifact from a comment body. Uses last-occurrence-wins
 * semantics so an adversarially crafted artifact block appearing before the
 * pipeline-emitted footer cannot override the real one. Returns null when no
 * artifact block is present or when the payload is malformed.
 *
 * Footer-position guard: if any legacy sentinel (reviewed-sha, blocking-keys,
 * verdict-diff-hash) appears AFTER the last artifact match, the artifact is
 * not in the pipeline footer position — likely injected before the footer in a
 * legacy comment — so we return null and let legacy sentinel fallback win.
 */
export function extractReviewArtifact(body: string): ReviewArtifact | null {
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEW_ARTIFACT_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  if (lastMatch === null) return null;

  // If any legacy sentinel appears after the artifact line, the artifact is
  // injected before the footer — not a legitimate pipeline footer artifact.
  if (
    hasMatchAfterPos(REVIEWED_SHA_RE, body, lastMatch.index) ||
    hasMatchAfterPos(PIPELINE_BLOCKING_KEYS_RE, body, lastMatch.index) ||
    hasMatchAfterPos(VERDICT_DIFF_HASH_RE, body, lastMatch.index)
  ) {
    return null;
  }
  try {
    const json = Buffer.from(lastMatch[1], "base64url").toString("utf8");
    const obj = JSON.parse(json);
    if (
      typeof obj !== "object" ||
      obj === null ||
      (obj.round !== 1 && obj.round !== 2) ||
      typeof obj.reviewedSha !== "string" ||
      (obj.diffHash !== null && typeof obj.diffHash !== "string") ||
      !Array.isArray(obj.blockingKeys) ||
      !obj.blockingKeys.every((k: unknown) => typeof k === "string") ||
      (obj.review1Risk !== null && obj.review1Risk !== "low" && obj.review1Risk !== "standard") ||
      (obj.bodyHash !== undefined && typeof obj.bodyHash !== "string")
    ) {
      return null;
    }
    const artifact: ReviewArtifact = {
      round: obj.round as 1 | 2,
      reviewedSha: obj.reviewedSha as string,
      diffHash: obj.diffHash as string | null,
      blockingKeys: obj.blockingKeys as string[],
      review1Risk: obj.review1Risk as "low" | "standard" | null,
    };
    if (typeof obj.bodyHash === "string") artifact.bodyHash = obj.bodyHash;
    return artifact;
  } catch {
    return null;
  }
}

/**
 * True when `body` is verified, untampered pipeline-generated review output
 * (#390 review 1): it decodes a valid `ReviewArtifact` (already guarded by
 * `extractReviewArtifact` against sentinels injected before it), nothing
 * follows the artifact line, AND the artifact's `bodyHash` matches a fresh
 * hash of the text preceding the artifact line (#390 review 1 finding
 * 1f4cb8cf). The trailing-content check alone only proves an artifact can be
 * decoded — it does not prove the body before it is the generated review
 * text, so a trusted actor could otherwise insert objection text before a
 * copied artifact line and still pass. Binding to `bodyHash` closes that gap:
 * `formatReviewComment`/`formatDeltaReviewComment` hash the exact rendered
 * prefix into the artifact, so any edit to that prefix — inserted before or
 * within it — changes the hash and fails verification, falling back to
 * scope-language detection. Comments without a `bodyHash` (encoded before
 * this field existed) are conservatively treated as unverified.
 */
export function isVerifiedPipelineReviewOutput(body: string): boolean {
  const artifact = extractReviewArtifact(body);
  if (artifact === null) return false;
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEW_ARTIFACT_RE.exec(body)) !== null) lastMatch = cur;
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  if (lastMatch === null) return false;
  if (body.slice(lastMatch.index + lastMatch[0].length).trim() !== "") return false;
  const rawPrefix = body.slice(0, lastMatch.index);
  const prefix = rawPrefix.endsWith("\n") ? rawPrefix.slice(0, -1) : rawPrefix;
  if (typeof artifact.bodyHash !== "string") return false;
  return hashReviewBody(prefix) === artifact.bodyHash;
}

/**
 * The bodyHash field's rollout boundary (#390 delta, key 06e32d8d): review
 * comments CREATED at or after this instant must carry a verifying bodyHash —
 * the pipeline has emitted it since this change shipped, so its absence on a
 * newer comment means tampering (e.g. stripping the field to make a comment
 * "look legacy"), never age. Comments created before it can never carry the
 * field and are eligible for the structural legacy check below.
 */
export const BODY_HASH_ROLLOUT_ISO = "2026-07-09T00:00:00Z";

/**
 * Legacy verification for review comments that provably predate the bodyHash
 * rollout (#390 delta, keys e0b0c22e + 06e32d8d). `createdAtIso` is GitHub's
 * server-assigned comment timestamp — an author cannot backdate it — so the
 * time anchor closes the strip-the-bodyHash bypass a format-only fallback
 * allowed: a post-rollout comment without a bodyHash NEVER verifies here.
 * For genuinely historical comments the check is structural: the artifact
 * decodes with no bodyHash, nothing follows the artifact line, and the body
 * is review output from its FIRST line (prepended objections break the
 * anchor and gate). Residual gap, confined to pre-rollout history only: text
 * inserted between a historical heading and its artifact is undetectable
 * without a hash.
 */
export function isLegacyVerifiedPipelineReviewOutput(body: string, createdAtIso: string): boolean {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created) || created >= Date.parse(BODY_HASH_ROLLOUT_ISO)) return false;
  const artifact = extractReviewArtifact(body);
  if (artifact === null || typeof artifact.bodyHash === "string") return false;
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEW_ARTIFACT_RE.exec(body)) !== null) lastMatch = cur;
  REVIEW_ARTIFACT_RE.lastIndex = 0;
  if (lastMatch === null) return false;
  if (body.slice(lastMatch.index + lastMatch[0].length).trim() !== "") return false;
  return LEGACY_REVIEW_OUTPUT_HEADING_RE.test(body.trimStart());
}

// Review artifacts are only emitted on review-verdict comments (`## Review N`
// by formatReviewComment, `## Pre-merge Delta Review` by
// formatDeltaReviewComment) — the legacy acceptance path anchors on exactly
// those headings (#390 delta, key e0b0c22e).
const LEGACY_REVIEW_OUTPUT_HEADING_RE = /^## (?:Review \d+\b|Pre-merge Delta Review\b)/;

// ---------------------------------------------------------------------------
// computeDiffHash
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the raw diff string, truncated to 16 hex characters. Used as the
 * `verdict-diff-hash` sentinel value to detect whether the PR diff has changed
 * since the last recorded verdict (#228).
 */
export function computeDiffHash(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Individual sentinel extractors (legacy fallback paths — kept for backward compat)
// ---------------------------------------------------------------------------

/**
 * Extract the `verdict-diff-hash` sentinel from a review comment body (#228).
 * Last-occurrence-wins (guards against spoofed sentinels before the footer).
 * Returns null when absent or structurally malformed. This extractor is the
 * LEGACY FALLBACK path; the primary path is `extractReviewArtifact(body)?.diffHash`.
 */
export function extractDiffHashFromComment(body: string): string | null {
  VERDICT_DIFF_HASH_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = VERDICT_DIFF_HASH_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  VERDICT_DIFF_HASH_RE.lastIndex = 0;
  return lastMatch?.[1] ?? null;
}

/**
 * Marker-only variant of {@link extractBlockingKeysFromComment}: returns the keys
 * from the authoritative `pipeline-blocking-keys` marker, or `null` when the
 * comment carries NO marker at all. Unlike {@link extractBlockingKeysFromComment}
 * it never falls back to scraping all `override-key` tokens. This extractor is
 * the LEGACY FALLBACK path; the primary path is `extractReviewArtifact(body)?.blockingKeys`.
 */
export function extractBlockingKeysMarker(body: string): Set<string> | null {
  PIPELINE_BLOCKING_KEYS_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = PIPELINE_BLOCKING_KEYS_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  PIPELINE_BLOCKING_KEYS_RE.lastIndex = 0;
  if (lastMatch === null) return null;
  const keys = new Set<string>();
  for (const k of lastMatch[1].split(",")) {
    if (/^[0-9a-f]{8}$/.test(k)) keys.add(k);
  }
  return keys;
}

/**
 * Collect the BLOCKING finding keys from a review verdict comment for the
 * recurrence early-park check (#133). Prefers the `pipeline-blocking-keys`
 * machine-readable marker; falls back to all `override-key` tokens only for
 * legacy comments without the marker. Two hardening properties: anchored
 * full-line regex + last-occurrence selection. Empty marker is authoritative.
 */
export function extractBlockingKeysFromComment(body: string): Set<string> {
  const marker = extractBlockingKeysMarker(body);
  if (marker !== null) return marker;
  return extractAllKeysFromComment(body);
}

/**
 * Extract the review-1 risk tier from issue comments (#232). Reads the last
 * `<!-- pipeline-review1-risk: low|standard -->` sentinel from trusted
 * pipeline-authored Review 1 comments only. Prefers `artifact.review1Risk`
 * when an artifact is present on the matched comment. Defaults to `"standard"`
 * when absent, unrecognized, or `actor` is null — conservative fail-closed.
 *
 * When `currentArtifact` is supplied the recovered tier is validated against the
 * current PR: prefers `verdict-diff-hash` (content-based); falls back to
 * `reviewed-sha`. A mismatch on either means the sentinel is stale → "standard".
 */
export function extractReview1Risk(
  comments: { author: string; body: string }[],
  actor: string | null,
  footer: string,
  currentArtifact?: { diffHash: string; sha: string },
): Review1Risk {
  if (actor === null) return "standard";
  let lastRisk: Review1Risk | null = null;
  let lastRiskBody: string | null = null;
  for (const c of comments) {
    if (!c.body.startsWith(REVIEW_MARKER_PREFIX_R1)) continue;
    if (c.author !== actor) continue;
    if (!c.body.includes(footer)) continue;
    // Primary: check artifact for risk tier.
    const artifact = extractReviewArtifact(c.body);
    if (artifact !== null && artifact.review1Risk !== null) {
      lastRisk = artifact.review1Risk;
      lastRiskBody = c.body;
      continue;
    }
    // Fallback: legacy sentinel.
    REVIEW1_RISK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found: Review1Risk | null = null;
    while ((m = REVIEW1_RISK_RE.exec(c.body)) !== null) {
      found = m[1] as Review1Risk;
    }
    REVIEW1_RISK_RE.lastIndex = 0;
    if (found !== null) {
      lastRisk = found;
      lastRiskBody = c.body;
    }
  }
  if (lastRisk === null || lastRiskBody === null) return "standard";
  // Staleness check: the recovered risk must describe the artifact review-2 is
  // currently evaluating. Primary: content-based diff-hash; fallback: SHA.
  if (currentArtifact !== undefined) {
    const commentArtifact = extractReviewArtifact(lastRiskBody);
    if (commentArtifact !== null && commentArtifact.diffHash !== null) {
      if (commentArtifact.diffHash !== currentArtifact.diffHash) return "standard";
    } else {
      const commentDiffHash = extractDiffHashFromComment(lastRiskBody);
      if (commentDiffHash !== null) {
        if (commentDiffHash !== currentArtifact.diffHash) return "standard";
      } else {
        REVIEWED_SHA_RE.lastIndex = 0;
        let shaCur: RegExpExecArray | null;
        let lastSha: string | null = null;
        while ((shaCur = REVIEWED_SHA_RE.exec(lastRiskBody)) !== null) {
          lastSha = shaCur[1];
        }
        REVIEWED_SHA_RE.lastIndex = 0;
        if (lastSha !== currentArtifact.sha) return "standard";
      }
    }
  }
  return lastRisk;
}

/**
 * Read the commit a prior review verdict evaluated (#16) from the most recent
 * review comment. Prefers `artifact.reviewedSha` when an artifact is present;
 * falls back to the `<!-- reviewed-sha: ... -->` sentinel for legacy comments.
 *
 * With `round`, only that round's comments are considered; without it, the
 * latest review comment of either round is used and its round reported.
 * Returns `null` when no review comment exists at all. Returns `{ sha: null }`
 * when a review comment exists but carries no SHA (unverifiable legacy comment).
 */
export function extractReviewedSha(
  comments: { body: string }[],
  round?: 1 | 2,
): { sha: string | null; round: 1 | 2 } | null {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => reviewRoundOf(b, round) !== null || (round !== 1 && isDeltaReviewComment(b)),
  );
  if (!m) return null;
  // Primary: prefer artifact SHA.
  const artifact = extractReviewArtifact(m.body);
  if (artifact !== null) {
    return {
      sha: artifact.reviewedSha,
      round: reviewRoundOf(m.body, round) ?? 2,
    };
  }
  // Fallback: legacy sentinel (last-occurrence-wins).
  REVIEWED_SHA_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEWED_SHA_RE.exec(m.body)) !== null) {
    lastMatch = cur;
  }
  REVIEWED_SHA_RE.lastIndex = 0;
  return {
    sha: lastMatch?.[1] ?? null,
    round: reviewRoundOf(m.body, round) ?? 2,
  };
}

// ---------------------------------------------------------------------------
// Comment body helpers
// ---------------------------------------------------------------------------

function isDeltaReviewComment(body: string): boolean {
  return body.startsWith(DELTA_REVIEW_MARKER_PREFIX);
}

/** Which review round a comment body belongs to, or null if it isn't one. */
export function reviewRoundOf(body: string, only?: 1 | 2): 1 | 2 | null {
  const isR1 = body.startsWith(REVIEW_MARKER_PREFIX_R1);
  const isR2 = body.startsWith(REVIEW_MARKER_PREFIX_R2);
  if (only === 1) return isR1 ? 1 : null;
  if (only === 2) return isR2 ? 2 : null;
  if (isR2) return 2;
  if (isR1) return 1;
  return null;
}

/**
 * Return the body of the most recent review comment for the given round, or
 * null when none exists. Used by the pre-merge SHA gate to check the cached
 * diff-hash sentinel without duplicating the prefix constants (#228).
 */
export function findLatestReviewCommentBody(
  comments: { body: string }[],
  round: 1 | 2,
): string | null {
  const prefix = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(prefix) || (round === 2 && isDeltaReviewComment(b)),
  );
  return m?.body ?? null;
}

/**
 * Extract the verdict string from the heading of a review comment produced by
 * `formatReviewComment`. Returns null when the heading is absent or malformed.
 * Used by the diff-hash cache path to reproduce routing without re-invoking the reviewer.
 */
export function extractVerdictFromComment(body: string): "approve" | "needs-attention" | null {
  const m = body.match(/^## Review \d+ \([^)]+\) — (approve|needs-attention)/m);
  if (!m) return null;
  return m[1] as "approve" | "needs-attention";
}

/**
 * Collect every content-addressed finding key a review comment carries by
 * scanning all `` `override-key: <8-hex>` `` tokens. Includes advisory findings
 * as well as blocking ones — used for RECURRING/NEW punch-list tagging.
 */
export function extractAllKeysFromComment(body: string): Set<string> {
  const keys = new Set<string>();
  const re = /`override-key: ([0-9a-f]{8})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) keys.add(m[1]);
  return keys;
}

/** How many prior `## Review {round}` verdict comments already exist. */
export function countPriorRounds(comments: { body: string }[], round: 1 | 2): number {
  const prefix = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;
  return comments.filter((c) => c.body.startsWith(prefix)).length;
}

/**
 * Scan issue comments for an existing `<!-- pipeline-ceiling-followup: #N -->`
 * marker, returning the recorded follow-up issue number or null when absent.
 * Only reads markers from pipeline-authored demotion comments. Last-occurrence-wins.
 */
export function extractCeilingFollowupNumber(
  comments: { author: string; body: string }[],
  actor: string | null,
): number | null {
  let last: number | null = null;
  for (const c of comments) {
    if (actor === null || c.author !== actor) continue;
    if (!c.body.startsWith(CEILING_DEMOTION_HEADING)) continue;
    const lastLine =
      c.body
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .at(-1) ?? "";
    const m = CEILING_FOLLOWUP_LINE_RE.exec(lastLine);
    if (m) last = Number(m[1]);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Recurrence tag helpers
// ---------------------------------------------------------------------------

const PUNCHLIST_TAG_RE = /^\*\*(?:NEW|RECURRING \(\d+ rounds?\))\*\*\s+/;
const PUNCHLIST_KEY_RE = /`([0-9a-f]{8})`/;

/**
 * The punch-list tag for a finding key (#133): `RECURRING (n rounds)` where `n`
 * counts the prior same-round verdict comments that carried the key, or `NEW`.
 */
export function recurrenceTag(key: string | undefined, priorKeySets: Set<string>[]): string {
  const n = key === undefined ? 0 : priorKeySets.filter((s) => s.has(key)).length;
  return n > 0 ? `RECURRING (${n} rounds)` : "NEW";
}

/**
 * Re-derive the RECURRING/NEW tag for each punch-list finding line when the
 * ceiling comment is read back (`--status` needs-human surface, #133).
 */
export function tagCeilingFindingLines(
  findingLines: string[],
  comments: { body: string }[],
  ceilingIdx: number,
): string[] {
  let triggerIdx = -1;
  for (let i = ceilingIdx - 1; i >= 0; i--) {
    if (reviewRoundOf(comments[i].body) !== null) {
      triggerIdx = i;
      break;
    }
  }
  const priorKeySets: Set<string>[] = [];
  if (triggerIdx !== -1) {
    const triggerRound = reviewRoundOf(comments[triggerIdx].body);
    for (let i = 0; i < triggerIdx; i++) {
      if (reviewRoundOf(comments[i].body) === triggerRound) {
        priorKeySets.push(extractAllKeysFromComment(comments[i].body));
      }
    }
  }
  return findingLines.map((line) => {
    const rest = line.replace(/^- /, "").replace(PUNCHLIST_TAG_RE, "");
    const key = rest.match(PUNCHLIST_KEY_RE)?.[1];
    return `- ${recurrenceTag(key, priorKeySets)} ${rest}`;
  });
}

// ---------------------------------------------------------------------------
// Verdict parsers
// ---------------------------------------------------------------------------

export function parseStructuredVerdict(
  output: string,
  commitSha = "",
): ReviewVerdict & { _raw?: string } {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Partial<ReviewVerdict>;
      if (data.verdict === "approve" || data.verdict === "needs-attention") {
        return {
          verdict: data.verdict,
          summary: data.summary ?? "",
          findings: Array.isArray(data.findings) ? (data.findings as ReviewFinding[]) : [],
          next_steps: Array.isArray(data.next_steps) ? data.next_steps as string[] : [],
          commitSha,
        };
      }
    } catch {
      // try the next candidate
    }
  }

  const prose = parseProseReview(output);
  if (prose) return { ...prose, commitSha };

  console.warn(
    "[pipeline] warning: verdict fallback — no structured JSON found in reviewer output; raw attached",
  );
  return {
    verdict: parseTextVerdict(output),
    summary: output.slice(0, 500),
    findings: [],
    next_steps: [],
    commitSha,
    _raw: output.slice(0, 4000),
  };
}

const STRICT_FINDING_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** Validate a single candidate finding against the full `ReviewFinding` contract.
 *  Required fields must have the correct type; optional fields, if present,
 *  must also have the correct type. Returns null on any mismatch. */
function validateStrictFinding(candidate: unknown): ReviewFinding | null {
  if (typeof candidate !== "object" || candidate === null) return null;
  const f = candidate as Record<string, unknown>;
  if (typeof f.severity !== "string" || !STRICT_FINDING_SEVERITIES.has(f.severity)) return null;
  if (typeof f.title !== "string") return null;
  if (typeof f.body !== "string") return null;
  if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) {
    return null;
  }
  if (typeof f.recommendation !== "string") return null;
  if (f.file !== undefined && typeof f.file !== "string") return null;
  if (f.line_start !== undefined && typeof f.line_start !== "number") return null;
  if (f.line_end !== undefined && typeof f.line_end !== "number") return null;
  if (f.category !== undefined && typeof f.category !== "string") return null;
  if (
    f.spec_divergence_direction !== undefined &&
    f.spec_divergence_direction !== "code-behind-spec" &&
    f.spec_divergence_direction !== "spec-behind-code"
  ) {
    return null;
  }
  if (f.blocking !== undefined && typeof f.blocking !== "boolean") return null;
  return {
    severity: f.severity as ReviewFinding["severity"],
    title: f.title,
    body: f.body,
    file: f.file as string | undefined,
    line_start: f.line_start as number | undefined,
    line_end: f.line_end as number | undefined,
    confidence: f.confidence,
    recommendation: f.recommendation,
    category: f.category as string | undefined,
    spec_divergence_direction: f.spec_divergence_direction as ReviewFinding["spec_divergence_direction"],
    blocking: f.blocking as boolean | undefined,
  };
}

/**
 * Strict verdict parser for external stage executor results (#314 review-2
 * finding 9e069297). Unlike `parseStructuredVerdict`, this performs NO
 * partial-JSON field defaulting and NO prose/text-verdict fallback: a
 * delegated executor's output either satisfies the full `ReviewVerdict` /
 * `ReviewFinding` schema, or it is a contract violation — returns `null` so the
 * caller can block the run naming the stage and executor, never silently
 * approving recognizable prose or a partial JSON object.
 */
export function parseStrictVerdict(output: string, commitSha = ""): ReviewVerdict | null {
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null) continue;
    const o = data as Record<string, unknown>;
    if (o.verdict !== "approve" && o.verdict !== "needs-attention") continue;
    if (typeof o.summary !== "string") continue;
    if (!Array.isArray(o.findings)) continue;
    const findings: ReviewFinding[] = [];
    let allFindingsValid = true;
    for (const raw of o.findings) {
      const finding = validateStrictFinding(raw);
      if (!finding) { allFindingsValid = false; break; }
      findings.push(finding);
    }
    if (!allFindingsValid) continue;
    if (!Array.isArray(o.next_steps) || !o.next_steps.every((s) => typeof s === "string")) continue;
    // An `approve` verdict with enumerated findings is contradictory — downgrade to
    // `needs-attention` so the severity/confidence policy gate runs and findings can
    // block or advise as their severity warrants (#314 3f6365e9).
    const effectiveVerdict =
      o.verdict === "approve" && findings.length > 0 ? "needs-attention" : o.verdict;
    return { verdict: effectiveVerdict, summary: o.summary, findings, next_steps: o.next_steps as string[], commitSha };
  }
  return null;
}

export function parseTextVerdict(output: string): "approve" | "needs-attention" {
  const upper = output.toUpperCase();
  const firstLines = output.split("\n", 15).map((l) => l.trim().toUpperCase());
  for (const line of firstLines) {
    if (line.includes("NEEDS-ATTENTION") || line.includes("NEEDS_ATTENTION")) {
      return "needs-attention";
    }
    if (line.includes("REQUEST_CHANGES") || line.includes("REQUEST CHANGES")) {
      return "needs-attention";
    }
    if (line.includes("APPROVE") && !line.includes("NEEDS") && !line.includes("REQUEST")) {
      return "approve";
    }
  }
  if (upper.includes("NEEDS-ATTENTION") || upper.includes("REQUEST_CHANGES") || upper.includes("REQUEST CHANGES")) {
    return "needs-attention";
  }
  if (
    upper.includes("NO MATERIAL FINDINGS") ||
    upper.includes("NO FINDINGS") ||
    upper.includes("NO ISSUES FOUND") ||
    upper.includes("LOOKS SAFE")
  ) {
    return "approve";
  }
  if (upper.includes('"VERDICT": "APPROVE"') || upper.includes("**APPROVE**")) {
    return "approve";
  }
  return "needs-attention";
}

const SEVERITY_BY_PRIORITY: Record<string, ReviewFinding["severity"]> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
};
const WORD_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * Parse Codex's native review (Markdown prose) into a structured verdict.
 * Returns `null` when the output is not a recognizable Codex review.
 */
export function parseProseReview(output: string): Omit<ReviewVerdict, "commitSha"> | null {
  const text = output ?? "";
  if (
    !/^#{1,6}\s*Codex\b.*\bReview\b/im.test(text) &&
    !/^\s*(?:Review comment|Findings)\s*:/im.test(text) &&
    !/^\s*Verdict\s*:/im.test(text)
  ) {
    return null;
  }

  const headerRe = /^\s*[-*]\s*\[\s*(P[0-3]|critical|high|medium|low)\s*\]\s*(.+?)\s*$/i;
  const locDash = /^(.*\S)\s+[—–-]\s+(\S.*?):(\d+)(?:\s*-\s*(\d+))?\s*$/;
  const locParen = /^(.*\S)\s+\((\S.*?):(\d+)(?:\s*-\s*(\d+))?\)\s*$/;

  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      findings.push(current);
      current = null;
    }
  };

  for (const line of text.split("\n")) {
    const h = line.match(headerRe);
    if (h) {
      flush();
      const tag = h[1].toLowerCase();
      const severity: ReviewFinding["severity"] =
        SEVERITY_BY_PRIORITY[tag] ??
        (WORD_SEVERITIES.has(tag) ? (tag as ReviewFinding["severity"]) : "medium");
      let title = h[2].trim();
      let file: string | undefined;
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      const loc = title.match(locDash) ?? title.match(locParen);
      if (loc) {
        title = loc[1].trim();
        file = loc[2].trim();
        lineStart = Number(loc[3]);
        lineEnd = loc[4] ? Number(loc[4]) : lineStart;
      }
      current = {
        severity,
        title,
        body: "",
        file,
        line_start: lineStart,
        line_end: lineEnd,
        confidence: 0.7,
        recommendation: "",
      };
      continue;
    }
    if (current) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (/^\s/.test(line)) {
        current.body += (current.body ? "\n" : "") + trimmed;
      } else {
        flush();
      }
    }
  }
  flush();

  const summary = extractProseSummary(text);
  if (findings.length > 0) {
    return { verdict: "needs-attention", summary, findings, next_steps: [] };
  }

  if (
    /^\s*Verdict\s*:\s*approve\b/im.test(text) ||
    /\bno (?:material )?(?:issues|findings|concerns|blocking)\b/i.test(text) ||
    /\b(?:looks good|lgtm|approved?|no problems found)\b/i.test(text)
  ) {
    return { verdict: "approve", summary, findings: [], next_steps: [] };
  }
  return null;
}

function extractProseSummary(text: string): string {
  const head = text.split(/^\s*(?:Review comment|Findings)\s*:/im)[0] ?? text;
  const cleaned = head
    .replace(/^#{1,6}\s*Codex\b.*Review\s*$/im, "")
    .replace(/^\s*Target:.*$/im, "")
    .replace(/^\s*Verdict\s*:.*$/im, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return (cleaned || "Codex review").slice(0, 500);
}

/**
 * Extract repo-relative file paths from a unified diff string.
 * Parses `diff --git a/<path> b/<path>` header lines produced by `gh pr diff`.
 */
export function diffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

/**
 * Classify the review-1 risk tier from its structured verdict (#232).
 * Returns `"low"` for approve with zero findings; `"standard"` otherwise.
 */
export function classifyReview1Risk(verdict: Pick<ReviewVerdict, "verdict" | "findings">): Review1Risk {
  return verdict.verdict === "approve" && verdict.findings.length === 0 ? "low" : "standard";
}
