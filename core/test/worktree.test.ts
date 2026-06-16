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
const noopMutexDeps: Pick<CreateWorktreeDeps, "acquireMutex" | "releaseMutex" | "sleep" | "resolveGitCommonDir"> = {
  acquireMutex: (_p) => {},
  releaseMutex: (_p) => {},
  sleep: async (_ms) => {},
  // Identity: no real git call; all tests use a fake cfg.repo_dir anyway.
  resolveGitCommonDir: async (repoDir) => repoDir,
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
  let mainUnlinked = false;
  let createCount = 0;
  acquireWorktreeMutex("/tmp/test-wt.lock", makeMutexDeps({
    atomicCreate: (p, _c) => {
      createCount++;
      if (p.endsWith(".reclaim")) return true; // reclaim lock acquired
      // Main lock: first EEXIST, third acquired after reclaim.
      return createCount >= 3;
    },
    readContent: (p) => {
      if (p.endsWith(".reclaim")) return null;
      return "99999";
    },
    unlink: (p) => {
      if (!p.endsWith(".reclaim")) mainUnlinked = true;
    },
    isPidAlive: (_pid) => false, // dead process
  }));
  assert.ok(mainUnlinked, "stale main lock file must be removed");
  assert.equal(createCount, 3, "must attempt: main(fail), reclaim(acquire), main(acquire after reclaim)");
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
    ...noopMutexDeps,
  };

  const result = await createWorktree(cfg, 42, "slug", deps);
  assert.equal(worktreeAddCalls, 2, "must retry once and succeed on second attempt");
  assert.ok(result.path.includes("pipeline-42-slug"));
});

test("createWorktree: all 4 git worktree add attempts fail with config.lock → throws with final stderr", async () => {
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
    ...noopMutexDeps,
  };

  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    /git worktree add failed/,
  );
  assert.equal(worktreeAddCalls, 4, "must attempt 4 times (1 initial + 3 retries) before giving up");
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
    ...noopMutexDeps,
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
    ...noopMutexDeps,
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
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    resolveGitCommonDir: async (d) => d,
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
    resolveGitCommonDir: async (d) => d,
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

