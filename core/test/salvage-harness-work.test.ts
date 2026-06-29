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
