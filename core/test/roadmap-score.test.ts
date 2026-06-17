// Tests for roadmap/score.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateEffort,
  estimateImpact,
  estimateConfidence,
  estimateRiskReduction,
  computeDepLeverage,
  computePriority,
  scoreItems,
  applyDepAdjustment,
  sortRoadmapByTier,
} from "../scripts/roadmap/score.ts";
import type { InventoryItem, DepGraph, ScoreBreakdown, ScoreWeights } from "../scripts/roadmap/types.ts";

function emptyGraph(): DepGraph {
  return {
    must_precede: [],
    should_precede: [],
    parallel_safe: [],
    blocked_pending_decision: [],
    duplicate_merge: [],
    conflict_pairs: [],
    cycle_reports: [],
    open_questions: [],
  };
}

function makeItem(n: number, title = "", body = "", labels: string[] = []): InventoryItem {
  return {
    issue: { number: n, title, body, labels, url: "", state: "open" },
    touched_files: [],
  };
}

describe("estimateEffort", () => {
  it("returns 1 for trivial issues", () => {
    assert.equal(estimateEffort(makeItem(1, "Fix typo in README", "")), 1);
  });

  it("returns 5 for XL issues", () => {
    assert.equal(estimateEffort(makeItem(2, "Epic: rewrite auth system", "")), 5);
  });

  it("returns 3 by default", () => {
    assert.equal(estimateEffort(makeItem(3, "Add new endpoint", "Some description")), 3);
  });
});

describe("estimateImpact", () => {
  it("returns 5 for critical label", () => {
    assert.equal(estimateImpact(makeItem(1, "", "", ["critical"])), 5);
  });

  it("returns 4 for p1 label", () => {
    assert.equal(estimateImpact(makeItem(1, "", "", ["p1"])), 4);
  });

  it("returns 2 for cleanup in title", () => {
    assert.equal(estimateImpact(makeItem(1, "cleanup: remove dead code", "")), 2);
  });

  it("returns 3 by default", () => {
    assert.equal(estimateImpact(makeItem(1, "Add logging", "")), 3);
  });
});

describe("estimateConfidence", () => {
  it("returns 1 for empty body", () => {
    assert.equal(estimateConfidence(makeItem(1, "", "")), 1);
  });

  it("increases score for acceptance criteria", () => {
    const body = "## Summary\nX\n## Acceptance Criteria\n- [ ] task\n" + "x".repeat(100);
    const score = estimateConfidence(makeItem(1, "", body));
    assert.ok(score >= 4, `expected >= 4, got ${score}`);
  });
});

describe("estimateRiskReduction", () => {
  it("returns 5 for security issues", () => {
    assert.equal(estimateRiskReduction(makeItem(1, "Fix security vulnerability", "")), 5);
  });

  it("returns 1 for generic issues", () => {
    assert.equal(estimateRiskReduction(makeItem(1, "Add dark mode", "")), 1);
  });
});

describe("computeDepLeverage", () => {
  it("returns 1 for an issue that unblocks nothing", () => {
    const graph = emptyGraph();
    assert.equal(computeDepLeverage(1, graph), 1);
  });

  it("returns 2 when issue is a prerequisite for one other", () => {
    const graph = emptyGraph();
    // Edge convention: {from: prerequisite, to: depender}
    // Issue 1 must precede issue 2: edge {from:1, to:2}
    graph.must_precede.push({ from: 1, to: 2, file_line: "", rationale: "" });
    assert.equal(computeDepLeverage(1, graph), 2);
  });

  it("returns 5 when an issue is a prerequisite for 4+ others", () => {
    const graph = emptyGraph();
    // Issues 2,3,4,5 all depend on issue 1: edges {from:1, to:i}
    for (let i = 2; i <= 5; i++) {
      graph.must_precede.push({ from: 1, to: i, file_line: "", rationale: "" });
    }
    assert.equal(computeDepLeverage(1, graph), 5);
  });
});

describe("computePriority", () => {
  it("applies the formula: Impact×Confidence×Ease + RiskReduction + DepLeverage", () => {
    const breakdown: ScoreBreakdown = {
      impact: 3, confidence: 2, ease: 2, effort: 3,
      risk_reduction: 1, dep_leverage: 1,
    };
    const priority = computePriority(breakdown);
    assert.equal(priority, 3 * 2 * 2 + 1 + 1); // 12 + 1 + 1 = 14
  });

  it("applies weight overrides", () => {
    const breakdown: ScoreBreakdown = {
      impact: 3, confidence: 2, ease: 2, effort: 3,
      risk_reduction: 1, dep_leverage: 1,
    };
    const weights: ScoreWeights = { impact: 2 };
    const priority = computePriority(breakdown, weights);
    // (3×2) × 2 × 2 + 1 + 1 = 12 × 2 = 24 + 1 + 1 = 26
    assert.equal(priority, 3 * 2 * 2 * 2 + 1 + 1);
  });
});

describe("scoreItems", () => {
  it("returns one scored item per inventory item", () => {
    const items: InventoryItem[] = [makeItem(1), makeItem(2), makeItem(3)];
    const scored = scoreItems(items, emptyGraph());
    assert.equal(scored.length, 3);
  });

  it("produces non-negative priorities", () => {
    const items: InventoryItem[] = [makeItem(1, "Add feature", "## Summary\nDescription")];
    const scored = scoreItems(items, emptyGraph());
    assert.ok(scored[0].priority >= 0);
  });
});

