// Pre-merge OpenSpec archive: fail-closed instead of silently skipping (#467).
//
// Regression coverage for the #464 shape: an override-resumed (or a plain
// first-time) pre-merge run advanced to ready-to-deploy without running the
// OpenSpec archive step, shipping an active `openspec/changes/<id>/` directory
// to the default branch. Four things change:
//   1. maybeArchiveOpenspec fails closed on a candidate-probe error instead of
//      reading a failed `git diff` as "no candidates".
//   2. maybeArchiveOpenspec fails closed on a missing worktree when the PR's
//      own file list still shows an active change.
//   3. A worktree-independent head-side guard (enforceOpenspecActiveChangeGuard)
//      blocks pre-merge whenever the PR's changed-file list still carries an
//      unarchived `openspec/changes/<id>/` path, computed purely from
//      getPrDiff/diffFilePaths — never the local worktree filesystem.
//   4. Every archive decision (archived/skipped/blocked) is recorded as a
//      `gate_result` run event.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  enforceOpenspecActiveChangeGuard,
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import { unarchivedChangeIdsFromPrFiles } from "../scripts/openspec.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const ISSUE = 467;
const PR = 464;

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

/** In-memory RunStoreDeps that captures appended events.jsonl lines (mirrors eval.test.ts). */
function appendOnlyRunStore(appended: string[]): RunStoreDeps {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p, data) => { appended.push(data); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
}

function appendedEvents(appended: string[]): Record<string, unknown>[] {
  return appended.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 1. Candidate probe failure → fail closed (3.1 / task 1.2)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: candidate probe (git diff) exits non-zero → blocked, not null", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: "", stderr: "fatal: bad revision 'origin/main...HEAD'", code: 128 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => false,
    openspecArchive: (async () => ({ success: true, unavailable: false, output: "" })) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.notEqual(out, null, "a failed probe must never be read as 'no candidates'");
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0].label, "openspec-invalid");
  assert.match(blockedCalls[0].reason, /git diff/);
  assert.match(blockedCalls[0].reason, /128/);
});

// ---------------------------------------------------------------------------
// 2. Worktree missing while the PR still introduces an active change (3.2)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: worktree missing + PR file list still carries an active change → blocked needs-human", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => null,
    getPrDiff: async () => "diff --git a/openspec/changes/foo/proposal.md b/openspec/changes/foo/proposal.md\n",
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.notEqual(out, null, "missing worktree with an active PR change must not silently continue");
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0].label, "needs-human");
  assert.match(blockedCalls[0].reason, /foo/);
});

test("maybeArchiveOpenspec: worktree missing + PR file list has no OpenSpec paths → returns null (unchanged)", async (t) => {
  const blockedCalls: string[] = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => null,
    getPrDiff: async () => "diff --git a/src/index.ts b/src/index.ts\n",
    setBlocked: async (_cfg, _n, reason) => { blockedCalls.push(reason); },
  };

  const out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);

  assert.equal(out, null);
  assert.deepEqual(blockedCalls, []);
});

test("maybeArchiveOpenspec: worktree missing + openspec.enabled off → returns null without fetching the PR diff", async (t) => {
  let prDiffCalled = false;
  const cfgOff = { ...cfg, openspec: { enabled: "off" } } as unknown as PipelineConfig;
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => null,
    getPrDiff: async () => { prDiffCalled = true; return ""; },
    setBlocked: async () => {},
  };

  const out = await maybeArchiveOpenspec(cfgOff, ISSUE, "run-1", deps, undefined, PR);

  assert.equal(out, null);
  assert.equal(prDiffCalled, false, "openspec.enabled: off must skip the guard entirely");
});

// ---------------------------------------------------------------------------
// 3. Archive CLI failure surfaces the output verbatim (D4 / task 4.1)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: openspec archive fails on a retitled MODIFIED header → blocked with CLI output verbatim", async (t) => {
  const CHANGE_ID = "finding-level-reversal-matching";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;
  const CLI_OUTPUT = "Error: header not found: '## MODIFIED Requirements: Finding-level match'";

  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    openspecArchive: (async () => ({ success: false, unavailable: false, output: CLI_OUTPUT })) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  assert.equal((out as { advanced: boolean })?.advanced, false);
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0].label, "openspec-invalid");
  assert.match(blockedCalls[0].reason, new RegExp(CHANGE_ID));
  assert.ok(blockedCalls[0].reason.includes(CLI_OUTPUT), "CLI output must appear verbatim in the blocker reason");
});

// ---------------------------------------------------------------------------
// 4. Head-side active-change guard (D1 / requirement scenarios)
// ---------------------------------------------------------------------------

test("unarchivedChangeIdsFromPrFiles: pure helper matches the guard's own semantics", () => {
  assert.deepEqual(
    unarchivedChangeIdsFromPrFiles(["openspec/changes/foo/proposal.md"]),
    ["foo"],
  );
});

