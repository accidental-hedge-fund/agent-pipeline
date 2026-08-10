// Tests for capacity-aware semver roadmap milestone grouping (#347).
// Covers: classifyCompatibilityImpact, effortPoints, capacity grouping,
// version-impact selection, rationale, uncertainty, dependency order,
// config schema, and continuous model isolation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSemverLanes,
  buildContinuousGroups,
  classifyCompatibilityImpact,
  EFFORT_POINTS,
  runRoadmap,
  type RoadmapDeps,
} from "../scripts/roadmap/index.ts";
import type { RoadmapEntry, InventoryItem, Issue } from "../scripts/roadmap/types.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cap-test-"));

function makeFakeRepo(content: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), content);
  return dir;
}

function makeFakeGh(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "${repoSlug}"\n`);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  n: number,
  opts: {
    tier?: RoadmapEntry["tier"];
    effort?: RoadmapEntry["effort"];
    blocked_by?: number[];
    risks?: string[];
  } = {},
): RoadmapEntry {
  return {
    rank: n,
    issue_number: n,
    title: `Issue ${n}`,
    tier: opts.tier ?? "high-value/low-risk",
    priority: 10 - n * 0.1,
    score_breakdown: { impact: 2, confidence: 2, ease: 2, effort: 2, risk_reduction: 1, dep_leverage: 1 },
    dep_rationale: "none",
    touched_files: [],
    effort: opts.effort ?? "M",
    risks: opts.risks ?? [],
    unblocks: [],
    blocked_by: opts.blocked_by ?? [],
  };
}

function makeItem(
  n: number,
  labels: string[] = [],
  body?: string,
  title?: string,
): InventoryItem {
  return {
    issue: {
      number: n,
      title: title ?? `Issue ${n}`,
      body: body ?? `## Summary\nDescription for issue ${n}.\n## Acceptance Criteria\n- [ ] Done`,
      labels,
      url: `https://github.com/example/repo/issues/${n}`,
      state: "open",
    },
    touched_files: [],
  };
}

function makeRoadmapDeps(overrides: Partial<RoadmapDeps> = {}): RoadmapDeps {
  return {
    getOpenIssues: async () => [],
    readFile: async () => null,
    runHarness: async () => ({ success: true, output: "[]" }),
    runCritiqueHarness: async () => ({ success: true, output: "{}" }),
    writeFile: async () => {},
    withThrowawayWorktree: async (_repoDir, _branch, _baseRef, fn) => fn("/tmp/roadmap-throwaway-wt"),
    gitCommit: async () => {},
    gitPushBranch: async () => {},
    findPrByHead: async () => null,
    createPr: async () => "https://github.com/example/repo/pull/1",
    createLabel: async () => {},
    applyLabel: async () => {},
    createMilestone: async () => 1,
    getMilestones: async () => [],
    listMilestonesDetailed: async () => [],
    listOpenIssueMilestoneSnapshots: async () => [],
    reopenMilestone: async () => {},
    updateMilestone: async () => {},
    clearIssueMilestone: async () => {},
    assignIssueMilestone: async () => {},
    closeIssue: async () => {},
    addComment: async () => {},
    editIssue: async () => {},
    createIssue: async () => 42,
    getIssueState: async () => "open",
    getIssueComments: async () => [],
    getLatestTag: async () => "v1.6.0",
    log: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Task 1: classifyCompatibilityImpact — exclusive semver:* labels only (#909)
// ---------------------------------------------------------------------------

describe("classifyCompatibilityImpact: explicit semver:* labels", () => {
  it("semver:major alone → resolved major with source_label", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["semver:major"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "major");
    assert.equal(result.source_label, "semver:major");
    assert.equal(result.uncertain, false);
  });

  it("semver:minor alone → resolved minor", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["semver:minor"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "minor");
    assert.equal(result.source_label, "semver:minor");
    assert.equal(result.uncertain, false);
  });

  it("semver:patch alone → resolved patch", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["semver:patch"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "patch");
    assert.equal(result.source_label, "semver:patch");
    assert.equal(result.uncertain, false);
  });

  it("semver:patch + breaking-language prose stays patch (not major)", () => {
    const entry = makeEntry(1);
    const item = makeItem(
      1,
      ["semver:patch"],
      "## Summary\nThis is a breaking change and needs a migration.\n- [ ] Done",
    );
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "patch");
    assert.notEqual(result.applied_impact, "major");
  });

  it("case-insensitive semver:MAJOR resolves major", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["SemVer:Major"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "major");
    assert.equal(result.source_label, "semver:major");
  });
});

