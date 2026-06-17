// Phase 4 + 5: Scoring and roadmap tier production.
// All logic is pure (no I/O) so unit tests don't need fakes.

import type {
  InventoryItem,
  DepGraph,
  ScoredItem,
  ScoreWeights,
  ScoreBreakdown,
  Tier,
  EffortSize,
  RoadmapEntry,
  IssueNumber,
} from "./types.ts";
import { topoSort } from "./depgraph.ts";

const EFFORT_TO_EASE: Record<number, number> = { 1: 4, 2: 3, 3: 2, 4: 1, 5: 0 };

/**
 * Estimate effort from issue body/title heuristics.
 * Returns 1–5 (1=XS, 5=XL). Default is 3 (M).
 */
export function estimateEffort(item: InventoryItem): number {
  const text = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
  if (/\bxl\b|very large|epic|quarter|months/.test(text)) return 5;
  if (/\blarge\b|major refactor|\bl\b effort/.test(text)) return 4;
  if (/\bsmall\b|\bxs\b|trivial|one.liner|typo|rename/.test(text)) return 1;
  if (/\bquick\b|\bs\b effort|straightforward|minor/.test(text)) return 2;
  return 3; // default M
}

/**
 * Estimate impact from issue labels, title keywords.
 * Returns 1–5.
 */
export function estimateImpact(item: InventoryItem): number {
  const labels = item.issue.labels.map((l) => l.toLowerCase());
  const text = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
  if (labels.some((l) => l.includes("critical") || l.includes("p0"))) return 5;
  if (labels.some((l) => l.includes("high") || l.includes("p1"))) return 4;
  if (labels.some((l) => l.includes("low") || l.includes("p3"))) return 2;
  if (/security|data.loss|outage|regression|crash/.test(text)) return 5;
  if (/performance|reliability|major feature/.test(text)) return 4;
  if (/cleanup|refactor|docs/.test(text)) return 2;
  return 3;
}

/**
 * Estimate confidence based on how well-defined the issue is.
 * Returns 1–5.
 */
