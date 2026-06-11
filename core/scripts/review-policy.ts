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
 * Stable short key for a finding so an operator can reference one specific
 * finding in an override. Content-addressed (severity|file|title) so it is
 * stable across review rounds: a reviewer that re-emits the same finding on a
 * later commit produces the same key, and a prior override keeps applying.
 */
export function findingKey(f: Pick<ReviewFinding, "severity" | "file" | "title">): string {
  const basis = `${f.severity ?? "medium"}|${f.file ?? ""}|${f.title ?? ""}`;
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
 */
export function partitionFindings(
  findings: ReviewFinding[],
  policy: ReviewPolicy,
  overrides: Map<string, string> = new Map(),
): PartitionResult {
  const threshold = severityRank(policy.block_threshold);
  const result: PartitionResult = { blocking: [], advisory: [], overridden: [] };

  for (const f of findings) {
    const key = findingKey(f);
    if (overrides.has(key)) {
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