describe("classifyCompatibilityImpact: prose alone never sets applied impact", () => {
  it("incidental 'migration' prose + no semver:* → unresolved_missing, not major", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, [], "## Summary\nRequires database migration.\n- [ ] Done");
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.uncertain, true);
    assert.notEqual(result.applied_impact, "major");
  });

  it("'breaking change' in body without semver:* → unresolved_missing, not major", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, [], "## Summary\nThis is a breaking change to the API.\n- [ ] Done");
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.notEqual(result.applied_impact, "major");
  });

  it("title/body-only edit with fixed labels does not change applied impact", () => {
    const entry = makeEntry(1);
    const before = classifyCompatibilityImpact(
      entry,
      makeItem(1, ["semver:minor"], "Original body about a feature"),
    );
    const after = classifyCompatibilityImpact(
      entry,
      makeItem(
        1,
        ["semver:minor"],
        "Edited body: breaking change and migration required",
        "New title with migration",
      ),
    );
    assert.equal(before.applied_impact, after.applied_impact);
    assert.equal(before.status, after.status);
    assert.equal(before.source_label, after.source_label);
  });
});

describe("classifyCompatibilityImpact: type labels are recommendations only", () => {
  it("breaking-change label alone → unresolved_missing with major recommendation", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["breaking-change"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.uncertain, true);
    assert.equal(result.recommendation?.impact, "major");
    assert.equal(result.recommendation?.source, "breaking-change");
  });

  it("bug label → unresolved_missing with patch recommendation (not applied)", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["bug"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.recommendation?.impact, "patch");
  });

  it("enhancement label → unresolved_missing with minor recommendation (not applied)", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["enhancement"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.recommendation?.impact, "minor");
  });

  it("chore / maintenance → patch recommendation only", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["chore"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.recommendation?.impact, "patch");
  });

  it("cleanup tier alone (no labels) → unresolved_missing, no applied impact", () => {
    const entry = makeEntry(1, { tier: "cleanup" });
    const item = makeItem(1, []);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.uncertain, true);
  });

  it("bug + semver:minor → applied minor (explicit beats type recommendation)", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["bug", "semver:minor"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "minor");
    assert.equal(result.source_label, "semver:minor");
    assert.equal(result.recommendation, undefined);
  });

  it("enhancement + semver:patch → applied patch", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["enhancement", "semver:patch"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "resolved");
    assert.equal(result.applied_impact, "patch");
  });

  it("bug + feature without semver:* → unresolved; recommendation minor (feature wins)", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["bug", "feature"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.recommendation?.impact, "minor");
  });
});