test("enforceOpenspecActiveChangeGuard: PR still introduces an unarchived change → blocks naming it", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getPrDiff: async () => "diff --git a/openspec/changes/foo/proposal.md b/openspec/changes/foo/proposal.md\n",
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
  };

  let out: Awaited<ReturnType<typeof enforceOpenspecActiveChangeGuard>> = null;
  await quiet(t, async () => {
    out = await enforceOpenspecActiveChangeGuard(cfg, ISSUE, PR, deps);
  });

  assert.notEqual(out, null);
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0].label, "openspec-invalid");
  assert.match(blockedCalls[0].reason, /foo/);
});

test("enforceOpenspecActiveChangeGuard: change was archived on the branch → inert", async (t) => {
  const deps: AdvancePreMergeDeps = {
    getPrDiff: async () =>
      "diff --git a/openspec/changes/archive/foo/proposal.md b/openspec/changes/archive/foo/proposal.md\n",
    setBlocked: async () => { throw new Error("must not be called"); },
  };

  const out = await enforceOpenspecActiveChangeGuard(cfg, ISSUE, PR, deps);
  assert.equal(out, null);
});

test("enforceOpenspecActiveChangeGuard: PR touches no OpenSpec changes → inert", async (t) => {
  const deps: AdvancePreMergeDeps = {
    getPrDiff: async () => "diff --git a/src/index.ts b/src/index.ts\n",
    setBlocked: async () => { throw new Error("must not be called"); },
  };

  const out = await enforceOpenspecActiveChangeGuard(cfg, ISSUE, PR, deps);
  assert.equal(out, null);
});

test("enforceOpenspecActiveChangeGuard: PR diff fetch fails → fails closed (blocked, not a thrown exception)", async (t) => {
  const blockedCalls: Array<{ reason: string; label: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getPrDiff: async () => { throw new Error("gh: authentication required"); },
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
  };

  let out: Awaited<ReturnType<typeof enforceOpenspecActiveChangeGuard>> = null;
  await quiet(t, async () => {
    out = await enforceOpenspecActiveChangeGuard(cfg, ISSUE, PR, deps);
  });

  assert.notEqual(out, null);
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blockedCalls[0].label, "needs-human");
  assert.match(blockedCalls[0].reason, /authentication required/);
});

// ---------------------------------------------------------------------------
// 5. Replaying the #464 shape end-to-end via advance() (this test must fail on
//    main and pass with this change)
// ---------------------------------------------------------------------------

test("advance(): #464 shape — worktree misreports OpenSpec inactive but the PR still carries an unarchived change → head-side guard blocks, ready-to-deploy is never reached", async (t) => {
  const SHA_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reviewComment = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;
  const transitions: Array<{ from: string; to: string }> = [];
  const blockedCalls: Array<{ reason: string; label: string }> = [];

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR,
    getIssueDetail: (async () => ({ comments: [{ body: reviewComment, author: "test-actor" }] })) as AdvancePreMergeDeps["getIssueDetail"],
    getPrDetail: (async () => ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" })) as AdvancePreMergeDeps["getPrDetail"],
    getPrCommits: async () => [],
    getPrChecks: (async () => [{ name: "ci", bucket: "pass" }]) as AdvancePreMergeDeps["getPrChecks"],
    // Worktree present but reports OpenSpec inactive (the exact class of bug D1
    // guards against — whichever silent-skip condition fired for #464).
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => false,
    // The PR's own file list (head-side, worktree-independent) still shows the
    // change #464 introduced, unarchived.
    getPrDiff: async () =>
      "diff --git a/openspec/changes/finding-level-reversal-matching/proposal.md " +
      "b/openspec/changes/finding-level-reversal-matching/proposal.md\n",
    postComment: async () => {},
    transition: async (_cfg, _n, from, to) => { transitions.push({ from, to }); },
    setBlocked: (async (_cfg, _n, reason, _stage, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
    getGhActor: async () => "test-actor",
  };

  let out: Awaited<ReturnType<typeof advance>> | undefined;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, {}, deps);
  });

  assert.equal(out!.advanced, false, "must not advance while the change is still active");
  assert.equal(out!.status, "blocked");
  assert.deepEqual(transitions, [], "must never transition toward visual-gate/ready-to-deploy");
  assert.equal(blockedCalls.length, 1);
  assert.equal(blockedCalls[0].label, "openspec-invalid");
  assert.match(blockedCalls[0].reason, /finding-level-reversal-matching/);
});

// ---------------------------------------------------------------------------
// 6. Override-resumed regression: archive step is invoked on the resumed path
// ---------------------------------------------------------------------------

