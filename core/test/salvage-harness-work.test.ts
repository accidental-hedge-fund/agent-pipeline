// Tests for salvage of uncommitted harness work (#131).
//
// Unit: salvageUncommittedWork via fake SalvageDeps — no real git processes.
// Contract: the salvage commit message must satisfy each stage's downstream
// commit-range gate (impl issue-ref, fix-round format, test-fix format,
// OpenSpec authoring path constraint, traceability trailers), so a salvaged
// run proceeds to the test gate instead of trading the "no commits" block for
// a format block. Each contract test includes the no-salvage counterpart
// (empty range → "No commits found in the range") proving the salvage bites.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSalvageCommitMessage,
  salvageUncommittedWork,
  trySalvageUncommittedWork,
  type SalvageDeps,
} from "../scripts/salvage-harness-work.ts";
import { enforceImplCommitRef } from "../scripts/stages/planning.ts";
import { enforceFixCommitGate, fixSalvageStageLabel } from "../scripts/stages/fix.ts";
import { enforceTestFixCommitFormat, testFixSalvageStageLabel } from "../scripts/testgate.ts";
import { verifyHarnessCommits, type VerifyDeps } from "../scripts/verify-harness-commits.ts";
import { validateCommitTrailers } from "../scripts/traceability.ts";

const RUN_ID = "131/2026-06-12T18:14:44Z";

function fakeGit(status: string) {
  const calls: { order: string[]; commits: { wtPath: string; message: string }[] } = {
    order: [],
    commits: [],
  };
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitAddAll: async (wt, _args) => {
      calls.order.push(`add:${wt}`);
    },
    gitCommit: async (wt, message) => {
      calls.order.push(`commit:${wt}`);
      calls.commits.push({ wtPath: wt, message });
    },
  };
  return { deps, calls };
}

function msgsDeps(messages: string[], diffFiles: string[] = []): VerifyDeps {
  return {
    gitMessages: async () => messages,
    gitDiffFiles: async () => diffFiles,
    gitDirtyFiles: async () => [],
  };
}

// ---------------------------------------------------------------------------
// salvageUncommittedWork — unit (tasks 1.2 a/b/c)
// ---------------------------------------------------------------------------

test("salvage: dirty worktree → git add -A + commit with salvage subject and trailers (1.2a)", async () => {
  const { deps, calls } = fakeGit(" M core/scripts/foo.ts\n?? core/test/foo.test.ts\n");
  const res = await salvageUncommittedWork("/wt", 131, RUN_ID, "implement", deps);
  assert.deepEqual(calls.order, ["add:/wt", "commit:/wt"], "stages all changes, then commits");
  assert.equal(res.salvaged, true);
  const msg = calls.commits[0].message;
  assert.ok(res.salvaged && res.message === msg, "returned message matches the committed one");
  assert.ok(msg.startsWith("salvage: stage harness work (#131)"), `subject: ${msg}`);
  assert.match(msg, /Pipeline-salvaged commit: the implement harness/);
  assert.match(
    msg,
    /\n\nIssue: #131\nPipeline-Run: 131\/2026-06-12T18:14:44Z$/,
    "message ends with a blank line + Issue/Pipeline-Run trailers",
  );
});

test("salvage: clean worktree → no git mutations, {salvaged: false} (1.2b)", async () => {
  for (const status of ["", "   \n"]) {
    const { deps, calls } = fakeGit(status);
    const res = await salvageUncommittedWork("/wt", 131, RUN_ID, "implement", deps);
    assert.deepEqual(res, { salvaged: false });
    assert.deepEqual(calls.order, [], "neither gitAddAll nor gitCommit is called");
  }
});

test("salvage: gitCommit throws → error propagates (1.2c)", async () => {
  const { deps, calls } = fakeGit("?? new-file\n");
  deps.gitCommit = async () => {
    throw new Error("commit boom");
  };
  await assert.rejects(
    salvageUncommittedWork("/wt", 131, RUN_ID, "implement", deps),
    /commit boom/,
  );
  assert.deepEqual(calls.order, ["add:/wt"], "add ran before the failing commit");
});

