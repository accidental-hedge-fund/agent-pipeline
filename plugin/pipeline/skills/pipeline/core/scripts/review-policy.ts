// Review severity policy + audited overrides (#17).
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
//
// Default policy (`block_threshold: "low"`, `min_confidence: 0`) reproduces the
// pre-#17 behavior exactly: every finding blocks.

import { createHash } from "node:crypto";
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

export interface PartitionResult {
  /** Findings that block: at/above threshold, at/above confidence, not overridden. */
  blocking: ReviewFinding[];
  /** Below the severity threshold or confidence floor — recorded, not blocking. */
  advisory: { finding: ReviewFinding; reason: string }[];
  /** Operator-dispositioned via a `pipeline-override` sentinel — not blocking. */
  overridden: { finding: ReviewFinding; key: string; disposition: string }[];
}

/**
 * Partition review findings into blocking / advisory / overridden under the
 * given policy and the set of active operator overrides (key → disposition).
 * Override takes precedence over the severity/confidence test so an explicit
 * human disposition always wins.
 *
 * Ambiguity guard (#144): an override is only applied when the current verdict
 * has exactly one *distinct blocking candidate* for that key. A "blocking
 * candidate" meets the severity threshold and confidence floor; "distinct"
 * means unique after normalizeTitle (exact duplicate payloads collapse to one).
 * Advisory findings and duplicate titles are excluded from the count so they
 * cannot create false ambiguity and cause a valid override to lapse.
 */
export function partitionFindings(
  findings: ReviewFinding[],
  policy: ReviewPolicy,
  overrides: Map<string, string> = new Map(),
): PartitionResult {
  const threshold = severityRank(policy.block_threshold);
  const result: PartitionResult = { blocking: [], advisory: [], overridden: [] };

  // Pre-classify: for each key, collect the set of distinct normalized titles
  // among blocking candidates only. Advisory findings and exact-duplicate titles
  // are not counted as distinct candidates and cannot trigger ambiguity.
  const blockingTitlesByKey = new Map<string, Set<string>>();
  for (const f of findings) {
    const isAboveSeverity = severityRank(f.severity) >= threshold;
    const isAboveConfidence = typeof f.confidence !== "number" || f.confidence >= policy.min_confidence;
    if (isAboveSeverity && isAboveConfidence) {
      const k = findingKey(f);
      if (!blockingTitlesByKey.has(k)) blockingTitlesByKey.set(k, new Set());
      blockingTitlesByKey.get(k)!.add(normalizeTitle(f.title));
    }
  }

  for (const f of findings) {
    const key = findingKey(f);
    const isBlockingCandidate =
      severityRank(f.severity) >= threshold &&
      (typeof f.confidence !== "number" || f.confidence >= policy.min_confidence);
    const distinctBlockers = blockingTitlesByKey.get(key)?.size ?? 0;
    const isAmbiguous = distinctBlockers > 1;

    if (overrides.has(key) && isBlockingCandidate && !isAmbiguous) {
      result.overridden.push({ finding: f, key, disposition: overrides.get(key)! });
      continue;
    }
    const belowSeverity = severityRank(f.severity) < threshold;
    const belowConfidence =
      typeof f.confidence === "number" && f.confidence < policy.min_confidence;
    if (belowSeverity || belowConfidence) {
      const reasons: string[] = [];
      if (belowSeverity) reasons.push(`severity ${f.severity} below threshold ${policy.block_threshold}`);
      if (belowConfidence) reasons.push(`confidence ${f.confidence} below ${policy.min_confidence}`);
      result.advisory.push({ finding: f, reason: reasons.join("; ") });
    } else {
      result.blocking.push(f);
    }
  }
  return result;
}

// Machine-readable override sentinel, mirroring the `reviewed-sha` precedent
// (#16). Anchored to line-start; the disposition token is recorded for display.
// Global flag so a single comment can carry several overrides; callers reset
// lastIndex before/after iterating.
const OVERRIDE_RE = /^<!-- pipeline-override: ([0-9a-f]{8}) (.+?) -->$/gm;

/**
 * Collect active overrides from issue/PR comments as key → disposition text.
 * A later override for the same key wins (lets a human revise a disposition).
 */
export function extractOverrides(comments: { body: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of comments) {
    OVERRIDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OVERRIDE_RE.exec(c.body)) !== null) {
      map.set(m[1], m[2].trim());
    }
  }
  OVERRIDE_RE.lastIndex = 0;
  return map;
}

/** Validate an operator-supplied finding key (8 lowercase hex chars). */
export function isValidFindingKey(key: string): boolean {
  return /^[0-9a-f]{8}$/.test(key);
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
  return [
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
}

/**
 * Parse a `--override` CLI argument of the form `<key>: <reason>` where the
 * reason may begin with a disposition word (`rejected` / `deferred [#N]`).
 * Returns the key, a normalized one-word disposition token for the sentinel,
 * and the full human reason for the audit comment.
 */
export function parseOverrideArg(
  arg: string,
): { key: string; disposition: string; reason: string } | { error: string } {
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
  // Normalize a sentinel disposition token: "deferred" (optionally "deferred-#N")
  // or "rejected"; default to "rejected" when the reason doesn't lead with one.
  const lower = reason.toLowerCase();
  let disposition = "rejected";
  if (lower.startsWith("deferred")) {
    const ref = reason.match(/#(\d+)/);
    disposition = ref ? `deferred-#${ref[1]}` : "deferred";
  } else if (lower.startsWith("rejected")) {
    disposition = "rejected";
  }
  return { key, disposition, reason };
}
