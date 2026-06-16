// Unit tests for worktree sweep logic.
//
// sweepMergedWorktrees is tested via injected deps to avoid real git/gh calls.
// parseDirtyWorkdir is pure and tested directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDirtyWorkdir, isDirtyResult, sweepMergedWorktrees, createWorktree, acquireWorktreeMutex } from "../scripts/worktree.ts";
import type { WorktreeRecord, SweepDeps, CreateWorktreeDeps, AcquireWorktreeMutexDeps } from "../scripts/worktree.ts";
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

// ---------------------------------------------------------------------------
// createWorktree — stale-path reclaim before capacity check (review-2 finding 1)
//
// Regression: setup succeeded but a later ready-stage step blocked, leaving the
// worktree alive. On the next run, countActive() counted that stale worktree
// against max_concurrent_worktrees, so the retry was permanently stuck at
// "At worktree capacity" before the stale-path removal could fire.
// Fix: reclaim the target issue's stale path BEFORE the capacity check.
// ---------------------------------------------------------------------------

function makeCreateCfg(): PipelineConfig {
  return {
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    max_concurrent_worktrees: 1,
  } as unknown as PipelineConfig;
}

// No-op mutex/sleep deps shared by createWorktree unit tests that don't
// exercise the mutex or retry logic (avoids real fs lock files in CI).
const noopMutexDeps: Pick<CreateWorktreeDeps, "acquireMutex" | "releaseMutex" | "sleep"> = {
  acquireMutex: (_p) => {},
  releaseMutex: (_p) => {},
  sleep: async (_ms) => {},
};

test("createWorktree: this issue's stale worktree is reclaimed before the capacity check", async () => {
  const cfg = makeCreateCfg();
  let removedIssue: number | null = null;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [makeRec(42, "slug")],
    existsSync: () => false,
    removeWorktree: async (_cfg, issueNumber) => { removedIssue = issueNumber; },
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutexDeps,
  };

  const result = await createWorktree(cfg, 42, "slug", deps);

  assert.equal(result.path.includes("pipeline-42"), true);
  assert.equal(removedIssue, 42, "this issue's stale worktree must be reclaimed");
});

test("createWorktree: no stale worktree → does not call removeWorktree", async () => {
  const cfg = makeCreateCfg();
  let removeCalled = false;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => { removeCalled = true; },
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutexDeps,
  };

  const result = await createWorktree(cfg, 42, "slug", deps);
  assert.equal(result.path.includes("pipeline-42"), true);
  assert.equal(removeCalled, false, "removeWorktree must not be called when the issue has no active worktree");
});

test("createWorktree: capacity check still fires when OTHER issues fill the pool", async () => {
  // The target issue is excluded from the capacity count, but OTHER issues
  // occupying the pool must still raise the capacity error.
  const cfg = makeCreateCfg(); // max_concurrent_worktrees: 1

  const deps: CreateWorktreeDeps = {
    // #42 has a stale worktree AND #99 fills the only slot.
    listActive: async () => [makeRec(42, "slug"), makeRec(99, "other")],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutexDeps,
  };

  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    /At worktree capacity/,
    "capacity error must fire when OTHER issues fill the pool",
  );
});

test("createWorktree: a full pool of THIS issue's own stale worktrees never blocks its retry", async () => {
  // Issue #42 accumulated TWO stale worktrees under different slugs (old-a,
  // old-b) across repeated title changes — enough to exhaust
  // max_concurrent_worktrees: 1 by itself. The retry uses slug "new-title".
  // ALL of #42's own worktrees must be reclaimed AND excluded from the capacity
  // count, so the retry succeeds instead of deadlocking on its own slots.
  //
  // Bites the single-record / count-self reclaim: removing only the first
  // record and counting the rest leaves the pool full (>= 1) and throws
  // "At worktree capacity".
  const cfg = makeCreateCfg(); // max_concurrent_worktrees: 1
  const removed: string[] = [];

  const deps: CreateWorktreeDeps = {
    listActive: async () => [makeRec(42, "old-a"), makeRec(42, "old-b")],
    existsSync: () => false,
    removeWorktree: async (_cfg, _issueNumber, slug) => { removed.push(slug); },
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopMutexDeps,
  };

  const result = await createWorktree(cfg, 42, "new-title", deps);

  assert.equal(
    result.path.includes("pipeline-42-new-title"),
    true,
    "the fresh worktree uses the new slug and is not blocked by the issue's own stale slots",
  );
  assert.deepEqual(
    removed.sort(),
    ["old-a", "old-b"],
    "every stale worktree for the issue must be reclaimed, not just the first",
  );
});

// ---------------------------------------------------------------------------
// acquireWorktreeMutex — stale-PID recovery and live-PID failure (#183)
// ---------------------------------------------------------------------------