test("trySalvage: returns true on dirty, false on clean, false (not throw) on git failure", async () => {
  const dirty = fakeGit("?? f\n");
  assert.equal(await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", dirty.deps), true);

  const clean = fakeGit("");
  assert.equal(await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", clean.deps), false);

  const broken = fakeGit("?? f\n");
  broken.deps.gitCommit = async () => {
    throw new Error("commit boom");
  };
  assert.equal(
    await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", broken.deps),
    false,
    "salvage failure degrades to the caller's existing block path",
  );
});

// ---------------------------------------------------------------------------
// Contract: salvaged commits pass each stage's downstream commit-range gate
// ---------------------------------------------------------------------------

test("contract: salvaged implement commit passes the issue-ref gate; empty range still blocks (bites)", async () => {
  const msg = buildSalvageCommitMessage(131, RUN_ID, "implement");
  const ok = await enforceImplCommitRef(131, "/wt", "abc", msgsDeps([msg]));
  assert.equal(ok.ok, true, "salvage subject carries #131 → impl gate passes");

  // Without salvage the range is empty — the pre-#131 block path.
  const blocked = await enforceImplCommitRef(131, "/wt", "abc", msgsDeps([]));
  assert.equal(blocked.ok, false);
  assert.ok(
    "reason" in blocked && blocked.reason.includes("No commits found in the range"),
    `unexpected reason: ${JSON.stringify(blocked)}`,
  );
});

test("contract: salvaged fix-round commit passes the fix format gate via the prescribed-subject label (bites)", async () => {
  for (const round of [1, 2] as const) {
    const msg = buildSalvageCommitMessage(131, RUN_ID, fixSalvageStageLabel(round, 131));
    const ok = await enforceFixCommitGate(round, 131, "/wt", "abc", msgsDeps([msg]));
    assert.equal(ok.ok, true, `round ${round}: salvage proceeds to the test gate`);

    // A label without the prescribed subject would re-block at the format gate —
    // proving the label, not the salvage subject, satisfies the gate.
    const bare = buildSalvageCommitMessage(131, RUN_ID, `fix-${round}`);
    const blocked = await enforceFixCommitGate(round, 131, "/wt", "abc", msgsDeps([bare]));
    assert.equal(blocked.ok, false);
  }
});

test("contract: salvaged test-fix commit passes the test-fix format gate (bites)", async () => {
  const msg = buildSalvageCommitMessage(131, RUN_ID, testFixSalvageStageLabel(131));
  const ok = await enforceTestFixCommitFormat(131, "/wt", "abc", msgsDeps([msg]));
  assert.equal(ok.ok, true);

  const bare = buildSalvageCommitMessage(131, RUN_ID, "test-fix");
  const blocked = await enforceTestFixCommitFormat(131, "/wt", "abc", msgsDeps([bare]));
  assert.equal(blocked.ok, false);
});

test("contract: salvaged OpenSpec-authoring commit passes the authoring gate when only openspec/ files changed", async () => {
  const msg = buildSalvageCommitMessage(131, RUN_ID, "OpenSpec authoring");
  const config = {
    issueNumber: 131,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "only intent files may be committed at this stage",
    },
  };
  const ok = await verifyHarnessCommits(
    "/wt",
    "abc",
    config,
    msgsDeps([msg], ["openspec/changes/x/proposal.md", "openspec/changes/x/tasks.md"]),
  );
  assert.equal(ok.ok, true);

  // Salvage must not bypass the path constraint: stray app code still blocks.
  const blocked = await verifyHarnessCommits(
    "/wt",
    "abc",
    config,
    msgsDeps([msg], ["openspec/changes/x/proposal.md", "core/scripts/pipeline.ts"]),
  );
  assert.equal(blocked.ok, false);
});

test("contract: salvage message satisfies the traceability-trailer validation (bites)", async () => {
  const msg = buildSalvageCommitMessage(131, RUN_ID, testFixSalvageStageLabel(131));
  assert.equal(validateCommitTrailers([msg], 131, RUN_ID), null);

  // A different run id must still be caught — salvage gets no trailer bypass.
  assert.notEqual(validateCommitTrailers([msg], 131, "131/other-run"), null);
});

// ---------------------------------------------------------------------------
// Scoped salvage (#321): optional staging scope for OpenSpec authoring
// ---------------------------------------------------------------------------

test("salvage [scoped, 3.1]: gitAddAll args restrict to scope and gitStatus receives scope when scope='openspec/'", async () => {
  let capturedArgs: string[] | null = null;
  let capturedStatusScope: string | undefined;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      capturedStatusScope = scope;
      // Simulate scoped git status: only return in-scope changes
      if (scope === "openspec/") return "A  openspec/changes/x/proposal.md\n";
      return " M tasks/todo.md\nA  openspec/changes/x/proposal.md\n";
    },
    gitRestoreStaged: async () => {},
    gitAddAll: async (_wt, args) => {
      capturedArgs = [...args];
    },
    gitCommit: async () => {},
  };

  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.equal(res.salvaged, true, "dirty-in-scope → salvage runs");
  assert.equal(capturedStatusScope, "openspec/", "gitStatus receives the scope");
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  assert.ok(
    (capturedArgs as string[]).includes("openspec/"),
    `gitAddAll args must include scope; got ${JSON.stringify(capturedArgs)}`,
  );
  assert.ok(
    (capturedArgs as string[]).includes(":(exclude)node_modules"),
    "gitAddAll args must still exclude node_modules",
  );
});

