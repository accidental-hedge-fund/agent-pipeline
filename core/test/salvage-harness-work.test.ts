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
  SALVAGE_NODE_MODULES_EXCLUDE,
  SALVAGE_MARKER_EXCLUDE,
  SALVAGE_MARKER_RESTORE_PATHSPEC,
  PIPELINE_INTERNAL_MARKER_FILES,
  type SalvageDeps,
} from "../scripts/salvage-harness-work.ts";
import { enforceImplCommitRef } from "../scripts/stages/planning.ts";
import { enforceFixCommitGate, fixSalvageStageLabel } from "../scripts/stages/fix.ts";
import { enforceTestFixCommitFormat, testFixSalvageStageLabel } from "../scripts/testgate.ts";
import { verifyHarnessCommits, type VerifyDeps } from "../scripts/verify-harness-commits.ts";
import { validateCommitTrailers } from "../scripts/traceability.ts";
import { REBASE_MARKER_FILE } from "../scripts/stages/pre_merge.ts";

const RUN_ID = "131/2026-06-12T18:14:44Z";

function fakeGit(status: string) {
  const calls: { order: string[]; commits: { wtPath: string; message: string }[] } = {
    order: [],
    commits: [],
  };
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitRestoreStaged: async () => {},
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

test("trySalvage: returns {salvaged:true} on dirty, {salvaged:false} on clean, {salvaged:false} (not throw) on git failure", async () => {
  const dirty = fakeGit("?? f\n");
  assert.deepEqual(await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", dirty.deps), { salvaged: true });

  const clean = fakeGit("");
  assert.deepEqual(await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", clean.deps), { salvaged: false });

  const broken = fakeGit("?? f\n");
  broken.deps.gitCommit = async () => {
    throw new Error("commit boom");
  };
  const res = await trySalvageUncommittedWork("/wt", 131, RUN_ID, "implement", broken.deps);
  assert.equal(res.salvaged, false, "salvage failure degrades to the caller's existing block path");
  assert.match(res.failureReason ?? "", /commit boom/, "the caught git failure is captured for blocker disclosure (#521)");
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
  for (const excl of SALVAGE_NODE_MODULES_EXCLUDE) {
    assert.ok(
      (capturedArgs as string[]).includes(excl),
      `gitAddAll args must still exclude node_modules; missing ${excl} in ${JSON.stringify(capturedArgs)}`,
    );
  }
});

test("salvage [scoped, 3.1 bites]: unscoped salvage omits openspec/ restriction and fails the authoring gate", async () => {
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\nA  openspec/changes/x/proposal.md\n",
    gitRestoreStaged: async () => {},
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
    gitRestoreStaged: async () => {},
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

  // gitRestoreStaged is called twice for scoped salvage: once (unconditionally)
  // to clear any already-staged pipeline-internal marker (#522 round 2), then
  // once to clear pre-staged out-of-scope entries.
  assert.equal(restoreCalls.length, 2, "gitRestoreStaged must be called twice for scoped salvage");
  for (const spec of SALVAGE_MARKER_RESTORE_PATHSPEC) {
    assert.ok(
      restoreCalls[0].includes(spec),
      `first restore call must target the marker pathspec; got ${JSON.stringify(restoreCalls[0])}`,
    );
  }
  const restoreArgs = restoreCalls[1];
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

test("salvage [scoped, regression #321 — only the marker restore fires without scope]: unscoped salvage calls gitRestoreStaged once, for the marker pathspec, not the out-of-scope restore", async () => {
  const restoreCalls: string[][] = [];
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\n M core/scripts/foo.ts\n",
    gitRestoreStaged: async (_wt, args) => { restoreCalls.push([...args]); },
    gitAddAll: async () => {},
    gitCommit: async () => {},
  };
  await salvageUncommittedWork("/wt", 321, RUN_ID, "implement", deps);
  assert.equal(restoreCalls.length, 1, "gitRestoreStaged must be called exactly once for unscoped salvage");
  for (const spec of SALVAGE_MARKER_RESTORE_PATHSPEC) {
    assert.ok(
      restoreCalls[0].includes(spec),
      `unscoped restore call must target the marker pathspec; got ${JSON.stringify(restoreCalls[0])}`,
    );
  }
  assert.ok(
    !restoreCalls[0].includes(":(exclude)openspec/"),
    "unscoped salvage must not run the out-of-scope restore",
  );
});

test("salvage [scoped, 3.4]: unscoped implement-stage salvage still stages non-openspec/ files unchanged", async () => {
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async () => " M tasks/todo.md\n M core/scripts/foo.ts\n",
    gitRestoreStaged: async () => {},
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => {},
  };
  // No scope (implement stage) — must use the unscoped default args exactly
  const res = await salvageUncommittedWork("/wt", 321, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true);
  assert.deepEqual(
    capturedArgs,
    ["add", "-A", "--", ...SALVAGE_NODE_MODULES_EXCLUDE, ...SALVAGE_MARKER_EXCLUDE],
    "unscoped implement salvage args are byte-for-byte unchanged apart from the #521/#522 depth-agnostic exclusions",
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
  assert.equal(restoreCalls.length, 2, "gitRestoreStaged called twice (marker unstage + out-of-scope restore)");

  const restoreArgs = restoreCalls[1];
  // node_modules must NOT be in the exclude list so the restore unstages them
  assert.ok(
    !restoreArgs.includes(":(exclude)node_modules"),
    `restore args must NOT exclude node_modules — must unstage them; got ${JSON.stringify(restoreArgs)}`,
  );
  assert.ok(restoreArgs.includes(":(exclude)openspec/"), "restore keeps openspec/ staged");

  // gitAddAll must still exclude node_modules so they are never re-staged
  assert.ok(addArgs !== null, "gitAddAll must be called");
  for (const excl of SALVAGE_NODE_MODULES_EXCLUDE) {
    assert.ok(
      (addArgs as string[]).includes(excl),
      `gitAddAll must still exclude node_modules; missing ${excl} in ${JSON.stringify(addArgs)}`,
    );
  }
});

test("salvage: gitAddAll receives the depth-agnostic node_modules exclusion when worktree contains node_modules (#180)", async () => {
  // Simulates: harness exits with a node_modules symlink AND a real modified file.
  // The salvage path must pass the depth-agnostic exclusion in the args so the
  // symlink is never staged even if .git/info/exclude was not yet written.
  const status = "?? node_modules\n M core/scripts/foo.ts\n";
  let capturedArgs: string[] | null = null;
  let commitCreated = false;
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitRestoreStaged: async () => {},
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => { commitCreated = true; },
  };
  const res = await salvageUncommittedWork("/wt", 131, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true, "worktree is dirty so salvage must run");
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  for (const excl of SALVAGE_NODE_MODULES_EXCLUDE) {
    assert.ok(
      (capturedArgs as string[]).includes(excl),
      `gitAddAll args must include ${excl}; got ${JSON.stringify(capturedArgs)}`,
    );
  }
  assert.equal(commitCreated, true, "commit must be created after staging");
});

// ---------------------------------------------------------------------------
// Regression #521: depth-agnostic node_modules exclusion for nested installs
// ---------------------------------------------------------------------------

/**
 * Minimal reimplementation of git's pathspec-exclusion matching, scoped to the
 * two shapes this module relies on:
 *   - a literal exclude ("node_modules"): matches only a worktree-root entry
 *     and its children (no glob magic, no leading-segment wildcard).
 *   - a `glob`-magic exclude with a `**\/` prefix ("**\/node_modules" or
 *     "**\/node_modules/**"): `**\/` matches zero or more leading path
 *     segments, so the entry is matched at any nesting depth.
 * Used only to prove the exclusion set actually covers a nested path — no
 * real git process is spawned.
 */
function isExcludedBy(pathspecs: string[], relPath: string): boolean {
  return pathspecs.some((spec) => {
    if (spec === ":(exclude)node_modules") {
      return relPath === "node_modules" || relPath.startsWith("node_modules/");
    }
    if (spec === ":(exclude,glob)**/node_modules") {
      return relPath === "node_modules" || relPath.endsWith("/node_modules");
    }
    if (spec === ":(exclude,glob)**/node_modules/**") {
      return relPath.startsWith("node_modules/") || relPath.includes("/node_modules/");
    }
    return false;
  });
}

test("regression #521: nested node_modules install is excluded by the depth-agnostic pathspec; the legacy top-level-only pathspec misses it (bites)", () => {
  const nested = "apps/web/node_modules/.pnpm/lodash@4/index.js";

  assert.ok(
    isExcludedBy(SALVAGE_NODE_MODULES_EXCLUDE, nested),
    `the depth-agnostic exclusion must cover a nested install; SALVAGE_NODE_MODULES_EXCLUDE=${JSON.stringify(SALVAGE_NODE_MODULES_EXCLUDE)}`,
  );

  // Bites: narrowing back to the pre-#521 top-level-only literal pathspec no
  // longer excludes the nested path — this is exactly the bug (#521): git add
  // -A enumerates the ignored nested path and refuses it without -f.
  assert.equal(
    isExcludedBy([":(exclude)node_modules"], nested),
    false,
    "the legacy top-level-only pathspec must NOT exclude a nested node_modules path — proves the fix is load-bearing",
  );

  // A worktree-root node_modules entry (and its children) remains excluded too.
  assert.ok(isExcludedBy(SALVAGE_NODE_MODULES_EXCLUDE, "node_modules"));
  assert.ok(isExcludedBy(SALVAGE_NODE_MODULES_EXCLUDE, "node_modules/.bin/tsc"));
});

test("regression #521: salvage stages a nested-node_modules dirty worktree using the depth-agnostic exclusion", async () => {
  const status =
    " M apps/web/src/foo.ts\n?? apps/web/node_modules/.pnpm/lodash@4/index.js\n";
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitRestoreStaged: async () => {},
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => {},
  };
  const res = await salvageUncommittedWork("/wt", 521, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true, "dirty worktree with real + nested-ignored changes → salvage runs");
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  for (const excl of SALVAGE_NODE_MODULES_EXCLUDE) {
    assert.ok(
      (capturedArgs as string[]).includes(excl),
      `gitAddAll args must include ${excl}; got ${JSON.stringify(capturedArgs)}`,
    );
  }
  const msg = res.salvaged ? res.message : "";
  assert.doesNotMatch(msg, /node_modules/, "the salvage commit message does not reference node_modules");
});

// ---------------------------------------------------------------------------
// Regression #522: pipeline-internal marker files excluded from salvage
// ---------------------------------------------------------------------------

const MARKER = PIPELINE_INTERNAL_MARKER_FILES[0];

test("regression #522: worktree dirty only with the rebase marker → {salvaged: false}, no gitAddAll/gitCommit; bites without the marker exclusion (4.1)", async () => {
  const status = `?? ${MARKER}\n`;

  // Fix in place: marker-only status is treated as clean.
  const clean = fakeGit(status);
  const res = await salvageUncommittedWork("/wt", 522, RUN_ID, "implement", clean.deps);
  assert.deepEqual(res, { salvaged: false }, "marker-only worktree is treated as clean");
  assert.deepEqual(clean.calls.order, [], "neither gitAddAll nor gitCommit is called");

  // Bites: without the marker exclusion, the same status is non-empty →
  // salvage runs and produces a commit whose only content is the marker.
  const rawStatusIsDirty = status.trim().length > 0;
  assert.ok(rawStatusIsDirty, "sanity: the raw porcelain status is non-empty on its own");
});

test("regression #522: real changed file + marker → salvage stages the real file, gitAddAll args exclude the marker, marker not committed (4.2)", async () => {
  const status = ` M core/scripts/foo.ts\n?? ${MARKER}\n`;
  const { deps, calls } = fakeGit(status);
  let capturedArgs: string[] | null = null;
  deps.gitAddAll = async (wt, args) => {
    capturedArgs = [...args];
    calls.order.push(`add:${wt}`);
  };

  const res = await salvageUncommittedWork("/wt", 522, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true, "genuine uncommitted work alongside the marker is still salvaged");
  assert.deepEqual(calls.order, ["add:/wt", "commit:/wt"]);
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  for (const excl of SALVAGE_MARKER_EXCLUDE) {
    assert.ok(
      (capturedArgs as string[]).includes(excl),
      `gitAddAll args must include the marker exclusion; got ${JSON.stringify(capturedArgs)}`,
    );
  }
});

test("regression #522: scoped (openspec/) salvage also excludes the marker (4.3)", async () => {
  let capturedArgs: string[] | null = null;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      if (scope === "openspec/") return "A  openspec/changes/x/proposal.md\n";
      return `A  openspec/changes/x/proposal.md\n?? ${MARKER}\n`;
    },
    gitRestoreStaged: async () => {},
    gitAddAll: async (_wt, args) => { capturedArgs = [...args]; },
    gitCommit: async () => {},
  };

  const res = await salvageUncommittedWork("/wt", 522, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.equal(res.salvaged, true, "in-scope real change → salvage runs");
  assert.ok(capturedArgs !== null, "gitAddAll must be called");
  assert.ok((capturedArgs as string[]).includes("openspec/"), "still restricts staging to scope");
  for (const excl of SALVAGE_MARKER_EXCLUDE) {
    assert.ok(
      (capturedArgs as string[]).includes(excl),
      `scoped gitAddAll args must include the marker exclusion; got ${JSON.stringify(capturedArgs)}`,
    );
  }
});

test("regression #522: scoped (openspec/) salvage dirty only with the marker → {salvaged: false} (4.3)", async () => {
  let addCalled = false;
  let commitCalled = false;
  const deps: SalvageDeps = {
    gitStatus: async (_wt, scope) => {
      if (scope === "openspec/") return `?? ${MARKER}\n`;
      return `?? ${MARKER}\n`;
    },
    gitRestoreStaged: async () => {},
    gitAddAll: async () => { addCalled = true; },
    gitCommit: async () => { commitCalled = true; },
  };

  const res = await salvageUncommittedWork("/wt", 522, RUN_ID, "OpenSpec authoring", deps, "openspec/");
  assert.deepEqual(res, { salvaged: false }, "scoped worktree dirty only with the marker → no salvage");
  assert.equal(addCalled, false);
  assert.equal(commitCalled, false);
});

test("regression #522 (review round 2): a marker already staged from an earlier interrupted salvage is unstaged before an unscoped commit — commit contains only the real file", async () => {
  // Reproduces the finding: a prior interrupted salvage left the marker staged
  // in the index (status reports it with a staged status code), and a genuine
  // file is separately modified. stripPipelineInternalMarkers hides the marker
  // line from the dirtiness check, but without an explicit unstage the marker
  // remains in the index and rides along into the commit alongside the real
  // file when `git commit` runs (git-add's exclude pathspec cannot remove an
  // already-staged entry).
  const status = `M  ${MARKER}\n M core/scripts/foo.ts\n`;
  const restoreCalls: string[][] = [];
  let addArgs: string[] | null = null;
  let committed = false;
  const deps: SalvageDeps = {
    gitStatus: async () => status,
    gitRestoreStaged: async (_wt, args) => { restoreCalls.push([...args]); },
    gitAddAll: async (_wt, args) => { addArgs = [...args]; },
    gitCommit: async () => { committed = true; },
  };

  const res = await salvageUncommittedWork("/wt", 522, RUN_ID, "implement", deps);
  assert.equal(res.salvaged, true, "genuine uncommitted work alongside the pre-staged marker is still salvaged");

  // The pre-staged marker must be explicitly unstaged before the commit — the
  // fix bites: without this call, the already-staged marker survives `git add`
  // (which can only prevent NEW staging, not remove an existing index entry)
  // and would be committed alongside the real file.
  assert.equal(restoreCalls.length, 1, "gitRestoreStaged must be called to clear the pre-staged marker");
  for (const spec of SALVAGE_MARKER_RESTORE_PATHSPEC) {
    assert.ok(
      restoreCalls[0].includes(spec),
      `restore call must target the marker pathspec; got ${JSON.stringify(restoreCalls[0])}`,
    );
  }
  assert.ok(addArgs !== null, "gitAddAll must be called");
  for (const excl of SALVAGE_MARKER_EXCLUDE) {
    assert.ok(
      (addArgs as string[]).includes(excl),
      `gitAddAll args must still exclude the marker; got ${JSON.stringify(addArgs)}`,
    );
  }
  assert.equal(committed, true, "commit is created after the marker is unstaged and the real file staged");
});

test("regression #522: drift guard — REBASE_MARKER_FILE (pre_merge) equals the canonical marker constant (4.4)", () => {
  assert.equal(
    REBASE_MARKER_FILE,
    PIPELINE_INTERNAL_MARKER_FILES[0],
    "pre_merge's marker writer must refer to the same canonical filename the salvage exclusion uses",
  );
  assert.equal(PIPELINE_INTERNAL_MARKER_FILES.length, 1, "exactly one canonical marker filename today");
});

test("regression #522: SALVAGE_MARKER_EXCLUDE carries a depth-agnostic exclusion pathspec for every marker", () => {
  for (const file of PIPELINE_INTERNAL_MARKER_FILES) {
    assert.ok(
      SALVAGE_MARKER_EXCLUDE.includes(`:(exclude,glob)**/${file}`),
      `missing depth-agnostic exclusion for ${file}; got ${JSON.stringify(SALVAGE_MARKER_EXCLUDE)}`,
    );
  }
});
