// Tests for per-cell isolation, execution, and result classification
// (openspec/changes/stage-eval-runner). Every dependency is injected — no
// real fs, git, subprocess, or network call (CLAUDE.md injectable-dep rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateCellIdentity, runCell, type CellExecutionDeps } from "../scripts/evals/executor.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { validateManifest } from "../scripts/evals/manifest.ts";
import type { Cell, Fixture } from "../scripts/evals/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";

const FAKE_CFG = { repo_dir: "/fake/repo" } as import("../scripts/types.ts").PipelineConfig;

const MANIFEST = validateManifest(
  {
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1"],
    mode: "review",
    treatments: { harness: ["claude"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
  },
  new Set(["f1"]),
);

function makeFixture(id = "f1", stage = "review"): Fixture {
  return validateFixture(
    {
      fixture_id: id,
      schema_version: 1,
      base_commit: SHA,
      task_input: "Review this.",
      stage_entry_artifacts: { [stage]: { diff: "..." } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    `${id}.json`,
  );
}

function makeCell(overrides: Partial<Cell> = {}): Cell {
  return {
    cell_id: "exp1/f1/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "f1",
    treatment_id: "harness=claude",
    treatment: { harness: "claude" },
    replicate: 1,
    mode: "review",
    base_sha: SHA,
    ...overrides,
  };
}

function successResult() {
  return { success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 };
}

test("allocateCellIdentity: distinct cell_ids never collide on path, branch, or session", () => {
  const cellA = makeCell({ cell_id: "exp1/f1/harness=claude/1" });
  const cellB = makeCell({ cell_id: "exp1/f1/harness=claude/2", replicate: 2 });
  const idA = allocateCellIdentity(FAKE_CFG, cellA);
  const idB = allocateCellIdentity(FAKE_CFG, cellB);
  assert.notEqual(idA.worktreePath, idB.worktreePath);
  assert.notEqual(idA.branch, idB.branch);
  assert.notEqual(idA.sessionId, idB.sessionId);
});

test("allocateCellIdentity: same cell_id always resolves to the same identity", () => {
  const cell = makeCell();
  assert.deepEqual(allocateCellIdentity(FAKE_CFG, cell), allocateCellIdentity(FAKE_CFG, cell));
});

test("runCell: worktree creation failure classifies as infra_error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async () => { throw new Error("git worktree add failed: disk full"); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /disk full/);
});

test("runCell: unauthenticated preflight classifies as auth_error, never invokes the harness", async () => {
  let invoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: false, failure: "unauthenticated", message: "not logged in" }),
    invokeHarness: async () => { invoked = true; return successResult(); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "auth_error");
  assert.equal(invoked, false, "harness must not be invoked after an auth preflight failure");
});

test("runCell: missing-cli preflight classifies as infra_error, not auth_error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: false, failure: "missing-cli", message: "claude not found" }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
});

test("runCell: a harness timeout classifies as timeout, not completed or infra_error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: true, exit_code: -1, stdout: "", stderr: "", duration: 60 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "timeout");
});

test("runCell: a spawn error classifies as infra_error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: false, spawn_error: true, exit_code: -1, stdout: "", stderr: "", duration: 0 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
});

test("runCell: an unsuccessful treatment outcome is still classified as completed", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: false, exit_code: 1, stdout: "wrong answer", stderr: "", duration: 3 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: a successful treatment outcome is classified as completed", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: worktree is always torn down, even after a harness failure", async () => {
  let removed = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => { removed = true; },
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: false, exit_code: 1, stdout: "", stderr: "", duration: 1 }),
  };
  await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(removed, true);
});

test("runCell: worktree is not torn down if it was never created", async () => {
  let removeCalled = false;
  const deps: CellExecutionDeps = {
    createWorktree: async () => { throw new Error("boom"); },
    removeWorktree: async () => { removeCalled = true; },
  };
  await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(removeCalled, false);
});

test("runCell: no production GitHub write occurs for a normal cell — ghRefusals is empty", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.deepEqual(result.ghRefusals, []);
});

test("runCell: a stage that attempts a mutating GitHub call is refused and the refusal is recorded", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      await assert.rejects(() => args.gh.addLabel(1, "pipeline:ready-to-deploy"));
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.ghRefusals.length, 1);
  assert.equal(result.ghRefusals[0].operation, "addLabel");
});

test("runCell: two replicates of the same treatment get distinct worktrees/branches", async () => {
  const seen: string[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => { seen.push(o.path); return o; },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  await runCell(FAKE_CFG, makeCell({ cell_id: "exp1/f1/harness=claude/1", replicate: 1 }), makeFixture(), MANIFEST, deps);
  await runCell(FAKE_CFG, makeCell({ cell_id: "exp1/f1/harness=claude/2", replicate: 2 }), makeFixture(), MANIFEST, deps);
  assert.equal(new Set(seen).size, 2);
});

test("runCell: strips GitHub/git write credentials from the real harness process env", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      seenEnv = args.env;
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(seenEnv?.GH_TOKEN, "");
  assert.equal(seenEnv?.GITHUB_TOKEN, "");
  assert.equal(seenEnv?.GH_ENTERPRISE_TOKEN, "");
  assert.equal(seenEnv?.SSH_AUTH_SOCK, "");
  assert.match(seenEnv?.GH_CONFIG_DIR ?? "", /\.eval-gh-config-empty$/);
});

test("runCell: a provider treatment on a harness with no provider axis is rejected as infra_error, not silently ignored", async () => {
  let invoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { invoked = true; return successResult(); },
  };
  const cell = makeCell({ treatment: { harness: "claude", provider: "anthropic" } });
  const result = await runCell(FAKE_CFG, cell, makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /no separate provider axis/);
  assert.equal(invoked, false, "an incompatible provider/harness treatment must never be executed as a no-op");
});

test("runCell: a provider treatment on a provider-qualified harness is folded into the model string", async () => {
  let seenModel: string | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => { seenModel = args.model; return successResult(); },
  };
  const cell = makeCell({
    treatment: { harness: "opencode", provider: "anthropic", model: "claude-opus-4" },
  });
  const result = await runCell(FAKE_CFG, cell, makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(seenModel, "anthropic/claude-opus-4");
});

test("runCell: distinct provider treatments on the same qualified harness produce distinct invocations", async () => {
  const seenModels: string[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => { seenModels.push(args.model ?? ""); return successResult(); },
  };
  await runCell(
    FAKE_CFG,
    makeCell({ treatment: { harness: "opencode", provider: "anthropic", model: "claude-opus-4" } }),
    makeFixture(),
    MANIFEST,
    deps,
  );
  await runCell(
    FAKE_CFG,
    makeCell({ treatment: { harness: "opencode", provider: "openai", model: "claude-opus-4" } }),
    makeFixture(),
    MANIFEST,
    deps,
  );
  assert.equal(new Set(seenModels).size, 2);
});

test("runCell: stage-mode invokes exactly one stage (never the other five)", async () => {
  const stagesInvoked: string[] = [];
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: {
        planning: { a: 1 },
        review: { b: 2 },
        fix: { c: 3 },
      },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      stagesInvoked.push(args.prompt);
      return successResult();
    },
  };
  await runCell(FAKE_CFG, makeCell({ mode: "review", cell_id: "exp1/f1/harness=claude/1" }), fixture, MANIFEST, deps);
  assert.equal(stagesInvoked.length, 1);
  assert.match(stagesInvoked[0], /Review the following diff/);
  assert.doesNotMatch(stagesInvoked[0], /Produce an implementation plan/);
});