test("salvage [scoped, 3.1 bites]: unscoped salvage omits openspec/ restriction and fails the authoring gate", async () => {
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\nA  openspec/changes/x/proposal.md\n",
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => {},
  };

  // Unscoped: both files are staged
  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "OpenSpec authoring", deps);
  assert.equal(res.salvaged, true, "unscoped dirty worktree → salvage runs");
  assert.ok(!(capturedArgs as string[]).includes("openspec/"), "unscoped: args do not restrict to openspec/");

  // A commit whose diff includes tasks/todo.md trips the authoring gate
  const msg = buildSalvageCommitMessage(321, RUN_ID, "OpenSpec authoring");
  const blocked = await verifyHarnessCommits("/wt", "abc", {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
    },
  }, msgsDeps([msg], ["openspec/changes/x/proposal.md", "tasks/todo.md"]));
  assert.equal(blocked.ok, false, "unscoped salvage includes tasks/todo.md → authoring gate blocks");
  assert.ok(
    "reason" in blocked && blocked.reason.includes("OpenSpec authoring step"),
    `unexpected reason: ${JSON.stringify(blocked)}`,
  );
});

test("salvage [scoped, 3.2]: in-scope-clean worktree → {salvaged: false}, no gitAddAll/gitCommit called", async () => {
  let addCalled = false;
  let commitCalled = false;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      // Scoped to openspec/ → empty (no openspec/ changes on disk)
      if (scope === "openspec/") return "";
      return " M tasks/todo.md\n";
    },
    gitAddAll: async () => { addCalled = true; },
    gitCommit: async () => { commitCalled = true; },
  };

  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.deepEqual(res, { salvaged: false }, "in-scope-clean → no salvage");
  assert.equal(addCalled, false, "gitAddAll must NOT be called");
  assert.equal(commitCalled, false, "gitCommit must NOT be called");
});

test("salvage [scoped, 3.3]: scoped authoring salvage commit passes the authoring path-constraint gate", async () => {
  const msg = buildSalvageCommitMessage(321, RUN_ID, "OpenSpec authoring");
  const config = {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
    },
  };
  // Scoped salvage produced a commit with only openspec/ files
  const ok = await verifyHarnessCommits(
    "/wt", "abc", config,
    msgsDeps([msg], ["openspec/changes/x/proposal.md", "openspec/changes/x/tasks.md"]),
  );
  assert.equal(ok.ok, true, "scoped salvage commit (openspec/ only) passes the authoring gate");
});

