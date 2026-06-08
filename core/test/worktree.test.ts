// Unit tests for worktree sweep logic.
//
// sweepMergedWorktrees is tested via injected deps to avoid real git/gh calls.
// parseDirtyWorkdir is pure and tested directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDirtyWorkdir, isDirtyResult, sweepMergedWorktrees } from "../scripts/worktree.ts";
import type { WorktreeRecord, SweepDeps } from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// parseDirtyWorkdir
// ---------------------------------------------------------------------------

test("parseDirtyWorkdir: empty output → false", () => {
  assert.equal(parseDirtyWorkdir(""), false);
  assert.equal(parseDirtyWorkdir("   \n"), false);
});

test("parseDirtyWorkdir: non-empty output → true", () => {
  assert.equal(parseDirtyWorkdir("M  src/foo.ts\n"), true);
  assert.equal(parseDirtyWorkdir("?? untracked.txt"), true);
});

// ---------------------------------------------------------------------------
// isDirtyResult — fail-closed dirty detection
// Regression: previously hasDirtyWorkdir used ignoreFailure but only inspected
// stdout, so a non-zero git status (lock error, permission error) with empty
// stdout was treated as "clean" and the worktree could be force-removed.
// ---------------------------------------------------------------------------

test("isDirtyResult: code=0, empty stdout → false (clean)", () => {
  assert.equal(isDirtyResult(0, ""), false);
  assert.equal(isDirtyResult(0, "   \n"), false);
});

test("isDirtyResult: code=0, non-empty stdout → true (dirty)", () => {
  assert.equal(isDirtyResult(0, "M  src/foo.ts\n"), true);
});

test("isDirtyResult: code≠0, empty stdout → true (fail closed)", () => {
  assert.equal(isDirtyResult(1, ""), true);
  assert.equal(isDirtyResult(128, ""), true);
});

test("isDirtyResult: code≠0, non-empty stdout → true", () => {
  assert.equal(isDirtyResult(1, "some error text"), true);
});

// ---------------------------------------------------------------------------
// sweepMergedWorktrees
// ---------------------------------------------------------------------------

function makeCfg(): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    domain: "test",
    max_concurrent_worktrees: 4,
    ci_timeout: 600,
    invocation: "pipeline",
    steps: {
      standard_review: true,
      adversarial_review: true,
    },
    profile: "claude",
  } as unknown as PipelineConfig;
}

