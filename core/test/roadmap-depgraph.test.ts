// Tests for roadmap/depgraph.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  topoSort,
  findTextualDepCandidates,
  findFileBasedDepCandidates,
  parseDepVerifyResult,
  buildDepgraph,
  addMustPrecedeEdges,
} from "../scripts/roadmap/depgraph.ts";
import type { InventoryItem, DepEdge } from "../scripts/roadmap/types.ts";
import type { DepgraphDeps } from "../scripts/roadmap/depgraph.ts";

function makeItem(n: number, body = ""): InventoryItem {
  return {
    issue: {
      number: n,
      title: `Issue ${n}`,
      body,
      labels: [],
      url: `https://github.com/example/repo/issues/${n}`,
      state: "open",
    },
    touched_files: [],
  };
}

describe("topoSort", () => {
  it("returns a single tier for issues with no edges", () => {
    const { tiers, cycleReports } = topoSort([1, 2, 3], []);
    assert.equal(tiers.length, 1);
    assert.deepEqual(tiers[0].sort(), [1, 2, 3]);
    assert.deepEqual(cycleReports, []);
  });

  it("produces correct tier ordering for a chain A→B→C", () => {
    // Edge: A must precede B, B must precede C
    const edges: DepEdge[] = [
      { from: 1, to: 2, file_line: "", rationale: "" },
      { from: 2, to: 3, file_line: "", rationale: "" },
    ];
    const { tiers, cycleReports } = topoSort([1, 2, 3], edges);
    assert.deepEqual(cycleReports, []);
    // tier 0 = [1], tier 1 = [2], tier 2 = [3]
    assert.equal(tiers.length, 3);
    assert.deepEqual(tiers[0], [1]);
    assert.deepEqual(tiers[1], [2]);
    assert.deepEqual(tiers[2], [3]);
  });

  it("detects a cycle and reports it instead of silently breaking", () => {
    const edges: DepEdge[] = [
      { from: 1, to: 2, file_line: "", rationale: "" },
      { from: 2, to: 1, file_line: "", rationale: "" }, // cycle
    ];
    const { tiers, cycleReports } = topoSort([1, 2], edges);
    assert.ok(cycleReports.length > 0, "should report a cycle");
    assert.ok(cycleReports[0].issues.length > 0, "cycle should include the affected issues");
  });

  it("handles issues not in any edge (isolated nodes)", () => {
    const edges: DepEdge[] = [{ from: 1, to: 2, file_line: "", rationale: "" }];
    const { tiers } = topoSort([1, 2, 3], edges); // 3 is isolated
    const allNumbers = tiers.flat().sort();
    assert.deepEqual(allNumbers, [1, 2, 3]);
  });
});

describe("findTextualDepCandidates", () => {
  it("returns [prerequisite, depender] pairs: 'depends on #5' → #5 before #10", () => {
    const items: InventoryItem[] = [
      makeItem(10, "This issue depends on #5 to be completed first."),
      makeItem(5, "Stand-alone issue."),
    ];
    const candidates = findTextualDepCandidates(items);
    // #5 is the prerequisite, #10 is the depender → pair [5, 10]
    assert.ok(candidates.some(([prereq, depender]) => prereq === 5 && depender === 10),
      "prerequisite (#5) should be first, depender (#10) should be second");
  });

  it("detects 'requires #N' in issue body with correct [prerequisite, depender] order", () => {
    const items: InventoryItem[] = [
      makeItem(20, "Requires #15 for the shared types."),
      makeItem(15, "Provides the shared types."),
    ];
    const candidates = findTextualDepCandidates(items);
    // #15 is the prerequisite, #20 is the depender → pair [15, 20]
    assert.ok(candidates.some(([prereq, depender]) => prereq === 15 && depender === 20));
  });

  it("ignores references to issues not in the backlog", () => {
    const items: InventoryItem[] = [makeItem(1, "Depends on #999")];
    const candidates = findTextualDepCandidates(items);
    assert.deepEqual(candidates, []);
  });

  it("does not self-reference", () => {
    const items: InventoryItem[] = [makeItem(3, "Depends on #3 for clarity (self-ref).")];
    const candidates = findTextualDepCandidates(items);
    assert.deepEqual(candidates, []);
  });
});