test("salvage [scoped, 3.3b regression #321]: dirty tasks/todo.md after scoped salvage does not trip authoring gate when allowDirtyPattern is set; bites without it", async () => {
  const msg = buildSalvageCommitMessage(321, RUN_ID, "OpenSpec authoring");
  // After a scoped salvage: only openspec/ committed, tasks/todo.md left dirty
  const depsWithDirty: VerifyDeps = {
    gitMessages: async () => [msg],
    gitDiffFiles: async () => ["openspec/changes/x/proposal.md", "openspec/changes/x/tasks.md"],
    gitDirtyFiles: async () => ["tasks/todo.md"],
    gitCommitShas: async () => [],
  };

  // With allowDirtyPattern: tasks/todo.md is exempt — gate must pass
  const ok = await verifyHarnessCommits("/wt", "abc", {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      allowDirtyPattern: /^tasks\//,
      description: "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
    },
  }, depsWithDirty);
  assert.equal(ok.ok, true, "dirty tasks/todo.md is exempt via allowDirtyPattern — authoring gate passes");

  // Without allowDirtyPattern: dirty tasks/todo.md trips the gate (bites)
  const blocked = await verifyHarnessCommits("/wt", "abc", {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
    },
  }, depsWithDirty);
  assert.equal(blocked.ok, false, "without allowDirtyPattern, dirty tasks/todo.md blocks the authoring gate");
  assert.ok(
    "reason" in blocked && blocked.reason.includes("OpenSpec authoring step"),
    `unexpected reason: ${JSON.stringify(blocked)}`,
  );
});

test("salvage [scoped, regression #321]: pre-staged tasks/todo.md is unstaged via gitRestoreStaged before scoped add — commit contains only openspec/ files", async () => {
  // Reproduces the bug: authoring harness staged tasks/todo.md and an openspec/
  // file before exiting. Without gitRestoreStaged, git-commit would include both.
  const restoreCalls: string[][] = [];
  let addArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      if (scope === "openspec/") return "A  openspec/changes/x/proposal.md\n";
      return " M tasks/todo.md\nA  openspec/changes/x/proposal.md\n";
    },
    gitRestoreStaged: async (_wt, args) => { restoreCalls.push([...args]); },
    gitAddAll: async (_wt, args) => { addArgs = [...args]; },
    gitCommit: async () => {},
  };

  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.equal(res.salvaged, true, "dirty-in-scope → salvage runs");

  // gitRestoreStaged must be called first to clear pre-staged out-of-scope entries
  assert.equal(restoreCalls.length, 1, "gitRestoreStaged must be called exactly once for scoped salvage");
  const restoreArgs = restoreCalls[0];
  assert.ok(restoreArgs.includes("."), "restore args must include '.' to cover all files");
  assert.ok(
    restoreArgs.includes(":(exclude)openspec/"),
    `restore args must exclude openspec/ (leave those staged); got ${JSON.stringify(restoreArgs)}`,
  );
  // node_modules must NOT be excluded from restore: the restore should unstage ALL
  // out-of-scope entries (including any pre-staged node_modules). The subsequent
  // gitAddAll excludes node_modules so they are never re-staged.
  assert.ok(
    !restoreArgs.includes(":(exclude)node_modules"),
    `restore args must NOT exclude node_modules — restore must unstage them; got ${JSON.stringify(restoreArgs)}`,
  );

  // gitAddAll must still run with scope restriction
  assert.ok(addArgs !== null, "gitAddAll must be called");
  assert.ok((addArgs as string[]).includes("openspec/"), "gitAddAll still restricts to scope");

  // Bites: without gitRestoreStaged, the pre-staged tasks/todo.md leaks into
  // the commit and trips the authoring path-constraint gate.
  const msg = buildSalvageCommitMessage(321, RUN_ID, "OpenSpec authoring");
  const leakedDiff = ["openspec/changes/x/proposal.md", "tasks/todo.md"];
  const gateBlocked = await verifyHarnessCommits("/wt", "abc", {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring step committed files outside `openspec/`",
    },
  }, msgsDeps([msg], leakedDiff));
  assert.equal(
    gateBlocked.ok,
    false,
    "without gitRestoreStaged, pre-staged tasks/todo.md leaks → authoring gate blocks",
  );
  assert.ok(
    "reason" in gateBlocked && gateBlocked.reason.includes("OpenSpec authoring step"),
    `unexpected reason: ${JSON.stringify(gateBlocked)}`,
  );

  // With gitRestoreStaged (fix in place), the salvaged commit contains only openspec/
  const cleanDiff = ["openspec/changes/x/proposal.md"];
  const gatePasses = await verifyHarnessCommits("/wt", "abc", {
    issueNumber: 321,
    pathConstraint: {
      allowPattern: /^openspec\//,
      description: "OpenSpec authoring step committed files outside `openspec/`",
    },
  }, msgsDeps([msg], cleanDiff));
  assert.equal(gatePasses.ok, true, "with gitRestoreStaged applied, commit has only openspec/ files → gate passes");
});

