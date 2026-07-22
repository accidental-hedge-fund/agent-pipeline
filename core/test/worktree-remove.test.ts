// Unit tests for removeWorktreeForIssue.
//
// All tests use injectable deps — no real git, network, or filesystem calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { removeWorktreeForIssue } from "../scripts/worktree.ts";
import type { RemoveWorktreeDeps, WorktreeRecord } from "../scripts/worktree.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_SCRIPT = path.join(__dirname, "..", "scripts", "pipeline.ts");

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
    hasLocalOnlyCommits: async () => false,
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
    hasLocalOnlyCommits: async () => false,
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
    hasLocalOnlyCommits: async () => false, // no unpushed commits; --force only bypasses dirty check
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
    hasLocalOnlyCommits: async () => false,
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
    hasLocalOnlyCommits: async () => false,
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
    hasLocalOnlyCommits: async () => false,
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
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.ok(listOnDiskCalled, "must call listOnDisk, not listActive");
  assert.ok(removeCalled);
  assert.equal(result.removed, true);
});

// ---------------------------------------------------------------------------
// Path not on disk — skip dirty check, still remove (deregister branch)
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: worktree path not on disk → skip dirty check, still run local-only check, proceed to remove", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let dirtyChecked = false;
  let removeCalled = false;
  let localOnlyCalled = false;
  let capturedPathOnDisk: boolean | undefined;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => { dirtyChecked = true; return false; },
    removeWorktree: async (_cfg, _num, _slug, pathOnDisk) => {
      capturedPathOnDisk = pathOnDisk;
      removeCalled = true;
    },
    pathExists: () => false,
    hasLocalOnlyCommits: async () => { localOnlyCalled = true; return false; },
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(dirtyChecked, false, "dirty check must be skipped when path is not on disk");
  assert.ok(localOnlyCalled, "local-only check must still run even when path is not on disk");
  assert.ok(removeCalled, "removeWorktree must still be called to deregister branch");
  assert.equal(capturedPathOnDisk, false, "removeWorktree must receive pathOnDisk=false for stale registration");
  assert.equal(result.removed, true);
  assert.equal(result.dirty, false);
});

// ---------------------------------------------------------------------------
// Managed-root guard — underManagedRoot: false records must be skipped
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: underManagedRoot=false record is skipped → not-found result, removeWorktree not called", async () => {
  const cfg = makeCfg();
  const rec: WorktreeRecord = {
    path: "/outside/.worktrees/pipeline-42-foo",
    branch: "pipeline/42-foo",
    issueNumber: 42,
    slug: "foo",
    underManagedRoot: false,
  };
  let removeCalled = false;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };
  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);
  assert.equal(result.removed, false, "must not remove unmanaged worktree");
  assert.equal(removeCalled, false, "removeWorktree must not be called for unmanaged record");
  assert.match(result.error ?? "", /no worktree found/);
});

// ---------------------------------------------------------------------------
// Cross-checkout discovery (#472)
//
// A worktree created from a linked checkout is registered under THAT
// checkout's root (e.g. /orchestration/.worktrees), not under cfg.repo_dir's
// root. listOnDisk's real implementation now classifies it underManagedRoot:
// true regardless of which checkout issued `git worktree list`, so it must
// be discoverable and removable when the removal command is invoked from a
// different checkout (the primary, or a third, unrelated linked checkout).
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: worktree registered under a linked checkout's root is removed when invoked from the primary checkout (#472)", async () => {
  const cfg = makeCfg(); // cfg.repo_dir === "/repo" (primary checkout)
  const rec: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true, // as classified by listOnDisk's root-set resolver
  };
  let removeCalled = false;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, true);
  assert.equal(result.worktree, "/orchestration/.worktrees/pipeline-7-fix-thing");
  assert.equal(result.branch, "pipeline/7-fix-thing");
  assert.ok(removeCalled);
});

test("removeWorktreeForIssue: same cross-checkout worktree resolves identically from a third, unrelated linked checkout (#472)", async () => {
  const cfg: PipelineConfig = { ...makeCfg(), repo_dir: "/third-checkout" };
  const rec: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, true);
  assert.equal(result.worktree, "/orchestration/.worktrees/pipeline-7-fix-thing");
});

test("removeWorktreeForIssue: an unregistered directory that merely looks like pipeline-N-<slug> is never selected (#472)", async () => {
  // listOnDisk only ever returns git-registered records (real parseWorktreePorcelain
  // drops anything absent from `git worktree list --porcelain`), so an unregistered
  // directory never appears here at all — asserting an empty list proves the not-found path.
  const cfg = makeCfg();
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { throw new Error("must not be called"); },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, false);
  assert.match(result.error ?? "", /no worktree found/);
});

