// Review severity policy + audited overrides (#17, #229).
//
// The pipeline historically treated EVERY `needs-attention` finding as a hard
// block that routes to a fix round. That makes a medium-severity scope-creep
// finding — or an outright reviewer false-positive — block ship exactly as hard
// as a real high-severity bug, with no escape hatch (see the #56 non-convergence
// loop). This module adds:
//
//   1. A severity threshold: findings below `block_threshold` (or below
//      `min_confidence`) are ADVISORY — recorded on the PR/issue but not routed
//      to a fix round.
//   2. Audited operator overrides: a human can mark a specific blocking finding
//      (by its stable key) as dispositioned, recorded as a `pipeline-override`
//      comment sentinel that the gate reads back and respects.
//   3. Scoped overrides (#229): `category:<name>` and `file:<path>` dispositions
//      that survive finding-key drift across re-reviews, applied by
//      `partitionFindings` on every round.
//
// Default policy (`block_threshold: "low"`, `min_confidence: 0`) reproduces the
// pre-#17 behavior exactly: every finding blocks.

import { createHash } from "node:crypto";
import { matchSettledAlternative, matchSettledFinding, type MatchBasis, type SettledFinding } from "./review-history.ts";
import { attestPipelineComment, isVerifiedPipelineAttestation } from "./stages/review-parsing.ts";
import type { ReviewFinding } from "./types.ts";

// Severity ordering, least → most severe. A finding blocks when its severity
// rank is >= the configured threshold's rank.
export const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

/** Numeric rank for a severity string. Unknown/garbled severities are treated
 *  as "medium" so a malformed reviewer value never silently downgrades to the
 *  lowest (and so it is never accidentally excluded from blocking). */
export function severityRank(sev: string): number {
  const i = SEVERITY_ORDER.indexOf(sev as Severity);
  return i === -1 ? SEVERITY_ORDER.indexOf("medium") : i;
}

export interface ReviewPolicy {
  block_threshold: Severity;
  /** Findings with confidence below this advise rather than block. 0 = no gate. */
  min_confidence: number;
}

/** Risk tier derived from the review-1 verdict (#232). */
export type Review1Risk = "low" | "standard";

/**
 * Returns the effective ReviewPolicy for a given review round and review-1 risk
 * context (#232). When round===2, risk_proportional is true, and the captured
 * review-1 risk is low, the effective block_threshold is raised to the stricter
 * of the configured threshold and "high" — so only high/critical findings block
 * in review-2 for low-risk changes. min_confidence is never altered. In all
 * other cases returns a ReviewPolicy with the configured values unchanged.
 *
 * "Stricter of configured and high" = higher severity rank = the one that blocks
 * FEWER findings (e.g. "critical" > "high" > "medium" > "low"). A configured
 * "critical" threshold is already above "high" and is left unchanged; "medium"
 * or "low" are raised to "high".
 */
export function effectiveReviewPolicy(
  policy: ReviewPolicy & { risk_proportional?: boolean },
  context: { round: 1 | 2; review1Risk: Review1Risk },
): ReviewPolicy {
  if (
    context.round !== 2 ||
    !policy.risk_proportional ||
    context.review1Risk !== "low"
  ) {
    return { block_threshold: policy.block_threshold, min_confidence: policy.min_confidence };
  }
  // Low-risk review-2: raise threshold to max(configured, "high") by severity rank.
  const configuredRank = severityRank(policy.block_threshold);
  const highRank = severityRank("high");
  const effectiveThreshold = SEVERITY_ORDER[Math.max(configuredRank, highRank)] as Severity;
  return { block_threshold: effectiveThreshold, min_confidence: policy.min_confidence };
}

/**
 * Fixed-partition line band for a finding's `line_start` (#144). Lines 1–5 map to
 * bucket 1, 6–10 to bucket 6, etc. — `Math.floor((L - 1) / 5) * 5 + 1` for `L >= 1`.
 * Returns 0 when `line_start` is absent or falsy, which routes `findingKey` to the
 * normalized-title fallback. A fixed partition (vs. a moving ±window centered on
 * `line_start`) is reproducible from the bucket alone: the bucket is a pure function
 * of the line number, so a finding that drifts ±a few lines within the same band
 * keeps the same key without needing to know where the override was first recorded.
 */
export function lineBucket(lineStart: number | undefined): number {
  if (!lineStart || lineStart < 1) return 0;
  return Math.floor((lineStart - 1) / 5) * 5 + 1;
}

/** Normalize a file path for the finding key: lowercase only (#144). */
export function normalizeFile(file: string | undefined): string {
  return (file ?? "").toLowerCase();
}

/**
 * Normalize a finding title for the fallback key (#144): lowercase, strip markdown
 * emphasis (`*`, `_`, backtick, `~`), strip leading/trailing punctuation and
 * ellipsis (`…`, `...`), collapse internal whitespace, trim. Absorbs the common
 * formatting/capitalization drift between rounds; it does NOT absorb word
 * insertion ("can starve" vs "can still starve"), which is why the location-based
 * key is preferred whenever `line_start` is available.
 */
