// #718 — park-release of blocked worktrees + capacity admission disposition.
// All tests inject deps — no real git, network, or filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
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
  pinAdvanceRunIdentity,
  realDispatchItem,
} from "../scripts/pipeline.ts";
import {
  buildAttestedBlockedComment,
  buildBlockedComment,
  lastBlockerKindFromComments,
  latestBlockedLabeledAtFromEvents,
} from "../scripts/gh.ts";
import type { PipelineConfig, Outcome } from "../scripts/types.ts";

const PIPELINE_ACTOR = "pipeline-bot";
/** Shared blocked-label incarnation time for capacity comment fallback tests. */
const BLOCKED_LABELED_AT = "2026-07-30T22:00:00Z";

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
  | "resolveOpenPrHeadForBranch"
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
  // Default: no open PR head (tests that exercise PR recovery inject their own).
  resolveOpenPrHeadForBranch: async () => null,
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
      resolveOpenPrHeadForBranch: async () => null,
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
    resolveOpenPrHeadForBranch: async () => null,
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
    resolveOpenPrHeadForBranch: async () => null,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /no remote branch tip|missing remote/i);
  assert.equal(removeCalled, false);
});

test("park-release: open PR with resolvable head allows release when remote tip absent", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    resolveOpenPrHeadForBranch: async () => ({
      prNumber: 99,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "released");
  assert.equal(removeCalled, true);
});

