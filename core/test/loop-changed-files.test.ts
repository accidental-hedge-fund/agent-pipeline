// Tests for the production changed-file-overlap observer (#530 review 1,
// finding ffbf2be1): SupervisorDeps.getChangedFiles must actually be wired to
// a real managed-worktree implementation in production, not left absent. All
// filesystem/git access is injected via RealGetChangedFilesDeps — no real
// filesystem, git, or network access in these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { realGetChangedFiles } from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function fakeCfg(): PipelineConfig {
  return { repo: "acme/widget", repo_dir: "/tmp/does-not-exist", base_branch: "main" } as unknown as PipelineConfig;
}

test("realGetChangedFiles: returns the trimmed, filtered diff --name-only paths for an item's on-disk worktree", async () => {
  const gitCalls: unknown[] = [];
  const getChangedFiles = realGetChangedFiles(fakeCfg(), {
    getOnDiskForIssue: async (_cfg, issueNumber) => (issueNumber === 100 ? { path: "/wt/pipeline-100-x", slug: "x" } : null),
    gitInWorktree: async (cwd, args) => {
      gitCalls.push({ cwd, args });
      return { stdout: "src/one/a.ts\nsrc/two/b.ts\n\n", stderr: "", code: 0 };
    },
  });

  const changed = await getChangedFiles!("100");
  assert.deepEqual(changed, ["src/one/a.ts", "src/two/b.ts"]);
  assert.deepEqual(gitCalls, [{ cwd: "/wt/pipeline-100-x", args: ["diff", "--name-only", "origin/main...HEAD"] }]);
});

test("realGetChangedFiles: an item with no on-disk worktree yet reports no changed files without calling git", async () => {
  let gitCalled = false;
  const getChangedFiles = realGetChangedFiles(fakeCfg(), {
    getOnDiskForIssue: async () => null,
    gitInWorktree: async () => {
      gitCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  const changed = await getChangedFiles!("200");
  assert.deepEqual(changed, []);
  assert.equal(gitCalled, false);
});