export function estimateConfidence(item: InventoryItem): number {
  const body = item.issue.body;
  if (!body || body.trim().length < 50) return 1;
  // Check for structure markers
  let score = 2;
  if (/##\s+acceptance criteria/i.test(body)) score++;
  if (/##\s+summary/i.test(body)) score++;
  if (/- \[ \]/.test(body)) score++;
  return Math.min(score, 5);
}

/**
 * Estimate risk reduction (how much technical debt / risk does this fix).
 * Returns 1–5.
 */
export function estimateRiskReduction(item: InventoryItem): number {
  const text = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
  if (/security|auth|vulnerability|exploit/.test(text)) return 5;
  if (/data.loss|corruption|race.condition|deadlock/.test(text)) return 4;
  if (/memory.leak|performance|timeout|retry/.test(text)) return 3;
  if (/deprecat|migration|upgrade/.test(text)) return 3;
  return 1;
}

/**
 * Compute dep_leverage: how many issues does this unblock?
 * Returns a score 1–5 based on unblock count.
 * Edge convention: {from: prerequisite, to: depender} — edges where from===issueNumber
 * mean this issue is a prerequisite for other issues (i.e., it unblocks them).
 */
export function computeDepLeverage(issueNumber: IssueNumber, graph: DepGraph): number {
  const unblocks = graph.must_precede.filter((e) => e.from === issueNumber).length;
  if (unblocks >= 4) return 5;
  if (unblocks === 3) return 4;
  if (unblocks === 2) return 3;
  if (unblocks === 1) return 2;
  return 1;
}

const EFFORT_LABELS: Record<number, EffortSize> = {
  1: "XS",
  2: "S",
  3: "M",
  4: "L",
  5: "XL",
};

/**
 * Compute priority score using the formula:
 * Priority = (Impact × Confidence × Ease) + RiskReduction + DepLeverage
 * with optional weight overrides.
 */
export function computePriority(breakdown: ScoreBreakdown, weights: ScoreWeights = {}): number {
  const wImpact = weights.impact ?? 1;
  const wConfidence = weights.confidence ?? 1;
  const wEase = weights.ease ?? 1;
  const wRisk = weights.risk_reduction ?? 1;
  const wDep = weights.dep_leverage ?? 1;

  return (
    breakdown.impact * wImpact *
    breakdown.confidence * wConfidence *
    breakdown.ease * wEase +
    breakdown.risk_reduction * wRisk +
    breakdown.dep_leverage * wDep
  );
}

/**
 * Score all inventory items against the dependency graph.
 */
export function scoreItems(
  items: InventoryItem[],
  graph: DepGraph,
  weights: ScoreWeights = {},
): ScoredItem[] {
  return items.map((item): ScoredItem => {
    const effort = estimateEffort(item);
    const ease = EFFORT_TO_EASE[effort] ?? 2;
    const breakdown: ScoreBreakdown = {
      impact: estimateImpact(item),
      confidence: estimateConfidence(item),
      ease,
      effort,
      risk_reduction: estimateRiskReduction(item),
      dep_leverage: computeDepLeverage(item.issue.number, graph),
    };
    const priority = computePriority(breakdown, weights);

    return {
      issue_number: item.issue.number,
      priority,
      score_breakdown: breakdown,
      tier: "high-value/low-risk", // placeholder; tier set by applyDepAdjustment
      effort: EFFORT_LABELS[effort] ?? "M",
      risks: extractRisks(item),
      dep_rationale: buildDepRationale(item.issue.number, graph),
      touched_files: item.touched_files,
    };
  });
}

function extractRisks(item: InventoryItem): string[] {
  const risks: string[] = [];
  const text = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
  if (/breaking.change|backwards.compat|migration/.test(text)) {
    risks.push("May require migration");
  }
  if (/performance/.test(text)) {
    risks.push("Performance impact uncertain");
  }
  if (/security/.test(text)) {
    risks.push("Security-sensitive change");
  }
  if (item.touched_files.length > 10) {
    risks.push("Wide blast radius");
  }
  return risks;
}

function buildDepRationale(issueNumber: IssueNumber, graph: DepGraph): string {
  // Edge convention: {from: prerequisite, to: depender}
  // "blocked by" = this issue is a depender, so edges where to === issueNumber; prerequisite = from
  const blockedBy = graph.must_precede
    .filter((e) => e.to === issueNumber)
    .map((e) => `#${e.from}`);
  // "unblocks" = this issue is a prerequisite, so edges where from === issueNumber; depender = to
  const unblocks = graph.must_precede
    .filter((e) => e.from === issueNumber)
    .map((e) => `#${e.to}`);

  const parts: string[] = [];
  if (blockedBy.length > 0) parts.push(`Blocked by: ${blockedBy.join(", ")}`);
  if (unblocks.length > 0) parts.push(`Unblocks: ${unblocks.join(", ")}`);
  return parts.join("; ") || "No hard dependencies";
}

/**
 * Assign tier based on issue characteristics and dep graph position.
 */
function assignTier(
  issueNumber: IssueNumber,
  item: InventoryItem,
  graph: DepGraph,
  topoTier: number,
  scored: ScoredItem,
): Tier {
  // Edge convention: {from: prerequisite, to: depender}
  // "isEnablerByDeps" = this issue is a prerequisite for 2+ others = many edges where from===issueNumber
  const isEnablerByDeps =
    graph.must_precede.filter((e) => e.from === issueNumber).length >= 2;
  // "hasNoDeps" = this issue has no prerequisites = no edges where to===issueNumber
  const hasNoDeps = graph.must_precede.filter((e) => e.to === issueNumber).length === 0;
  const text = `${item.issue.title}\n${item.issue.body}`.toLowerCase();
  const isCleanup = /refactor|cleanup|deprecat|tech.debt|remove.dead/.test(text);
  const isResearch = /spike|research|investigate|explore/.test(text);

  if (isCleanup) return "cleanup";
  if (isResearch) return "larger-bets";
  if (isEnablerByDeps && hasNoDeps) return "enablers";
  if (topoTier === 0 && scored.score_breakdown.dep_leverage >= 2) return "dependency-unlock";
  if (scored.priority >= 30) return "high-value/low-risk";
  if (scored.priority >= 15) return "high-value/low-risk";
  return "larger-bets";
}

/**
 * Apply dependency ordering to produce tiered roadmap entries.
 * A dependent MUST NOT appear before its must_precede prerequisite.
 * Within the same topo tier, items are ordered by canonical tier then priority.
 */
export function applyDepAdjustment(
  scored: ScoredItem[],
  items: InventoryItem[],
  graph: DepGraph,
): RoadmapEntry[] {
  const { tiers: topoTiers } = topoSort(
    scored.map((s) => s.issue_number),
    graph.must_precede,
  );

  // Map issue → topo tier index (lower = earlier)
  const topoTierMap = new Map<IssueNumber, number>();
  topoTiers.forEach((tier, idx) => {
    for (const n of tier) topoTierMap.set(n, idx);
  });

  const itemByNumber = new Map(items.map((i) => [i.issue.number, i]));

  const TIER_ORDER: Tier[] = ["enablers", "dependency-unlock", "high-value/low-risk", "larger-bets", "cleanup"];

  // Two-pass: first assign canonical tiers (needs topo tier info), then sort
  const withTiers = scored.map((s) => {
    const item = itemByNumber.get(s.issue_number)!;
    const topoTierIdx = topoTierMap.get(s.issue_number) ?? 0;
    const tier = assignTier(s.issue_number, item, graph, topoTierIdx, s);
    return { s, tier, topoTierIdx };
  });

  // Sort by: topo tier first (hard dep constraint), then canonical tier, then priority desc
  withTiers.sort((a, b) => {
    if (a.topoTierIdx !== b.topoTierIdx) return a.topoTierIdx - b.topoTierIdx;
    const ta = TIER_ORDER.indexOf(a.tier);
    const tb = TIER_ORDER.indexOf(b.tier);
    if (ta !== tb) return ta - tb;
    return b.s.priority - a.s.priority;
  });

  return withTiers.map(({ s, tier }, idx): RoadmapEntry => {
    const item = itemByNumber.get(s.issue_number)!;

    // Edge convention: {from: prerequisite, to: depender}
    // "unblocks" = this issue is a prerequisite; edges where from===issueNumber → dependers
    const unblocks = graph.must_precede
      .filter((e) => e.from === s.issue_number)
      .map((e) => e.to);
    // "blocked_by" = this issue is a depender; edges where to===issueNumber → prerequisites
    const blocked_by = graph.must_precede
      .filter((e) => e.to === s.issue_number)
      .map((e) => e.from);

    return {
      rank: idx + 1,
      issue_number: s.issue_number,
      title: item.issue.title,
      tier,
      priority: s.priority,
      score_breakdown: s.score_breakdown,
      dep_rationale: s.dep_rationale,
      touched_files: s.touched_files,
      effort: s.effort,
      risks: s.risks,
      unblocks,
      blocked_by,
    };
  });
}

/**
 * Sort roadmap entries by tier (canonical tier order) then priority.
 * Used after critique corrections to re-sort.
 */
export function sortRoadmapByTier(entries: RoadmapEntry[]): RoadmapEntry[] {
  const TIER_ORDER: Tier[] = ["enablers", "dependency-unlock", "high-value/low-risk", "larger-bets", "cleanup"];
  const sorted = [...entries].sort((a, b) => {
    const ta = TIER_ORDER.indexOf(a.tier);
    const tb = TIER_ORDER.indexOf(b.tier);
    if (ta !== tb) return ta - tb;
    return b.priority - a.priority;
  });
  return sorted.map((e, idx) => ({ ...e, rank: idx + 1 }));
}
