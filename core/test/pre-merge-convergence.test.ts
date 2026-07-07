// Pre-merge gate convergence fixes (#181):
//   1. archiveAlreadyDone: idempotency guard reads git log so the archive step
//      runs at most once per branch, even across many polling iterations.
//   2. CI failure with rebase guard exhausted blocks to needs-human immediately
//      rather than looping until the iteration cap.
// Pre-merge archive commit failure recovery (#255):
//   3. When git commit fails after openspec archive, restore the worktree so the
//      next run's changeDirExists check still finds the active change directory.

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
// 2. maybeArchiveOpenspec skips when no active candidates exist (3.2)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: returns null without calling archive when diff is empty (no active candidates)", async () => {
  const archiveCalls: string[] = [];
  const gitCalls: string[][] = [];

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      gitCalls.push(args);
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => false,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
  };

  const out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);

  assert.equal(out, null, "must return null (continue) when no active candidates");
  assert.deepEqual(archiveCalls, [], "openspecArchive must NOT be called");
  // git add/commit/push must not be called (only diff is called, not write ops)
  const nonDiffCalls = gitCalls.filter((a) => a[0] !== "diff");
  assert.deepEqual(nonDiffCalls, [], "git add/commit/push must NOT be called");
});

test("maybeArchiveOpenspec: proceeds to archive when prior archive commit exists but active candidates remain (#181 fix 2)", async (t) => {
  // Regression: old code returned null at archiveAlreadyDone check before computing
  // candidates, masking re-introduced change directories. New code checks candidates
  // first and only skips when there are no active candidates to archive.
  const archiveCalls: string[] = [];
  let archived = false;
  const CHANGE_ID = "pre-merge-gate-convergence";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
      // Clean before archive (passes the pre-archive cleanliness guard), dirty after.
      if (args[0] === "status") return { stdout: archived ? " M openspec/specs/x/spec.md" : "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      archived = true;
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
  };

  await quiet(t, async () => {
    await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.deepEqual(archiveCalls, [CHANGE_ID], "openspecArchive must be called for the active candidate despite prior archive commit");
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
    getGhActor: async () => "test-actor",
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
    getGhActor: async () => "test-actor",
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

// ---------------------------------------------------------------------------
// 5. maybeArchiveOpenspec: restores worktree after commit failure (#255)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: restores worktree after commit failure so a rerun can retry archive", async (t) => {
  // Regression for #255: when openspec archive deletes openspec/changes/<id>/ and
  // the subsequent git commit fails, the next run must still find the candidate via
  // changeDirExists. Without restoration, candidates is empty and pre-merge proceeds
  // without the required archive commit.
  const CHANGE_ID = "block-pre-merge-255";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;

  const restorationCalls: string[][] = [];
  // dirRestored tracks whether the fix performed the restoration that would let
  // changeDirExists return true on the retry run.
  let dirRestored = false;
  // archived models worktree state: clean before `openspec archive` runs (passes the
  // pre-archive cleanliness guard), dirty after (the archive's openspec/ changes to commit).
  let archived = false;

  const makeGitFn = (commitCode: number): AdvancePreMergeDeps["gitInWorktree"] => {
    return (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
      if (args[0] === "add") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: archived ? "M  openspec/specs/x.md" : "", stderr: "", code: 0 };
      if (args[0] === "commit") return { stdout: "", stderr: "pre-commit hook rejected", code: commitCode };
      if (args[0] === "push") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "restore" || args[0] === "clean") {
        restorationCalls.push([...args]);
        dirRestored = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"];
  };

  // Run 1: archive succeeds but commit fails → must block and restore
  let run1;
  await quiet(t, async () => {
    run1 = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", {
      getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
      openspecIsActive: () => true,
      gitInWorktree: makeGitFn(1),
      changeDirExists: () => true,
      openspecArchive: (async () => { archived = true; return { success: true, unavailable: false, output: "" }; }) as AdvancePreMergeDeps["openspecArchive"],
      setBlocked: async () => {},
      getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
      branchDeveloperCommits: async () => [],
      trustedReviewAuthor: "test-actor",
    });
  });

  assert.equal((run1 as Awaited<ReturnType<typeof maybeArchiveOpenspec>>)?.reason, "archive commit failed",
    "run 1 must block on commit failure");
  assert.ok(
    restorationCalls.some((a) => a[0] === "restore" && a.includes("--staged")),
    "git restore --staged must be called to undo staged archive changes",
  );
  assert.ok(dirRestored, "restoration must be triggered so changeDirExists returns true on retry");

  // Run 2: retry after block is cleared — dir is present because run 1 restored it.
  // The commit-failure rollback restored the tree, so it is clean again before run 2's archive.
  archived = false;
  const archiveCallsRun2: string[] = [];
  let run2;
  await quiet(t, async () => {
    run2 = await maybeArchiveOpenspec(cfg, ISSUE, "run-2", {
      getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
      openspecIsActive: () => true,
      gitInWorktree: makeGitFn(0),
      changeDirExists: () => dirRestored, // true because run 1 restored the dir
      openspecArchive: (async (_w: string, id: string) => {
        archiveCallsRun2.push(id);
        archived = true;
        return { success: true, unavailable: false, output: "" };
      }) as AdvancePreMergeDeps["openspecArchive"],
      setBlocked: async () => {},
      getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
      branchDeveloperCommits: async () => [],
      trustedReviewAuthor: "test-actor",
    });
  });

  assert.deepEqual(archiveCallsRun2, [CHANGE_ID], "archive must be called on the retry run");
  assert.equal((run2 as Awaited<ReturnType<typeof maybeArchiveOpenspec>>)?.status, "waiting",
    "retry run must complete archive and return waiting");
});