// ---------------------------------------------------------------------------
// Regression parity: the #296 safety ladder is unchanged for a cross-checkout
// record — only *which record is selected* changes, not what happens next (#472).
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: cross-checkout record — dirty without --force blocks identically to a same-root record", async () => {
  const cfg = makeCfg();
  const rec: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  let removeCalled = false;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, false);
  assert.equal(result.dirty, true);
  assert.match(result.error ?? "", /uncommitted changes/);
  assert.equal(removeCalled, false);
});

test("removeWorktreeForIssue: cross-checkout record — local-only commits block even with --force", async () => {
  const cfg = makeCfg();
  const rec: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => true,
    hasLocalOnlyCommits: async () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 7, { force: true }, deps);

  assert.equal(result.removed, false);
  assert.match(result.error ?? "", /local-only commits/);
});

test("removeWorktreeForIssue: cross-checkout stale registration (path gone) deregisters via rec.path, not a cfg.repo_dir-derived path", async () => {
  const cfg = makeCfg();
  const rec: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  let capturedPath: string | undefined;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async (_cfg, _num, _slug, _pathOnDisk, resolvedPath) => { capturedPath = resolvedPath; },
    pathExists: () => false,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, true);
  assert.equal(capturedPath, "/orchestration/.worktrees/pipeline-7-fix-thing");
});

// ---------------------------------------------------------------------------
// Ambiguous managed match — fail closed, no removal (#472)
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: two managed candidates for the same issue → refused, names both paths, no removal", async () => {
  const cfg = makeCfg();
  const recA: WorktreeRecord = {
    path: "/repo/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  const recB: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  let removeCalled = false;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [recA, recB],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, {}, deps);

  assert.equal(result.removed, false);
  assert.equal(result.worktree, null);
  assert.match(result.error ?? "", /ambiguous/);
  assert.match(result.error ?? "", /\/repo\/\.worktrees\/pipeline-7-fix-thing/);
  assert.match(result.error ?? "", /\/orchestration\/\.worktrees\/pipeline-7-fix-thing/);
  assert.equal(removeCalled, false, "no removal operation may run when the match is ambiguous");
});

test("removeWorktreeForIssue: ambiguity is not bypassable with --force", async () => {
  const cfg = makeCfg();
  const recA: WorktreeRecord = {
    path: "/repo/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  const recB: WorktreeRecord = {
    path: "/orchestration/.worktrees/pipeline-7-fix-thing",
    branch: "pipeline/7-fix-thing",
    issueNumber: 7,
    slug: "fix-thing",
    underManagedRoot: true,
  };
  let removeCalled = false;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [recA, recB],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 7, { force: true }, deps);

  assert.equal(result.removed, false);
  assert.match(result.error ?? "", /ambiguous/);
  assert.equal(removeCalled, false);
});

// ---------------------------------------------------------------------------
// Force threading — opts.force must be forwarded to the removeWorktree dep
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: opts.force=false → removeWorktree dep receives force=false", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let capturedForce: boolean | undefined = undefined;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async (_cfg, _num, _slug, _pathOnDisk, _path, force) => { capturedForce = force; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };
  await removeWorktreeForIssue(cfg, 42, { force: false }, deps);
  assert.equal(capturedForce, false, "removeWorktree must receive force=false when opts.force is false");
});

test("removeWorktreeForIssue: opts.force=true → removeWorktree dep receives force=true", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let capturedForce: boolean | undefined = undefined;
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    removeWorktree: async (_cfg, _num, _slug, _pathOnDisk, _path, force) => { capturedForce = force; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false, // no unpushed commits; --force only bypasses dirty check
  };
  await removeWorktreeForIssue(cfg, 42, { force: true }, deps);
  assert.equal(capturedForce, true, "removeWorktree must receive force=true when opts.force is true");
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
        hasLocalOnlyCommits: async () => false,
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
        hasLocalOnlyCommits: async () => false,
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
        hasLocalOnlyCommits: async () => false,
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

// ---------------------------------------------------------------------------
// Finding 1 regression: local-only commits must block non-forced clean removal
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: on-disk worktree calls hasLocalOnlyCommits with non-null path", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let capturedPath: string | null | undefined;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => true,
    hasLocalOnlyCommits: async (_cfg, worktreePath) => { capturedPath = worktreePath; return false; },
  };

  await removeWorktreeForIssue(cfg, 42, {}, deps);
  assert.equal(capturedPath, "/repo/.worktrees/pipeline-42-some-feature", "on-disk path must be passed for HEAD check");
});