function makeRec(issueNumber: number, slug: string, rootOverride?: string): WorktreeRecord {
  const root = rootOverride ?? "/repo/.worktrees";
  return {
    path: `${root}/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
  };
}

function okResult(): Promise<{ ok: true }> {
  return Promise.resolve({ ok: true as const });
}

test("sweep: merged + clean + same SHA → removed", async () => {
  const cfg = makeCfg();
  const rec = makeRec(1, "my-feature");
  const removeWorktreeCalls: WorktreeRecord[] = [];

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 10, headSha: "abc123" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "abc123",
    pathExists: () => true,
    removeWorktree: async (_c, n, s) => {
      removeWorktreeCalls.push(makeRec(n, s));
      return okResult();
    },
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].branch, "pipeline/1-my-feature");
  assert.equal(result.skipped.length, 0);
  assert.equal(removeWorktreeCalls.length, 1);
});

test("sweep: open PR → untouched (not in removed or skipped)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(2, "open-feature");
  const removeWorktreeCalls: number[] = [];

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: false }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "def456",
    pathExists: () => true,
    removeWorktree: async () => { removeWorktreeCalls.push(1); return { ok: true as const }; },
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(removeWorktreeCalls.length, 0);
});

test("sweep: merged + dirty → skipped with 'uncommitted changes'", async () => {
  const cfg = makeCfg();
  const rec = makeRec(3, "dirty-feature");

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 30, headSha: "ghi789" }),
    hasDirtyWorkdir: async () => true,
    getWorktreeHeadSha: async () => "ghi789",
    pathExists: () => true,
    removeWorktree: async () => ({ ok: true as const }),
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].rec.branch, "pipeline/3-dirty-feature");
  assert.equal(result.skipped[0].reason, "uncommitted changes");
});

test("sweep: merged + clean + diverged local HEAD → skipped", async () => {
  const cfg = makeCfg();
  const rec = makeRec(4, "diverged-feature");

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 40, headSha: "merged-sha" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "local-sha-different",
    pathExists: () => true,
    removeWorktree: async () => ({ ok: true as const }),
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /local HEAD differs/);
});

test("sweep: no pipeline worktrees on disk → empty result (no-op)", async () => {
  const cfg = makeCfg();

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [],
    getPrMergeState: async () => ({ merged: false }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "",
    pathExists: () => false,
    removeWorktree: async () => ({ ok: true as const }),
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 0);
});

test("sweep: worktree outside cfg.worktree_root is ignored", async () => {
  const cfg = makeCfg();
  const outsideRec: WorktreeRecord = {
    path: "/other-dir/.worktrees/pipeline-5-outside",
    branch: "pipeline/5-outside",
    issueNumber: 5,
    slug: "outside",
  };
  const removeWorktreeCalls: number[] = [];

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [outsideRec],
    getPrMergeState: async () => ({ merged: true, prNumber: 50, headSha: "abc" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "abc",
    pathExists: () => true,
    removeWorktree: async () => { removeWorktreeCalls.push(1); return { ok: true as const }; },
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(removeWorktreeCalls.length, 0);
});

test("sweep: second run is a no-op (idempotent)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(6, "already-cleaned");
  let callCount = 0;

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => (callCount++ === 0 ? [rec] : []),
    getPrMergeState: async () => ({ merged: true, prNumber: 60, headSha: "xyz" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "xyz",
    pathExists: () => true,
    removeWorktree: async () => ({ ok: true as const }),
  };

  const first = await sweepMergedWorktrees(cfg, deps);
  assert.equal(first.removed.length, 1);

  const second = await sweepMergedWorktrees(cfg, deps);
  assert.equal(second.removed.length, 0);
  assert.equal(second.skipped.length, 0);
});

test("sweep: removeWorktree failure → skipped with reason, not added to removed", async () => {
  const cfg = makeCfg();
  const rec = makeRec(7, "removal-fails");

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 70, headSha: "sha-ok" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "sha-ok",
    pathExists: () => true,
    removeWorktree: async () => ({ ok: false as const, reason: "git worktree remove failed: locked" }),
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /removal failed/);
  assert.match(result.skipped[0].reason, /git worktree remove failed: locked/);
});

test("sweep: getPrMergeState error → skipped with reason, not silently treated as unmerged", async () => {
  const cfg = makeCfg();
  const rec = makeRec(8, "gh-error");

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: false, error: "gh: authentication required" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "",
    pathExists: () => true,
    removeWorktree: async () => ({ ok: true as const }),
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(result.removed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /could not determine PR merge state/);
  assert.match(result.skipped[0].reason, /gh: authentication required/);
});

test("sweep: merged + path gone on disk → removal attempted; ok → removed", async () => {
  const cfg = makeCfg();
  const rec = makeRec(9, "stale-reg");
  let removeCalled = false;

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [rec],
    getPrMergeState: async () => ({ merged: true, prNumber: 90, headSha: "stale-sha" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "",
    pathExists: () => false,
    removeWorktree: async (_c, _n, _s, pathOnDisk) => {
      removeCalled = true;
      assert.equal(pathOnDisk, false, "should signal path is not on disk");
      return { ok: true as const };
    },
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.ok(removeCalled, "removeWorktree should be called for stale registration");
  assert.equal(result.removed.length, 1);
  assert.equal(result.skipped.length, 0);
});

// Regression: previously path-not-on-disk triggered global `git worktree prune`
// which could deregister unrelated user-created worktrees outside the pipeline
// root. The sweep must only attempt removal of the specific pipeline worktree.
test("sweep: stale-reg + unrelated worktree present → only pipeline worktree removal is invoked", async () => {
  const cfg = makeCfg();
  const pipelineRec = makeRec(10, "stale-pipeline");
  // Unrelated worktree that listOnDisk returns (branch does not start with "pipeline/")
  // — it will be filtered out by the pipeline-root guard, so removeWorktree
  // should only ever be called once with the pipeline record.
  const removedIssues: number[] = [];

  const deps: Partial<SweepDeps> = {
    listOnDisk: async () => [pipelineRec],
    getPrMergeState: async () => ({ merged: true, prNumber: 100, headSha: "sha-stale" }),
    hasDirtyWorkdir: async () => false,
    getWorktreeHeadSha: async () => "",
    pathExists: () => false,
    removeWorktree: async (_c, n, _s, pathOnDisk) => {
      removedIssues.push(n);
      assert.equal(pathOnDisk, false);
      return { ok: true as const };
    },
  };

  const result = await sweepMergedWorktrees(cfg, deps);
  assert.equal(removedIssues.length, 1, "removeWorktree must be called exactly once");
  assert.equal(removedIssues[0], 10);
  assert.equal(result.removed.length, 1);
  assert.equal(result.skipped.length, 0);
});