test("park-release: open PR without resolvable head retains (not reconstructible)", async () => {
  const rec = makeRec(42, "feat");
  let removeCalled = false;
  const result = await releaseWorktreeForParkedIssue(makeCfg(), 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    // PR "exists" but head SHA unresolvable — must not release (#718 ac32c448).
    resolveOpenPrHeadForBranch: async () => null,
    removeWorktree: async () => {
      removeCalled = true;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /resolvable head|missing remote/i);
  assert.equal(removeCalled, false);
});

test("createWorktree: remote tip path verifies fetch + SHA before startPoint (#718 9ab37b7c)", async () => {
  const cfg = makeCfg(2);
  const remoteTip = "dddddddddddddddddddddddddddddddddddddddd";
  const branch = "pipeline/42-feat";
  const gitArgs: string[][] = [];
  const created = await createWorktree(cfg, 42, "feat", {
    ...noopCreateExtras,
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_c, _cwd, args) => {
      gitArgs.push([...args]);
      if (args[0] === "ls-remote") {
        return { code: 0, stdout: `${remoteTip}\trefs/heads/${branch}\n`, stderr: "" };
      }
      if (
        args[0] === "fetch" &&
        args.includes(`${branch}:refs/remotes/origin/${branch}`)
      ) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args.includes(`refs/remotes/origin/${branch}`)) {
        return { code: 0, stdout: `${remoteTip}\n`, stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    resolveOpenPrHeadForBranch: async () => null,
  });
  assert.ok(created.path.includes("pipeline-42"));
  const add = gitArgs.find((a) => a[0] === "worktree" && a[1] === "add");
  assert.ok(add, "worktree add must run");
  assert.equal(add![add!.length - 1], `origin/${branch}`);
});

test("createWorktree: failed branch fetch refuses stale startPoint (#718 9ab37b7c)", async () => {
  const cfg = makeCfg(2);
  const remoteTip = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const branch = "pipeline/42-feat";
  let worktreeAddCalled = false;
  await assert.rejects(
    () =>
      createWorktree(cfg, 42, "feat", {
        ...noopCreateExtras,
        listActive: async () => [],
        existsSync: () => false,
        removeWorktree: async () => {},
        mkdirSync: () => {},
        gitCmd: async (_c, _cwd, args) => {
          if (args[0] === "ls-remote") {
            return { code: 0, stdout: `${remoteTip}\trefs/heads/${branch}\n`, stderr: "" };
          }
          if (
            args[0] === "fetch" &&
            args.includes(`${branch}:refs/remotes/origin/${branch}`)
          ) {
            // Simulate fetch failure while a stale local remote-tracking ref
            // may still exist — must not proceed to worktree add.
            return { code: 1, stdout: "", stderr: "error: could not fetch" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            worktreeAddCalled = true;
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        resolveOpenPrHeadForBranch: async () => null,
      }),
    (err: unknown) =>
      err instanceof Error &&
      /git fetch origin pipeline\/42-feat failed/.test(err.message) &&
      /verified remote tip/.test(err.message),
  );
  assert.equal(worktreeAddCalled, false, "must not worktree add from stale ref");
});

test("createWorktree: SHA mismatch after fetch refuses stale startPoint (#718 9ab37b7c)", async () => {
  const cfg = makeCfg(2);
  const remoteTip = "ffffffffffffffffffffffffffffffffffffffff";
  const staleLocal = "1111111111111111111111111111111111111111";
  const branch = "pipeline/42-feat";
  let worktreeAddCalled = false;
  await assert.rejects(
    () =>
      createWorktree(cfg, 42, "feat", {
        ...noopCreateExtras,
        listActive: async () => [],
        existsSync: () => false,
        removeWorktree: async () => {},
        mkdirSync: () => {},
        gitCmd: async (_c, _cwd, args) => {
          if (args[0] === "ls-remote") {
            return { code: 0, stdout: `${remoteTip}\trefs/heads/${branch}\n`, stderr: "" };
          }
          if (
            args[0] === "fetch" &&
            args.includes(`${branch}:refs/remotes/origin/${branch}`)
          ) {
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "rev-parse" && args.includes(`refs/remotes/origin/${branch}`)) {
            // Fetch "succeeded" but local tracking ref still points at stale OID.
            return { code: 0, stdout: `${staleLocal}\n`, stderr: "" };
          }
          if (args[0] === "worktree" && args[1] === "add") {
            worktreeAddCalled = true;
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        resolveOpenPrHeadForBranch: async () => null,
      }),
    (err: unknown) =>
      err instanceof Error &&
      /does not match remote tip/.test(err.message) &&
      err.message.includes(remoteTip),
  );
  assert.equal(worktreeAddCalled, false, "must not worktree add from mismatched ref");
});

test("createWorktree: open PR head used when remote branch tip absent (#718 ac32c448)", async () => {
  const cfg = makeCfg(2);
  const prHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const gitArgs: string[][] = [];
  const created = await createWorktree(cfg, 42, "feat", {
    ...noopCreateExtras,
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_c, _cwd, args) => {
      gitArgs.push([...args]);
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "fetch" && args.includes(`pull/7/head:refs/remotes/origin/pipeline/42-feat`)) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    resolveOpenPrHeadForBranch: async (_c, branch) => {
      assert.equal(branch, "pipeline/42-feat");
      return { prNumber: 7, headSha: prHead };
    },
  });
  assert.ok(created.path.includes("pipeline-42"));
  const add = gitArgs.find((a) => a[0] === "worktree" && a[1] === "add");
  assert.ok(add, "worktree add must run");
  // Must not start from base alone when PR head was recoverable.
  assert.notEqual(add![add!.length - 1], "origin/main");
  assert.ok(
    add!.includes("origin/pipeline/42-feat") || add!.includes(prHead),
    `startPoint should be PR-derived, got: ${add!.join(" ")}`,
  );
});

test("regression: release then resume with no remote tip reconstructs from PR head", async () => {
  const cfg = makeCfg(1);
  const rec = makeRec(42, "feat");
  const prHead = "cccccccccccccccccccccccccccccccccccccccc";
  // 1) Park-release on open PR only (no remote tip).
  const release = await releaseWorktreeForParkedIssue(cfg, 42, {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 12, headSha: prHead }),
    removeWorktree: async () => {},
  });
  assert.equal(release.action, "released");

  // 2) Resume create with no remote tip — must use PR head, not base.
  const startPoints: string[] = [];
  await createWorktree(cfg, 42, "feat", {
    ...noopCreateExtras,
    listActive: async () => [],
    existsSync: () => false,
    removeWorktree: async () => {},
    mkdirSync: () => {},
    gitCmd: async (_c, _cwd, args) => {
      if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "worktree" && args[1] === "add") {
        startPoints.push(args[args.length - 1]!);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 12, headSha: prHead }),
  });
  assert.equal(startPoints.length, 1);
  assert.notEqual(startPoints[0], "origin/main");
  assert.ok(
    startPoints[0] === "origin/pipeline/42-feat" || startPoints[0] === prHead,
    `expected PR-derived start, got ${startPoints[0]}`,
  );
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

test("lastBlockerKindFromComments reads trusted attested pipeline-blocker-kind (#718 9873320c/b5108544)", () => {
  const body = buildAttestedBlockedComment({
    issueNumber: 42,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T00:00:00Z",
    reason: "At worktree capacity (5/5)",
    kind: "worktree-capacity",
    runId: "run-cap-1",
  });
  assert.match(body, /<!-- pipeline-blocker-kind: worktree-capacity -->/);
  const labeledAt = "2026-07-30T00:00:00Z";
  const createdAt = "2026-07-30T00:00:01Z";
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: PIPELINE_ACTOR, body, createdAt }],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    "worktree-capacity",
  );
  assert.equal(
    lastBlockerKindFromComments(
      [
        { author: PIPELINE_ACTOR, body: "unrelated", createdAt },
        { author: PIPELINE_ACTOR, body, createdAt },
      ],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    "worktree-capacity",
  );
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: PIPELINE_ACTOR, body: "no marker", createdAt }],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    null,
  );
});

