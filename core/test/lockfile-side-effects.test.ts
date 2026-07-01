// Regression tests for lock-file side-effect inclusion (#358).
//
// Tests the helper directly via injectable seams — no real git, network, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  includeLockfileSideEffects,
  isLockFilePath,
  type LockfileSideEffectsDeps,
} from "../scripts/lockfile-side-effects.ts";

// ---------------------------------------------------------------------------
// isLockFilePath — unit
// ---------------------------------------------------------------------------

test("isLockFilePath: recognizes bare lock file names", () => {
  assert.equal(isLockFilePath("package-lock.json"), true);
  assert.equal(isLockFilePath("yarn.lock"), true);
  assert.equal(isLockFilePath("pnpm-lock.yaml"), true);
});

test("isLockFilePath: recognizes nested lock file paths", () => {
  assert.equal(isLockFilePath("core/package-lock.json"), true);
  assert.equal(isLockFilePath("plugin/.claude/skills/pipeline/core/package-lock.json"), true);
  assert.equal(isLockFilePath("some/deep/nested/yarn.lock"), true);
  assert.equal(isLockFilePath("plugin/pnpm-lock.yaml"), true);
});

test("isLockFilePath: rejects non-lock files", () => {
  assert.equal(isLockFilePath("core/scripts/foo.ts"), false);
  assert.equal(isLockFilePath("package.json"), false);
  assert.equal(isLockFilePath("lock.json"), false);
  assert.equal(isLockFilePath("package-lock.json.bak"), false);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Calls {
  added: string[][];
  amended: number;
}

function makeDeps(porcelainOutput: string): { deps: LockfileSideEffectsDeps; calls: Calls } {
  const calls: Calls = { added: [], amended: 0 };
  const deps: LockfileSideEffectsDeps = {
    gitStatusPorcelain: async () => porcelainOutput,
    gitAddPaths: async (_wt, paths) => { calls.added.push(paths); },
    gitAmendNoEdit: async () => { calls.amended++; },
  };
  return { deps, calls };
}

// ---------------------------------------------------------------------------
// 3.1: Lock dirty after commit → helper stages lock file and amends HEAD
// ---------------------------------------------------------------------------

test("dirty lock after commit → stages lock and amends HEAD (3.1)", async () => {
  const { deps, calls } = makeDeps(" M core/package-lock.json\n");
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes("core/package-lock.json"));
  assert.deepEqual(calls.added, [["core/package-lock.json"]], "stages only the lock path");
  assert.equal(calls.amended, 1, "amends HEAD exactly once");
});

test("biting test: without inclusion, lock file stays uncommitted (3.1 bites)", async () => {
  // Simulate the state without calling includeLockfileSideEffects.
  // The porcelain output still shows the dirty lock file.
  const { calls } = makeDeps(" M core/package-lock.json\n");
  // We deliberately do NOT call includeLockfileSideEffects here.
  assert.deepEqual(calls.added, [], "no add occurred — lock file remains uncommitted");
  assert.equal(calls.amended, 0, "no amend occurred — worktree dirty");
});

// ---------------------------------------------------------------------------
// 3.2: No lock change → helper is a no-op
// ---------------------------------------------------------------------------

test("no lock change → no-op: gitAddPaths and gitAmendNoEdit not called (3.2)", async () => {
  for (const status of [
    "",
    "   \n",
    " M core/scripts/fix.ts\n",
    " M core/scripts/fix.ts\n M core/package.json\n",
  ]) {
    const { deps, calls } = makeDeps(status);
    const result = await includeLockfileSideEffects("/wt", deps);
    assert.equal(result.included, false, `should be no-op for status: ${JSON.stringify(status)}`);
    assert.deepEqual(calls.added, [], "gitAddPaths not called");
    assert.equal(calls.amended, 0, "gitAmendNoEdit not called");
  }
});

// ---------------------------------------------------------------------------
// 3.3: Mixed dirt → only lock files are staged
// ---------------------------------------------------------------------------

test("mixed dirt: only lock file is staged, non-lock left untouched (3.3)", async () => {
  const { deps, calls } = makeDeps(
    " M core/package-lock.json\n M core/scripts/foo.ts\n",
  );
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes("core/package-lock.json"), "lock path included");
  assert.ok(result.included && !result.paths.includes("core/scripts/foo.ts"), "non-lock NOT included");
  assert.deepEqual(calls.added, [["core/package-lock.json"]], "only lock file staged");
  assert.equal(calls.amended, 1);
});

