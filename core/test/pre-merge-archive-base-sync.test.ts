// Archive-base sync guard (#579): pre-merge blocked with "push failed after
// archive" during #568's own run because the OpenSpec archive commit was built
// on a stale local worktree base (`c155967`, the fix-2 commit) instead of the
// reviewed/pushed PR head (`dd25659`). The two commits were true siblings, so
// the push was correctly rejected non-fast-forward — but had the engine ever
// retried with `--force`, it would have silently discarded the entire reviewed
// fix. `maybeArchiveOpenspec` must now sync the worktree to `origin/<branch>`
// before archiving, block with a precise SHA diagnostic on true divergence, and
// never force-push to reconcile a gap.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { maybeArchiveOpenspec, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const ISSUE = 579;
const SLUG = "s";
const BRANCH = `pipeline/${ISSUE}-${SLUG}`;
const CHANGE_ID = "openspec-archive-base-sync";
const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;
const OLD_HEAD = "c155967c155967c155967c155967c155967c15";
const REVIEWED_HEAD = "dd25659dd25659dd25659dd25659dd25659dd2";

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

function baseDeps(gitInWorktree: AdvancePreMergeDeps["gitInWorktree"]): AdvancePreMergeDeps {
  return {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree,
    changeDirExists: () => true,
    openspecArchive: undefined,
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
  };
}

test("maybeArchiveOpenspec: worktree behind origin/<branch> is fast-forwarded before archiving (#579)", async (t) => {
  const gitCalls: string[][] = [];
  const pushCalls: string[][] = [];
  const archiveCalls: string[] = [];
  let ffApplied = false;
  let archived = false;

  const gitInWorktree = (async (_p: string, args: string[]) => {
    gitCalls.push([...args]);
    if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
    if (args[0] === "status") {
      return { stdout: archived ? " M openspec/specs/x/spec.md" : "", stderr: "", code: 0 };
    }
    if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") {
      if (args[1] === "HEAD") return { stdout: ffApplied ? REVIEWED_HEAD : OLD_HEAD, stderr: "", code: 0 };
      if (args[1] === `origin/${BRANCH}`) return { stdout: REVIEWED_HEAD, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      ffApplied = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "add") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "commit") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "push") {
      pushCalls.push([...args]);
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as AdvancePreMergeDeps["gitInWorktree"];

  const deps = baseDeps(gitInWorktree);
  deps.openspecArchive = (async (_w: string, id: string) => {
    archiveCalls.push(id);
    archived = true;
    return { success: true, unavailable: false, output: "" };
  }) as AdvancePreMergeDeps["openspecArchive"];

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.ok(
    gitCalls.some((a) => a[0] === "fetch" && a[1] === "origin" && a[2] === BRANCH),
    "must fetch origin/<branch> before archiving",
  );
  assert.ok(
    gitCalls.some((a) => a[0] === "merge" && a[1] === "--ff-only" && a[2] === `origin/${BRANCH}`),
    "must fast-forward to origin/<branch> when the worktree is behind",
  );
  assert.deepEqual(archiveCalls, [CHANGE_ID], "archive must run on the synced (reviewed) head");
  assert.equal(pushCalls.length, 1, "push must be attempted exactly once");
  assert.ok(!pushCalls[0].includes("--force") && !pushCalls[0].includes("--force-with-lease"),
    "push must never be forced");
  assert.equal((out as { status: string })?.status, "waiting", "sync + archive must proceed to waiting");
});

test("maybeArchiveOpenspec: true divergence from origin/<branch> blocks with a SHA diagnostic, never forces (#579)", async (t) => {
  const gitCalls: string[][] = [];
  const archiveCalls: string[] = [];
  const blockedReasons: string[] = [];

  const gitInWorktree = (async (_p: string, args: string[]) => {
    gitCalls.push([...args]);
    if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
    if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") {
      if (args[1] === "HEAD") return { stdout: OLD_HEAD, stderr: "", code: 0 };
      if (args[1] === `origin/${BRANCH}`) return { stdout: REVIEWED_HEAD, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "merge" && args[1] === "--ff-only") {
      // Fast-forward impossible: local and remote are true siblings off an older base.
      return { stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.", code: 128 };
    }
    if (args[0] === "push" || args[0] === "commit" || args[0] === "add") {
      throw new Error(`must not reach ${args[0]} when the archive base has diverged`);
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as AdvancePreMergeDeps["gitInWorktree"];

  const deps = baseDeps(gitInWorktree);
  deps.setBlocked = (async (_cfg, _issue, reason) => {
    blockedReasons.push(reason);
  }) as AdvancePreMergeDeps["setBlocked"];
  deps.openspecArchive = (async (_w: string, id: string) => {
    archiveCalls.push(id);
    return { success: true, unavailable: false, output: "" };
  }) as AdvancePreMergeDeps["openspecArchive"];

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.equal((out as { status: string })?.status, "blocked", "true divergence must block");
  assert.match((out as { reason: string }).reason, /archive base `.*` != reviewed head `.*`/,
    "block reason must name both SHAs");
  assert.ok(blockedReasons[0]?.includes(OLD_HEAD) && blockedReasons[0]?.includes(REVIEWED_HEAD),
    "setBlocked must be called with a reason naming both the archive base and reviewed head");
  assert.deepEqual(archiveCalls, [], "openspec archive must never run on a diverged base");
  assert.ok(!gitCalls.some((a) => a[0] === "push"), "no push may be attempted when the base diverged");
  assert.ok(
    !gitCalls.some((a) => a.includes("--force") || a.includes("--force-with-lease")),
    "no git call may ever include --force or --force-with-lease",
  );
});

test("maybeArchiveOpenspec: worktree already at origin/<branch> archives unchanged (regression guard) (#579)", async (t) => {
  const gitCalls: string[][] = [];
  const archiveCalls: string[] = [];
  let archived = false;

  const gitInWorktree = (async (_p: string, args: string[]) => {
    gitCalls.push([...args]);
    if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
    if (args[0] === "status") {
      return { stdout: archived ? " M openspec/specs/x/spec.md" : "", stderr: "", code: 0 };
    }
    if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") {
      // Already in sync: HEAD equals origin/<branch> from the start.
      return { stdout: REVIEWED_HEAD, stderr: "", code: 0 };
    }
    if (args[0] === "add") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "commit") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "push") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as AdvancePreMergeDeps["gitInWorktree"];

  const deps = baseDeps(gitInWorktree);
  deps.openspecArchive = (async (_w: string, id: string) => {
    archiveCalls.push(id);
    archived = true;
    return { success: true, unavailable: false, output: "" };
  }) as AdvancePreMergeDeps["openspecArchive"];

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.ok(
    !gitCalls.some((a) => a[0] === "merge"),
    "already-in-sync worktree must never attempt a fast-forward merge",
  );
  assert.deepEqual(archiveCalls, [CHANGE_ID], "archive must still run when already at the reviewed head");
  assert.equal((out as { status: string })?.status, "waiting", "behavior is unchanged when already in sync");
});