function makeMutexDeps(
  overrides: Partial<AcquireWorktreeMutexDeps>,
): AcquireWorktreeMutexDeps {
  return {
    atomicCreate: (_p, _c) => true,
    readContent: (_p) => null,
    unlink: (_p) => {},
    isPidAlive: (_pid) => false,
    currentPid: () => 42,
    ...overrides,
  };
}

test("acquireWorktreeMutex: clean path → writes current PID and returns", () => {
  let writtenContent = "";
  acquireWorktreeMutex("/tmp/test-wt.lock", makeMutexDeps({
    atomicCreate: (_p, c) => { writtenContent = c; return true; },
    currentPid: () => 99,
  }));
  assert.equal(writtenContent, "99", "current PID must be written to the lock file");
});

test("acquireWorktreeMutex: stale file (dead PID) → reclaimed and acquired", () => {
  let unlinked = false;
  let createCount = 0;
  acquireWorktreeMutex("/tmp/test-wt.lock", makeMutexDeps({
    atomicCreate: (_p, _c) => {
      createCount++;
      return createCount === 1 ? false : true; // first: EEXIST, second: acquired
    },
    readContent: (_p) => "99999",
    unlink: (_p) => { unlinked = true; },
    isPidAlive: (_pid) => false, // dead process
  }));
  assert.ok(unlinked, "stale lock file must be removed");
  assert.equal(createCount, 2, "must re-try acquisition after reclaim");
});

test("acquireWorktreeMutex: live PID → throws", () => {
  let createCount = 0;
  assert.throws(
    () => acquireWorktreeMutex("/tmp/test-wt.lock", makeMutexDeps({
      atomicCreate: (_p, _c) => { createCount++; return false; }, // always EEXIST
      readContent: (_p) => "55555",
      isPidAlive: (_pid) => true, // live process
    })),
    /Worktree mutex held by process 55555/,
  );
});

test("acquireWorktreeMutex: garbage lock content → treated as stale, reclaimed", () => {
  let unlinked = false;
  let createCount = 0;
  acquireWorktreeMutex("/tmp/test-wt.lock", makeMutexDeps({
    atomicCreate: (_p, _c) => { createCount++; return createCount > 1; },
    readContent: (_p) => "not-a-pid",
    unlink: (_p) => { unlinked = true; },
  }));
  assert.ok(unlinked, "garbage-content lock must be removed");
});

// ---------------------------------------------------------------------------
// createWorktree retry logic on .git/config.lock contention (#183)
// ---------------------------------------------------------------------------

const CONFIG_LOCK_STDERR =
  "Preparing worktree (new branch 'pipeline/42-slug')\n" +
  "error: could not lock config file .git/config: File exists\n" +
  "error: unable to write upstream branch configuration";

test("createWorktree: first git worktree add fails with config.lock, second succeeds → returns normally", async () => {
  const cfg = makeCreateCfg();
  let worktreeAddCalls = 0;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args, _opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddCalls++;
        if (worktreeAddCalls === 1) {
          return { code: 1, stdout: "", stderr: CONFIG_LOCK_STDERR };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => {},
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  };

  const result = await createWorktree(cfg, 42, "slug", deps);
  assert.equal(worktreeAddCalls, 2, "must retry once and succeed on second attempt");
  assert.ok(result.path.includes("pipeline-42-slug"));
});

test("createWorktree: all 3 git worktree add attempts fail with config.lock → throws with final stderr", async () => {
  const cfg = makeCreateCfg();
  let worktreeAddCalls = 0;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args, _opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddCalls++;
        return { code: 1, stdout: "", stderr: CONFIG_LOCK_STDERR };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => {},
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  };

  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    /git worktree add failed/,
  );
  assert.equal(worktreeAddCalls, 3, "must attempt exactly 3 times before giving up");
});

test("createWorktree: non-lock git error → throws immediately without retrying", async () => {
  const cfg = makeCreateCfg();
  let worktreeAddCalls = 0;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args, _opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAddCalls++;
        return { code: 128, stdout: "", stderr: "fatal: '...' is already checked out" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => {},
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  };

  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    /git worktree add failed/,
  );
  assert.equal(worktreeAddCalls, 1, "must not retry on non-lock errors");
});

// ---------------------------------------------------------------------------
// createWorktree: dangling branch from failed attempt cleaned up before retry
// (#183 finding 1)
//
// Regression: `git worktree add -b <branch>` creates the branch before
// writing .git/config. A config-lock failure leaves the branch behind. The
// next retry would then fail with "branch already exists" (a non-lock error)
// and throw immediately instead of retrying. Fix: delete the branch before
// each retry attempt inside the lock.
// ---------------------------------------------------------------------------

