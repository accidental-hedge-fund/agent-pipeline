// Unit tests for removeWorktreeForIssue.
//
// All tests use injectable deps — no real git, network, or filesystem calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { removeWorktreeForIssue } from "../scripts/worktree.ts";
import type { RemoveWorktreeDeps, WorktreeRecord } from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function makeCfg(): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    domain: "test",
    max_concurrent_worktrees: 4,
  } as unknown as PipelineConfig;
}

function makeRec(issueNumber: number, slug: string): WorktreeRecord {
  return {
    path: `/repo/.worktrees/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
  };
}

// ---------------------------------------------------------------------------
// 5.1 Clean worktree removed
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: clean worktree → removed=true, dirty=false, error=null", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, true);
  assert.equal(result.dirty, false);
  assert.equal(result.error, null);
  assert.equal(result.branch, "pipeline/42-some-feature");
  assert.equal(result.worktree, "/repo/.worktrees/pipeline-42-some-feature");
  assert.ok(removeCalled, "removeWorktree dep must be called");
});

// ---------------------------------------------------------------------------
// 5.2 Dirty worktree without force
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: dirty worktree without --force → removed=false, dirty=true, removeWorktree not called", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false);
  assert.equal(result.dirty, true);
  assert.match(result.error ?? "", /uncommitted changes/);
  assert.equal(removeCalled, false, "removeWorktree must NOT be called when dirty without force");
});

// ---------------------------------------------------------------------------
// 5.3 Dirty worktree with force
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: dirty worktree with --force → removed=true, dirty=true, removeWorktree called", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, { force: true }, deps);

  assert.equal(result.removed, true);
  assert.equal(result.dirty, true);
  assert.equal(result.error, null);
  assert.ok(removeCalled, "removeWorktree dep must be called when forced");
});

// ---------------------------------------------------------------------------
// 5.4 Not found
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: no worktree for issue → removed=false, worktree=null, branch=null, error contains 'not found'", async () => {
  const cfg = makeCfg();

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [makeRec(99, "other-issue")],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false);
  assert.equal(result.dirty, false);
  assert.equal(result.worktree, null);
  assert.equal(result.branch, null);
  assert.match(result.error ?? "", /no worktree found/);
});

test("removeWorktreeForIssue: empty on-disk list → not-found result", async () => {
  const cfg = makeCfg();

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false);
  assert.equal(result.worktree, null);
  assert.equal(result.branch, null);
  assert.match(result.error ?? "", /no worktree found/);
});

// ---------------------------------------------------------------------------
// 5.5 removeWorktree dep fails
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: removeWorktree dep throws → removed=false, error contains git error", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { throw new Error("git worktree remove failed: locked"); },
    pathExists: () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false);
  assert.match(result.error ?? "", /git worktree remove failed: locked/);
});

// ---------------------------------------------------------------------------
// Behavior regardless of PR state
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: uses listOnDisk (not listActive), so PR state is irrelevant", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "merged-pr-issue");
  let listOnDiskCalled = false;
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => { listOnDiskCalled = true; return [rec]; },
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.ok(listOnDiskCalled, "must call listOnDisk, not listActive");
  assert.ok(removeCalled);
  assert.equal(result.removed, true);
});

// ---------------------------------------------------------------------------
// Path not on disk — skip dirty check, still remove (deregister branch)
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: worktree path not on disk → skip dirty check, proceed to remove", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let dirtyChecked = false;
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => { dirtyChecked = true; return false; },
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(dirtyChecked, false, "dirty check must be skipped when path is not on disk");
  assert.ok(removeCalled, "removeWorktree must still be called to deregister branch");
  assert.equal(result.removed, true);
  assert.equal(result.dirty, false);
});

// ---------------------------------------------------------------------------
// 5.6 CLI smoke: --force and --remove-worktree are recognized Commander options
// ---------------------------------------------------------------------------

test("CLI: --force and --remove-worktree are recognized Commander options", async () => {
  const { buildCmd } = await import("../scripts/pipeline.ts");
  const cmd = buildCmd();
  // Parse --remove-worktree --force together — no "unknown option" error.
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  // Should not throw "unknown option" for either flag.
  cmd.parse(["node", "pipeline", "42", "--remove-worktree", "--force"]);
  const opts = cmd.opts();
  assert.equal(opts.removeWorktree, true, "--remove-worktree must parse as true");
  assert.equal(opts.force, true, "--force must parse as true");
});

test("CLI: --force alone parses (validation error fires in main, not parse phase)", async () => {
  // Commander only validates option syntax; the --force-requires-remove-worktree
  // logic lives in main() and exits 2. We test the parsed opts shape here.
  const { buildCmd } = await import("../scripts/pipeline.ts");
  const cmd = buildCmd();
  cmd.exitOverride();
  cmd.configureOutput({ writeErr: () => {} });
  cmd.parse(["node", "pipeline", "42", "--force"]);
  const opts = cmd.opts();
  assert.equal(opts.force, true, "--force parses as true");
  assert.equal(opts.removeWorktree, undefined, "--remove-worktree absent when not passed");
  // The constraint (force requires removeWorktree) is enforced in main().
});

// ---------------------------------------------------------------------------
// 5.7 CLI smoke: result shape has all required fields
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: result always contains required fields (removed, dirty, branch, worktree, error)", async () => {
  const cfg = makeCfg();

  for (const [label, deps, force] of [
    [
      "clean removal",
      {
        listOnDisk: async () => [makeRec(42, "f")],
        hasDirtyWorkdir: async () => false,
        removeWorktree: async () => {},
        pathExists: () => true,
      } as RemoveWorktreeDeps,
      false,
    ],
    [
      "dirty without force",
      {
        listOnDisk: async () => [makeRec(42, "f")],
        hasDirtyWorkdir: async () => true,
        removeWorktree: async () => {},
        pathExists: () => true,
      } as RemoveWorktreeDeps,
      false,
    ],
    [
      "not found",
      {
        listOnDisk: async () => [],
        hasDirtyWorkdir: async () => false,
        removeWorktree: async () => {},
        pathExists: () => false,
      } as RemoveWorktreeDeps,
      false,
    ],
  ] as [string, RemoveWorktreeDeps, boolean][]) {
    const result = await removeWorktreeForIssue(cfg, 42, { force }, deps);
    assert.ok("removed" in result, `${label}: missing 'removed'`);
    assert.ok("dirty" in result, `${label}: missing 'dirty'`);
    assert.ok("branch" in result, `${label}: missing 'branch'`);
    assert.ok("worktree" in result, `${label}: missing 'worktree'`);
    assert.ok("error" in result, `${label}: missing 'error'`);
    assert.equal(typeof result.removed, "boolean", `${label}: 'removed' must be boolean`);
    assert.equal(typeof result.dirty, "boolean", `${label}: 'dirty' must be boolean`);
  }
});
