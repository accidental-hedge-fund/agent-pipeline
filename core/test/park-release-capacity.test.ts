// #718 — park-release of blocked worktrees + capacity admission disposition.
// All tests inject deps — no real git, network, or filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorktreeCapacityError,
  WORKTREE_CAPACITY_ERROR_CODE,
  WORKTREE_CAPACITY_MESSAGE_PREFIX,
  createWorktree,
  isWorktreeCapacityError,
  releaseWorktreeForParkedIssue,
  type CreateWorktreeDeps,
  type ParkReleaseDeps,
  type WorktreeRecord,
} from "../scripts/worktree.ts";
import { bootstrapWorktree, type BootstrapWorktreeDeps } from "../scripts/stages/planning.ts";
import {
  isAutoLoopRecoverable,
  isDurableParkOutcome,
} from "../scripts/pipeline-run.ts";
import {
  classifyDispatchOutcome,
  lastBlockerKindFromEventsJsonl,
} from "../scripts/pipeline.ts";
import type { PipelineConfig, Outcome } from "../scripts/types.ts";

function makeCfg(max = 2): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: "main",
    domain: "test",
    max_concurrent_worktrees: max,
  } as unknown as PipelineConfig;
}

function makeRec(issueNumber: number, slug: string, opts: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    path: `/repo/.worktrees/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
    underManagedRoot: true,
    ...opts,
  };
}

const noopCreateExtras: Pick<
  CreateWorktreeDeps,
  | "acquireMutex"
  | "releaseMutex"
  | "sleep"
  | "resolveGitCommonDir"
  | "writeNodeModulesExclude"
  | "lstatPath"
  | "unlinkPath"
  | "hasDirtyWorkdir"
  | "hasLocalOnlyCommits"
> = {
  acquireMutex: () => {},
  releaseMutex: () => {},
  sleep: async () => {},
  resolveGitCommonDir: async (d) => d,
  writeNodeModulesExclude: async () => {},
  lstatPath: async () => null,
  unlinkPath: async () => {},
  hasDirtyWorkdir: async () => false,
  hasLocalOnlyCommits: async () => false,
};

// ---------------------------------------------------------------------------
// Capacity error identity
// ---------------------------------------------------------------------------

test("WorktreeCapacityError is machine-distinguishable (#718)", () => {
  const err = new WorktreeCapacityError(5, 5);
  assert.equal(err.code, WORKTREE_CAPACITY_ERROR_CODE);
  assert.equal(err.name, "WorktreeCapacityError");
  assert.ok(err.message.startsWith(WORKTREE_CAPACITY_MESSAGE_PREFIX));
  assert.equal(isWorktreeCapacityError(err), true);
  assert.equal(isWorktreeCapacityError(new Error("git worktree add failed")), false);
  assert.equal(
    isWorktreeCapacityError(new Error(`${WORKTREE_CAPACITY_MESSAGE_PREFIX} (3/3). Wait`)),
    true,
    "plain Error with stable prefix is still recognized",
  );
});

test("createWorktree throws WorktreeCapacityError when other issues fill the pool", async () => {
  const cfg = makeCfg(1);
  const deps: CreateWorktreeDeps = {
    listActive: async () => [makeRec(99, "other")],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...noopCreateExtras,
  };
  await assert.rejects(
    () => createWorktree(cfg, 42, "slug", deps),
    (err: unknown) => {
      assert.equal(isWorktreeCapacityError(err), true);
      assert.ok(err instanceof WorktreeCapacityError);
      assert.equal(err.otherActive, 1);
      assert.equal(err.maxConcurrent, 1);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// bootstrap → capacity tag (not worktree-creation-failed / needs-human)
// ---------------------------------------------------------------------------

test("bootstrapWorktree: capacity error tags worktree-capacity (#718)", async () => {
  const deps: BootstrapWorktreeDeps = {
    createWorktree: async () => {
      throw new WorktreeCapacityError(5, 5);
    },
    detectAndInstall: async () => {
      throw new Error("should not be called");
    },
    removeWorktree: async () => {
      throw new Error("should not be called");
    },
  };
  const result = await bootstrapWorktree(makeCfg(), 42, "slug", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.tag, "worktree-capacity");
    assert.ok(result.reason.includes(WORKTREE_CAPACITY_MESSAGE_PREFIX));
  }
});

test("bootstrapWorktree: generic create failure stays worktree-creation-failed", async () => {
  const deps: BootstrapWorktreeDeps = {
    createWorktree: async () => {
      throw new Error("git worktree add failed: lock");
    },
    detectAndInstall: async () => {
      throw new Error("should not be called");
    },
    removeWorktree: async () => {},
  };
  const result = await bootstrapWorktree(makeCfg(), 42, "slug", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.tag, "worktree-creation-failed");
  }
});

// ---------------------------------------------------------------------------
// Park-release: safe release frees capacity for issue N+1
// ---------------------------------------------------------------------------

test("park-release: N clean parked worktrees release so issue N+1 can create (#718 Policy A)", async () => {
  const max = 2;
  const cfg = makeCfg(max);
  const onDisk = new Map<number, WorktreeRecord>([
    [10, makeRec(10, "a")],
    [11, makeRec(11, "b")],
  ]);
  const removed: number[] = [];

  for (const issue of [10, 11]) {
    const result = await releaseWorktreeForParkedIssue(cfg, issue, {
      listOnDisk: async () => [...onDisk.values()],
      hasDirtyWorkdir: async () => false,
      hasLocalOnlyCommits: async () => false,
      pathExists: () => true,
      hasRemoteBranchTip: async () => true,
      hasOpenPrForBranch: async () => false,
      removeWorktree: async (_c, n) => {
        removed.push(n);
        onDisk.delete(n);
      },
    } satisfies ParkReleaseDeps);
    assert.equal(result.action, "released", `issue #${issue} should release`);
  }
  assert.deepEqual(removed.sort(), [10, 11]);

  // After release, capacity count for a new issue is 0 — create succeeds at cap N.
  const createDeps: CreateWorktreeDeps = {
    listActive: async () => [...onDisk.values()],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_c, _cwd, args) => {
      // Prefer remote tip path may ls-remote; return empty so start from base.
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ...noopCreateExtras,
  };
  const created = await createWorktree(cfg, 12, "new", createDeps);
  assert.ok(created.path.includes("pipeline-12"));
});