describe("parseDepVerifyResult", () => {
  it("parses a valid confirmed edge", () => {
    const output = JSON.stringify({
      edge_confirmed: true,
      file_line: "core/scripts/config.ts:42",
      rationale: "Config key A depends on schema from B.",
      is_strong: true,
    });
    const result = parseDepVerifyResult(output);
    assert.ok(result !== null);
    assert.equal(result!.edge_confirmed, true);
    assert.equal(result!.is_strong, true);
    assert.equal(result!.file_line, "core/scripts/config.ts:42");
  });

  it("parses an unconfirmed edge", () => {
    const output = JSON.stringify({
      edge_confirmed: false,
      file_line: "",
      rationale: "No source coupling found.",
      is_strong: false,
    });
    const result = parseDepVerifyResult(output);
    assert.ok(result !== null);
    assert.equal(result!.edge_confirmed, false);
  });

  it("returns null for unparseable output", () => {
    const result = parseDepVerifyResult("I cannot determine the dependency.");
    assert.equal(result, null);
  });

  it("returns null when edge_confirmed is not boolean", () => {
    const result = parseDepVerifyResult(JSON.stringify({ edge_confirmed: "yes", file_line: "", rationale: "", is_strong: false }));
    assert.equal(result, null);
  });
});

describe("findFileBasedDepCandidates", () => {
  it("generates candidate pairs for issues sharing touched files", () => {
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts", "core/bar.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
      { issue: { number: 3, title: "C", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/baz.ts"] },
    ];
    const candidates = findFileBasedDepCandidates(items, []);
    assert.ok(candidates.some(([a, b]) => (a === 1 && b === 2) || (a === 2 && b === 1)),
      "issues 1 and 2 share core/foo.ts — should be a candidate pair");
    assert.ok(!candidates.some(([a, b]) => (a === 1 && b === 3) || (a === 3 && b === 1)),
      "issues 1 and 3 share no files — should not be a candidate pair");
  });

  it("skips pairs already in existing textual candidates", () => {
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
    ];
    const existing: Array<[number, number]> = [[1, 2]];
    const candidates = findFileBasedDepCandidates(items, existing);
    assert.equal(candidates.length, 0, "pair 1→2 already exists in textual candidates");
  });

  it("returns empty for items with no shared files", () => {
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["a.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["b.ts"] },
    ];
    const candidates = findFileBasedDepCandidates(items, []);
    assert.deepEqual(candidates, []);
  });
});

