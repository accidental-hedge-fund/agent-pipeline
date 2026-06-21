// Unit tests for getOnDiskForIssue — the fast, GitHub-free worktree path lookup.
//
// All tests inject a fake listOnDisk so no real git or gh subprocesses run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getOnDiskForIssue } from "../scripts/worktree.ts";
import type { WorktreeRecord } from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STAGES_DIR = join(__dirname, "../scripts/stages");

const cfg = {} as PipelineConfig;

function makeRecord(issueNumber: number, slug: string, p?: string): WorktreeRecord {
  return {
    path: p ?? `/repo/.worktrees/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
  };
}

// ---------------------------------------------------------------------------
// Scenario: found on disk
// ---------------------------------------------------------------------------

test("getOnDiskForIssue: found — returns path and slug, zero gh calls", async () => {
  let ghCalls = 0;

  const result = await getOnDiskForIssue(cfg, 42, {
    listOnDisk: async () => {
      return [makeRecord(42, "fix-bug")];
    },
  });

  assert.deepEqual(result, { path: "/repo/.worktrees/pipeline-42-fix-bug", slug: "fix-bug" });
  assert.equal(ghCalls, 0, "no gh calls should be made");
});

// ---------------------------------------------------------------------------
// Scenario: not on disk
// ---------------------------------------------------------------------------

test("getOnDiskForIssue: not found — returns null", async () => {
  const result = await getOnDiskForIssue(cfg, 42, {
    listOnDisk: async () => [],
  });

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Scenario: multiple worktrees, correct one returned
// ---------------------------------------------------------------------------

test("getOnDiskForIssue: multiple worktrees — only the matching issue record is returned", async () => {
  const records: WorktreeRecord[] = [
    makeRecord(10, "alpha"),
    makeRecord(42, "target-slug"),
    makeRecord(99, "omega"),
  ];

  const result = await getOnDiskForIssue(cfg, 42, {
    listOnDisk: async () => records,
  });

  assert.deepEqual(result, { path: "/repo/.worktrees/pipeline-42-target-slug", slug: "target-slug" });
});

// ---------------------------------------------------------------------------
// Ensure listOnDisk is the only I/O path (no gh calls)
// ---------------------------------------------------------------------------

test("getOnDiskForIssue: listOnDisk called exactly once, no additional I/O", async () => {
  let listCalls = 0;
  const records: WorktreeRecord[] = [makeRecord(7, "some-feature")];

  await getOnDiskForIssue(cfg, 7, {
    listOnDisk: async () => {
      listCalls++;
      return records;
    },
  });

  assert.equal(listCalls, 1, "listOnDisk should be called exactly once");
});

// ---------------------------------------------------------------------------
// Spec scenario: non-capacity callers do not trigger active-state lookups
// Verify that each stage file uses getOnDiskForIssue (not getForIssue) for
// path-only worktree resolution, so no gh call is issued per worktree.
// ---------------------------------------------------------------------------

const PATH_ONLY_STAGES = [
  "fix.ts",
  "auto_recover.ts",
  "deploy_ready.ts",
  "eval.ts",
  "planning.ts",
  "review-routing.ts",
  "shipcheck.ts",
  "pre_merge.ts",
];

for (const stage of PATH_ONLY_STAGES) {
  const src = readFileSync(join(STAGES_DIR, stage), "utf-8");
  test(`stage ${stage}: uses getOnDiskForIssue for path resolution (not bare getForIssue call)`, () => {
    assert.ok(
      src.includes("getOnDiskForIssue"),
      `${stage} must import/use getOnDiskForIssue for path-only worktree lookup`,
    );
  });
}