test("acquireWorktreeMutex: does not unlink main lock when content changed before unlink (concurrent stale reclaim guard)", () => {
  let mainUnlinked = false;
  let reclaimUnlinked = false;
  let readCount = 0;
  let createCount = 0;

  // Simulates: two processes both see the dead PID "1234".  This process
  // acquires the reclaimer lock, then re-reads the main lock content — it has
  // changed to "9999" (another process already won the race and reacquired).
  // The guard must restart without unlinking the main lock.
  acquireWorktreeMutex("/tmp/test-wt.lock", {
    atomicCreate: (p, _c) => {
      createCount++;
      if (p.endsWith(".reclaim")) return true; // reclaim lock acquired
      // Main lock: first EEXIST (dead-PID lock), third acquired after restart.
      return createCount >= 3;
    },
    readContent: (p) => {
      readCount++;
      if (p.endsWith(".reclaim")) return null; // not called in this path
      if (readCount === 1) return "1234"; // initial read: dead PID
      if (readCount === 2) return "9999"; // re-verify inside reclaim lock: content changed
      return null;
    },
    unlink: (p) => {
      if (p.endsWith(".reclaim")) reclaimUnlinked = true;
      else mainUnlinked = true;
    },
    isPidAlive: (pid) => pid !== 1234,
    currentPid: () => 42,
  });

  assert.equal(mainUnlinked, false, "must not unlink main lock when content changed — prevents removing a freshly acquired lock");
  assert.ok(reclaimUnlinked, "reclaim lock must be released in finally even when content changed");
  assert.equal(createCount, 3, "must retry atomicCreate on main lock after content-changed restart");
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
    resolveGitCommonDir: async (d) => d,
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

// ---------------------------------------------------------------------------
// Finding 1 (#183 review 2): mutex key must use git common dir, not repo_dir
//
// Regression: two linked worktrees of the same repo have different repo_dir
// paths but share a single .git/config (via the common dir).  Keying the
// mutex on repo_dir would produce different lock files, leaving the config.lock
// race intact.  Both runs must resolve to the same mutex path.
// ---------------------------------------------------------------------------

test("createWorktree: two runs from different linked worktrees of the same repo use the same mutex path", async () => {
  // Simulate two pipeline instances: one started from the repo root, one from
  // a linked worktree (different repo_dir, same underlying .git directory).
  const cfg1 = { ...makeCreateCfg(), repo_dir: "/repo" };
  const cfg2 = { ...makeCreateCfg(), repo_dir: "/repo/.worktrees/pipeline-999-other" };

  const capturedMutexPaths: string[] = [];

  const makeDeps = (): CreateWorktreeDeps => ({
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    // Both worktrees share the same common dir regardless of their repo_dir.
    resolveGitCommonDir: async (_repoDir) => "/repo/.git",
    acquireMutex: (p) => { capturedMutexPaths.push(p); },
    releaseMutex: (_p) => {},
    sleep: async (_ms) => {},
  });

  await createWorktree(cfg1, 1, "issue-one", makeDeps());
  await createWorktree(cfg2, 2, "issue-two", makeDeps());

  assert.equal(capturedMutexPaths.length, 2, "each call must acquire the mutex once");
  assert.equal(
    capturedMutexPaths[0],
    capturedMutexPaths[1],
    "two runs from different linked worktrees must acquire the same per-repo mutex",
  );
});

// ---------------------------------------------------------------------------
// Finding 2 (#183 review 2): mutex wait timeout must cover the git subprocess
//
// Regression: MUTEX_TIMEOUT_MS was 30 s but the git subprocess can run up to
// 60 s.  A holder mid-checkout would cause the waiter to give up too early.
// The timeout must be at least 90 s (60 s git timeout + 30 s margin).
// ---------------------------------------------------------------------------

test("createWorktree: mutex wait succeeds after more than 30s of simulated waiting (timeout is ≥ 90s)", async () => {
  const cfg = makeCreateCfg();
  let acquireAttempts = 0;
  let totalSleepMs = 0;

  // 151 failed attempts × 200ms poll = 30,200ms simulated time.
  // The old 30,000ms timeout would fire before attempt 152.
  const FAIL_COUNT = 151;

  const deps: CreateWorktreeDeps = {
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    resolveGitCommonDir: async (d) => d,
    acquireMutex: (_p) => {
      acquireAttempts++;
      if (acquireAttempts <= FAIL_COUNT) {
        throw new Error(
          "Worktree mutex held by process 99999: /tmp/test.lock. " +
          "Wait for the concurrent worktree creation to finish, or remove the file if you are sure it is stale.",
        );
      }
      // Attempt 152: holder released, acquire succeeds.
    },
    releaseMutex: (_p) => {},
    sleep: async (ms) => { totalSleepMs += ms; },
  };

  const result = await createWorktree(cfg, 42, "slug", deps);
  assert.equal(acquireAttempts, FAIL_COUNT + 1, "must retry until the mutex is released");
  assert.ok(
    totalSleepMs > 30_000,
    `simulated wait was ${totalSleepMs}ms but must exceed the old 30,000ms timeout`,
  );
  assert.ok(result.path.includes("pipeline-42-slug"));
});

// ---------------------------------------------------------------------------
// Finding 3 (#183 review 2): reclaim lock blocks concurrent reclaimer from
// unlinking the fresh main lock
//
// Regression: two processes both see the dead PID; the first reclaims and
// reacquires; the second's unlink fires after the reacquire, deleting the
// fresh lock.  Fix: a short-lived reclaimer lock serializes the reclaim
// sequence so only one process can unlink-and-reacquire at a time.
// ---------------------------------------------------------------------------

// After fix for Finding 2 (#183 review 2): a live reclaimer now causes
// acquireWorktreeMutex to THROW instead of recursing, so createWorktree's
// bounded sleep loop handles the wait without unbounded stack growth.
test("acquireWorktreeMutex: live reclaim-lock holder → throws, main lock not unlinked", () => {
  let mainUnlinked = false;
  let atomicCreateCount = 0;

  // Scenario: Process A holds the reclaim lock (live PID 9999) while reclaiming
  // the stale main lock (dead PID 1234).  Process B (this test) also sees the
  // dead PID, tries to get the reclaim lock, sees A is alive, and throws —
  // without ever touching the main lock.  The caller (createWorktree) retries
  // with bounded sleep until A finishes and releases the lock.
  assert.throws(
    () => acquireWorktreeMutex("/tmp/test-wt.lock", {
      atomicCreate: (p, _c) => {
        atomicCreateCount++;
        if (p.endsWith(".reclaim")) {
          // Reclaim lock is held by process A (PID 9999).
          return false;
        }
        // Main lock always EEXIST for this test (we only check the throw path).
        return false;
      },
      readContent: (p) => {
        if (p.endsWith(".reclaim")) return "9999"; // A is alive in the reclaim lock
        return "1234";                              // dead PID in the main lock
      },
      unlink: (p) => {
        if (!p.endsWith(".reclaim")) mainUnlinked = true;
      },
      isPidAlive: (pid) => pid === 9999, // 9999 (reclaimer A) alive, 1234 (main holder) dead
      currentPid: () => 42,
    }),
    /Worktree mutex held by process 9999/,
    "must throw with the reclaimer PID when a live reclaimer holds the reclaim lock",
  );

  assert.equal(
    mainUnlinked,
    false,
    "main lock must NOT be unlinked when a live reclaimer already holds the reclaim lock",
  );
});

// ---------------------------------------------------------------------------
// Finding 1 (#183 review 2): invalid/garbage lock content must route through
// the reclaimer lock, not unlink directly.
//
// Regression: two concurrent callers both read the same garbage/empty lock
// content, both pass the invalid-PID check, both call unlink — the second
// unlink deletes the first's freshly-acquired lock, reopening the race.
// Fix: invalid content is treated identically to a dead PID and goes through
// the reclaim-lock protocol.
// ---------------------------------------------------------------------------

test("acquireWorktreeMutex: invalid/garbage lock content routes through reclaimer lock before unlinking", () => {
  // Verify that the reclaim lock IS acquired even for garbage content, and
  // that the main lock is unlinked exactly once (serialized by the reclaim lock).
  let reclaimAcquired = false;
  let mainUnlinkCount = 0;
  let createCount = 0;

  acquireWorktreeMutex("/tmp/test-wt.lock", {
    atomicCreate: (p, _c) => {
      createCount++;
      if (p.endsWith(".reclaim")) {
        reclaimAcquired = true;
        return true; // we win the reclaim lock
      }
      return createCount >= 3; // main lock: EEXIST first, acquired after reclaim
    },
    readContent: (p) => {
      if (p.endsWith(".reclaim")) return null;
      return "not-a-pid"; // garbage content
    },
    unlink: (p) => {
      if (!p.endsWith(".reclaim")) mainUnlinkCount++;
    },
    isPidAlive: () => false,
    currentPid: () => 42,
  });

  assert.ok(reclaimAcquired, "reclaim lock must be acquired even for invalid/garbage lock content");
  assert.equal(mainUnlinkCount, 1, "main lock must be unlinked exactly once via the serialized reclaim path");
});

test("acquireWorktreeMutex: two reclaimers with same invalid content — second restarts after first wins reclaim lock", () => {
  // Simulates process B (this test): sees garbage content, tries reclaim lock
  // → fails (process A holds it), reads A's live PID from reclaim lock → throws.
  // Proves the second reclaimer cannot sneak past to unlink the main lock.
  let mainUnlinked = false;

  assert.throws(
    () => acquireWorktreeMutex("/tmp/test-wt.lock", {
      atomicCreate: (p, _c) => {
        if (p.endsWith(".reclaim")) return false; // A holds the reclaim lock
        return false;                              // main lock EEXIST
      },
      readContent: (p) => {
        if (p.endsWith(".reclaim")) return "8888"; // A is alive
        return "not-a-pid";                        // garbage main lock content
      },
      unlink: (p) => {
        if (!p.endsWith(".reclaim")) mainUnlinked = true;
      },
      isPidAlive: (pid) => pid === 8888,
      currentPid: () => 42,
    }),
    /Worktree mutex held by process 8888/,
    "must throw when a live process holds the reclaim lock during invalid-content reclaim",
  );

  assert.equal(mainUnlinked, false, "second reclaimer must NOT unlink the main lock");
});