// ---------------------------------------------------------------------------
// 6. maybeArchiveOpenspec: CLI unavailable with active candidates → blocked (#308)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: CLI unavailable with active candidate → blocks with openspec-invalid", async (t) => {
  // Regression for #308: when openspec archive returns { unavailable: true } and
  // there is at least one active change candidate, the step must block rather than
  // return null (which would silently skip the archive and ship an orphaned change dir).
  const CHANGE_ID = "some-active-change";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;

  const blockedCalls: Array<{ reason: string; stage: string; label: string }> = [];
  const archiveCalls: string[] = [];

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 }; // clean
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { unavailable: true, success: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_cfg, _n, reason, stage, label) => {
      blockedCalls.push({ reason, stage, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
  };

  let out;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.equal((out as Awaited<ReturnType<typeof maybeArchiveOpenspec>>)?.status, "blocked",
    "must return blocked, not null, when CLI is unavailable with active candidates");
  assert.equal((out as Awaited<ReturnType<typeof maybeArchiveOpenspec>>)?.advanced, false);
  assert.equal(blockedCalls.length, 1, "setBlocked must be called exactly once");
  assert.equal(blockedCalls[0].stage, "pre-merge");
  assert.equal(blockedCalls[0].label, "openspec-invalid");
  assert.match(blockedCalls[0].reason, /openspec/, "reason must mention openspec CLI");
  assert.match(blockedCalls[0].reason, new RegExp(CHANGE_ID), "reason must name the change id");
});

test("maybeArchiveOpenspec: CLI unavailable with no active candidates → returns null without calling archive or setBlocked (#308 no-regression)", async () => {
  // When there are no active candidates, the CLI is never invoked, so unavailability
  // must not block — repos with nothing to archive are unaffected.
  const archiveCalls: string[] = [];
  const blockedCalls: string[] = [];

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: "", stderr: "", code: 0 }; // no paths in diff
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => false,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { unavailable: true, success: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async (_cfg, _n, reason) => {
      blockedCalls.push(reason);
    },
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
  };

  const out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);

  assert.equal(out, null, "must return null (continue) when there are no active candidates");
  assert.deepEqual(archiveCalls, [], "openspecArchive must NOT be called when no candidates");
  assert.deepEqual(blockedCalls, [], "setBlocked must NOT be called when no candidates");
});