describe("applyDepAdjustment", () => {
  it("regression: prerequisite (#1) appears before dependent (#2) in roadmap", () => {
    // Edge convention: {from: prerequisite, to: depender}
    // Issue 2 depends on issue 1 → edge {from:1, to:2} = "1 must precede 2"
    const items: InventoryItem[] = [makeItem(1), makeItem(2)];
    const graph: DepGraph = {
      ...emptyGraph(),
      must_precede: [{ from: 1, to: 2, file_line: "src/types.ts:1", rationale: "import" }],
    };
    const scored = scoreItems(items, graph);
    const roadmap = applyDepAdjustment(scored, items, graph);

    const rank1 = roadmap.find((r) => r.issue_number === 1)!.rank;
    const rank2 = roadmap.find((r) => r.issue_number === 2)!.rank;
    assert.ok(rank1 < rank2, `prerequisite (#1, rank ${rank1}) must come before dependent (#2, rank ${rank2})`);
  });

  it("assigns ranks starting at 1", () => {
    const items: InventoryItem[] = [makeItem(1), makeItem(2), makeItem(3)];
    const roadmap = applyDepAdjustment(scoreItems(items, emptyGraph()), items, emptyGraph());
    const ranks = roadmap.map((r) => r.rank).sort((a, b) => a - b);
    assert.deepEqual(ranks, [1, 2, 3]);
  });

  it("cleanup-last: refactor issue ranks after non-cleanup issues (same topo tier)", () => {
    const cleanupItem = makeItem(1, "cleanup: remove dead code", "Refactor old unused modules.");
    const featureItem = makeItem(2, "Add new API endpoint", "## Summary\nNew endpoint.\n## Acceptance Criteria\n- [ ] Done");
    const items = [cleanupItem, featureItem];
    const graph = emptyGraph();
    const scored = scoreItems(items, graph);
    const roadmap = applyDepAdjustment(scored, items, graph);

    const cleanupEntry = roadmap.find((r) => r.issue_number === 1)!;
    const featureEntry = roadmap.find((r) => r.issue_number === 2)!;
    assert.equal(cleanupEntry.tier, "cleanup", "refactor issue should be in cleanup tier");
    assert.ok(cleanupEntry.rank > featureEntry.rank,
      `cleanup (rank ${cleanupEntry.rank}) should rank after feature (rank ${featureEntry.rank})`);
  });

  it("enabler-first: issue unblocking 2+ others ranks before non-enablers (same topo tier)", () => {
    // Issue 1 is a prerequisite for issues 2 and 3 → qualifies as enabler
    const items = [makeItem(1, "Enable CI infrastructure"), makeItem(2, "Feature A"), makeItem(3, "Feature B")];
    const graph: DepGraph = {
      ...emptyGraph(),
      must_precede: [
        { from: 1, to: 2, file_line: "ci.yml:1", rationale: "unblocks" },
        { from: 1, to: 3, file_line: "ci.yml:1", rationale: "unblocks" },
      ],
    };
    const scored = scoreItems(items, graph);
    const roadmap = applyDepAdjustment(scored, items, graph);

    const enablerEntry = roadmap.find((r) => r.issue_number === 1)!;
    assert.equal(enablerEntry.tier, "enablers", "issue unblocking 2+ should be in enablers tier");
    assert.equal(enablerEntry.rank, 1, "enabler should be ranked first");
  });
});

describe("sortRoadmapByTier", () => {
  it("sorts enablers before dependency-unlock before high-value/low-risk", () => {
    const roadmap = [
      { rank: 1, issue_number: 1, title: "", tier: "larger-bets" as const, priority: 10, score_breakdown: { impact:1, confidence:1, ease:1, effort:1, risk_reduction:1, dep_leverage:1 }, dep_rationale: "", touched_files: [], effort: "M" as const, risks: [], unblocks: [], blocked_by: [] },
      { rank: 2, issue_number: 2, title: "", tier: "enablers" as const, priority: 5, score_breakdown: { impact:1, confidence:1, ease:1, effort:1, risk_reduction:1, dep_leverage:1 }, dep_rationale: "", touched_files: [], effort: "M" as const, risks: [], unblocks: [], blocked_by: [] },
    ];
    const sorted = sortRoadmapByTier(roadmap);
    assert.equal(sorted[0].tier, "enablers");
    assert.equal(sorted[1].tier, "larger-bets");
  });

  it("re-assigns sequential ranks after sorting", () => {
    const roadmap = [
      { rank: 1, issue_number: 1, title: "", tier: "cleanup" as const, priority: 1, score_breakdown: { impact:1, confidence:1, ease:1, effort:1, risk_reduction:1, dep_leverage:1 }, dep_rationale: "", touched_files: [], effort: "M" as const, risks: [], unblocks: [], blocked_by: [] },
      { rank: 2, issue_number: 2, title: "", tier: "enablers" as const, priority: 1, score_breakdown: { impact:1, confidence:1, ease:1, effort:1, risk_reduction:1, dep_leverage:1 }, dep_rationale: "", touched_files: [], effort: "M" as const, risks: [], unblocks: [], blocked_by: [] },
    ];
    const sorted = sortRoadmapByTier(roadmap);
    assert.deepEqual(sorted.map((r) => r.rank), [1, 2]);
    assert.equal(sorted[0].tier, "enablers"); // enablers first
  });
});
