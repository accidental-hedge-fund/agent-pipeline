// Tests for roadmap/depgraph.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  topoSort,
  findTextualDepCandidates,
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
  it("detects 'depends on #N' in issue body", () => {
    const items: InventoryItem[] = [
      makeItem(10, "This issue depends on #5 to be completed first."),
      makeItem(5, "Stand-alone issue."),
    ];
    const candidates = findTextualDepCandidates(items);
    assert.ok(candidates.some(([from, to]) => from === 10 && to === 5));
  });

  it("detects 'requires #N' in issue body", () => {
    const items: InventoryItem[] = [
      makeItem(20, "Requires #15 for the shared types."),
      makeItem(15, "Provides the shared types."),
    ];
    const candidates = findTextualDepCandidates(items);
    assert.ok(candidates.some(([from, to]) => from === 20 && to === 15));
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

  it("promotes textually-confirmed strong edge to must_precede", async () => {
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
    assert.ok(graph.must_precede.some((e) => e.from === 10 && e.to === 5));
    assert.deepEqual(graph.cycle_reports, []);
  });

  it("promotes textually-confirmed weak edge to should_precede", async () => {
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
    assert.ok(graph.should_precede.some((e) => e.from === 10 && e.to === 5));
    assert.deepEqual(graph.must_precede, []);
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