test("removeWorktreeForIssue: clean but has local-only commits without --force → removed=false, error names local-only", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "must not remove when local-only commits exist without --force");
  assert.equal(result.dirty, false);
  assert.match(result.error ?? "", /local-only commits/, "error must mention local-only commits");
  assert.equal(removeCalled, false, "removeWorktree must NOT be called when local-only commits block");
});

// null = hard failure (network/auth/stale-ref/git error) — blocked regardless of --force
test("removeWorktreeForIssue: hasLocalOnlyCommits returns null (git/network/auth error) → removed=false, error mentions verification failed", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => null,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "must not remove when commit verification failed (hard failure)");
  assert.match(result.error ?? "", /commit verification failed/, "error must mention verification failure");
  assert.equal(removeCalled, false, "removeWorktree must NOT be called on hard git/network failure");
});

// Regression: null is a HARD block — --force must NOT bypass git/network/auth errors
test("removeWorktreeForIssue: hasLocalOnlyCommits returns null + --force → removed=false (hard failure, not bypassable)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => null, // hard failure: network/auth/git error
  };

  const result = await removeWorktreeForIssue(cfg, 42, { force: true }, deps);

  assert.equal(result.removed, false, "--force must NOT bypass hard git/network failure (null)");
  assert.match(result.error ?? "", /commit verification failed/);
  assert.equal(removeCalled, false, "removeWorktree must NOT be called when hard failure blocks");
});

// "unverifiable" = squash-merge ambiguity (remote branch deleted, commits not in base)
// Blocked without --force; allowed with --force (user takes explicit responsibility).
test("removeWorktreeForIssue: hasLocalOnlyCommits returns 'unverifiable' without --force → removed=false, error mentions squash-merge", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => "unverifiable",
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "must not remove on squash-merge ambiguity without --force");
  assert.match(result.error ?? "", /cannot verify/, "error must mention cannot verify");
  assert.equal(removeCalled, false);
});

// Regression: post-merge deleted-branch squash-merge case — "unverifiable" + --force → removed=true
test("removeWorktreeForIssue: hasLocalOnlyCommits returns 'unverifiable' + --force → removed=true (squash-merge, user takes responsibility)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => "unverifiable", // squash-merge: remote deleted, commits not in base
  };

  const result = await removeWorktreeForIssue(cfg, 42, { force: true }, deps);

  assert.equal(result.removed, true, "--force must allow removal for squash-merge ambiguity (unverifiable)");
  assert.ok(removeCalled, "removeWorktree must be called when --force overrides squash-merge ambiguity");
});

// Regression for pre-merge delta finding: --force must NOT bypass the local-only
// commits check. --force only bypasses the uncommitted-changes guard.
test("removeWorktreeForIssue: local-only commits with --force → removed=false (--force does not bypass local-only check)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, { force: true }, deps);

  assert.equal(result.removed, false, "--force must NOT bypass local-only commits; user must push first");
  assert.match(result.error ?? "", /local-only commits/, "error must mention local-only commits");
  assert.equal(removeCalled, false, "removeWorktree must NOT be called when local-only commits block");
});

// Regression for pre-merge delta finding: dirty + local-only + --force must block
// on local-only (not silently discard both uncommitted changes and unpushed commits).
test("removeWorktreeForIssue: dirty + local-only commits + --force → blocked on local-only, not silently discarded", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, { force: true }, deps);

  assert.equal(result.removed, false, "dirty + local-only + force must be blocked by local-only check");
  assert.equal(result.dirty, true, "dirty flag must reflect actual workdir state");
  assert.match(result.error ?? "", /local-only commits/);
  assert.equal(removeCalled, false);
});

// Regression for pre-merge finding: on-disk detached HEAD with commits not on branch
// must be caught. hasLocalOnlyCommits receives the worktree path so it can check HEAD.
test("removeWorktreeForIssue: on-disk clean worktree in detached HEAD with unreachable commits → removed=false (reviewer catches via HEAD check)", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;
  // Simulate detached HEAD at a local commit not on origin/<branch>:
  // hasDirtyWorkdir=false (clean), but HEAD has a commit not on origin/<branch>
  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    // hasLocalOnlyCommits is called with the worktree path and returns true
    // because origin/<branch>..HEAD is non-empty (detached commit)
    hasLocalOnlyCommits: async (_cfg, worktreePath) => worktreePath !== null ? true : false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "must not remove when detached HEAD has local-only commits");
  assert.match(result.error ?? "", /local-only commits/);
  assert.equal(removeCalled, false);
});

