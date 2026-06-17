// Tests for roadmap/depgraph.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  topoSort,
  findTextualDepCandidates,
  findFileBasedDepCandidates,
  findCrossFileDepCandidates,
  parseDepVerifyResult,
  buildDepVerifyPrompt,
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

  it("skips the specific direction already in existing candidates, but generates the reverse", () => {
    // If [1,2] is already a textual candidate, findFileBasedDepCandidates should skip [1,2]
    // but still generate [2,1] so both directions are source-verified.
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
    ];
    const existing: Array<[number, number]> = [[1, 2]];
    const candidates = findFileBasedDepCandidates(items, existing);
    // [1,2] is already covered; [2,1] is new and should be generated
    assert.ok(!candidates.some(([a, b]) => a === 1 && b === 2), "should not re-generate pair 1→2 (already in existing)");
    assert.ok(candidates.some(([a, b]) => a === 2 && b === 1), "should generate reverse pair 2→1 (new direction)");
  });

  it("skips both directions only when both are already in existing candidates", () => {
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
    ];
    const existing: Array<[number, number]> = [[1, 2], [2, 1]];
    const candidates = findFileBasedDepCandidates(items, existing);
    assert.equal(candidates.length, 0, "both directions already covered — no new candidates");
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

describe("buildDepVerifyPrompt — prompt direction regression", () => {
  it("asks whether the DEPENDER depends on the PREREQUISITE (not the reverse)", async () => {
    // Regression for review finding #1: the old prompt asked "does A depend on B" where A was
    // the prerequisite and B was the depender — semantically backwards.
    // When '#10 depends on #5', the prerequisite is #5 and the depender is #10.
    // The prompt must ask: 'can #10 (depender) be completed without #5 (prerequisite)?'
    const prereq: InventoryItem = {
      issue: { number: 5, title: "Shared types", body: "Provides shared types.", labels: [], url: "", state: "open" },
      touched_files: ["core/types.ts"],
    };
    const depender: InventoryItem = {
      issue: { number: 10, title: "Consumer", body: "Depends on #5 for types.", labels: [], url: "", state: "open" },
      touched_files: ["core/consumer.ts"],
    };
    const deps = {
      runHarness: async () => ({ success: true, output: "{}" }),
      readFile: async () => null,
      log: () => {},
    };

    const prompt = await buildDepVerifyPrompt(prereq, depender, deps);
    // The prompt must say depender (#10) cannot be completed without prerequisite (#5)
    assert.ok(
      prompt.includes("#10") && prompt.includes("#5"),
      "prompt must reference both issue numbers",
    );
    assert.ok(
      /whether issue #10 depends on issue #5/i.test(prompt) ||
      /#10.*CANNOT be completed without #5/i.test(prompt) ||
      /#10 \(depender\).*#5 \(prerequisite\)/i.test(prompt),
      `prompt should ask if #10 (depender) depends on #5 (prerequisite), got: ${prompt.slice(0, 300)}`,
    );
    // Must NOT ask if the prerequisite (#5) cannot be completed without the depender (#10)
    assert.ok(
      !/whether issue #5.*CANNOT be completed without #10/i.test(prompt),
      "prompt must NOT ask if the prerequisite depends on the depender",
    );
  });

  it("includes files from both prerequisite and depender for cross-file detection", async () => {
    const prereq: InventoryItem = {
      issue: { number: 1, title: "Add types", body: "Creates types.ts.", labels: [], url: "", state: "open" },
      touched_files: ["core/types.ts"],
    };
    const depender: InventoryItem = {
      issue: { number: 2, title: "Use types", body: "Imports from types.", labels: [], url: "", state: "open" },
      touched_files: ["core/consumer.ts"],
    };
    const filesRead: string[] = [];
    const deps = {
      runHarness: async () => ({ success: true, output: "{}" }),
      readFile: async (f: string) => { filesRead.push(f); return `// ${f} content`; },
      log: () => {},
    };

    await buildDepVerifyPrompt(prereq, depender, deps);
    // Should read files from BOTH issues, not just shared files
    assert.ok(filesRead.includes("core/types.ts"), "should read prerequisite's files");
    assert.ok(filesRead.includes("core/consumer.ts"), "should read depender's files");
  });
});

describe("findFileBasedDepCandidates — both-direction regression", () => {
  it("generates BOTH directions for a shared-file pair (not just one)", () => {
    const items: InventoryItem[] = [
      { issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
      { issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" }, touched_files: ["core/foo.ts"] },
    ];
    const candidates = findFileBasedDepCandidates(items, []);
    // Both directions must be generated so the harness can verify each independently
    const has12 = candidates.some(([a, b]) => a === 1 && b === 2);
    const has21 = candidates.some(([a, b]) => a === 2 && b === 1);
    assert.ok(has12, "should generate candidate [1, 2]");
    assert.ok(has21, "should generate candidate [2, 1]");
  });
});

describe("findCrossFileDepCandidates", () => {
  it("detects a cross-file import: consumer.ts (issue 2) imports from types.ts (issue 1)", async () => {
    // Regression for review finding #2: issue A modifies consumer.ts that imports a type
    // from types.ts which issue B creates. They share no touched_files, but we detect the import.
    const items: InventoryItem[] = [
      {
        issue: { number: 1, title: "Add types", body: "", labels: [], url: "", state: "open" },
        touched_files: ["core/types.ts"],
      },
      {
        issue: { number: 2, title: "Use types", body: "", labels: [], url: "", state: "open" },
        touched_files: ["core/consumer.ts"],
      },
    ];

    const fileContents: Record<string, string> = {
      "core/types.ts": "export type T = string;",
      "core/consumer.ts": `import type { T } from './types';\nexport function use(t: T) {}`,
    };

    const deps = {
      runHarness: async () => ({ success: true, output: "{}" }),
      readFile: async (f: string) => fileContents[f] ?? null,
      log: () => {},
    };

    const candidates = await findCrossFileDepCandidates(items, [], deps);
    // consumer.ts imports from types.ts → issue 2 (consumer) may depend on issue 1 (types)
    // We expect a candidate [1, 2] (prereq=1, depender=2) to be generated
    assert.ok(
      candidates.some(([a, b]) => a === 1 && b === 2),
      "should generate candidate [1, 2] — issue 1 (types.ts) as potential prerequisite for issue 2 (consumer.ts)",
    );
  });

  it("returns no candidates when no import relationships are found", async () => {
    const items: InventoryItem[] = [
      {
        issue: { number: 1, title: "A", body: "", labels: [], url: "", state: "open" },
        touched_files: ["core/a.ts"],
      },
      {
        issue: { number: 2, title: "B", body: "", labels: [], url: "", state: "open" },
        touched_files: ["core/b.ts"],
      },
    ];
    const deps = {
      runHarness: async () => ({ success: true, output: "{}" }),
      readFile: async () => "export const x = 1;", // no imports
      log: () => {},
    };

    const candidates = await findCrossFileDepCandidates(items, [], deps);
    assert.deepEqual(candidates, []);
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