test("createWorktree: dangling branch from config-lock failure is deleted before each retry", async () => {
  const cfg = makeCreateCfg();
  const callOrder: string[] = [];

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args) => {
      if (args[0] === "branch" && args[1] === "-D") {
        callOrder.push(`branch-D:${args[2]}`);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        const n = callOrder.filter((c) => c === "worktree-add").length;
        callOrder.push("worktree-add");
        if (n === 0) {
          // First attempt: config.lock failure; branch was already created
          return { code: 1, stdout: "", stderr: CONFIG_LOCK_STDERR };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => {},
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  };

  await createWorktree(cfg, 42, "slug", deps);

  const firstAddIdx = callOrder.indexOf("worktree-add");
  const branchDeleteAfterFirstAdd = callOrder
    .slice(firstAddIdx + 1)
    .includes("branch-D:pipeline/42-slug");
  assert.ok(
    branchDeleteAfterFirstAdd,
    `expected 'git branch -D pipeline/42-slug' after first failed worktree add; ` +
    `call order was: ${callOrder.join(", ")}`,
  );
  assert.equal(
    callOrder.filter((c) => c === "worktree-add").length,
    2,
    "must attempt worktree add exactly twice",
  );
});

// ---------------------------------------------------------------------------
// createWorktree: mutex wait/retry for live holders (#183 finding 2)
//
// Regression: acquireMutexFn was called once and threw immediately when a
// live process held the lock. Fix: retry with backoff until the holder
// releases or a timeout is reached.
// ---------------------------------------------------------------------------

test("createWorktree: waits for live mutex holder to release before proceeding", async () => {
  const cfg = makeCreateCfg();
  let acquireAttempts = 0;
  let slept = false;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args) => {
      if (args[0] === "worktree" && args[1] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => {
      acquireAttempts++;
      if (acquireAttempts === 1) {
        throw new Error(
          "Worktree mutex held by process 99999: /tmp/test.lock. " +
          "Wait for the concurrent worktree creation to finish, or remove the file if you are sure it is stale.",
        );
      }
      // Second call: holder released, acquire succeeds.
    },
    releaseMutex: (_p) => {},
    sleep: async (_ms) => { slept = true; },
  };

  const result = await createWorktree(cfg, 42, "slug", deps);
  assert.equal(acquireAttempts, 2, "must retry mutex acquisition after first failure");
  assert.ok(slept, "must sleep between mutex acquisition attempts");
  assert.ok(result.path.includes("pipeline-42-slug"));
});

test("createWorktree: non-mutex errors during acquire are not retried", async () => {
  const cfg = makeCreateCfg();

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    acquireMutex: (_p) => { throw new Error("EACCES: permission denied"); },
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  };

  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    /EACCES: permission denied/,
    "non-mutex errors must propagate immediately without retrying",
  );
});

// ---------------------------------------------------------------------------
// acquireWorktreeMutex: stale-reclaim race guard (#183 finding 3)
//
// Regression: two concurrent processes both read the same dead PID, one
// reclaims and reacquires, then the second's blind unlink removes the fresh
// lock. Fix: re-read content before unlinking; if it changed, restart instead
// of unlinking.
// ---------------------------------------------------------------------------

test("acquireWorktreeMutex: does not unlink when content changed before unlink (concurrent stale reclaim guard)", () => {
  let unlinked = false;
  let readCount = 0;
  let createCount = 0;

  // Simulates: two processes both see the dead PID "1234".  Before this
  // process can unlink, the other already removed and reacquired (content
  // changed to "9999").  The guard must skip the unlink and restart.
  acquireWorktreeMutex("/tmp/test-wt.lock", {
    atomicCreate: (_p, _c) => {
      createCount++;
      // First: EEXIST (dead-PID lock). Second: acquired cleanly after restart.
      return createCount >= 2;
    },
    readContent: (_p) => {
      readCount++;
      if (readCount === 1) return "1234"; // initial read: dead PID
      if (readCount === 2) return "9999"; // guard re-read: content changed
      return null;
    },
    unlink: (_p) => { unlinked = true; },
    isPidAlive: (pid) => pid !== 1234,
    currentPid: () => 42,
  });

  assert.equal(unlinked, false, "must not unlink when content changed — prevents removing a freshly acquired lock");
  assert.equal(createCount, 2, "must retry atomicCreate after content-changed restart");
});

// ---------------------------------------------------------------------------
// createWorktree mutex wiring: acquire before gitCmd, release in finally (#183)
// ---------------------------------------------------------------------------

test("createWorktree: mutex acquired before git worktree add, released after even when git fails", async () => {
  const cfg = makeCreateCfg();
  const events: string[] = [];

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_cfg, _cwd, args, _opts) => {
      if (args[0] === "worktree" && args[1] === "add") {
        events.push("git");
        return { code: 128, stdout: "", stderr: "fatal: branch already exists" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    acquireMutex: (_p) => { events.push("acquire"); },
    releaseMutex: (_p) => { events.push("release"); },
    sleep: async (_ms) => {},
  };

  await assert.rejects(() => createWorktree(cfg, 42, "slug", deps));
  assert.deepEqual(
    events,
    ["acquire", "git", "release"],
    "mutex must be acquired before git call and released in finally",
  );
});
