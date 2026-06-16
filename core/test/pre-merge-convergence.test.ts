// Pre-merge gate convergence fixes (#181):
//   1. archiveAlreadyDone: idempotency guard reads git log so the archive step
//      runs at most once per branch, even across many polling iterations.
//   2. CI failure with rebase guard exhausted blocks to needs-human immediately
//      rather than looping until the iteration cap.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  archiveAlreadyDone,
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { gitInWorktree } from "../scripts/worktree.ts";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const ISSUE = 181;
const PR = 99;
const SHA_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ARCHIVE_PREFIX = `chore: archive OpenSpec change(s) for #${ISSUE}`;

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

// ---------------------------------------------------------------------------
// 1. archiveAlreadyDone (3.1)
// ---------------------------------------------------------------------------

function makeGitFn(logLines: string[]): typeof gitInWorktree {
  return (async (_path: string, args: string[]) => {
    if (args[0] === "log") {
      return { stdout: logLines.join("\n"), stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }) as typeof gitInWorktree;
}

test("archiveAlreadyDone: returns true when log contains the archive commit for this issue", async () => {
  const gitFn = makeGitFn([ARCHIVE_PREFIX, "fix: some other commit"]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", ISSUE), true);
});

test("archiveAlreadyDone: returns false when log is empty", async () => {
  const gitFn = makeGitFn([]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", ISSUE), false);
});

test("archiveAlreadyDone: returns false when log only contains unrelated commits", async () => {
  const gitFn = makeGitFn(["fix: implement the feature", "chore: bump deps"]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", ISSUE), false);
});

test("archiveAlreadyDone: does not match archive commit for a different issue number", async () => {
  const gitFn = makeGitFn([`chore: archive OpenSpec change(s) for #999`]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", ISSUE), false);
});

test("archiveAlreadyDone: does not match archive commit for an issue whose number is a prefix of this issue (#18 vs #181)", async () => {
  // #18 is a numeric prefix of #181; startsWith would falsely match without the boundary check.
  const gitFn = makeGitFn([`chore: archive OpenSpec change(s) for #18`]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", ISSUE), false);
});

test("archiveAlreadyDone: does not match when this issue number is a prefix of the commit's issue (#181 log commit does not match #18 check)", async () => {
  // Checking for issue #18 must not be satisfied by a #181 archive commit.
  const gitFn = makeGitFn([`chore: archive OpenSpec change(s) for #181`]);
  assert.equal(await archiveAlreadyDone(gitFn, "/wt", "main", 18), false);
});

// ---------------------------------------------------------------------------
// 2. maybeArchiveOpenspec skips when archiveAlreadyDone returns true (3.2)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: returns null without calling archive when archiveAlreadyDone=true", async () => {
  const archiveCalls: string[] = [];
  const gitCalls: string[][] = [];

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    archiveAlreadyDone: async () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      gitCalls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
  };

  const out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);

  assert.equal(out, null, "must return null (continue) when archive already done");
  assert.deepEqual(archiveCalls, [], "openspecArchive must NOT be called");
  // git must not be called for add/commit/push (the short-circuit fires before those)
  const nonLogCalls = gitCalls.filter((a) => a[0] !== "log");
  assert.deepEqual(nonLogCalls, [], "git add/commit/push must NOT be called");
});

// ---------------------------------------------------------------------------
// 3. advance(): CI failure + rebase already attempted → needs-human (3.3)
// ---------------------------------------------------------------------------

test("advance(): CI failure + rebaseAlreadyAttempted=true → setBlocked needs-human, returns blocked", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const reviewComment = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR,
    getIssueDetail: (async () => ({
      comments: [{ body: reviewComment }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    getPrDetail: (async () => ({
      head_sha: SHA_HEAD,
      mergeable: true,
      mergeable_state: "CLEAN",
    })) as AdvancePreMergeDeps["getPrDetail"],
    getPrCommits: async () => [],
    getPrChecks: (async () => [
      { name: "clippy", bucket: "fail" },
      { name: "test", bucket: "fail" },
    ]) as AdvancePreMergeDeps["getPrChecks"],
    getForIssue: (async () => ({ path: "/wt", slug: "s" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => false,
    rebaseAlreadyAttempted: () => true,
    tryRebaseAndPush: async () => { throw new Error("must not be called"); },
    markRebaseAttempted: () => {},
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    transition: async () => {},
    postComment: async () => {},
  };

  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, {}, deps);
  });

  assert.equal(out!.advanced, false);
  assert.equal(out!.status, "blocked");
  assert.equal(out!.reason, "CI failed");
  assert.equal(blockedCalls.length, 1, "setBlocked must be called exactly once");
  assert.equal(blockedCalls[0].label, "needs-human", "label must be needs-human, not test-gate-exhausted");
  assert.match(blockedCalls[0].reason, /clippy/, "failing check name must appear in reason");
  assert.match(blockedCalls[0].reason, /test/, "all failing check names must appear");
});

// ---------------------------------------------------------------------------
// 4. advance(): CI failure + rebaseAlreadyAttempted=false + rebase fails → needs-human (3.4)
// ---------------------------------------------------------------------------

test("advance(): CI failure + rebaseAlreadyAttempted=false + tryRebaseAndPush=false → setBlocked needs-human", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const reviewComment = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR,
    getIssueDetail: (async () => ({
      comments: [{ body: reviewComment }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    getPrDetail: (async () => ({
      head_sha: SHA_HEAD,
      mergeable: true,
      mergeable_state: "CLEAN",
    })) as AdvancePreMergeDeps["getPrDetail"],
    getPrCommits: async () => [],
    getPrChecks: (async () => [
      { name: "clippy", bucket: "fail" },
    ]) as AdvancePreMergeDeps["getPrChecks"],
    getForIssue: (async () => ({ path: "/wt", slug: "s" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => false,
    rebaseAlreadyAttempted: () => false,
    tryRebaseAndPush: async () => false,
    markRebaseAttempted: () => {},
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    transition: async () => {},
    postComment: async () => {},
  };

  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, {}, deps);
  });

  assert.equal(out!.advanced, false);
  assert.equal(out!.status, "blocked");
  assert.equal(out!.reason, "CI failed");
  assert.equal(blockedCalls.length, 1, "setBlocked must be called exactly once");
  assert.equal(blockedCalls[0].label, "needs-human", "label must be needs-human");
  assert.match(blockedCalls[0].reason, /clippy/, "failing check name must appear in reason");
});