test("salvage [scoped, regression #321 — gitRestoreStaged NOT called without scope]: unscoped salvage does not call gitRestoreStaged", async () => {
  let restoreCalled = false;
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\n M core/scripts/foo.ts\n",
    gitRestoreStaged: async () => { restoreCalled = true; },
    gitAddAll: async () => {},
    gitCommit: async () => {},
  };
  await salvageUncommittedWork("/wt", 321, RUN_ID, "implement", deps);
  assert.equal(restoreCalled, false, "gitRestoreStaged must NOT be called for unscoped (implement) salvage");
});

test("salvage [scoped, 3.4]: unscoped implement-stage salvage still stages non-openspec/ files unchanged", async () => {
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\n M core/scripts/foo.ts\n",
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => {},
  };
  // No scope (implement stage) — must use the unscoped default args exactly
  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true);
  assert.deepEqual(
    capturedArgs,
    ["add", "-A", "--", ":(exclude)node_modules"],
    "unscoped implement salvage args are byte-for-byte unchanged from the pre-#321 default",
  );
});

// ---------------------------------------------------------------------------
// Regression #180: salvage gitAddAll must exclude node_modules
// ---------------------------------------------------------------------------

test("salvage [scoped, regression #321 — node_modules not excluded from restore]: pre-staged node_modules/foo.js is unstaged before scoped add and not included in commit", async () => {
  // Reproduces the bug: gitRestoreStaged previously excluded node_modules from
  // the restore, which left pre-staged node_modules/ entries in the index. Those
  // entries then leaked into the salvage commit even though gitAddAll excludes
  // node_modules. The fix: remove :(exclude)node_modules from the restore args so
  // ALL out-of-scope index entries (including node_modules) are unstaged first.
  const restoreCalls: string[][] = [];
  let addArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      // Scoped to openspec/ → only the openspec file appears
      if (scope === "openspec/") return "A  openspec/changes/x/proposal.md\n";
      // Full status: node_modules pre-staged alongside an openspec file
      return "A  node_modules/foo.js\nA  openspec/changes/x/proposal.md\n";
    },
    gitRestoreStaged: async (_wt, args) => { restoreCalls.push([...args]); },
    gitAddAll: async (_wt, args) => { addArgs = [...args]; },
    gitCommit: async () => {},
  };

  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.equal(res.salvaged, true, "dirty-in-scope → salvage runs");
  assert.equal(restoreCalls.length, 1, "gitRestoreStaged called once");

  const restoreArgs = restoreCalls[0];
  // node_modules must NOT be in the exclude list so the restore unstages them
  assert.ok(
    !restoreArgs.includes(":(exclude)node_modules"),
    `restore args must NOT exclude node_modules — must unstage them; got ${JSON.stringify(restoreArgs)}`,
  );
  assert.ok(restoreArgs.includes(":(exclude)openspec/"), "restore keeps openspec/ staged");

  // gitAddAll must still exclude node_modules so they are never re-staged
  assert.ok(addArgs !== null, "gitAddAll must be called");
  assert.ok(
    (addArgs as string[]).includes(":(exclude)node_modules"),
    `gitAddAll must still exclude node_modules; got ${JSON.stringify(addArgs)}`,
  );
});

test("salvage: gitAddAll receives :(exclude)node_modules pathspec when worktree contains node_modules (#180)", async () => {
  // Simulates: harness exits with a node_modules symlink AND a real modified file.
  // The salvage path must pass :(exclude)node_modules in the args so the symlink
  // is never staged even if .git/info/exclude was not yet written.
  const status = "?? node_modules\n M core/scripts/foo.ts\n";
  let capturedArgs: string[] | null = null;
  let commitCreated = false;
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => { commitCreated = true; },
  };
  const res = await salvageUncommittedWork("/wt", 131, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true, "worktree is dirty so salvage must run");
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  assert.ok(
    (capturedArgs as string[]).includes(":(exclude)node_modules"),
    `gitAddAll args must include :(exclude)node_modules; got ${JSON.stringify(capturedArgs)}`,
  );
  assert.equal(commitCreated, true, "commit must be created after staging");
});