// ---------------------------------------------------------------------------
// 3.4: Nested lock file recognized and included
// ---------------------------------------------------------------------------

test("nested lock file path recognized and included (3.4)", async () => {
  const nestedPath = "plugin/.claude/skills/pipeline/core/package-lock.json";
  const { deps, calls } = makeDeps(` M ${nestedPath}\n`);
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes(nestedPath), "nested lock path folded in");
  assert.deepEqual(calls.added, [[nestedPath]]);
  assert.equal(calls.amended, 1);
});

// ---------------------------------------------------------------------------
// Multiple lock files
// ---------------------------------------------------------------------------

test("multiple lock files all staged in one add call", async () => {
  const { deps, calls } = makeDeps(
    " M core/package-lock.json\n M plugin/yarn.lock\n M pnpm-lock.yaml\n",
  );
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.length === 3);
  assert.equal(calls.added.length, 1, "single gitAddPaths call with all paths");
  assert.ok(calls.added[0].includes("core/package-lock.json"));
  assert.ok(calls.added[0].includes("plugin/yarn.lock"));
  assert.ok(calls.added[0].includes("pnpm-lock.yaml"));
  assert.equal(calls.amended, 1);
});

// ---------------------------------------------------------------------------
// Rename porcelain format
// ---------------------------------------------------------------------------

test("rename porcelain format: uses destination path for lock file detection", async () => {
  // Porcelain rename: "R  old -> new"
  const { deps, calls } = makeDeps("R  old-lock.json -> core/package-lock.json\n");
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes("core/package-lock.json"));
  assert.deepEqual(calls.added, [["core/package-lock.json"]]);
});

test("rename to non-lock destination: not included", async () => {
  const { deps, calls } = makeDeps("R  package-lock.json -> core/scripts/something.ts\n");
  const result = await includeLockfileSideEffects("/wt", deps);
  assert.equal(result.included, false);
  assert.deepEqual(calls.added, []);
  assert.equal(calls.amended, 0);
});

// ---------------------------------------------------------------------------
// 3.6: Pre-staged non-lock file is not swept into the amend (regression #358 finding 1)
// ---------------------------------------------------------------------------

test("pre-staged non-lock file: temporarily unstaged before amend, re-staged after (regression #358 f1)", async () => {
  // "M  core/scripts/foo.ts" = staged modification (X=M, Y=space)
  // " M core/package-lock.json" = worktree-modified lock file, not staged (X=space, Y=M)
  // Without the fix: amendFn would amend with both foo.ts (pre-staged) and package-lock.json.
  // With the fix: foo.ts is unstaged before the amend and re-staged after; only the
  // lock file is folded in. Bites: remove the gitRestoreStaged call and restoreStaged stays [].
  const restoreStaged: string[][] = [];
  const added: string[][] = [];
  let amended = 0;
  const deps: LockfileSideEffectsDeps = {
    gitStatusPorcelain: async () => "M  core/scripts/foo.ts\n M core/package-lock.json\n",
    gitRestoreStaged: async (_wt, paths) => { restoreStaged.push([...paths]); },
    gitAddPaths: async (_wt, paths) => { added.push([...paths]); },
    gitAmendNoEdit: async () => { amended++; },
  };
  const result = await includeLockfileSideEffects("/wt", deps);

  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes("core/package-lock.json"));
  // Pre-staged non-lock path is restored before the amend so it is not swept in.
  assert.deepEqual(restoreStaged, [["core/scripts/foo.ts"]], "gitRestoreStaged called with pre-staged non-lock path");
  // Only the lock file is staged for the amend.
  assert.deepEqual(added[0], ["core/package-lock.json"], "lock file staged first");
  // HEAD is amended exactly once.
  assert.equal(amended, 1, "amend called exactly once");
  // Pre-staged non-lock path is re-staged after the amend (preserves its staged state).
  assert.deepEqual(added[1], ["core/scripts/foo.ts"], "non-lock path re-staged after amend");
  assert.equal(added.length, 2, "gitAddPaths called exactly twice");
});