test("advance(): override-resumed pre-merge (blocking delta-review key overridden) still invokes the archive step, does not skip straight to ready-to-deploy", async (t) => {
  const SHA_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const CHANGE_ID = "pre-merge-archive-fail-closed";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;
  // A blocking delta-review verdict at HEAD, with its one blocking key already
  // dispositioned via `pipeline override` — this is exactly the state
  // `runAdvance` re-enters pre-merge with after an override.
  const blockingComment =
    `## Review 2 (Adversarial) — needs-attention\n\nNo-ship: blocking findings remain.\n\n` +
    `<!-- reviewed-sha: ${SHA_HEAD} -->\n<!-- pipeline-blocking-keys: bb1716ab -->`;
  const overrideComment = `## Pipeline: Finding override\n\n<!-- pipeline-override: bb1716ab deferred -->`;

  const archiveCalls: string[] = [];
  const pushed: string[][] = [];
  const transitions: Array<{ from: string; to: string }> = [];

  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR,
    getIssueDetail: (async () => ({
      comments: [
        { body: blockingComment, author: "test-actor" },
        { body: overrideComment, author: "test-actor" },
      ],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    getPrDetail: (async () => ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" })) as AdvancePreMergeDeps["getPrDetail"],
    getPrCommits: async () => [],
    getPrChecks: (async () => [{ name: "ci", bucket: "pass" }]) as AdvancePreMergeDeps["getPrChecks"],
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (() => {
      let addCalled = false;
      return (async (_p: string, args: string[]) => {
        if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
        if (args[0] === "add") { addCalled = true; return { stdout: "", stderr: "", code: 0 }; }
        // Pre-archive cleanliness check (before "add") must report clean; the
        // post-archive status check (after "add") must show the archive's diff.
        if (args[0] === "status") {
          return addCalled
            ? { stdout: ` M openspec/specs/${CHANGE_ID}/spec.md`, stderr: "", code: 0 }
            : { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "push") { pushed.push(args); return { stdout: "", stderr: "", code: 0 }; }
        return { stdout: "", stderr: "", code: 0 };
      }) as AdvancePreMergeDeps["gitInWorktree"];
    })(),
    changeDirExists: () => true,
    openspecArchive: (async (_w: string, id: string) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    postComment: async () => {},
    transition: async (_cfg, _n, from, to) => { transitions.push({ from, to }); },
    setBlocked: async () => {},
    getGhActor: async () => "test-actor",
  };

  let out: Awaited<ReturnType<typeof advance>> | undefined;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, {}, deps);
  });

  assert.deepEqual(archiveCalls, [CHANGE_ID], "the archive step must be invoked on the override-resumed path");
  assert.ok(pushed.length >= 1, "the archive commit must be pushed");
  assert.deepEqual(transitions, [], "must not transition straight to ready-to-deploy in the same poll that pushed the archive commit");
  assert.equal(out!.advanced, false);
  assert.equal(out!.status, "waiting", "archive push forces a CI re-run, not an immediate advance");
});

// ---------------------------------------------------------------------------
// 7. Archive decision is recorded as a gate_result run event (D5)
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: records a gate_result event when skipped (no-candidates)", async () => {
  const appended: string[] = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async () => ({ stdout: "", stderr: "", code: 0 })) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => false,
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    runDir: "/runs/467",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);

  const events = appendedEvents(appended).filter((e) => e.type === "gate_result" && e.gate === "openspec-archive");
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "skipped");
  assert.equal(events[0].reason, "no-candidates");
});

test("maybeArchiveOpenspec: records a gate_result event when archived", async (t) => {
  const appended: string[] = [];
  const CHANGE_ID = "some-change";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (() => {
      let addCalled = false;
      return (async (_p: string, args: string[]) => {
        if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
        if (args[0] === "add") { addCalled = true; return { stdout: "", stderr: "", code: 0 }; }
        if (args[0] === "status") {
          return addCalled
            ? { stdout: ` M openspec/specs/${CHANGE_ID}/spec.md`, stderr: "", code: 0 }
            : { stdout: "", stderr: "", code: 0 };
        }
        return { stdout: "", stderr: "", code: 0 };
      }) as AdvancePreMergeDeps["gitInWorktree"];
    })(),
    changeDirExists: () => true,
    openspecArchive: (async () => ({ success: true, unavailable: false, output: "" })) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/467",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  await quiet(t, async () => {
    await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  const events = appendedEvents(appended).filter((e) => e.type === "gate_result" && e.gate === "openspec-archive");
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "pass");
  assert.equal(events[0].reason, CHANGE_ID);
});

test("maybeArchiveOpenspec: records a gate_result event when blocked (archive CLI failure)", async (t) => {
  const appended: string[] = [];
  const CHANGE_ID = "some-change";
  const CHANGE_PATH = `openspec/changes/${CHANGE_ID}/proposal.md`;
  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: "s", branch: "b" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    gitInWorktree: (async (_p: string, args: string[]) => {
      if (args[0] === "diff") return { stdout: CHANGE_PATH, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: () => true,
    openspecArchive: (async () => ({ success: false, unavailable: false, output: "header not found" })) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {},
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/467",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  await quiet(t, async () => {
    await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps);
  });

  const events = appendedEvents(appended).filter((e) => e.type === "gate_result" && e.gate === "openspec-archive");
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "fail");
  assert.match(events[0].reason as string, /header not found/);
});