test("park-release: dirty worktree is retained with visible reason", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => true,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => true,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /dirty/i);
  assert.equal(removeCalled, false);
});

test("park-release: local-only commits retain with reason", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => true,
    pathExists: () => true,
    hasRemoteBranchTip: async () => true,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /local-only/i);
  assert.equal(removeCalled, false);
});

test("park-release: missing remote and no open PR retains", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    hasOpenPrForBranch: async () => false,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /no remote branch tip|missing remote/i);
  assert.equal(removeCalled, false);
});

test("park-release: open PR allows release when remote tip absent", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    hasOpenPrForBranch: async () => true,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "released");
  assert.equal(removeCalled, true);
});

test("park-release: out-of-managed-root is never auto-released", async () => {
  const rec = makeRec(42, "feat", {
    underManagedRoot: false,
    path: "/home/dev/checkout",
  });
  // isManaged filters underManagedRoot === false — appears as absent.
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => true,
    removeWorktree: async () => {
      throw new Error("must not remove");
    },
  });
  assert.equal(result.action, "absent");
});

test("park-release: idempotent when no managed worktree on disk", async () => {
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [],
    removeWorktree: async () => {
      throw new Error("must not remove");
    },
  });
  assert.equal(result.action, "absent");
});

// ---------------------------------------------------------------------------
// Same-issue reclaim at cap 1 still works after capacity error typing
// ---------------------------------------------------------------------------

test("createWorktree: same-issue reclaim at max_concurrent_worktrees:1 still works (#718)", async () => {
  const cfg = makeCfg(1);
  let removed = false;
  const deps: CreateWorktreeDeps = {
    listActive: async () => [makeRec(42, "old")],
    existsSync: () => false,
    removeWorktree: async () => {
      removed = true;
    },
    mkdirSync: () => {},
    gitCmd: async (_c, _cwd, args) => {
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ...noopCreateExtras,
  };
  const result = await createWorktree(cfg, 42, "new", deps);
  assert.ok(result.path.includes("pipeline-42"));
  assert.equal(removed, true);
});

// ---------------------------------------------------------------------------
// Capacity disposition is not product needs-human
// ---------------------------------------------------------------------------

test("isAutoLoopRecoverable: worktree-capacity is not recoverable (#718)", () => {
  const out: Outcome = {
    advanced: false,
    status: "blocked",
    reason: "At worktree capacity (5/5)",
    blockerKind: "worktree-capacity",
  };
  assert.equal(isAutoLoopRecoverable(out), false);
});

test("classifyDispatchOutcome: worktree-capacity kind → capacity_wait not blocked_needs_human", () => {
  assert.equal(
    classifyDispatchOutcome({ labels: ["blocked", "pipeline:planning"], state: "open" }, "worktree-capacity"),
    "capacity_wait",
  );
  assert.equal(
    classifyDispatchOutcome({ labels: ["blocked", "pipeline:planning"], state: "open" }, "needs-human"),
    "blocked_needs_human",
  );
  assert.equal(
    classifyDispatchOutcome({ labels: ["blocked"], state: "open" }),
    "blocked_needs_human",
  );
});

test("lastBlockerKindFromEventsJsonl reads last blocker_set kind", () => {
  const text = [
    JSON.stringify({ type: "stage_start", stage: "planning" }),
    JSON.stringify({ type: "blocker_set", blocker_kind: "needs-human" }),
    JSON.stringify({ type: "blocker_set", blocker_kind: "worktree-capacity" }),
  ].join("\n");
  assert.equal(lastBlockerKindFromEventsJsonl(text), "worktree-capacity");
});

test("isDurableParkOutcome: blocked and finalized park; waiting does not", () => {
  assert.equal(
    isDurableParkOutcome({ advanced: false, status: "blocked", reason: "x", blockerKind: "needs-human" }),
    true,
  );
  assert.equal(
    isDurableParkOutcome({ advanced: false, status: "finalized", reason: "needs-human" }),
    true,
  );
  assert.equal(
    isDurableParkOutcome({ advanced: false, status: "waiting", reason: "ci pending" }),
    false,
  );
  assert.equal(
    isDurableParkOutcome({ advanced: true, from: "planning", to: "implementing", summary: "ok" }),
    false,
  );
});

// Without park-release, N parked siblings would fill capacity and block N+1.
// This bites the pre-fix resource leak: listActive still counts released-absent as 0.
test("regression bite: without release, parked siblings fill capacity for N+1", async () => {
  const cfg = makeCfg(2);
  const parked = [makeRec(10, "a"), makeRec(11, "b")];
  await assert.rejects(
    () =>
      createWorktree(cfg, 12, "c", {
        listActive: async () => parked,
        existsSync: () => false,
        removeWorktree: async () => {},
        mkdirSync: () => {},
        gitCmd: async () => ({ code: 0, stdout: "", stderr: "" }),
        ...noopCreateExtras,
      }),
    (err: unknown) => isWorktreeCapacityError(err),
  );
});