describe("classifyCompatibilityImpact: conflicts and missing", () => {
  it("conflicting semver:major + semver:patch → unresolved_conflict, lists labels", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, ["semver:major", "semver:patch"]);
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_conflict");
    assert.equal(result.applied_impact, null);
    assert.equal(result.uncertain, true);
    assert.deepEqual(result.conflict_labels, ["semver:major", "semver:patch"]);
  });

  it("no labels and plain body → unresolved_missing, not silently major/minor/patch", () => {
    const entry = makeEntry(1);
    const item = makeItem(1, [], "## Summary\nDo something.\n## Acceptance Criteria\n- [ ] Done");
    const result = classifyCompatibilityImpact(entry, item);
    assert.equal(result.status, "unresolved_missing");
    assert.equal(result.applied_impact, null);
    assert.equal(result.uncertain, true);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Effort-weighted capacity grouping
// ---------------------------------------------------------------------------

describe("EFFORT_POINTS map", () => {
  it("XS=1, S=2, M=3, L=5, XL=8", () => {
    assert.equal(EFFORT_POINTS.XS, 1);
    assert.equal(EFFORT_POINTS.S, 2);
    assert.equal(EFFORT_POINTS.M, 3);
    assert.equal(EFFORT_POINTS.L, 5);
    assert.equal(EFFORT_POINTS.XL, 8);
  });
});

describe("buildSemverLanes: capacity grouping", () => {
  it("XL issue (effort=XL, points=8 ≥ budget=8) is isolated alone in its own milestone", () => {
    const roadmap = [
      makeEntry(1, { effort: "XL" }),
      makeEntry(2, { effort: "XS" }),
      makeEntry(3, { effort: "XS" }),
    ];
    const items = [
      makeItem(1, ["semver:minor"]),
      makeItem(2, ["semver:minor"]),
      makeItem(3, ["semver:minor"]),
    ];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    // Issue 1 (XL) must be alone
    const xlLane = lanes.find((l) => l.issue_numbers.includes(1));
    assert.ok(xlLane, "XL issue must be in a lane");
    assert.equal(xlLane.issue_numbers.length, 1, "XL issue must be isolated alone");
  });

  it("semver:major issue is isolated alone when isolate_breaking is enabled (default)", () => {
    const roadmap = [
      makeEntry(1),
      makeEntry(2),
    ];
    const items = [
      makeItem(1, ["semver:major"]),
      makeItem(2, ["semver:minor"]),
    ];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const breakingLane = lanes.find((l) => l.issue_numbers.includes(1));
    assert.ok(breakingLane, "major issue must be in a lane");
    assert.equal(breakingLane.issue_numbers.length, 1, "major issue must be isolated alone");
    // The other issue must be in a separate lane
    const otherLane = lanes.find((l) => l.issue_numbers.includes(2));
    assert.ok(otherLane, "minor issue must be in a lane");
    assert.ok(!otherLane.issue_numbers.includes(1), "minor lane must not contain major issue");
  });

  it("semver:major issue is NOT isolated when isolate_breaking: false", () => {
    const roadmap = [
      makeEntry(1, { effort: "S" }),
      makeEntry(2, { effort: "S" }),
    ];
    const items = [
      makeItem(1, ["semver:major"]),
      makeItem(2, ["semver:minor"]),
    ];
    // S=2, budget=10 (large), isolate_breaking=false → both should share a milestone
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items, { effort_budget: 10, isolate_breaking: false });
    const combined = lanes.flatMap((l) => l.issue_numbers);
    // Both issues should appear
    assert.ok(combined.includes(1));
    assert.ok(combined.includes(2));
    // They should be in the same lane (since S+S=4 ≤ 10 and not isolated)
    const laneWith1 = lanes.find((l) => l.issue_numbers.includes(1));
    const laneWith2 = lanes.find((l) => l.issue_numbers.includes(2));
    assert.ok(laneWith1 === laneWith2, "both issues should share a milestone when isolate_breaking is false");
  });

  it("breaking-change type label alone does not enter a lane or isolate as major", () => {
    const roadmap = [makeEntry(1), makeEntry(2)];
    const items = [
      makeItem(1, ["breaking-change"]),
      makeItem(2, ["semver:minor"]),
    ];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const allNums = lanes.flatMap((l) => l.issue_numbers);
    assert.ok(!allNums.includes(1), "recommendation-only breaking-change must not auto-assign");
    assert.ok(allNums.includes(2));
  });

  it("seven XS issues with resolved patch grouped into one milestone (count > 5 not a boundary)", () => {
    const roadmap = Array.from({ length: 7 }, (_, i) => makeEntry(i + 1, { effort: "XS" }));
    const items = Array.from({ length: 7 }, (_, i) => makeItem(i + 1, ["semver:patch"]));
    // XS=1, 7×1=7 ≤ budget=8 → all 7 in one milestone
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1, "all seven XS issues should fit in one milestone");
    assert.equal(lanes[0].issue_numbers.length, 7);
  });

  it("budget accumulation: issues exceeding the budget boundary start a new milestone", () => {
    // M=3, three M issues: 3+3=6 ≤ 8, 6+3=9 > 8 → first two in one lane, third in next
    const roadmap = [
      makeEntry(1, { effort: "M" }),
      makeEntry(2, { effort: "M" }),
      makeEntry(3, { effort: "M" }),
    ];
    const items = Array.from({ length: 3 }, (_, i) => makeItem(i + 1, ["semver:minor"]));
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 2, "should produce 2 milestones");
    assert.deepEqual(lanes[0].issue_numbers, [1, 2], "first two M issues in first milestone");
    assert.deepEqual(lanes[1].issue_numbers, [3], "third M issue in second milestone");
  });

  it("no issue appears in more than one milestone (uniqueness)", () => {
    const roadmap = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1, { effort: "M" }));
    const items = Array.from({ length: 10 }, (_, i) => makeItem(i + 1, ["semver:minor"]));
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const seen = new Set<number>();
    for (const lane of lanes) {
      for (const n of lane.issue_numbers) {
        assert.ok(!seen.has(n), `issue #${n} appears in two milestones`);
        seen.add(n);
      }
    }
  });

  it("unresolved issues are omitted from automatic milestone assignment", () => {
    const roadmap = [makeEntry(1), makeEntry(2), makeEntry(3)];
    const items = [
      makeItem(1, ["semver:patch"]),
      makeItem(2, [], "## Summary\nRequires migration.\n"),
      makeItem(3, ["semver:major", "semver:minor"]),
    ];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const allNums = lanes.flatMap((l) => l.issue_numbers);
    assert.ok(allNums.includes(1), "resolved patch must be assigned");
    assert.ok(!allNums.includes(2), "missing semver:* must not be assigned");
    assert.ok(!allNums.includes(3), "conflicting semver:* must not be assigned");
  });
});