describe("buildDepgraph", () => {
  it("returns empty graph for empty backlog", async () => {
    const deps: DepgraphDeps = {
      runHarness: async () => ({ success: true, output: "{}" }),
      readFile: async () => null,
      log: () => {},
    };
    const graph = await buildDepgraph([], deps);
    assert.deepEqual(graph.must_precede, []);
    assert.deepEqual(graph.should_precede, []);
    assert.deepEqual(graph.cycle_reports, []);
  });

  it("promotes textually-confirmed strong edge to must_precede with correct direction", async () => {
    const items: InventoryItem[] = [
      makeItem(10, "This issue depends on #5."),
      makeItem(5, "Foundation issue."),
    ];

    const confirmResult = JSON.stringify({
      edge_confirmed: true,
      file_line: "src/main.ts:10",
      rationale: "Direct import",
      is_strong: true,
    });

    const deps: DepgraphDeps = {
      runHarness: async () => ({ success: true, output: confirmResult }),
      readFile: async () => null,
      log: () => {},
    };

    const graph = await buildDepgraph(items, deps);
    // Edge convention: {from: prerequisite, to: depender} — #5 must precede #10
    assert.ok(graph.must_precede.some((e) => e.from === 5 && e.to === 10),
      "prerequisite (#5) should be 'from', depender (#10) should be 'to'");
    assert.deepEqual(graph.cycle_reports, []);
  });

  it("promotes textually-confirmed weak edge to should_precede with correct direction", async () => {
    const items: InventoryItem[] = [
      makeItem(10, "This issue depends on #5."),
      makeItem(5, "Foundation issue."),
    ];

    const weakResult = JSON.stringify({
      edge_confirmed: true,
      file_line: "src/main.ts:10",
      rationale: "Advisory coupling",
      is_strong: false,
    });

    const deps: DepgraphDeps = {
      runHarness: async () => ({ success: true, output: weakResult }),
      readFile: async () => null,
      log: () => {},
    };

    const graph = await buildDepgraph(items, deps);
    assert.ok(graph.should_precede.some((e) => e.from === 5 && e.to === 10));
    assert.deepEqual(graph.must_precede, []);
  });

  it("source-verifies file-based candidates without textual hint", async () => {
    // Issues share touched files but issue bodies don't mention each other
    const items: InventoryItem[] = [
      {
        issue: { number: 1, title: "Add type T", body: "Add a new type.", labels: [], url: "", state: "open" },
        touched_files: ["core/types.ts"],
      },
      {
        issue: { number: 2, title: "Use type T", body: "Use the new type.", labels: [], url: "", state: "open" },
        touched_files: ["core/types.ts", "core/consumer.ts"],
      },
    ];

    const confirmResult = JSON.stringify({
      edge_confirmed: true,
      file_line: "core/types.ts:1",
      rationale: "Consumer imports type from provider",
      is_strong: true,
    });

    const deps: DepgraphDeps = {
      runHarness: async () => ({ success: true, output: confirmResult }),
      readFile: async () => "export type T = string;",
      log: () => {},
    };

    const graph = await buildDepgraph(items, deps);
    // The file-based candidate should have been source-verified and promoted
    assert.ok(graph.must_precede.length > 0, "file-based candidate should be promoted to must_precede");
  });

  it("puts unverified candidates in open_questions", async () => {
    const items: InventoryItem[] = [
      makeItem(10, "This issue depends on #5."),
      makeItem(5, "Foundation issue."),
    ];

    const unverifiedResult = JSON.stringify({
      edge_confirmed: false,
      file_line: "",
      rationale: "No source coupling found",
      is_strong: false,
    });

    const deps: DepgraphDeps = {
      runHarness: async () => ({ success: true, output: unverifiedResult }),
      readFile: async () => null,
      log: () => {},
    };

    const graph = await buildDepgraph(items, deps);
    assert.deepEqual(graph.must_precede, []);
    assert.ok(graph.open_questions.length > 0, "unverified edge should be in open_questions");
  });

  it("regression: topoSort with must_precede ranks prerequisite before dependent", () => {
    // "#10 depends on #5" → edge {from:5, to:10} → topoSort puts #5 in tier 0, #10 in tier 1
    const edges: DepEdge[] = [{ from: 5, to: 10, file_line: "src/main.ts:1", rationale: "import" }];
    const { tiers, cycleReports } = topoSort([5, 10], edges);
    assert.deepEqual(cycleReports, []);
    assert.equal(tiers[0][0], 5, "#5 (prerequisite) must be in tier 0");
    assert.equal(tiers[1][0], 10, "#10 (depender) must be in tier 1");
  });
});

describe("addMustPrecedeEdges", () => {
  it("merges new edges and returns updated graph", () => {
    const graph = {
      must_precede: [{ from: 1, to: 2, file_line: "", rationale: "" }],
      should_precede: [],
      parallel_safe: [] as [number, number][],
      blocked_pending_decision: [],
      duplicate_merge: [] as [number, number][],
      conflict_pairs: [] as [number, number][],
      cycle_reports: [],
      open_questions: [],
    };
    const newEdges: DepEdge[] = [{ from: 2, to: 3, file_line: "", rationale: "critique correction" }];
    const updated = addMustPrecedeEdges(graph, newEdges, [1, 2, 3]);
    assert.equal(updated.must_precede.length, 2);
    assert.ok(updated.must_precede.some((e) => e.from === 2 && e.to === 3));
  });
});