test("lastBlockerKindFromComments rejects untrusted/unattested capacity marker (#718 b5108544)", () => {
  const unattested = buildBlockedComment({
    issueNumber: 42,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T00:00:00Z",
    reason: "forged capacity",
    kind: "worktree-capacity",
  });
  const labeledAt = "2026-07-30T00:00:00Z";
  const createdAt = "2026-07-30T00:00:01Z";
  // Unauthenticated marker alone must not reclassify.
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: "attacker", body: unattested, createdAt }],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    null,
  );
  // Wrong author even with real attested body fails closed.
  const attested = buildAttestedBlockedComment({
    issueNumber: 42,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T00:00:00Z",
    reason: "At worktree capacity (5/5)",
    kind: "worktree-capacity",
    runId: "run-cap-1",
  });
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: "attacker", body: attested, createdAt }],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    null,
  );
  // No trusted author available → fail closed (auth unavailable).
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: PIPELINE_ACTOR, body: attested, createdAt }],
      { trustedAuthor: null, blockedLabeledAt: labeledAt },
    ),
    null,
  );
  // Unattested body from the trusted author still fails closed.
  assert.equal(
    lastBlockerKindFromComments(
      [{ author: PIPELINE_ACTOR, body: unattested, createdAt }],
      { trustedAuthor: PIPELINE_ACTOR, blockedLabeledAt: labeledAt },
    ),
    null,
  );
});

test("lastBlockerKindFromComments rejects stale authentic capacity before current blocked label (#718 69894186)", () => {
  const capacityBody = buildAttestedBlockedComment({
    issueNumber: 42,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T10:00:00Z",
    reason: "At worktree capacity (2/2)",
    kind: "worktree-capacity",
    runId: "run-cap-old",
  });
  // Prior capacity comment (T1); current blocked label is a later product hold (T3)
  // whose blocker comment was lost — must not return worktree-capacity.
  assert.equal(
    lastBlockerKindFromComments(
      [
        {
          author: PIPELINE_ACTOR,
          body: capacityBody,
          createdAt: "2026-07-30T10:00:01Z",
        },
      ],
      {
        trustedAuthor: PIPELINE_ACTOR,
        blockedLabeledAt: "2026-07-30T12:00:00Z",
      },
    ),
    null,
  );
  // Same comment bound to its own incarnation still classifies as capacity.
  assert.equal(
    lastBlockerKindFromComments(
      [
        {
          author: PIPELINE_ACTOR,
          body: capacityBody,
          createdAt: "2026-07-30T10:00:01Z",
        },
      ],
      {
        trustedAuthor: PIPELINE_ACTOR,
        blockedLabeledAt: "2026-07-30T10:00:00Z",
      },
    ),
    "worktree-capacity",
  );
  // Missing incarnation binding fails closed even with a trusted capacity body.
  assert.equal(
    lastBlockerKindFromComments(
      [
        {
          author: PIPELINE_ACTOR,
          body: capacityBody,
          createdAt: "2026-07-30T10:00:01Z",
        },
      ],
      { trustedAuthor: PIPELINE_ACTOR },
    ),
    null,
  );
});

