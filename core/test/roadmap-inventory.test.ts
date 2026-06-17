// Tests for roadmap/inventory.ts (#171)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBacklogSha, filterIssues, extractCandidateFiles, parseTouchedFiles, buildInventory } from "../scripts/roadmap/inventory.ts";
import type { Issue, RoadmapConfig } from "../scripts/roadmap/types.ts";
import type { InventoryDeps } from "../scripts/roadmap/inventory.ts";

function makeIssue(n: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: `Body of issue ${n}`,
    labels: [],
    url: `https://github.com/example/repo/issues/${n}`,
    state: "open",
    updatedAt: `2026-01-0${n}T00:00:00Z`,
    ...overrides,
  };
}

describe("computeBacklogSha", () => {
  it("produces a stable 8-char hex string", () => {
    const issues = [makeIssue(1), makeIssue(2)];
    const sha = computeBacklogSha(issues);
    assert.match(sha, /^[0-9a-f]{8}$/);
  });

  it("is deterministic regardless of input order", () => {
    const sha1 = computeBacklogSha([makeIssue(1), makeIssue(2)]);
    const sha2 = computeBacklogSha([makeIssue(2), makeIssue(1)]);
    assert.equal(sha1, sha2);
  });

  it("changes when an issue updatedAt changes", () => {
    const sha1 = computeBacklogSha([makeIssue(1, { updatedAt: "2026-01-01T00:00:00Z" })]);
    const sha2 = computeBacklogSha([makeIssue(1, { updatedAt: "2026-01-02T00:00:00Z" })]);
    assert.notEqual(sha1, sha2);
  });

  it("returns a value for empty backlog", () => {
    const sha = computeBacklogSha([]);
    assert.match(sha, /^[0-9a-f]{8}$/);
  });
});

describe("filterIssues", () => {
  const issues: Issue[] = [
    makeIssue(1, { labels: ["bug", "p1"] }),
    makeIssue(2, { labels: ["enhancement"] }),
    makeIssue(3, { labels: ["wontfix", "bug"] }),
    makeIssue(4, { labels: [] }),
  ];

  it("returns all issues when no filter configured", () => {
    const result = filterIssues(issues, {});
    assert.equal(result.length, 4);
  });

  it("include_labels: keeps only issues with at least one matching label", () => {
    const result = filterIssues(issues, { include_labels: ["bug"] });
    assert.deepEqual(result.map((i) => i.number).sort(), [1, 3]);
  });

  it("exclude_labels: drops issues with any matching label", () => {
    const result = filterIssues(issues, { exclude_labels: ["wontfix"] });
    assert.deepEqual(result.map((i) => i.number).sort(), [1, 2, 4]);
  });

  it("include_labels + exclude_labels: intersection applied", () => {
    // include bug, exclude wontfix → issue 1 (has bug, no wontfix); not 3 (has both)
    const result = filterIssues(issues, { include_labels: ["bug"], exclude_labels: ["wontfix"] });
    assert.deepEqual(result.map((i) => i.number), [1]);
  });
});

describe("extractCandidateFiles", () => {
  it("extracts backtick-wrapped file paths", () => {
    const issue = makeIssue(1, {
      body: "Edit `core/scripts/config.ts` and also `test/config.test.ts`.",
    });
    const files = extractCandidateFiles(issue);
    assert.ok(files.includes("core/scripts/config.ts"), "should include config.ts");
    assert.ok(files.includes("test/config.test.ts"), "should include test file");
  });

  it("extracts plain path patterns", () => {
    const issue = makeIssue(1, {
      body: "Update core/scripts/pipeline.ts and scripts/build.mjs",
    });
    const files = extractCandidateFiles(issue);
    assert.ok(files.some((f) => f.includes("pipeline.ts")));
  });

  it("deduplicates", () => {
    const issue = makeIssue(1, {
      body: "`foo.ts` appears twice: `foo.ts`",
    });
    const files = extractCandidateFiles(issue);
    assert.equal(files.filter((f) => f === "foo.ts").length, 1);
  });

  it("returns empty for issue with no file refs", () => {
    const issue = makeIssue(1, { body: "Add dark mode support to the UI." });
    const files = extractCandidateFiles(issue);
    assert.ok(Array.isArray(files));
  });
});

describe("parseTouchedFiles", () => {
  it("parses a JSON array from harness output", () => {
    const output = 'Sure! Here are the files:\n```json\n["src/a.ts", "src/b.ts"]\n```';
    const files = parseTouchedFiles(output);
    assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
  });

  it("returns empty array when no JSON array found", () => {
    const files = parseTouchedFiles("I cannot determine which files this touches.");
    assert.deepEqual(files, []);
  });

  it("filters non-string entries", () => {
    const files = parseTouchedFiles('[1, null, "valid.ts", false]');
    assert.deepEqual(files, ["valid.ts"]);
  });

  it("caps at 15 files", () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => `file${i}.ts`));
    const files = parseTouchedFiles(many);
    assert.equal(files.length, 15);
  });
});

describe("buildInventory", () => {
  it("returns empty when backlog is empty", async () => {
    const deps: InventoryDeps = {
      getOpenIssues: async () => [],
      readFile: async () => null,
      runHarness: async () => ({ success: true, output: "[]" }),
      log: () => {},
    };
    const result = await buildInventory("example/repo", {}, deps);
    assert.deepEqual(result, []);
  });

  it("filters issues before calling harness per issue", async () => {
    const issues: Issue[] = [
      makeIssue(1, { labels: ["bug"] }),
      makeIssue(2, { labels: ["wontfix"] }),
    ];
    const harnessCallCount = { value: 0 };
    const deps: InventoryDeps = {
      getOpenIssues: async () => issues,
      readFile: async () => null,
      runHarness: async () => {
        harnessCallCount.value++;
        return { success: true, output: '["src/index.ts"]' };
      },
      log: () => {},
    };
    const result = await buildInventory("example/repo", { exclude_labels: ["wontfix"] }, deps);
    assert.equal(result.length, 1);
    assert.equal(result[0].issue.number, 1);
    assert.equal(harnessCallCount.value, 1, "harness should only run for filtered issues");
  });

  it("falls back to extractCandidateFiles when harness fails", async () => {
    const issue = makeIssue(5, { body: "Update `core/scripts/gh.ts` please." });
    const deps: InventoryDeps = {
      getOpenIssues: async () => [issue],
      readFile: async () => null,
      runHarness: async () => ({ success: false, output: "error" }),
      log: () => {},
    };
    const result = await buildInventory("example/repo", {}, deps);
    assert.equal(result.length, 1);
    assert.ok(result[0].touched_files.some((f) => f.includes("gh.ts")));
  });
});