export function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[*_`~]/g, "")
    .replace(/^[\s\p{P}…]+/u, "")
    .replace(/[\s\p{P}…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable short key for a finding so an operator can reference one specific
 * finding in an override, and so recurrence detection (#133) recognizes the same
 * issue across rounds. Location-addressed: `sha1(severity | normalizeFile(file) |
 * lineBucket(line_start))` when `line_start` is present, falling back to
 * `sha1(severity | normalizeFile(file) | normalizeTitle(title))` when it is not.
 *
 * Stable under title rewording (#144): because the primary key excludes the title,
 * a reviewer that re-words a finding ("can starve" → "can still starve") at the
 * same file + line band + severity produces the SAME key, so a recorded override
 * keeps applying instead of silently lapsing and re-parking the item at
 * `needs-human` (the #19 five-round failure). Title is the reviewer's natural-
 * language description of an issue, not the issue's identity.
 *
 * MIGRATION (ships ~2026-06, #144): this replaces the prior `severity|file|title`
 * algorithm. `pipeline-override` sentinels recorded before this change carry
 * old-algorithm keys and will no longer match any finding's new key — any
 * in-flight overrides must be re-recorded after deploy. One-time cost.
 */
export function findingKey(
  f: Pick<ReviewFinding, "severity" | "file" | "title" | "line_start">,
): string {
  const severity = f.severity ?? "medium";
  const file = normalizeFile(f.file);
  const bucket = lineBucket(f.line_start);
  const basis = bucket > 0 ? `${severity}|${file}|${bucket}` : `${severity}|${file}|${normalizeTitle(f.title)}`;
  return createHash("sha1").update(basis).digest("hex").slice(0, 8);
}

/**
 * Stable surface key for a finding: `normalize(file) + "|" + (category ?? "")`.
 * Two findings sharing the same normalized file and the same category share a
 * surface key regardless of their individual findingKey, severity, line, or title
 * (#234). Returns null when the finding has no `file` (or an empty `file`) —
 * such findings are excluded from surface clustering.
 */
export function surfaceKey(f: Pick<ReviewFinding, "file" | "category">): string | null {
  const file = normalizeFile(f.file);
  if (!file) return null;
  return `${file}|${f.category ?? ""}`;
}

// Machine-readable per-round blocking-surfaces marker (#234).
// Format: <!-- pipeline-blocking-surfaces: <findingKey>~<encodedSurfaceKey>,... -->
// Full-line-anchored; global flag lets extractBlockingSurfacesFromComment pick
// the LAST occurrence, guarding against a spoofed earlier marker in reviewer prose.
const PIPELINE_BLOCKING_SURFACES_RE = /^<!-- pipeline-blocking-surfaces: (.*?) -->$/gm;

/**
 * Emit the machine-readable `pipeline-blocking-surfaces` marker for a set of
 * blocking findings. Each pair `<findingKey>~<surfaceKey>` records one finding's
 * surface. Findings without a surface key (no `file`) are omitted. The surface
 * key is URI-percent-encoded to handle file paths and category names that contain
 * commas, tildes, or other separator characters. Emits an empty marker when no
 * finding carries a surface, so a prior advisory-only round cannot seed a false
 * surface streak. Pure (no network/git/subprocess).
 */
export function formatBlockingSurfacesMarker(findings: ReviewFinding[]): string {
  const pairs: string[] = [];
  const seenFindingKeys = new Set<string>();
  for (const f of findings) {
    const sk = surfaceKey(f);
    if (sk === null) continue;
    const fk = findingKey(f);
    if (seenFindingKeys.has(fk)) continue;
    seenFindingKeys.add(fk);
    pairs.push(`${fk}~${encodeURIComponent(sk)}`);
  }
  return `<!-- pipeline-blocking-surfaces: ${pairs.join(",")} -->`;
}

/**
 * Extract the `pipeline-blocking-surfaces` mapping (findingKey → surfaceKey)
 * from a review comment body (#234). Full-line-anchored regex; picks the LAST
 * occurrence (guards against a spoofed marker placed before the real pipeline-
 * emitted footer marker by reviewer-authored content). Returns an empty mapping
 * for a body with no marker, an empty marker, or malformed content — never throws.
 * Pure (no network, git, or subprocess calls).
 */
export function extractBlockingSurfacesFromComment(body: string): Map<string, string> {
  PIPELINE_BLOCKING_SURFACES_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = PIPELINE_BLOCKING_SURFACES_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  PIPELINE_BLOCKING_SURFACES_RE.lastIndex = 0;
  const map = new Map<string, string>();
  if (lastMatch === null || !lastMatch[1].trim()) return map;
  for (const pair of lastMatch[1].split(",")) {
    const tildeIdx = pair.indexOf("~");
    if (tildeIdx === -1) continue;
    const fk = pair.slice(0, tildeIdx).trim();
    const encodedSk = pair.slice(tildeIdx + 1).trim();
    if (!/^[0-9a-f]{8}$/.test(fk)) continue;
    try {
      map.set(fk, decodeURIComponent(encodedSk));
    } catch {
      map.set(fk, encodedSk);
    }
  }
  return map;
}

/**
 * Structured finding category (#106) that flags a divergence between the code and
 * the OpenSpec spec delta. The pre-merge consistency guard keys on THIS — emitted
 * into the review comment by `formatReviewComment` from the reviewer's structured
 * `ReviewFinding.category` field — never on free-text prose. Prose keyword-matching
 * is adversarially unwinnable (it oscillates false-pos ↔ false-neg); a controlled
 * marker we emit and read is a total function over a structured input.
 */
export const SPEC_DIVERGENCE_CATEGORY = "spec-divergence";

/** The exact (backtick-wrapped) token rendered per categorized finding in a review
 * comment, and matched by the guard. Single-sourced so emit + read cannot drift. */
export function categoryMarker(category: string): string {
  return `\`category: ${category}\``;
}

/** True when a rendered review comment carries a spec-divergence finding marker.
 * Exact-marker match (not prose inference). Pure; exported for tests. */
export function reviewCommentFlagsSpecDivergence(reviewBody: string): boolean {
  return reviewBody.includes(categoryMarker(SPEC_DIVERGENCE_CATEGORY));
}

/**
 * Which entity must change to resolve a spec-divergence finding (#356).
 * "code-behind-spec" — the active spec delta already requires the behavior;
 *   the implementation must change. Normal fix-round path.
 * "spec-behind-code" — the accepted implementation moved past the active delta;
 *   the spec delta must be updated before archiving.
 */
export type SpecDivergenceDirection = "code-behind-spec" | "spec-behind-code";