test("latestBlockedLabeledAtFromEvents picks the latest blocked label application", () => {
  assert.equal(
    latestBlockedLabeledAtFromEvents([
      { label: "pipeline:planning", createdAt: "2026-07-30T09:00:00Z" },
      { label: "blocked", createdAt: "2026-07-30T10:00:00Z" },
      { label: "pipeline:implementing", createdAt: "2026-07-30T11:00:00Z" },
      { label: "blocked", createdAt: "2026-07-30T12:00:00Z" },
    ]),
    "2026-07-30T12:00:00Z",
  );
  assert.equal(latestBlockedLabeledAtFromEvents([]), null);
  assert.equal(
    latestBlockedLabeledAtFromEvents([
      { label: "pipeline:planning", createdAt: "2026-07-30T09:00:00Z" },
    ]),
    null,
  );
});

function fakeSpawnChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  queueMicrotask(() => ee.emit("exit", 0, null));
  return ee;
}

test("realDispatchItem: clearBlocked failure still capacity_wait; re-dispatch uses comment kind (#718 9873320c)", async () => {
  const fixedNow = new Date("2026-07-30T22:09:03.000Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 718, fixedNow);
  const capacityComment = buildAttestedBlockedComment({
    issueNumber: 718,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T22:00:00Z",
    reason: "At worktree capacity (2/2)",
    kind: "worktree-capacity",
    runId: "run-cap-718",
  });
  let clearCalls = 0;

  // First dispatch: events have capacity kind; clear throws.
  const dispatch1 = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: (p) => p === expectedPin.events_path,
      readEventsText: () =>
        JSON.stringify({ type: "blocker_set", blocker_kind: "worktree-capacity" }) + "\n",
      spawn: ((cmd: string, args: readonly string[]) => {
        void cmd;
        void args;
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () =>
        ({
          labels: ["blocked", "pipeline:planning"],
          state: "open",
          comments: [{ author: PIPELINE_ACTOR, body: capacityComment, createdAt: "2026-07-30T22:00:00Z" }],
        }) as never,
      getPrForIssue: async () => null,
      getGhActor: async () => PIPELINE_ACTOR,
      getLatestBlockedLabeledAt: async () => BLOCKED_LABELED_AT,
      clearBlocked: async () => {
        clearCalls++;
        throw new Error("gh label remove failed: HTTP 502");
      },
    },
  );
  const response1 = await dispatch1(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "718",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-cap",
    },
    { onAdvanceLinked: async () => {} },
  );
  assert.equal(clearCalls, 1, "clearBlocked must be attempted (not silently skipped)");
  // Ops capacity disposition for this cycle — not needs-human / not silent no-op.
  assert.equal(response1.outcome, "capacity_wait");

  // Second dispatch: no events capacity kind (early-blocked re-dispatch), but
  // durable attested comment from the pipeline actor remains + blocked label.
  // Comment createdAt is bound to the same blocked-label incarnation.
  const dispatch2 = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: (p) => p === expectedPin.events_path,
      readEventsText: () => "", // no blocker_set — the cascade path without durable kind
      spawn: ((cmd: string, args: readonly string[]) => {
        void cmd;
        void args;
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () =>
        ({
          labels: ["blocked", "pipeline:planning"],
          state: "open",
          comments: [{ author: PIPELINE_ACTOR, body: capacityComment, createdAt: "2026-07-30T22:00:00Z" }],
        }) as never,
      getPrForIssue: async () => null,
      getGhActor: async () => PIPELINE_ACTOR,
      getLatestBlockedLabeledAt: async () => BLOCKED_LABELED_AT,
      clearBlocked: async () => {
        clearCalls++;
        // Succeeds on retry after re-dispatch
      },
    },
  );
  const response2 = await dispatch2(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "718",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-cap-2",
    },
    { onAdvanceLinked: async () => {} },
  );
  assert.equal(
    response2.outcome,
    "capacity_wait",
    "re-dispatch with blocked + capacity comment must not become blocked_needs_human",
  );
  assert.equal(clearCalls, 2);
});