// ---------------------------------------------------------------------------
// Task 3: Compatibility-impact version walk
// ---------------------------------------------------------------------------

describe("buildSemverLanes: version-impact selection", () => {
  it("semver:patch milestone bumps patch and records version_impact: patch", () => {
    const roadmap = [makeEntry(1, { effort: "S" })];
    const items = [makeItem(1, ["semver:patch"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].title, "v1.6.1");
    assert.equal(lanes[0].version_impact, "patch");
  });

  it("semver:minor milestone bumps minor and records version_impact: minor", () => {
    const roadmap = [makeEntry(1, { effort: "M" })];
    const items = [makeItem(1, ["semver:minor"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].title, "v1.7.0");
    assert.equal(lanes[0].version_impact, "minor");
  });

  it("semver:major milestone bumps major and records version_impact: major", () => {
    const roadmap = [makeEntry(1, { effort: "S" })];
    const items = [makeItem(1, ["semver:major"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].title, "v2.0.0");
    assert.equal(lanes[0].version_impact, "major");
  });

  it("milestone version_impact is max over resolved issues (major overrides minor)", () => {
    // One major, one minor in same milestone (budget large, no isolation)
    const roadmap = [
      makeEntry(1, { effort: "XS" }),
      makeEntry(2, { effort: "XS" }),
    ];
    const items = [
      makeItem(1, ["semver:minor"]),
      makeItem(2, ["semver:major"]),
    ];
    // isolate_breaking: false so they share
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items, { effort_budget: 10, isolate_breaking: false });
    const milestone = lanes.find((l) => l.issue_numbers.includes(1) && l.issue_numbers.includes(2));
    assert.ok(milestone, "both issues should share a milestone");
    assert.equal(milestone.version_impact, "major");
    assert.equal(milestone.title, "v2.0.0");
  });

  it("migration prose without semver:* does not force a major version lane", () => {
    const roadmap = [makeEntry(1, { effort: "S" })];
    const items = [makeItem(1, [], "Requires a data migration and breaking change.")];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 0, "prose-only issues must not create a major lane");
  });

  it("type-label recommendations alone do not create version increments", () => {
    const roadmap = [makeEntry(1), makeEntry(2)];
    const items = [makeItem(1, ["bug"]), makeItem(2, ["enhancement"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 0, "recommendations must not create SemVer lanes");
  });

  it("consecutive milestones have monotonically increasing semver titles", () => {
    const roadmap = [
      makeEntry(1, { effort: "XS" }),
      makeEntry(2, { effort: "XS" }),
      makeEntry(3, { effort: "XS" }),
    ];
    const items = [
      makeItem(1, ["semver:patch"]),
      makeItem(2, ["semver:minor"]),
      makeItem(3, ["semver:patch"]),
    ];
    // Use budget=1 to force one issue per milestone
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items, { effort_budget: 1 });
    assert.equal(lanes.length, 3);
    // Verify monotonically increasing
    for (let i = 1; i < lanes.length; i++) {
      const prev = lanes[i - 1].title.slice(1).split(".").map(Number) as [number, number, number];
      const curr = lanes[i].title.slice(1).split(".").map(Number) as [number, number, number];
      const prevNum = prev[0] * 1e6 + prev[1] * 1e3 + prev[2];
      const currNum = curr[0] * 1e6 + curr[1] * 1e3 + curr[2];
      assert.ok(currNum > prevNum, `lane ${i} title "${lanes[i].title}" must be > "${lanes[i-1].title}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4: Per-milestone rationale and uncertainty
// ---------------------------------------------------------------------------

describe("buildSemverLanes: rationale and unresolved visibility", () => {
  it("every milestone has a non-empty rationale", () => {
    const roadmap = [makeEntry(1), makeEntry(2, { effort: "XL" })];
    const items = [makeItem(1, ["semver:minor"]), makeItem(2, ["semver:minor"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    for (const lane of lanes) {
      assert.ok(lane.rationale.length > 0, `lane "${lane.title}" must have non-empty rationale`);
    }
  });

  it("rationale references at least one product-term boundary reason", () => {
    const PRODUCT_TERMS = [
      /compatibility/i,
      /theme/i,
      /risk/i,
      /capacity/i,
      /dependency/i,
      /feature/i,
      /maintenance/i,
      /breaking/i,
      /semver/i,
    ];
    const roadmap = [makeEntry(1, { effort: "M" })];
    const items = [makeItem(1, ["semver:minor"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1);
    const matchesAny = PRODUCT_TERMS.some((re) => re.test(lanes[0].rationale));
    assert.ok(matchesAny, `rationale must reference a product-term reason; got: "${lanes[0].rationale}"`);
  });

  it("missing inventory items produce empty lanes (no invented applied impact)", () => {
    const roadmap = [makeEntry(1, { effort: "M" })];
    // No items → unresolved_missing → excluded from lanes
    const lanes = buildSemverLanes(roadmap, "v1.6.0");
    assert.equal(lanes.length, 0);
  });

  it("missing/conflicting SemVer labels surface in open_questions and plan classifications", async () => {
    const written: Record<string, string> = {};
    const logs: string[] = [];
    const deps = makeRoadmapDeps({
      writeFile: async (p, c) => { written[p] = c; },
      getLatestTag: async () => "v1.6.0",
      log: (msg) => { logs.push(msg); },
      getOpenIssues: async () => [
        {
          number: 1,
          title: "Issue 1",
          body: "Short body with migration wording",
          labels: [],
          url: "https://github.com/example/repo/issues/1",
          state: "open" as const,
        },
        {
          number: 2,
          title: "Issue 2",
          body: "Conflict case",
          labels: ["semver:major", "semver:patch"],
          url: "https://github.com/example/repo/issues/2",
          state: "open" as const,
        },
        {
          number: 3,
          title: "Issue 3",
          body: "Resolved patch",
          labels: ["semver:patch"],
          url: "https://github.com/example/repo/issues/3",
          state: "open" as const,
        },
      ],
    });
    await runRoadmap("example/repo", "/repo", "main", {}, { apply: false }, deps);
    const planJson = Object.entries(written).find(([k]) => k.endsWith("plan.json"))?.[1];
    assert.ok(planJson, "plan.json must be written");
    const plan = JSON.parse(planJson);
    assert.ok(Array.isArray(plan.compatibility_classifications));
    const byNum = new Map(
      plan.compatibility_classifications.map((c: { issue_number: number }) => [c.issue_number, c]),
    );
    assert.equal((byNum.get(1) as { status: string }).status, "unresolved_missing");
    assert.equal((byNum.get(2) as { status: string }).status, "unresolved_conflict");
    assert.equal((byNum.get(3) as { status: string }).status, "resolved");
    assert.equal((byNum.get(3) as { applied_impact: string }).applied_impact, "patch");

    const assigned = plan.milestones.flatMap((m: { issue_numbers: number[] }) => m.issue_numbers);
    assert.ok(!assigned.includes(1));
    assert.ok(!assigned.includes(2));
    assert.ok(assigned.includes(3));

    const hasMissingQ = plan.open_questions.some(
      (q: { description: string }) =>
        q.description.includes("#1") && q.description.includes("no explicit semver"),
    );
    const hasConflictQ = plan.open_questions.some(
      (q: { description: string }) =>
        q.description.includes("#2") && q.description.includes("conflicting"),
    );
    assert.ok(hasMissingQ, "missing label must produce open_questions entry");
    assert.ok(hasConflictQ, "conflict must produce open_questions entry");

    const md = Object.entries(written).find(([k]) => k.endsWith("roadmap.md"))?.[1] ?? "";
    assert.match(md, /Compatibility impact/i);
    assert.match(md, /unresolved_missing/);
    assert.match(md, /unresolved_conflict/);
    assert.ok(
      logs.some((l) => l.includes("compatibility classifications")),
      "dry-run/apply preview must log classifications",
    );
  });

  it("resolved-only milestones have no uncertainty field", () => {
    const roadmap = [makeEntry(1, { effort: "M" })];
    const items = [makeItem(1, ["semver:minor"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].uncertainty, undefined, "resolved milestone must not invent uncertainty");
  });
});

// ---------------------------------------------------------------------------
// Task 5: Dependency-order preservation
// ---------------------------------------------------------------------------

describe("buildSemverLanes: dependency order preservation", () => {
  it("B blocked by A places A in earlier-or-equal milestone index", () => {
    // A (issue 1) ranked first; dep order from rank (topo sort in applyDepAdjustment)
    const roadmap = [
      makeEntry(1, { effort: "M" }),
      makeEntry(2, { effort: "M", blocked_by: [1] }),
    ];
    const items = [makeItem(1, ["semver:minor"]), makeItem(2, ["semver:minor"])];
    // Force each to separate milestone with budget=3 (M=3 exactly at budget limit)
    // M=3, budget=3, M+M=6 > 3 → separate milestones
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items, { effort_budget: 3 });
    // A (rank 1) → milestone 0, B (rank 2) → milestone 1
    const idxA = lanes.findIndex((l) => l.issue_numbers.includes(1));
    const idxB = lanes.findIndex((l) => l.issue_numbers.includes(2));
    assert.ok(idxA >= 0 && idxB >= 0, "both issues must be in milestones");
    assert.ok(idxA <= idxB, `A's milestone index (${idxA}) must be ≤ B's (${idxB})`);
  });

  it("issues in blocked_pending_decision are excluded from milestones", () => {
    const roadmap = [
      makeEntry(1, { effort: "M" }),
      makeEntry(2, { effort: "M" }),
      makeEntry(3, { effort: "M" }),
    ];
    const items = [
      makeItem(1, ["semver:minor"]),
      makeItem(2, ["semver:minor"]),
      makeItem(3, ["semver:minor"]),
    ];
    // Issue 2 is an unresolved/external blocked decision — must be excluded
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items, undefined, new Set([2]));
    const allNums = lanes.flatMap((l) => l.issue_numbers);
    assert.ok(!allNums.includes(2), "issue in blocked_pending_decision must be excluded");
    assert.ok(allNums.includes(1));
    assert.ok(allNums.includes(3));
  });

  it("issue with local blocked_by dependency is included in milestones (not excluded)", () => {
    // Issue 2 has a local in-plan dependency on issue 1 but is not in blocked_pending_decision
    const roadmap = [
      makeEntry(1, { effort: "M" }),
      makeEntry(2, { effort: "M", blocked_by: [1] }),
    ];
    const items = [makeItem(1, ["semver:minor"]), makeItem(2, ["semver:minor"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const allNums = lanes.flatMap((l) => l.issue_numbers);
    assert.ok(allNums.includes(1), "prerequisite must be in a milestone");
    assert.ok(allNums.includes(2), "dependent with local blocked_by must be included (not excluded)");
  });

  it("isolating a major issue does not reorder its position relative to earlier-ranked issues", () => {
    // Issue 1 is major (isolated), issue 2 is a regular minor ranked after it
    const roadmap = [
      makeEntry(1, { effort: "S" }),
      makeEntry(2, { effort: "S" }),
    ];
    const items = [
      makeItem(1, ["semver:major"]),
      makeItem(2, ["semver:minor"]),
    ];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const idxBreaking = lanes.findIndex((l) => l.issue_numbers.includes(1));
    const idxFeature = lanes.findIndex((l) => l.issue_numbers.includes(2));
    assert.ok(idxBreaking <= idxFeature, "major issue (ranked first) must remain in earlier milestone");
  });

  it("small high-risk issue (Security-sensitive change) is isolated into its own milestone", () => {
    // Issue 1 is XS effort but carries a security risk — must be isolated regardless of size
    const roadmap = [
      makeEntry(1, { effort: "XS", risks: ["Security-sensitive change"] }),
      makeEntry(2, { effort: "XS" }),
      makeEntry(3, { effort: "XS" }),
    ];
    const items = [
      makeItem(1, ["semver:minor"]),
      makeItem(2, ["semver:minor"]),
      makeItem(3, ["semver:minor"]),
    ];
    // Without risk isolation, three XS (1+1+1=3 ≤ budget=8) would all fit one milestone
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const riskLane = lanes.find((l) => l.issue_numbers.includes(1));
    assert.ok(riskLane, "high-risk issue must be placed in a milestone");
    assert.equal(riskLane.issue_numbers.length, 1, "Security-sensitive issue must be isolated alone");
  });

  it("small high-risk issue (Wide blast radius) is isolated into its own milestone", () => {
    const roadmap = [
      makeEntry(1, { effort: "XS", risks: ["Wide blast radius"] }),
      makeEntry(2, { effort: "XS" }),
    ];
    const items = [makeItem(1, ["semver:patch"]), makeItem(2, ["semver:patch"])];
    const lanes = buildSemverLanes(roadmap, "v1.6.0", items);
    const riskLane = lanes.find((l) => l.issue_numbers.includes(1));
    assert.ok(riskLane, "wide-blast-radius issue must be placed in a milestone");
    assert.equal(riskLane.issue_numbers.length, 1, "Wide blast radius issue must be isolated alone");
  });
});

// ---------------------------------------------------------------------------
// Task 6: Config schema
// ---------------------------------------------------------------------------

describe("config: roadmap.release_capacity schema", () => {
  it("valid release_capacity block resolves correctly", async () => {
    const repo = makeFakeRepo(
      "roadmap:\n  release_capacity:\n    effort_budget: 12\n    isolate_breaking: false\n",
    );
    const binDir = makeFakeGh("acme/cap1");
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cbcap1=${Date.now()}`);
      const cfg = cfgMod.resolveConfig({ repoPath: repo });
      assert.equal(cfg.roadmap?.release_capacity?.effort_budget, 12);
      assert.equal(cfg.roadmap?.release_capacity?.isolate_breaking, false);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("absent release_capacity block resolves without error", async () => {
    const repo = makeFakeRepo("roadmap:\n  release_model: semver\n");
    const binDir = makeFakeGh("acme/cap2");
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cbcap2=${Date.now()}`);
      const cfg = cfgMod.resolveConfig({ repoPath: repo });
      assert.equal(cfg.roadmap?.release_capacity, undefined);
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("unknown sub-key under release_capacity is rejected (strict schema)", async () => {
    const repo = makeFakeRepo("roadmap:\n  release_capacity:\n    lane_size: 5\n");
    const binDir = makeFakeGh("acme/cap3");
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cbcap3=${Date.now()}`);
      assert.throws(
        () => cfgMod.resolveConfig({ repoPath: repo }),
        (err: Error) =>
          /Invalid .*pipeline\.yml/.test(err.message) && err.message.includes("lane_size"),
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it("non-positive effort_budget is rejected", async () => {
    const repoZero = makeFakeRepo("roadmap:\n  release_capacity:\n    effort_budget: 0\n");
    const binDir = makeFakeGh("acme/cap4");
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cbcap4=${Date.now()}`);
      assert.throws(
        () => cfgMod.resolveConfig({ repoPath: repoZero }),
        (err: Error) => /Invalid .*pipeline\.yml/.test(err.message),
      );
    } finally {
      process.env.PATH = oldPath;
    }

    const repoNeg = makeFakeRepo("roadmap:\n  release_capacity:\n    effort_budget: -1\n");
    const binDir2 = makeFakeGh("acme/cap5");
    process.env.PATH = `${binDir2}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cbcap5=${Date.now()}`);
      assert.throws(
        () => cfgMod.resolveConfig({ repoPath: repoNeg }),
        (err: Error) => /Invalid .*pipeline\.yml/.test(err.message),
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

// ---------------------------------------------------------------------------
// Task 7: continuous model unaffected
// ---------------------------------------------------------------------------

describe("buildContinuousGroups: unaffected by semver capacity rules", () => {
  it("continuous run produces no semver titles", () => {
    const roadmap = [makeEntry(1), makeEntry(2, { effort: "XL" }), makeEntry(3, { tier: "cleanup" })];
    const items = [
      makeItem(1, ["breaking-change"]),
      makeItem(2, ["enhancement"]),
      makeItem(3, ["chore"]),
    ];
    const groups = buildContinuousGroups(roadmap, items);
    for (const g of groups) {
      assert.doesNotMatch(g.title, /^v\d+\.\d+\.\d+$/, `continuous title "${g.title}" must not be semver`);
    }
  });

  it("continuous run produces no version_impact field", () => {
    const roadmap = [makeEntry(1), makeEntry(2)];
    const items = [makeItem(1, ["breaking-change"]), makeItem(2, ["chore"])];
    const groups = buildContinuousGroups(roadmap, items);
    for (const g of groups) {
      assert.equal(
        (g as { version_impact?: string }).version_impact,
        undefined,
        "continuous milestones must not carry version_impact",
      );
    }
  });

  it("runRoadmap continuous model produces no semver titles in plan.json", async () => {
    const written: Record<string, string> = {};
    const deps = makeRoadmapDeps({
      writeFile: async (p, c) => { written[p] = c; },
      getOpenIssues: async () => [
        { number: 1, title: "Issue 1", body: "## Summary\nDesc.\n- [ ] Done", labels: ["epic:auth"], url: "u1", state: "open" as const },
      ],
    });
    await runRoadmap(
      "example/repo",
      "/repo",
      "main",
      { release_model: "continuous" },
      { apply: false },
      deps,
    );
    const planJson = Object.entries(written).find(([k]) => k.endsWith("plan.json"))?.[1];
    assert.ok(planJson, "plan.json must be written");
    const plan = JSON.parse(planJson);
    for (const m of plan.milestones) {
      assert.doesNotMatch(
        m.title,
        /^v\d+\.\d+\.\d+$/,
        `continuous mode must not produce semver title "${m.title}"`,
      );
      assert.equal(m.version_impact, undefined, "continuous mode must not produce version_impact");
    }
  });
});