/** The exact (backtick-wrapped) token rendered per spec-divergence finding,
 * single-sourced so emit + read cannot drift (#356). */
export function directionMarker(direction: SpecDivergenceDirection): string {
  return `\`direction: ${direction}\``;
}

/**
 * Extract the spec-divergence direction from a rendered review comment body.
 * Exact-marker match only — never infers direction from reviewer prose (#356).
 * Returns null when no direction marker is present (unclassified). Pure.
 */
export function extractSpecDivergenceDirection(reviewBody: string): SpecDivergenceDirection | null {
  if (reviewBody.includes(directionMarker("spec-behind-code"))) return "spec-behind-code";
  if (reviewBody.includes(directionMarker("code-behind-spec"))) return "code-behind-spec";
  return null;
}

// ---------------------------------------------------------------------------
// Scoped overrides (#229)
// ---------------------------------------------------------------------------

/**
 * An active scope disposition recovered from `<!-- pipeline-override-scope: ... -->`
 * sentinels (#229). A scope matches all findings in a category or under a file path
 * prefix, regardless of each finding's per-finding key.
 */
export interface ScopedOverride {
  /** Match axis: "category" matches `finding.category`, "file" matches `finding.file`. */
  type: "category" | "file";
  /** Normalized value: lowercase for both types, trimmed for category names. */
  value: string;
  /** Normalized disposition token: "deferred-#N" or "rejected". */
  disposition: string;
  /** Human-supplied reason text as originally recorded. */
  reason: string;
}

/**
 * An entry in `PartitionResult.overridden`. Discriminated by `kind`:
 * - `"key"`: overridden by a per-finding key override (`pipeline-override` sentinel).
 * - `"scope"`: overridden by a scoped override (`pipeline-override-scope` sentinel, #229).
 */
export type OverriddenEntry =
  | { kind: "key"; finding: ReviewFinding; key: string; disposition: string }
  | {
      kind: "scope";
      finding: ReviewFinding;
      scopeType: "category" | "file";
      scopeValue: string;
      disposition: string;
      /** Human-supplied reason, preserved from the operator's --override argument (#229 fix). */
      reason: string;
    };

/**
 * Audit detail for a `reversal-unacknowledged` demotion (#464): which settled
 * finding the demoted finding was matched against, and how (`"key"` — the
 * finding's stable key equals the settled entry's, or `"title-similarity"` —
 * the normalized titles are similar enough to describe the same defect).
 */
export interface ReversalMatch {
  settledKey: string;
  settledTitle: string;
  settledRound: number;
  matchedBy: MatchBasis;
}

/**
 * Audit detail for a `settled-alternative-reinstated` demotion (#483): which
 * settled finding's rejected alternative the demoted finding's recommendation
 * reinstated, and the round that settled it.
 */
export interface AlternativeReinstatementMatch {
  settledKey: string;
  settledRound: number;
  matchedAlternative: string;
}

export interface PartitionResult {
  /** Findings that block: at/above threshold, at/above confidence, not overridden. */
  blocking: ReviewFinding[];
  /** Below the severity threshold or confidence floor — recorded, not blocking.
   *  `reversalMatch` is present iff `reason === "reversal-unacknowledged"`.
   *  `alternativeMatch` is present iff `reason === "settled-alternative-reinstated"`. */
  advisory: { finding: ReviewFinding; reason: string; reversalMatch?: ReversalMatch; alternativeMatch?: AlternativeReinstatementMatch }[];
  /** Operator-dispositioned via a `pipeline-override` or `pipeline-override-scope`
   *  sentinel — not blocking. Discriminated by `kind`. */
  overridden: OverriddenEntry[];
}

/**
 * A fingerprint of the fields that make two same-key findings *materially*
 * different: normalized title + normalized body + normalized recommendation +
 * line range. The ambiguity guard counts distinct fingerprints — not the raw
 * finding count (which an exact duplicate or an advisory duplicate could inflate)
 * and not the title alone (which collapses genuinely different findings that
 * happen to share a key + title). Exact-duplicate payloads share a fingerprint
 * and collapse; materially different findings do not. Exported for tests.
 *
 * Accepts `Pick<ReviewFinding, ...>` (not the full type) so callers that only
 * have a partial finding reconstructed from rendered review-comment text (e.g.
 * the fix-stage `parseFindingSummaries`, #391) can compute the same
 * fingerprint without a full `ReviewFinding`.
 */