test("removeWorktreeForIssue: stale registration (path not on disk) calls hasLocalOnlyCommits with null path", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let capturedPath: string | null | undefined;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => false,
    hasLocalOnlyCommits: async (_cfg, worktreePath) => { capturedPath = worktreePath; return false; },
  };

  await removeWorktreeForIssue(cfg, 42, {}, deps);
  assert.equal(capturedPath, null, "stale registration must pass null so impl uses branch-ref check");
});

test("removeWorktreeForIssue: stale registration (path not on disk) with all-pushed branch → removed=true", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let localOnlyCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => {},
    pathExists: () => false,
    hasLocalOnlyCommits: async () => { localOnlyCalled = true; return false; },
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.ok(localOnlyCalled, "local-only check must run even when path is not on disk");
  assert.equal(result.removed, true);
});

test("removeWorktreeForIssue: stale registration (path not on disk) with local-only branch commits → removed=false, blocks without --force", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => false,
    hasLocalOnlyCommits: async () => true,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "stale registration with local-only commits must block without --force");
  assert.match(result.error ?? "", /local-only commits/, "error must mention local-only commits");
  assert.equal(removeCalled, false, "removeWorktree must NOT be called");
});

test("removeWorktreeForIssue: stale registration (path not on disk) with git/network error → removed=false, fails closed", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => false,
    hasLocalOnlyCommits: async () => null, // hard failure: network/auth/git error
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, false, "stale registration with git/network failure must fail closed");
  assert.match(result.error ?? "", /commit verification failed/, "error must mention verification failure");
  assert.equal(removeCalled, false, "removeWorktree must NOT be called");
});

// ---------------------------------------------------------------------------
// Finding 3 regression: removeWorktree dep receives pathOnDisk=true when on disk
// ---------------------------------------------------------------------------

test("removeWorktreeForIssue: path on disk → removeWorktree dep receives pathOnDisk=true", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "some-feature");
  let capturedPathOnDisk: boolean | undefined;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async (_cfg, _num, _slug, pathOnDisk) => { capturedPathOnDisk = pathOnDisk; },
    pathExists: () => true,
    hasLocalOnlyCommits: async () => false,
  };

  await removeWorktreeForIssue(cfg, 42, {}, deps);
  assert.equal(capturedPathOnDisk, true, "removeWorktree must receive pathOnDisk=true when directory exists");
});

// Regression: post-merge deleted-branch case — checkLocalOnlyCommits returns false
// (all commits reachable from base branch) so removal proceeds without --force.
// Simulated via dep injection: hasLocalOnlyCommits returns false even though remote
// branch is absent (base-branch reachability proved the work was merged).
test("removeWorktreeForIssue: post-merge clean worktree (deleted remote branch, commits in base) → removed=true without --force", async () => {
  const cfg = makeCfg();
  const rec = makeRec(42, "merged-feature");
  let removeCalled = false;

  const deps: RemoveWorktreeDeps = {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    removeWorktree: async () => { removeCalled = true; },
    pathExists: () => true,
    // Simulates checkLocalOnlyCommits returning false when remote branch is gone but
    // commits are all reachable from origin/<base_branch> (the merged case).
    hasLocalOnlyCommits: async () => false,
  };

  const result = await removeWorktreeForIssue(cfg, 42, {}, deps);

  assert.equal(result.removed, true, "merged worktree must be removable without --force even if remote branch was deleted");
  assert.ok(removeCalled);
});

// ---------------------------------------------------------------------------
// Finding 2 regression: --remove-worktree must reject --dry-run and --detach
// ---------------------------------------------------------------------------

test("CLI: 'pipeline 42 --remove-worktree --dry-run' exits 2 with conflict error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "42", "--remove-worktree", "--dry-run"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.equal(result.status, 2, "must exit 2 when --remove-worktree is combined with --dry-run");
  assert.match(result.stderr, /--dry-run/, "error must name the conflicting flag");
});

test("CLI: 'pipeline 42 --remove-worktree --detach' exits 2 with conflict error", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "42", "--remove-worktree", "--detach"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  assert.equal(result.status, 2, "must exit 2 when --remove-worktree is combined with --detach");
  assert.match(result.stderr, /--detach/, "error must name the conflicting flag");
});

// Regression: adding !opts.removeWorktree to the --json guard must not remove the
// refine-spec exemption — `pipeline refine-spec --json` must reach dispatch, not exit 2.
test("CLI: 'pipeline refine-spec --json' is not rejected by the --json status-only guard", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "refine-spec", "--json"],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
  // The command may fail for other reasons (missing --title/--body, no GitHub auth),
  // but it must NOT exit 2 with the "requires --status" json-guard message.
  assert.ok(
    result.status !== 2 || !result.stderr.includes("--json requires --status"),
    `refine-spec --json must not be blocked by the --json guard; got: ${result.stderr}`,
  );
});