test("realDispatchItem: stale authentic capacity comment does not clear later product hold (#718 69894186)", async () => {
  const fixedNow = new Date("2026-07-30T22:09:03.000Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 718, fixedNow);
  // Older capacity wait left a trusted attested marker; later product hold
  // re-applied `blocked` without a recoverable blocker comment.
  const staleCapacity = buildAttestedBlockedComment({
    issueNumber: 718,
    stageStr: "planning",
    harness: "claude",
    ts: "2026-07-30T10:00:00Z",
    reason: "At worktree capacity (2/2)",
    kind: "worktree-capacity",
    runId: "run-cap-stale",
  });
  let clearCalls = 0;
  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: (p) => p === expectedPin.events_path,
      readEventsText: () => "", // event-less redispatch — forces comment fallback
      spawn: ((cmd: string, args: readonly string[]) => {
        void cmd;
        void args;
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () =>
        ({
          labels: ["blocked", "pipeline:implementing"],
          state: "open",
          comments: [
            {
              author: PIPELINE_ACTOR,
              body: staleCapacity,
              createdAt: "2026-07-30T10:00:01Z",
            },
          ],
        }) as never,
      getPrForIssue: async () => null,
      getGhActor: async () => PIPELINE_ACTOR,
      // Current blocked-label incarnation is the later product hold.
      getLatestBlockedLabeledAt: async () => "2026-07-30T12:00:00Z",
      clearBlocked: async () => {
        clearCalls++;
      },
    },
  );
  const response = await dispatch(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "718",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-stale-cap",
    },
    { onAdvanceLinked: async () => {} },
  );
  assert.equal(
    response.outcome,
    "blocked_needs_human",
    "stale capacity marker must not reclassify a later product/human hold",
  );
  assert.equal(clearCalls, 0, "clearBlocked must not run for unbound capacity markers");
});

test("realDispatchItem: forged capacity comment from untrusted author does not clearBlocked (#718 b5108544)", async () => {
  const fixedNow = new Date("2026-07-30T22:09:03.000Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 718, fixedNow);
  // Genuine product block is still on the label; attacker posts a capacity marker.
  const forged = buildBlockedComment({
    issueNumber: 718,
    stageStr: "implementing",
    harness: "claude",
    ts: "2026-07-30T22:05:00Z",
    reason: "forged capacity to clear product hold",
    kind: "worktree-capacity",
  });
  let clearCalls = 0;
  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: (p) => p === expectedPin.events_path,
      readEventsText: () =>
        // Prior product needs-human block — no capacity in events.
        JSON.stringify({ type: "blocker_set", blocker_kind: "needs-human" }) + "\n",
      spawn: ((cmd: string, args: readonly string[]) => {
        void cmd;
        void args;
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () =>
        ({
          labels: ["blocked", "pipeline:implementing"],
          state: "open",
          comments: [{ author: "attacker", body: forged, createdAt: "2026-07-30T22:05:00Z" }],
        }) as never,
      getPrForIssue: async () => null,
      getGhActor: async () => PIPELINE_ACTOR,
      getLatestBlockedLabeledAt: async () => "2026-07-30T22:04:00Z",
      clearBlocked: async () => {
        clearCalls++;
      },
    },
  );
  const response = await dispatch(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "718",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-forge",
    },
    { onAdvanceLinked: async () => {} },
  );
  // Events carry needs-human; even if events were empty, forged comment must not
  // become capacity_wait. With events present, kind is needs-human.
  assert.equal(response.outcome, "blocked_needs_human");
  assert.equal(clearCalls, 0, "clearBlocked must not run for product holds");
});

test("realDispatchItem: untrusted comment cannot force capacity_wait when events lack kind (#718 b5108544)", async () => {
  const fixedNow = new Date("2026-07-30T22:09:03.000Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 718, fixedNow);
  const forged = [
    "## Pipeline: Blocked at implementing",
    "",
    "### Why",
    "forged",
    "<!-- pipeline-blocker-kind: worktree-capacity -->",
  ].join("\n");
  let clearCalls = 0;
  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: (p) => p === expectedPin.events_path,
      readEventsText: () => "", // no blocker_set — forces comment fallback
      spawn: ((cmd: string, args: readonly string[]) => {
        void cmd;
        void args;
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () =>
        ({
          labels: ["blocked", "pipeline:implementing"],
          state: "open",
          comments: [{ author: "attacker", body: forged, createdAt: "2026-07-30T22:05:00Z" }],
        }) as never,
      getPrForIssue: async () => null,
      getGhActor: async () => PIPELINE_ACTOR,
      getLatestBlockedLabeledAt: async () => "2026-07-30T22:04:00Z",
      clearBlocked: async () => {
        clearCalls++;
      },
    },
  );
  const response = await dispatch(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "718",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-forge-2",
    },
    { onAdvanceLinked: async () => {} },
  );
  assert.equal(response.outcome, "blocked_needs_human");
  assert.equal(clearCalls, 0);
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