export function findingPayloadFingerprint(
  f: Pick<ReviewFinding, "title" | "body" | "recommendation" | "line_start" | "line_end">,
): string {
  const norm = (s: string | undefined): string =>
    (s ?? "").toLowerCase().replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  // Normalize the range: an omitted line_end means the single line `line_start`,
  // so `{46}` and `{46, line_end: 46}` must produce the same range (else an exact
  // duplicate with one form omitted falsely reads as a distinct candidate).
  const effectiveEnd = f.line_end ?? f.line_start;
  const raw = [
    normalizeTitle(f.title),
    norm(f.body),
    norm(f.recommendation),
    `${f.line_start ?? ""}-${effectiveEnd ?? ""}`,
  ].join("␟");
  // Hash the normalized payload so the returned fingerprint is an opaque digest —
  // the raw fields (body, recommendation) can contain secrets or injection text
  // that must not leak into persisted run artifacts via payload_fingerprint.
  return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

/**
 * True when finding `f` matches scope `s` by the scope's axis:
 * - category: `finding.category`, lowercased and trimmed, equals the scope value.
 *   A finding without a category does NOT match.
 * - file: `normalizeFile(finding.file)` equals the scope value OR begins with
 *   `scopeValue + "/"` (directory-boundary-aware prefix, #229).
 *   A finding without a file does NOT match.
 *
 * Accepts `Pick<ReviewFinding, "category" | "file">` (not the full type) so
 * callers that only have a partial finding reconstructed from rendered review
 * text (e.g. the fix-stage override pre-filter, #391) can reuse this single
 * identity implementation instead of re-deriving the match rule.
 */
export function matchFindingScope(f: Pick<ReviewFinding, "category" | "file">, s: ScopedOverride): boolean {
  if (s.type === "category") {
    const cat = (f.category ?? "").toLowerCase().trim();
    return cat !== "" && cat === s.value;
  }
  const nf = normalizeFile(f.file);
  return nf !== "" && (nf === s.value || nf.startsWith(s.value + "/"));
}

/**
 * Partition review findings into blocking / advisory / overridden under the
 * given policy and the set of active operator overrides (key → disposition) and
 * active scoped overrides (#229: category/file scopes).
 *
 * Evaluation order:
 *   1. Scope match (#229): any finding that matches an active scope is moved to
 *      `overridden` (kind: "scope") immediately, WITHOUT the per-key ambiguity
 *      guard. Scopes are re-evaluated on every round so they survive key drift.
 *   2. Key override: a finding not scope-matched is moved to `overridden`
 *      (kind: "key") when its stable key appears in `overrides` AND it is a
 *      blocking candidate AND its key is NOT ambiguous (at most one distinct
 *      blocking payload for that key).
 *   3. Advisory / blocking: the remaining findings are classified by the severity
 *      threshold and confidence floor.
 *
 * Override takes precedence over the severity/confidence test so an explicit
 * human disposition always wins.
 *
 * Ambiguity guard (#144): a key override is only applied when the current verdict
 * has exactly one *distinct blocking candidate* for that key. A "blocking
 * candidate" meets the severity threshold and confidence floor; "distinct" is
 * measured by findingPayloadFingerprint — so exact-duplicate payloads (and
 * same-key advisory duplicates, which are never counted) collapse to one, but
 * two materially different findings that share a key + normalized title do NOT,
 * and correctly withhold the override so a real blocker cannot advance under it.
 * Scoped overrides bypass this guard by design (#229): a scope is explicitly
 * intended to match more than one finding.
 *
 * SHA-anchored non-reproducing disposition (#391): a finding whose key has one
 * or more recorded {@link extractNonReproducingDispositions} entries is
 * treated like a key override — same ambiguity guard — but ONLY when at least
 * one of those entries has both a `sha` equal to `reviewedSha` (the SHA this
 * verdict was produced against) AND a `fingerprint` equal to the finding's
 * {@link findingPayloadFingerprint} (#391 review-1 finding 5805b17e). `findingKey`
 * is intentionally coarse (file + severity + 5-line band), so a key+SHA match
 * alone is not enough to prove it is the SAME finding — the fingerprint
 * requirement rules out a different finding that happens to land in the same
 * coarse bucket at the same SHA, and multiple dispositions are kept per key
 * (#391 review-2 finding 53b23912) so a colliding finding's disposition is
 * never lost. A disposition recorded against a since-superseded SHA, or whose
 * fingerprint no longer matches, does not apply, so the finding is evaluated
 * afresh. Callers MUST pre-filter the source comments to trusted authors
 * before calling, mirroring the trust model of `overrides`.
 *
 * Settled-finding reversal guard (#389, narrowed to finding-level matching by
 * #464): after the override/non-reproducing checks (which still take
 * precedence — an explicit disposition always wins), a finding that would
 * otherwise block, whose `prior_round_acknowledgment` is absent, empty, or
 * whitespace-only, AND which `matchSettledFinding` reports as re-raising a
 * specific entry in `settledFindings`, is moved to advisory with reason
 * `reversal-unacknowledged` instead of blocking. This is the structural guard
 * against a later round silently re-flipping a trade-off an earlier round
 * already settled (see `review-history.ts`'s `matchSettledFinding`). Surface
 * identity alone never suffices — a genuinely new, distinct defect that
 * merely shares a file/category with a settled finding is NOT demoted; it is
 * partitioned by `policy` alone (#464, fixing the #395 mis-fire). A finding
 * carrying a non-empty `prior_round_acknowledgment` blocks exactly as it
 * would without this guard; a finding matching no entry in `settledFindings`
 * (or when the caller supplies no entries at all) is unaffected.
 */
export function partitionFindings(
  findings: ReviewFinding[],
  policy: ReviewPolicy,
  overrides: Map<string, string> = new Map(),
  scopes: ScopedOverride[] = [],
  nonReproducing: Map<string, { sha: string; fingerprint: string }[]> = new Map(),
  reviewedSha: string | null = null,
  settledFindingsList: SettledFinding[] = [],
): PartitionResult {
  const threshold = severityRank(policy.block_threshold);
  const result: PartitionResult = { blocking: [], advisory: [], overridden: [] };

  // Pre-classify: for each key, collect the set of distinct *payload fingerprints*
  // among blocking candidates only. Advisory findings are not counted — including
  // findings marked `blocking: false` (#236), which are never blocking candidates.
  // Exact-duplicate payloads collapse to one — but two materially different
  // findings that share a key stay distinct, so they correctly trigger ambiguity.
  const blockingFingerprintsByKey = new Map<string, Set<string>>();
  for (const f of findings) {
    if (f.blocking === false) continue; // non-blocking marker: never a blocking candidate (#236)
    const isAboveSeverity = severityRank(f.severity) >= threshold;
    const isAboveConfidence = typeof f.confidence !== "number" || f.confidence >= policy.min_confidence;
    if (isAboveSeverity && isAboveConfidence) {
      const k = findingKey(f);
      if (!blockingFingerprintsByKey.has(k)) blockingFingerprintsByKey.set(k, new Set());
      blockingFingerprintsByKey.get(k)!.add(findingPayloadFingerprint(f));
    }
  }

  for (const f of findings) {
    // 0. Non-blocking marker (#236): advisory regardless of severity/confidence.
    if (f.blocking === false) {
      result.advisory.push({ finding: f, reason: "marked non-blocking by reviewer" });
      continue;
    }

    // 1. Scope match (#229): no ambiguity guard, re-evaluated every round.
    const matchedScope = scopes.find((s) => matchFindingScope(f, s));
    if (matchedScope) {
      result.overridden.push({
        kind: "scope",
        finding: f,
        scopeType: matchedScope.type,
        scopeValue: matchedScope.value,
        disposition: matchedScope.disposition,
        reason: matchedScope.reason,
      });
      continue;
    }

    // 2. Key override: only for blocking candidates, with ambiguity guard.
    const key = findingKey(f);
    const isBlockingCandidate =
      severityRank(f.severity) >= threshold &&
      (typeof f.confidence !== "number" || f.confidence >= policy.min_confidence);
    const distinctBlockers = blockingFingerprintsByKey.get(key)?.size ?? 0;
    const isAmbiguous = distinctBlockers > 1;

    if (overrides.has(key) && isBlockingCandidate && !isAmbiguous) {
      result.overridden.push({ kind: "key", finding: f, key, disposition: overrides.get(key)! });
      continue;
    }

    // 2b. SHA-anchored non-reproducing disposition (#391): only consulted when
    // the disposition's recorded SHA matches the SHA this verdict was produced
    // against AND its recorded payload fingerprint matches this finding's
    // current fingerprint (#391 review-1 finding 5805b17e) — the coarse key
    // alone cannot distinguish a different finding that lands in the same
    // file/severity/line-band bucket at the same SHA.
    const nonRepro = reviewedSha
      ? nonReproducing.get(key)?.find(
          (d) => d.sha === reviewedSha && d.fingerprint === findingPayloadFingerprint(f),
        )
      : undefined;
    if (nonRepro && isBlockingCandidate && !isAmbiguous) {
      result.overridden.push({
        kind: "key",
        finding: f,
        key,
        disposition: `declared non-reproducing at ${reviewedSha.slice(0, 7)} by a prior fix round`,
      });
      continue;
    }

    // 3. Advisory / blocking classification.
    const belowSeverity = severityRank(f.severity) < threshold;
    const belowConfidence =
      typeof f.confidence === "number" && f.confidence < policy.min_confidence;
    if (belowSeverity || belowConfidence) {
      const reasons: string[] = [];
      if (belowSeverity) reasons.push(`severity ${f.severity} below threshold ${policy.block_threshold}`);
      if (belowConfidence) reasons.push(`confidence ${f.confidence} below ${policy.min_confidence}`);
      result.advisory.push({ finding: f, reason: reasons.join("; ") });
      continue;
    }

    // 4. Settled-finding reversal guard (#389, finding-level matching #464):
    // an otherwise-blocking finding that re-raises a SPECIFIC settled finding
    // (not merely shares its surface), raised again without an acknowledgment,
    // is demoted rather than allowed to silently re-flip the prior decision.
    const hasAcknowledgment = (f.prior_round_acknowledgment ?? "").trim() !== "";
    if (!hasAcknowledgment) {
      const match = matchSettledFinding(f, settledFindingsList);
      if (match) {
        result.advisory.push({
          finding: f,
          reason: "reversal-unacknowledged",
          reversalMatch: {
            settledKey: match.entry.key,
            settledTitle: match.entry.title,
            settledRound: match.entry.round,
            matchedBy: match.basis,
          },
        });
        continue;
      }

      // 5. Settled-alternative reinstatement guard (#483): independent of the
      // reversal guard above (a different axis — recommendation vs. rejected
      // alternative, not title/key) — catches a later round re-raising a
      // settled trade-off under a NEW finding key and a re-framed title, which
      // the key/title-similarity guard above cannot see (fuseiq-core#95 round
      // 5 vs round 2).
      const altMatch = matchSettledAlternative(f, settledFindingsList);
      if (altMatch) {
        result.advisory.push({
          finding: f,
          reason: "settled-alternative-reinstated",
          alternativeMatch: {
            settledKey: altMatch.entry.key,
            settledRound: altMatch.entry.round,
            matchedAlternative: altMatch.matchedAlternative,
          },
        });
        continue;
      }
    }

    result.blocking.push(f);
  }
  return result;
}

/**
 * Build the set of issue/PR comments that are trusted sources for override and
 * scoped-override sentinels (#229 Findings 4 + 5 + 6).
 *
 * Trust model: honor override comments authored by:
 *   1. The current pipeline actor (whoever is running this invocation), AND
 *   2. Any identity listed in `cfg.trusted_override_actors` — an explicit,
 *      non-forgeable repo-config allowlist for multi-actor setups.
 *
 * Body-prefix heuristics ("any ## Review N author") are NOT used — they are
 * forgeable by any commenter who posts a fake review-headed comment (#229 Finding 6).
 *
 * The filter is author-only — it returns every comment from a trusted author
 * regardless of body content, not just scope-override-headed ones. This is
 * also the source `findUnacknowledgedComments`'s `trustedComments` argument
 * is built from (review-routing.ts, fix.ts) for the human-input ack gate (#390).
 *
 * Returns [] when `actor` is null (auth failure → fail-closed).
 */
export function buildTrustedOverrideComments<T extends { body: string; author?: string | null }>(
  comments: T[],
  actor: string | null,
  allowlist?: string[],
): T[] {
  if (actor === null) return [];
  const trusted = new Set<string>(allowlist ?? []);
  trusted.add(actor);
  return comments.filter((c) => c.author != null && trusted.has(c.author as string));
}

// Machine-readable override sentinel, mirroring the `reviewed-sha` precedent
// (#16). Anchored to line-start; the disposition token is recorded for display.
// Exported (#389) so review-history.ts can attribute an override to the round
// in which it was recorded without duplicating this parsing logic.
export const OVERRIDE_RE = /^<!-- pipeline-override: ([0-9a-f]{8}) (.+?) -->$/m;
export const OVERRIDE_HEADING = "## Pipeline: Finding override";

/**
 * Collect active overrides from issue/PR comments as key → disposition text.
 * A later override for the same key wins (lets a human revise a disposition).
 *
 * Security invariants (parallel to extractScopedOverrides, #229 Finding 3):
 * 1. Only comments with the `## Pipeline: Finding override` heading are processed.
 * 2. Only the last non-empty line is parsed as the machine sentinel, EXCEPT that
 *    `overrideComment` now appends a generic pipeline attestation (#471/#484) after
 *    the override sentinel; when the true last line is a valid `pipeline-attest`
 *    marker, it is stripped before applying the last-line check (mirroring
 *    `extractNonReproducingDispositions`) so the sentinel underneath it is still
 *    the line that gets read.
 */
export function extractOverrides(comments: { body: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of comments) {
    if (!c.body.startsWith(OVERRIDE_HEADING)) continue;
    const lines = c.body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && isVerifiedPipelineAttestation(c.body)) {
      lines.pop();
    }
    const lastLine = lines.at(-1) ?? "";
    const m = OVERRIDE_RE.exec(lastLine);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

// Machine-readable scope override sentinel (#229). Anchored to line-start; the
// scope type+value and disposition token are recorded. Global flag so multiple
// sentinels in one comment can be read; callers reset lastIndex before/after.
// Exported (#389) so review-history.ts can attribute a scope override to the
// round in which it was recorded without duplicating this parsing logic.
export const SCOPE_OVERRIDE_RE = /^<!-- pipeline-override-scope: (category|file):(\S+) (.+?) -->$/gm;

export const SCOPE_OVERRIDE_HEADING = "## Pipeline: Scope override";

/**
 * Collect active scoped overrides (#229) from issue/PR comments. A later sentinel
 * for the same `<type>:<value>` wins (lets a human revise a scoped disposition).
 * The returned array is ready to pass as the `scopes` argument of `partitionFindings`.
 *
 * Security invariants (#229 Finding 1 + Finding 2):
 * 1. Only comments with the controlled `## Pipeline: Scope override` heading are
 *    processed — pipeline-authored review comments may contain raw reviewer finding
 *    text that could embed sentinel-shaped lines.
 * 2. Only the last non-empty line of each qualifying comment is parsed as the machine
 *    sentinel — free-form reason text in the comment body cannot inject additional
 *    scope records even if it contains a sentinel-shaped line. `scopedOverrideComment`
 *    now appends a generic pipeline attestation (#471/#484) after that sentinel; when
 *    the true last line is a valid `pipeline-attest` marker, it is stripped first
 *    (mirroring `extractNonReproducingDispositions`) so the sentinel underneath it is
 *    still the line that gets read.
 */
export function extractScopedOverrides(comments: { body: string }[]): ScopedOverride[] {
  const map = new Map<string, ScopedOverride>(); // key: "${type}:${value}" → last wins
  for (const c of comments) {
    if (!c.body.startsWith(SCOPE_OVERRIDE_HEADING)) continue;
    // Only examine the last non-empty line — scopedOverrideComment always places the
    // machine sentinel there; free-form reason text earlier in the body is ignored.
    const lines = c.body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && isVerifiedPipelineAttestation(c.body)) {
      lines.pop();
    }
    const lastLine = lines.at(-1) ?? "";
    SCOPE_OVERRIDE_RE.lastIndex = 0;
    const m = SCOPE_OVERRIDE_RE.exec(lastLine);
    if (!m) continue;
    const type = m[1] as "category" | "file";
    // Decode percent-encoded scope values (#229 fix 2). Old sentinels without
    // encoding round-trip safely; malformed sequences fall back to the raw string.
    let value: string;
    try { value = decodeURIComponent(m[2]); } catch { value = m[2]; }
    // Sentinel format: "disposition | human reason" (new, #229 fix) or "disposition" (old).
    // The " | " delimiter separates the normalized token from the operator-supplied text.
    const captured = m[3].trim();
    const pipeIdx = captured.indexOf(" | ");
    const disposition = pipeIdx >= 0 ? captured.slice(0, pipeIdx).trim() : captured;
    const reason = pipeIdx >= 0 ? captured.slice(pipeIdx + 3).trim() : captured;
    map.set(`${type}:${value}`, { type, value, disposition, reason });
  }
  SCOPE_OVERRIDE_RE.lastIndex = 0;
  return [...map.values()];
}

/** Validate an operator-supplied finding key (8 lowercase hex chars). */
export function isValidFindingKey(key: string): boolean {
  return /^[0-9a-f]{8}$/.test(key);
}

/**
 * Normalize a disposition token from an operator-supplied reason string:
 * "deferred" (optionally "deferred-#N") or "rejected"; defaults to "rejected"
 * when the reason doesn't lead with one of those words.
 */
function normalizeDisposition(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.startsWith("deferred")) {
    const ref = reason.match(/#(\d+)/);
    return ref ? `deferred-#${ref[1]}` : "deferred";
  }
  return "rejected";
}

/**
 * The audited override comment body. The visible block records the disposition,
 * stage, timestamp, and reason; the trailing sentinel is what the gate reads.
 * GitHub comment authorship supplies the "who" half of the audit trail.
 */
export function overrideComment(args: {
  key: string;
  disposition: string;
  reason: string;
  stage: string;
  timestamp: string;
  footer?: string;
}): string {
  const { key, disposition, reason, stage, timestamp, footer } = args;
  const rendered = [
    "## Pipeline: Finding override",
    "",
    `**Finding**: \`${key}\``,
    `**Disposition**: ${disposition}`,
    `**Stage**: ${stage}`,
    `**Recorded at**: ${timestamp}`,
    "",
    "### Reason",
    reason,
    "",
    (footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- pipeline-override: ${key} ${disposition} -->`,
  ].join("\n");
  return attestPipelineComment("finding-override", rendered);
}

/**
 * The audited scoped override comment body (#229). Records a `category:<name>` or
 * `file:<path>` scope disposition that partitionFindings re-evaluates on every
 * (re-)review against the live verdict, regardless of per-finding key drift.
 * The `<!-- pipeline-override-scope: ... -->` sentinel is what `extractScopedOverrides`
 * reads back; the visible block is the human audit trail.
 */
export function scopedOverrideComment(args: {
  scopeType: "category" | "file";
  scopeValue: string;
  disposition: string;
  reason: string;
  stage: string;
  timestamp: string;
  footer?: string;
}): string {
  const { scopeType, scopeValue, disposition, reason, stage, timestamp, footer } = args;
  // Sanitize the reason before embedding in the machine sentinel: strip newlines and
  // escape HTML comment close sequences so reason text cannot contain a sentinel-shaped
  // line or close the comment early (#229 Finding 2).
  const safeReason = reason.replace(/[\r\n]/g, " ").replace(/-->/g, "—>");
  const rendered = [
    "## Pipeline: Scope override",
    "",
    `**Scope**: \`${scopeType}:${scopeValue}\``,
    `**Disposition**: ${disposition}`,
    `**Stage**: ${stage}`,
    `**Recorded at**: ${timestamp}`,
    "",
    "### Reason",
    reason,
    "",
    (footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- pipeline-override-scope: ${scopeType}:${encodeURIComponent(scopeValue)} ${disposition} | ${safeReason} -->`,
  ].join("\n");
  return attestPipelineComment("scope-override", rendered);
}

// ---------------------------------------------------------------------------
// Non-reproducing disposition (#391) — SHA-anchored, machine-authored, weaker
// than an operator override. Recorded when the fix harness declares a blocking
// finding does not reproduce at the reviewed SHA (see fix.ts's does-not-reproduce
// declaration parsing) so a later fix/review re-entry at the SAME SHA does not
// reproduce the "reported success but produced no new commits" dead-end.
// ---------------------------------------------------------------------------

const NON_REPRODUCING_HEADING = "## Pipeline: Finding does not reproduce";
// Third capture is the finding's payload fingerprint (#391 review-1 finding
// 5805b17e) — 16 lowercase hex chars, matching findingPayloadFingerprint's
// output — recorded alongside the key/SHA so a later re-review at the same SHA
// can require a full-payload match, not just a coarse key match.
const NON_REPRODUCING_RE =
  /^<!-- pipeline-non-reproducing: ([0-9a-f]{8}) ([0-9a-fA-F]{40}) ([0-9a-f]{16}) -->$/m;

/**
 * The audited non-reproducing disposition comment (#391). Distinct heading and
 * sentinel from `overrideComment` — this disposition is machine-authored and
 * SHA-anchored, never an unconditional human clearance.
 */
export function nonReproducingDispositionComment(args: {
  key: string;
  reviewedSha: string;
  fingerprint: string;
  stage: string;
  justification: string;
  timestamp: string;
  footer?: string;
}): string {
  const { key, reviewedSha, fingerprint, stage, justification, timestamp, footer } = args;
  const rendered = [
    NON_REPRODUCING_HEADING,
    "",
    `**Finding**: \`${key}\``,
    `**Reviewed SHA**: \`${reviewedSha}\``,
    `**Stage**: ${stage}`,
    `**Recorded at**: ${timestamp}`,
    "",
    "### Justification (fix harness)",
    justification,
    "",
    "This disposition is machine-authored and SHA-anchored: it is consulted only " +
      "while the reviewed SHA is unchanged. A new commit re-opens the finding for review.",
    "",
    (footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- pipeline-non-reproducing: ${key} ${reviewedSha} ${fingerprint} -->`,
  ].join("\n");
  return attestPipelineComment("finding-does-not-reproduce", rendered);
}

// ---------------------------------------------------------------------------
// Needs-human-decision outcome (#473) — a bounded, machine-readable outcome
// for a no-commit fix round whose correct result is a human product/authority
// decision, not a code change. Distinct heading and sentinel from both
// `overrideComment` (an unconditional human clearance) and
// `nonReproducingDispositionComment` (a claim the finding's condition does not
// exist): this comment records that the finding remains open and blocking,
// and posts durable evidence for the human decision it is waiting on. Nothing
// reads its sentinel back to suppress or disposition the finding (#473 5.2).
// ---------------------------------------------------------------------------

const HUMAN_DECISION_HEADING = "## Pipeline: Human decision required";

/**
 * Neutralize untrusted harness-provided text before it is embedded as plain
 * text in any pipeline-authored sink (comment body or blocker reason): strip
 * newlines and HTML comment delimiters so this text cannot form a literal
 * `<!-- ... -->` marker that a later run's sentinel extractors could mistake
 * for a trusted override/non-reproducing/human-decision disposition (#473
 * review-2 finding a64f2252cd2dbd0a — every sink that renders this text must
 * use this same neutralization, not just the evidence comment).
 */
export function neutralizeSentinelText(text: string): string {
  return text
    .replace(/[\r\n]/g, " ")
    .replace(/<!--/g, "<!—")
    .replace(/-->/g, "—>");
}

/**
 * The audited needs-human-decision evidence comment (#473). Carries the
 * decision category, the one-line decision request, the finding's identity,
 * the reviewed SHA, and the stage — readable by a human and by the audit
 * trail. Posting this comment never resolves or suppresses the finding it
 * names.
 */
export function humanDecisionComment(args: {
  category: "product-decision" | "authority" | "external-dependency";
  key: string;
  fingerprint: string;
  reviewedSha: string;
  request: string;
  stage: string;
  timestamp: string;
  footer?: string;
}): string {
  const { category, key, fingerprint, reviewedSha, request, stage, timestamp, footer } = args;
  // Sanitize the harness-provided request before embedding it as plain text in the
  // attested comment (#473 review-1 finding b48e383e).
  const safeRequest = neutralizeSentinelText(request);
  const rendered = [
    HUMAN_DECISION_HEADING,
    "",
    `**Finding**: \`${key}\``,
    `**Category**: ${category}`,
    `**Reviewed SHA**: \`${reviewedSha}\``,
    `**Stage**: ${stage}`,
    `**Recorded at**: ${timestamp}`,
    "",
    "### Decision needed",
    safeRequest,
    "",
    "This outcome does NOT resolve or suppress the finding above, and does NOT " +
      "advance this item. The fix harness determined that the correct next step is a " +
      "human decision, not a code change. Resume through the existing `--unblock` / " +
      "`--override` flow once the decision is made.",
    "",
    (footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- pipeline-human-decision: ${key} ${fingerprint} ${reviewedSha} -->`,
  ].join("\n");
  return attestPipelineComment("needs-human-decision", rendered);
}

/**
 * Collect active non-reproducing dispositions from trusted-author comments as
 * key → `{ sha, fingerprint }[]` (every disposition recorded under that coarse
 * key, each anchored to the SHA and payload fingerprint it was declared
 * against). The coarse key (file + severity + 5-line band) can collide across
 * distinct findings, so multiple dispositions per key are preserved rather
 * than the later one overwriting the earlier — a consumer must match on both
 * SHA and fingerprint (#391 review-2 finding 53b23912), not key alone. Callers
 * MUST pre-filter `comments` to trusted authors (e.g. via
 * `buildTrustedOverrideComments`) before calling — mirrors the trust model of
 * `extractOverrides`.
 *
 * Security invariants (parallel to extractOverrides):
 * 1. Only comments with the `## Pipeline: Finding does not reproduce` heading are processed.
 * 2. Only the last non-empty line is parsed as the machine sentinel, EXCEPT that
 *    `nonReproducingDispositionComment` now appends a generic pipeline attestation
 *    (#471) after the non-reproducing sentinel; when the true last line is a valid
 *    `pipeline-attest` marker, it is stripped before applying the last-line check
 *    (mirroring `extractCeilingFollowupNumber`) so the sentinel underneath it is
 *    still the line that gets read.
 */
export function extractNonReproducingDispositions(
  comments: { body: string }[],
): Map<string, { sha: string; fingerprint: string }[]> {
  const map = new Map<string, { sha: string; fingerprint: string }[]>();
  for (const c of comments) {
    if (!c.body.startsWith(NON_REPRODUCING_HEADING)) continue;
    const lines = c.body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && isVerifiedPipelineAttestation(c.body)) {
      lines.pop();
    }
    const lastLine = lines.at(-1) ?? "";
    const m = NON_REPRODUCING_RE.exec(lastLine);
    if (!m) continue;
    const entry = { sha: m[2], fingerprint: m[3] };
    const existing = map.get(m[1]);
    if (existing) existing.push(entry);
    else map.set(m[1], [entry]);
  }
  return map;
}

/**
 * Parse a `--override` CLI argument. Accepts three forms:
 *
 *   "<key>: <reason>"                    → key disposition (existing behavior)
 *   "category:<name>: <reason>"          → category scope disposition (#229)
 *   "file:<path>: <reason>"              → file/path-prefix scope disposition (#229)
 *
 * For key dispositions, the key must be exactly 8 lowercase hex chars.
 * For scoped dispositions, the scope value must be non-empty and the reason
 * must be non-empty; the scope value is normalized (lowercase, trimmed).
 * An empty scope value or empty reason is rejected with a usage error.
 * Reason strings are normalized to a sentinel disposition token:
 * "deferred" (optionally "deferred-#N") or "rejected" (the default).
 */
export function parseOverrideArg(
  arg: string,
):
  | { kind: "key"; key: string; disposition: string; reason: string }
  | { kind: "scope"; scopeType: "category" | "file"; scopeValue: string; disposition: string; reason: string }
  | { error: string } {
  // Detect scope prefix: "category:" or "file:"
  const scopeType: "category" | "file" | null =
    arg.startsWith("category:") ? "category" : arg.startsWith("file:") ? "file" : null;

  if (scopeType !== null) {
    // Everything after "category:" / "file:"
    const rest = arg.slice(scopeType.length + 1);
    // Split on the first ": " to separate scope value from reason.
    const sep = rest.indexOf(": ");
    if (sep === -1) {
      return {
        error: `Scoped override must be "${scopeType}:<value>: <reason>" — got: ${arg}`,
      };
    }
    const scopeValue = rest.slice(0, sep).trim().toLowerCase();
    const reason = rest.slice(sep + 2).trim();
    if (!scopeValue) {
      return { error: `Scope value must not be empty — expected "${scopeType}:<name>: <reason>".` };
    }
    if (!reason) {
      return { error: "Override reason must not be empty." };
    }
    return { kind: "scope", scopeType, scopeValue, disposition: normalizeDisposition(reason), reason };
  }

  // Existing key logic: "<key>: <reason>"
  const colon = arg.indexOf(":");
  if (colon === -1) {
    return { error: `Override must be "<key>: <reason>" — got: ${arg}` };
  }
  const key = arg.slice(0, colon).trim().toLowerCase();
  const reason = arg.slice(colon + 1).trim();
  if (!isValidFindingKey(key)) {
    return { error: `Invalid finding key "${key}" — expected 8 hex chars (see the review comment).` };
  }
  if (!reason) {
    return { error: "Override reason must not be empty." };
  }
  return { kind: "key", key, disposition: normalizeDisposition(reason), reason };
}