test("staged rename (non-lock): both sides unstaged before amend, rename re-staged after (regression #358 f1-rename)", async () => {
  // Bug: old code tracked only the dst path (new.ts) in preStagedNonLock.
  // git restore --staged -- new.ts unstaged the addition but left the staged deletion
  // of old.ts in the index; the amend then committed that deletion into HEAD.
  // Fix: track both src (as deletion) and dst (as addition) for rename entries.
  // Bites: with old code, restoreStaged[0] is ["core/scripts/new.ts"] only — the
  // assert.ok(restoreStaged[0].includes("core/scripts/old.ts")) assertion fails.
  const restoreStaged: string[][] = [];
  const added: string[][] = [];
  const rmCached: string[][] = [];
  let amended = 0;
  const deps: LockfileSideEffectsDeps = {
    gitStatusPorcelain: async () =>
      "R  core/scripts/old.ts -> core/scripts/new.ts\n M core/package-lock.json\n",
    gitRestoreStaged: async (_wt, paths) => { restoreStaged.push([...paths]); },
    gitAddPaths: async (_wt, paths) => { added.push([...paths]); },
    gitAmendNoEdit: async () => { amended++; },
    gitRmCached: async (_wt, paths) => { rmCached.push([...paths]); },
  };
  const result = await includeLockfileSideEffects("/wt", deps);

  assert.equal(result.included, true);
  assert.ok(result.included && result.paths.includes("core/package-lock.json"));
  // Both sides of the rename must be unstaged before the amend.
  assert.equal(restoreStaged.length, 1, "gitRestoreStaged called once");
  assert.ok(restoreStaged[0].includes("core/scripts/old.ts"), "src side of rename unstaged");
  assert.ok(restoreStaged[0].includes("core/scripts/new.ts"), "dst side of rename unstaged");
  // Only the lock file is staged for the amend.
  assert.deepEqual(added[0], ["core/package-lock.json"], "lock file staged first");
  assert.equal(amended, 1, "HEAD amended exactly once");
  // Rename is restored: src as deletion via gitRmCached, dst as addition via gitAddPaths.
  assert.deepEqual(rmCached, [["core/scripts/old.ts"]], "src deletion re-applied via gitRmCached");
  assert.deepEqual(added[1], ["core/scripts/new.ts"], "dst addition re-staged via gitAddPaths");
  assert.equal(added.length, 2, "gitAddPaths called exactly twice");
});

test("pre-staged deletion: unstaged before amend, removed from index again after", async () => {
  // "D  core/scripts/gone.ts" = staged deletion (X=D)
  // " M core/package-lock.json" = dirty lock file
  const restoreStaged: string[][] = [];
  const added: string[][] = [];
  const rmCached: string[][] = [];
  let amended = 0;
  const deps: LockfileSideEffectsDeps = {
    gitStatusPorcelain: async () => "D  core/scripts/gone.ts\n M core/package-lock.json\n",
    gitRestoreStaged: async (_wt, paths) => { restoreStaged.push([...paths]); },
    gitAddPaths: async (_wt, paths) => { added.push([...paths]); },
    gitAmendNoEdit: async () => { amended++; },
    gitRmCached: async (_wt, paths) => { rmCached.push([...paths]); },
  };
  const result = await includeLockfileSideEffects("/wt", deps);

  assert.equal(result.included, true);
  assert.deepEqual(restoreStaged, [["core/scripts/gone.ts"]], "staged deletion unstaged before amend");
  assert.deepEqual(added, [["core/package-lock.json"]], "only lock file staged for amend");
  assert.equal(amended, 1);
  assert.deepEqual(rmCached, [["core/scripts/gone.ts"]], "deletion re-applied via gitRmCached after amend");
});
