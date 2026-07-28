// Tests for per-cell isolation, execution, and result classification
// (openspec/changes/stage-eval-runner). Every dependency is injected — no
// real fs, git, subprocess, or network call (CLAUDE.md injectable-dep rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { allocateCellIdentity, defaultContractIO, deriveModelEndpointOverride, runCell as runCellReal, type CellExecutionDeps } from "../scripts/evals/executor.ts";
import { materializeStagePrompt } from "../scripts/evals/stage-adapters.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { validateManifest } from "../scripts/evals/manifest.ts";
import type { Cell, Fixture } from "../scripts/evals/types.ts";
import { parseReportedFindings, gradeReview } from "../scripts/evals/grading/graders/review.ts";
import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../scripts/review-schema.ts";

// #607 eval-agent-isolation-boundary added a real-fs contract install/restore
// and a real command-boundary shim to every runCell() call. Every test in
// this file uses a fake `createWorktree` that never creates a real
// directory (CLAUDE.md's injectable-dep rule — no real fs/subprocess in
// these tests), so the production defaults for those two features would
// fail against a nonexistent path. This local `runCell` wrapper injects
// harmless in-memory fakes for both by default, so every pre-existing test
// below is unaffected; a test that specifically exercises contract/boundary
// behavior overrides the relevant key(s) explicitly (object spread below
// puts `...deps` last, so an explicit key — including `undefined`, which
// opts back into the real default via `??` inside runCell itself — always
// wins).
function fakeContractIO(): NonNullable<CellExecutionDeps["contractIO"]> {
  const files = new Map<string, string>();
  return {
    readFile: (p) => (files.has(p) ? files.get(p)! : null),
    writeFile: (p, c) => { files.set(p, c); },
    removeFile: (p) => { files.delete(p); },
  };
}

async function runCell(...args: Parameters<typeof runCellReal>): ReturnType<typeof runCellReal> {
  const [cfg, cell, fixture, manifest, deps = {}] = args;
  return runCellReal(cfg, cell, fixture, manifest, {
    contractIO: fakeContractIO(),
    installBoundaryShim: (worktreeDir: string) => `${worktreeDir}/.eval-boundary-shim`,
    readBoundaryDenials: () => [],
    ...deps,
  });
}

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

function makeFixture(id = "f1", stage = "review", environment?: unknown[]): Fixture {
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
      ...(environment ? { environment } : {}),
    },
    `${id}.json`,
  );
}

function envDep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "github-api",
    mode: "forbidden",
    version: "1",
    required_permissions: [],
    initial_state: {},
    expected: {},
    setup: "echo setup",
    teardown: "echo teardown",
    ...overrides,
  };
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

// ---------------------------------------------------------------------------
// declared-effort deliverability (#621) — a cell whose treatment declares an
// effort against a harness that cannot express one must fail before the
// harness is ever invoked, and must never be recorded as a completed
// treatment carrying an effort coordinate that was never delivered.
// ---------------------------------------------------------------------------

test("runCell: a declared effort against a harness with no adapter (custom CLI) is infra_error and never invokes the harness (#621)", async () => {
  let invoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { invoked = true; return successResult(); },
  };
  const cell = makeCell({
    treatment: { harness: "review_harness_custom", effort: "high" },
    treatment_id: "harness=review_harness_custom,effort=high",
  });
  const result = await runCell(FAKE_CFG, cell, makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /review_harness_custom/, "error must name the harness");
  assert.match(result.outcome.error ?? "", /high/, "error must name the requested effort");
  assert.equal(invoked, false, "the harness must never be invoked when its declared effort is undeliverable");
});

test("runCell: no declared effort against a harness with no adapter still executes normally (#621)", async () => {
  let invoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { invoked = true; return successResult(); },
  };
  const cell = makeCell({
    treatment: { harness: "review_harness_custom" },
    treatment_id: "harness=review_harness_custom",
  });
  const result = await runCell(FAKE_CFG, cell, makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(invoked, true, "a cell with no declared effort must still execute against a custom harness");
});

test("runCell: two cells differing only in declared effort send different effort values to the harness (#621)", async () => {
  const seenEfforts: (string | undefined)[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => { seenEfforts.push(args.effort); return successResult(); },
  };
  await runCell(FAKE_CFG, makeCell({ treatment: { harness: "claude", effort: "low" } }), makeFixture(), MANIFEST, deps);
  await runCell(FAKE_CFG, makeCell({ treatment: { harness: "claude", effort: "high" } }), makeFixture(), MANIFEST, deps);
  assert.deepEqual(seenEfforts, ["low", "high"]);
  assert.notEqual(seenEfforts[0], seenEfforts[1]);
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

test("runCell: strips git/ssh/gh credential sources beyond just tokens", async () => {
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
  await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(seenEnv?.GIT_CONFIG_NOSYSTEM, "1");
  assert.match(seenEnv?.GIT_CONFIG_GLOBAL ?? "", /\.eval-gitconfig-empty$/);
  assert.match(seenEnv?.GIT_SSH_COMMAND ?? "", /IdentityFile=\/dev\/null/);
  assert.match(seenEnv?.GIT_SSH_COMMAND ?? "", /IdentitiesOnly=yes/);
});

test("runCell: preflight failure classifies infra_error/auth_error but never rejects", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => { throw new Error("preflight probe crashed"); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /preflight probe crashed/);
});

test("runCell: a worktree-removal failure does not reject runCell or override the primary outcome", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => { throw new Error("git worktree remove failed"); },
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: a rate-limit/throttle signal on invocation failure classifies as auth_error, not completed", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: false, timed_out: false, exit_code: 1, stdout: "", stderr: "", duration: 1, throttled: true,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "auth_error");
});

test("runCell: credentials that expire mid-invocation classify as auth_error via a preflight recheck", async () => {
  let preflightCalls = 0;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => {
      preflightCalls++;
      // ok before the invocation, unauthenticated on the post-failure recheck.
      return preflightCalls === 1 ? { ok: true } : { ok: false, failure: "unauthenticated", message: "token expired" };
    },
    invokeHarness: async () => ({ success: false, timed_out: false, exit_code: 1, stdout: "", stderr: "", duration: 1 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "auth_error");
  assert.match(result.outcome.error ?? "", /token expired/);
  assert.equal(preflightCalls, 2);
});

test("runCell: an unsuccessful outcome with no auth/throttle signal is still classified as completed (recheck ok)", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: false, exit_code: 1, stdout: "wrong answer", stderr: "", duration: 3 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: an end-to-end cell shares one deadline across stages, not a fresh timeout per stage", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { planning: { a: 1 }, review: { b: 2 } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "end-to-end",
      treatments: { harness: ["claude"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 1,
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  const seenTimeouts: number[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      seenTimeouts.push(args.timeoutSec);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell({ mode: "end-to-end", cell_id: "exp1/f1/harness=claude/1" }), fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(seenTimeouts.length, 2);
  assert.ok(seenTimeouts[1] <= seenTimeouts[0], `second stage's remaining budget (${seenTimeouts[1]}) must not exceed the first's (${seenTimeouts[0]}) — each stage must not receive a fresh full timeout`);
});

test("runCell: an end-to-end cell that exhausts its deadline mid-run times out without invoking the remaining stages", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { planning: { a: 1 }, review: { b: 2 } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "end-to-end",
      treatments: { harness: ["claude"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 0.02, // 20ms budget for the whole cell
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  let invocations = 0;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => {
      invocations++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell({ mode: "end-to-end", cell_id: "exp1/f1/harness=claude/1" }), fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "timeout");
  assert.equal(invocations, 1, "the second stage must never be invoked once the cell deadline has passed");
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

test("runCell: checks are run and recorded in detail.checks only when the fixture declares one", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: ["npm run ci"],
      hidden_checks: ["node --test hidden.test.ts"],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  let ranWith: string[] | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
    runChecks: async (args) => {
      ranWith = args.checks;
      return { "npm run ci": true, "node --test hidden.test.ts": false };
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.deepEqual(ranWith, ["npm run ci", "node --test hidden.test.ts"]);
  assert.deepEqual(result.outcome.detail?.checks, { "npm run ci": true, "node --test hidden.test.ts": false });
});

test("runCell: checks that would overrun the cell deadline classify as timeout, not completed", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: ["npm run ci"],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "review",
      treatments: { harness: ["claude"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 0.02, // 20ms budget for the whole cell
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  let runChecksInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return successResult();
    },
    runChecks: async () => {
      runChecksInvoked = true;
      return { "npm run ci": true };
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "timeout");
  assert.equal(runChecksInvoked, false, "checks must never start once the cell deadline has already passed");
});

test("runCell: check execution is capped by the cell's remaining deadline, not a fixed per-check ceiling", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: ["npm run ci"],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const manifest = validateManifest(
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
  let receivedDeadlineMs: number | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
    runChecks: async (args) => {
      receivedDeadlineMs = args.deadlineMs;
      return { "npm run ci": true };
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, manifest, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.ok(receivedDeadlineMs !== undefined && receivedDeadlineMs > 0 && receivedDeadlineMs <= 60_000);
});

test("runCell: no hidden check name ever reaches the materialized prompt sent to the treatment", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: ["npm run ci"],
      hidden_checks: ["node --test the-hidden-marker-check.ts"],
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
    invokeHarness: async () => successResult(),
    runChecks: async () => ({}),
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.doesNotMatch(result.materializedPrompt, /the-hidden-marker-check/);
});

test("runCell: checks are never run when the fixture declares none, with no dep provided", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.detail?.checks, undefined);
});

test("runCell: changed_paths is recorded only when the fixture declares an allowed-change boundary", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      allowed_change_paths: ["core/scripts/gh.ts"],
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
    invokeHarness: async () => successResult(),
    getChangedPaths: async () => ["core/scripts/gh.ts", "core/scripts/other.ts"],
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.deepEqual(result.outcome.detail?.changed_paths, ["core/scripts/gh.ts", "core/scripts/other.ts"]);

  const withoutBoundary = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  });
  assert.equal(withoutBoundary.outcome.detail?.changed_paths, undefined);
});

test("runCell: review-mode findings are parsed from harness stdout into detail.findings (bare verdict object, tolerant — missing summary/next_steps)", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: JSON.stringify({ verdict: "needs-attention", findings: [{ file: "a.ts", severity: "high" }] }),
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  const findings = result.outcome.detail?.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "a.ts");
  assert.equal(findings[0].severity, "high");
  assert.equal(result.outcome.detail?.review_verdict_parse, "tolerant");
});

test("runCell: review-mode findings satisfying the full verdict contract are recorded with provenance 'strict'", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: JSON.stringify({
        verdict: "needs-attention",
        summary: "one issue found",
        findings: [
          {
            severity: "high",
            title: "bug",
            body: "explanation",
            file: "a.ts",
            line_start: 1,
            line_end: 2,
            confidence: 0.9,
            recommendation: "fix it",
          },
        ],
        next_steps: [],
      }),
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  const findings = result.outcome.detail?.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "a.ts");
  assert.equal(findings[0].line_start, 1);
  assert.equal(findings[0].line_end, 2);
  assert.equal(findings[0].severity, "high");
  assert.equal(result.outcome.detail?.review_verdict_parse, "strict");
});

test("runCell: a review-mode verdict inside a fenced json block with surrounding prose is parsed into detail.findings", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout:
        "Here is my review:\n\n```json\n" +
        JSON.stringify({
          verdict: "needs-attention",
          summary: "one issue found",
          findings: [
            {
              severity: "high",
              title: "bug",
              body: "explanation",
              file: "a.ts",
              line_start: 1,
              line_end: 2,
              confidence: 0.9,
              recommendation: "fix it",
            },
          ],
          next_steps: [],
        }) +
        "\n```\n\nThanks!",
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  const findings = result.outcome.detail?.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "a.ts");
  assert.equal(result.outcome.detail?.review_verdict_parse, "strict");
});

test("runCell: an inline (unfenced) verdict object surrounded by other text is parsed into detail.findings", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout:
        "My review: " +
        JSON.stringify({
          verdict: "needs-attention",
          summary: "one issue found",
          findings: [
            {
              severity: "high",
              title: "bug",
              body: "explanation",
              file: "a.ts",
              line_start: 1,
              line_end: 2,
              confidence: 0.9,
              recommendation: "fix it",
            },
          ],
          next_steps: [],
        }) +
        " — end of review.",
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  const findings = result.outcome.detail?.findings as Array<Record<string, unknown>>;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "a.ts");
  assert.equal(result.outcome.detail?.review_verdict_parse, "strict");
});

test("runCell: a parsed finding retains every REVIEW_SCHEMA_FIELDS.finding field the harness emitted, including optional ones", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: JSON.stringify({
        verdict: "needs-attention",
        summary: "one issue found",
        findings: [
          {
            severity: "high",
            title: "bug",
            body: "explanation",
            file: "a.ts",
            line_start: 1,
            line_end: 2,
            confidence: 0.9,
            recommendation: "fix it",
            category: "correctness",
            blocking: true,
            spec_divergence_direction: "code-behind-spec",
            prior_round_acknowledgment: "round 2: still applies",
            rejected_alternatives: ["ignore it"],
          },
        ],
        next_steps: [],
      }),
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  const finding = (result.outcome.detail?.findings as Array<Record<string, unknown>>)[0];
  assert.equal(finding.file, "a.ts");
  assert.equal(finding.line_start, 1);
  assert.equal(finding.line_end, 2);
  assert.equal(finding.severity, "high");
  assert.equal(finding.category, "correctness");
  assert.equal(finding.blocking, true);
  assert.equal(finding.spec_divergence_direction, "code-behind-spec");
  assert.equal(finding.prior_round_acknowledgment, "round 2: still applies");
  assert.deepEqual(finding.rejected_alternatives, ["ignore it"]);
});

test("runCell: prose-only review-mode output is recorded as unparseable, not as a verdict with zero findings", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: "This diff looks fine to me, no issues found.",
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.detail?.findings, undefined);
  assert.equal(result.outcome.detail?.review_verdict_parse, "unparseable");
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: a verdict-field-only JSON object with no findings array is recorded as unparseable, not a verdict with zero findings", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      // No `findings` key at all — not verdict-shaped enough to trust as a
      // recovered review (#606 review 1 finding e74066d5).
      stdout: JSON.stringify({ verdict: "approve" }),
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.detail?.findings, undefined);
  assert.equal(result.outcome.detail?.review_verdict_parse, "unparseable");
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: empty review-mode stdout is recorded as unparseable", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration: 1,
    }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.detail?.findings, undefined);
  assert.equal(result.outcome.detail?.review_verdict_parse, "unparseable");
});

// ---------------------------------------------------------------------------
// #606 eval-review-verdict-contract — the materialized review-mode prompt
// states the production structured verdict contract, and a review cell's
// parsed findings reach the review grader end-to-end.
// ---------------------------------------------------------------------------

function fixtureReviewWithDefect(): Fixture {
  return validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "Review this.",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      seeded_defects: [
        { defect_id: "d1", path: "a.ts", line_start: 10, line_end: 12, expected_severity: "high" },
      ],
      grader_refs: [{ grader: "review", version: "1" }],
      category: "c",
      risk: "medium",
      provenance: "synthetic",
    },
    "f1.json",
  );
}

test("materializeStagePrompt: the review-stage prompt contains the exact REVIEW_VERDICT_SCHEMA_BLOCK text and a JSON-only instruction, with no unsubstituted {{...}} token", () => {
  const prompt = materializeStagePrompt("review", makeFixture());
  assert.ok(prompt.includes(REVIEW_VERDICT_SCHEMA_BLOCK), "prompt must contain the exact schema block text");
  assert.match(prompt, /Return ONLY valid JSON/i);
  assert.doesNotMatch(prompt, /\{\{[a-zA-Z_]+\}\}/, "no unsubstituted {{...}} placeholder may reach the harness");
});

test("materializeStagePrompt: non-review stages are byte-identical to their pre-#606 materialization and never contain the review schema block", () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "Do the thing.",
      stage_entry_artifacts: {
        planning: { a: 1 },
        "plan-review": { b: 2 },
        implementing: { c: 3 },
        fix: { d: 4 },
        shipcheck: { e: 5 },
      },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const expected: Record<string, string> = {
    planning: "Produce an implementation plan for the following issue.\n\n## Task\nDo the thing.\n\n## Stage input\n" + JSON.stringify({ a: 1 }, null, 2),
    "plan-review": "Review the following implementation plan for correctness and completeness.\n\n## Task\nDo the thing.\n\n## Stage input\n" + JSON.stringify({ b: 2 }, null, 2),
    implementing: "Implement the following plan in this repository.\n\n## Task\nDo the thing.\n\n## Stage input\n" + JSON.stringify({ c: 3 }, null, 2),
    fix: "Resolve the following review finding with a minimal, surgical diff.\n\n## Task\nDo the thing.\n\n## Stage input\n" + JSON.stringify({ d: 4 }, null, 2),
    shipcheck: "Verify the following change is ready to ship: re-run checks and confirm no regressions.\n\n## Task\nDo the thing.\n\n## Stage input\n" + JSON.stringify({ e: 5 }, null, 2),
  };
  for (const [stage, expectedPrompt] of Object.entries(expected)) {
    const prompt = materializeStagePrompt(stage as Parameters<typeof materializeStagePrompt>[0], fixture);
    assert.equal(prompt, expectedPrompt, `stage "${stage}" prompt must be byte-identical to pre-#606 materialization`);
    assert.doesNotMatch(prompt, /"findings":/, `stage "${stage}" prompt must not contain the review schema block`);
  }
});

test("runCell: a review cell's parsed findings reach the review grader end-to-end — a valid verdict naming the seeded defect yields true_positives > 0 and recall === 1", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: JSON.stringify({
        verdict: "needs-attention",
        summary: "found the seeded defect",
        findings: [
          {
            severity: "high",
            title: "bug",
            body: "explanation",
            file: "a.ts",
            line_start: 11,
            line_end: 11,
            confidence: 0.9,
            recommendation: "fix it",
          },
        ],
        next_steps: [],
      }),
      stderr: "",
      duration: 1,
    }),
  };
  const fixture = fixtureReviewWithDefect();
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.outcome.detail?.review_verdict_parse, "strict");
  const findings = parseReportedFindings(result.outcome.detail?.findings as unknown[] | undefined);
  const grade = gradeReview(fixture, findings);
  assert.equal(grade.true_positives, 1, "the parsed finding must reach the grader as a true positive");
  assert.equal(grade.recall, 1);
});

test("runCell: prose review-mode output records review_verdict_parse: unparseable, not a verdict with zero findings — the grader reports the seeded defect as a false negative, not an infra error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({
      success: true,
      timed_out: false,
      exit_code: 0,
      stdout: "This diff looks fine to me, no issues found.",
      stderr: "",
      duration: 1,
    }),
  };
  const fixture = fixtureReviewWithDefect();
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.outcome.detail?.review_verdict_parse, "unparseable");
  assert.equal(result.outcome.detail?.findings, undefined);
  const findings = parseReportedFindings(result.outcome.detail?.findings as unknown[] | undefined);
  const grade = gradeReview(fixture, findings);
  assert.equal(grade.true_positives, 0);
  assert.equal(grade.false_negatives, 1);
  assert.equal(grade.recall, 0);
});

test("runCell: a review stage inside an end-to-end cell receives the contract-bearing prompt and its findings are captured with provenance", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { planning: { a: 1 }, review: { diff: "..." } },
      public_checks: [],
      seeded_defects: [
        { defect_id: "d1", path: "a.ts", line_start: 10, line_end: 12, expected_severity: "high" },
      ],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "f1.json",
  );
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "end-to-end",
      treatments: { harness: ["claude"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 60,
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  const promptsSeen: string[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      promptsSeen.push(args.prompt);
      if (args.prompt.includes("Review the following diff")) {
        return {
          success: true,
          timed_out: false,
          exit_code: 0,
          stdout: JSON.stringify({
            verdict: "needs-attention",
            summary: "found it",
            findings: [
              {
                severity: "high",
                title: "bug",
                body: "explanation",
                file: "a.ts",
                line_start: 11,
                line_end: 11,
                confidence: 0.9,
                recommendation: "fix it",
              },
            ],
            next_steps: [],
          }),
          stderr: "",
          duration: 1,
        };
      }
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell({ mode: "end-to-end", cell_id: "exp1/f1/harness=claude/1" }), fixture, manifest, deps);
  const reviewPrompt = promptsSeen.find((p) => p.includes("Review the following diff"));
  assert.ok(reviewPrompt?.includes(REVIEW_VERDICT_SCHEMA_BLOCK), "the review stage inside end-to-end mode must receive the contract-bearing prompt");
  assert.equal(result.outcome.detail?.review_verdict_parse, "strict");
  const findings = parseReportedFindings(result.outcome.detail?.findings as unknown[] | undefined);
  const grade = gradeReview(fixture, findings);
  assert.equal(grade.true_positives, 1);
});

// ---------------------------------------------------------------------------
// #434 stage-eval-runner integration — API treatment bound to a named
// model-endpoint executor
// ---------------------------------------------------------------------------

function apiCfg() {
  return {
    ...FAKE_CFG,
    executors: {
      "openrouter-review": {
        type: "model-endpoint" as const,
        base_url: "https://openrouter.ai/api/v1",
        model: "openai/gpt-5",
        dialect: "openrouter" as const,
      },
      "not-an-endpoint": {
        type: "agent-system" as const,
        provider: "opencode",
        endpoint: "https://opencode.internal/api",
      },
    },
  } as unknown as import("../scripts/types.ts").PipelineConfig;
}

function apiCell(overrides: Partial<Cell> = {}): Cell {
  return makeCell({
    treatment: { executor: "openrouter-review", model: "openai/gpt-5-mini", effort: "high" },
    treatment_id: "executor=openrouter-review,model=openai/gpt-5-mini,effort=high",
    ...overrides,
  });
}

test("runCell: an API treatment reaches the request with its per-cell override", async () => {
  let capturedOverride: unknown;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async (args) => {
      capturedOverride = args.override;
      return { ok: true, result: successResult() as unknown as import("../scripts/harness.ts").HarnessResult };
    },
  };
  const result = await runCell(apiCfg(), apiCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.deepEqual(capturedOverride, { model: "openai/gpt-5-mini", effort: "high" });
  assert.equal((result.outcome.detail as Record<string, unknown>)?.execution_class, "api-key");
});

test("runCell: replaying the same cell resolves the same override (determinism)", async () => {
  const overrides: unknown[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async (args) => {
      overrides.push(args.override);
      return { ok: true, result: successResult() as unknown as import("../scripts/harness.ts").HarnessResult };
    },
  };
  await runCell(apiCfg(), apiCell(), makeFixture(), MANIFEST, deps);
  await runCell(apiCfg(), apiCell(), makeFixture(), MANIFEST, deps);
  assert.deepEqual(overrides[0], overrides[1]);
});

test("runCell: an unknown executor name is classified infra_error, never a completed treatment outcome", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
  };
  const result = await runCell(
    apiCfg(),
    apiCell({ treatment: { executor: "does-not-exist" } }),
    makeFixture(),
    MANIFEST,
    deps,
  );
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /does-not-exist/);
});

test("runCell: an executor that isn't a model-endpoint is classified infra_error", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
  };
  const result = await runCell(
    apiCfg(),
    apiCell({ treatment: { executor: "not-an-endpoint" } }),
    makeFixture(),
    MANIFEST,
    deps,
  );
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /not-an-endpoint/);
});

test("runCell: an invalid per-cell override is classified infra_error, not a completed treatment outcome", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async () => ({ ok: false, error: 'executor "openrouter-review" for stage "review-1" received an invalid params override: temperatur: unrecognized key' }),
  };
  const result = await runCell(apiCfg(), apiCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /temperatur/);
});

test("runCell: an end-to-end mode with an API treatment is rejected as infra_error (model-endpoint is single-stage only)", async () => {
  const e2eManifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "end-to-end",
      treatments: { executor: ["openrouter-review"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 60,
      output_dir: ".agent-pipeline/evals",
    },
    new Set(["f1"]),
  );
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "Do the thing.",
      stage_entry_artifacts: { planning: {}, review: { diff: "..." } },
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
  };
  const result = await runCell(
    apiCfg(),
    apiCell({ mode: "end-to-end" }),
    fixture,
    e2eManifest,
    deps,
  );
  assert.equal(result.outcome.result_class, "infra_error");
});

test("runCell: a local-CLI cell record carries execution_class 'local-cli', distinguishable without inspecting harness/model", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal((result.outcome.detail as Record<string, unknown>)?.execution_class, "local-cli");
});

// ---------------------------------------------------------------------------
// #434 review 1 finding e2de1c5f — per-cell `params` override reaches the
// request via `deriveModelEndpointOverride` / `invokeExecutor`, without
// mutating committed executor configuration.
// ---------------------------------------------------------------------------

test("deriveModelEndpointOverride: carries treatment.params onto the override", () => {
  const override = deriveModelEndpointOverride({
    executor: "openrouter-review",
    model: "openai/gpt-5-mini",
    effort: "high",
    params: { temperature: 0, seed: 7 },
  });
  assert.deepEqual(override, { model: "openai/gpt-5-mini", effort: "high", params: { temperature: 0, seed: 7 } });
});

test("deriveModelEndpointOverride: omits params when the treatment declares none", () => {
  const override = deriveModelEndpointOverride({ executor: "openrouter-review" });
  assert.deepEqual(override, {});
  assert.ok(!("params" in override));
});

test("runCell: two cells with distinct treatment.params send distinct parameter payloads, without config mutation", async () => {
  const cfg = apiCfg();
  const committedParamsBefore = JSON.stringify((cfg.executors as Record<string, unknown>)["openrouter-review"]);
  const capturedOverrides: unknown[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async (args) => {
      capturedOverrides.push(args.override);
      return { ok: true, result: successResult() as unknown as import("../scripts/harness.ts").HarnessResult };
    },
  };
  const cellA = apiCell({
    treatment: { executor: "openrouter-review", params: { temperature: 0 } },
    treatment_id: "executor=openrouter-review,params={\"temperature\":0}",
  });
  const cellB = apiCell({
    treatment: { executor: "openrouter-review", params: { temperature: 1 } },
    treatment_id: "executor=openrouter-review,params={\"temperature\":1}",
  });
  await runCell(cfg, cellA, makeFixture(), MANIFEST, deps);
  await runCell(cfg, cellB, makeFixture(), MANIFEST, deps);
  assert.deepEqual(capturedOverrides, [{ params: { temperature: 0 } }, { params: { temperature: 1 } }]);
  assert.equal(JSON.stringify((cfg.executors as Record<string, unknown>)["openrouter-review"]), committedParamsBefore);
});

test("runCell: an API treatment's endpoint provenance is carried onto the cell detail", async () => {
  const provenance = {
    requested_model: "openai/gpt-5-mini",
    resolved_model: "openai/gpt-5-mini-2026-01-01",
    upstream_provider: "OpenAI",
    request_id: "gen-1",
    finish_reason: "stop",
    usage: null,
    cost_usd: 0.001,
    retry_count: 0,
    rate_limited: null,
    duration_ms: 500,
    requested_effort: "high",
    resolved_effort: "high",
    effort_support: "encoded",
  };
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async () => ({
      ok: true,
      result: { ...successResult(), executor_provenance: provenance } as unknown as import("../scripts/harness.ts").HarnessResult,
    }),
  };
  const result = await runCell(apiCfg(), apiCell(), makeFixture(), MANIFEST, deps);
  assert.deepEqual((result.outcome.detail as Record<string, unknown>)?.executor_provenance, provenance);
});

// ---------------------------------------------------------------------------
// Environment-fidelity enforcement (#535 review 1 finding ed37a4fd; review 2
// finding d906091a): a declared `forbidden` dependency must be deterministically
// denied at the dependency boundary — its setup/teardown stand-in runs like a
// `simulated` dependency's, the treatment still executes, and the expected
// denial is exposed to checks/graders via `detail.environment` — rather than
// refusing the whole cell before a worktree even exists.
// ---------------------------------------------------------------------------

test("runCell: a forbidden environment dependency runs its deterministic denial and still executes the treatment", async () => {
  let worktreeCreated = false;
  let harnessInvoked = false;
  const commands: Array<{ command: string; phase: string }> = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => { worktreeCreated = true; return o; },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
    runEnvironmentCommand: async (args) => {
      commands.push({ command: args.command, phase: args.phase });
      return { ok: true };
    },
  };
  const fixture = makeFixture("f1", "review", [
    envDep({ name: "github-api", mode: "forbidden", expected: { errors: ["403 forbidden"] } }),
  ]);
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(worktreeCreated, true, "a forbidden dependency's deterministic denial requires a worktree, like a simulated dependency's stand-in");
  assert.equal(harnessInvoked, true, "a forbidden dependency must not block the treatment from executing");
  assert.deepEqual(commands.map((c) => c.phase), ["setup", "teardown"]);
  const environmentDetail = (result.outcome.detail as Record<string, unknown>)?.environment as Array<Record<string, unknown>>;
  assert.equal(environmentDetail?.length, 1);
  assert.equal(environmentDetail?.[0]?.name, "github-api");
  assert.equal(environmentDetail?.[0]?.mode, "forbidden");
  assert.deepEqual(environmentDetail?.[0]?.expected, { errors: ["403 forbidden"] });
});

test("runCell: a simulated environment dependency runs its declared setup before, and teardown after, the treatment", async () => {
  const commands: Array<{ command: string; phase: string }> = [];
  let harnessInvokedAt = -1;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { harnessInvokedAt = commands.length; return successResult(); },
    runEnvironmentCommand: async (args) => {
      commands.push({ command: args.command, phase: args.phase });
      return { ok: true };
    },
  };
  const fixture = makeFixture("f1", "review", [
    envDep({ name: "github-api", mode: "simulated", setup: "seed fixtures.json", teardown: "rm fixtures.json" }),
  ]);
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.deepEqual(commands.map((c) => c.phase), ["setup", "teardown"]);
  assert.equal(commands[0].command, "seed fixtures.json");
  assert.equal(commands[1].command, "rm fixtures.json");
  assert.equal(harnessInvokedAt, 1, "the harness must run only after the simulated dependency's setup completes");
});

test("runCell: a simulated dependency's setup failure classifies as infra_error and never invokes the harness", async () => {
  let harnessInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
    runEnvironmentCommand: async () => ({ ok: false, error: "seed script exited 1" }),
  };
  const fixture = makeFixture("f1", "review", [envDep({ name: "github-api", mode: "simulated" })]);
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /seed script exited 1/);
  assert.equal(harnessInvoked, false);
});

test("runCell: a simulated dependency's setup shelling out to gh is refused by the real default runner — no injected fake", async () => {
  // Exercises `defaultRunEnvironmentCommand` for real (deps.runEnvironmentCommand
  // is intentionally omitted) — review 2 finding dc817cec: a fixture-declared
  // setup/teardown must never be able to shell out to GitHub-write or
  // network tooling, even without a test double standing in for it.
  let harnessInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
  };
  const fixture = makeFixture("f1", "review", [
    envDep({ name: "github-api", mode: "simulated", setup: "gh issue create --title x --body y" }),
  ]);
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /gh/);
  assert.match(result.outcome.error ?? "", /not permitted/);
  assert.equal(harnessInvoked, false, "a denied setup command must block the treatment, the same as any other setup failure");
});

// ---------------------------------------------------------------------------
// #607 eval-agent-isolation-boundary — eval agent contract install/restore,
// process-level command boundary wiring, and the declared sandbox mode.
// ---------------------------------------------------------------------------

test("runCell: installs the eval agent contract before the first harness invocation, and restores it after", async () => {
  const agentsMdContent = new Map<string, string>();
  let contentSeenByHarness: string | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    contractIO: {
      readFile: (p) => (p.endsWith("AGENTS.md") ? (agentsMdContent.get(p) ?? "prior agents content") : null),
      writeFile: (p, c) => { agentsMdContent.set(p, c); },
      removeFile: (p) => { agentsMdContent.delete(p); },
    },
    invokeHarness: async () => {
      // Snapshot the AGENTS.md content the harness would actually see —
      // must already be the contract, not the repo's prior content.
      contentSeenByHarness = [...agentsMdContent.values()][0];
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.match(contentSeenByHarness ?? "", /Evaluation cell — root instruction contract/);
  // After the cell completes, the path must be restored to its prior content.
  assert.deepEqual([...agentsMdContent.values()], ["prior agents content"]);
});

test("runCell: restores each root-instruction path's prior content (or removes it if none existed)", async () => {
  const writes: Array<{ path: string; content: string }> = [];
  const removed: string[] = [];
  let phase: "install" | "restore" = "install";
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    contractIO: {
      readFile: (p) => (p.endsWith("AGENTS.md") ? "prior agents content" : null),
      writeFile: (p, c) => {
        writes.push({ path: p, content: c });
      },
      removeFile: (p) => {
        removed.push(p);
      },
    },
    invokeHarness: async () => {
      phase = "restore";
      return successResult();
    },
  };
  await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(phase, "restore");
  const agentsWrites = writes.filter((w) => w.path.endsWith("AGENTS.md"));
  assert.equal(agentsWrites[agentsWrites.length - 1].content, "prior agents content", "AGENTS.md must be restored to its prior content");
  assert.ok(removed.some((p) => p.endsWith("CLAUDE.md")), "CLAUDE.md had no prior content and must be removed on restore");
});

test("defaultContractIO.readFile: a genuinely-absent file is null, but a non-ENOENT read failure (EISDIR) propagates — never mistaken for absence (finding e3e72127)", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "eval-contract-io-read-"));
  try {
    // A missing file is "no prior content".
    assert.equal(defaultContractIO.readFile(nodePath.join(dir, "absent.md")), null);
    // Reading a *directory* fails with EISDIR (not ENOENT) — this MUST throw, not
    // return null. Pre-fix it returned null, so restore would have deleted the
    // "absent" path, destroying content it merely could not read.
    assert.throws(() => defaultContractIO.readFile(dir), (err: NodeJS.ErrnoException) => err.code !== "ENOENT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultContractIO.removeFile: an already-absent file is a no-op, but a non-ENOENT unlink failure propagates — never silently swallowed (finding e3e72127)", () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "eval-contract-io-remove-"));
  try {
    // Removing an absent file is a no-op (restoring "no prior file").
    assert.doesNotThrow(() => defaultContractIO.removeFile(nodePath.join(dir, "absent.md")));
    // Unlinking a non-empty directory fails with EISDIR/EPERM (not ENOENT) — this
    // MUST throw so it surfaces as a restore_failure, not be swallowed as success.
    fs.writeFileSync(nodePath.join(dir, "child.txt"), "x");
    assert.throws(() => defaultContractIO.removeFile(dir), (err: NodeJS.ErrnoException) => err.code !== "ENOENT");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCell: a partial contract install (a later path's write fails) still restores the already-modified earlier path (finding e3e72127)", async () => {
  // EVAL_AGENT_CONTRACT_PATHS install order is ["AGENTS.md", "CLAUDE.md"]. AGENTS.md
  // is written successfully; CLAUDE.md's write throws. Pre-fix, installEvalContract
  // discarded the captured prior on failure, so finish() had nothing to restore and
  // AGENTS.md was left holding the contract text. The fix retains the partial prior.
  const content = new Map<string, string>();
  let harnessInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    contractIO: {
      readFile: (p) => (p.endsWith("AGENTS.md") ? "prior agents content" : null),
      writeFile: (p, c) => {
        if (p.endsWith("CLAUDE.md")) throw new Error("disk full");
        content.set(p, c);
      },
      removeFile: (p) => { content.delete(p); },
    },
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.equal(harnessInvoked, false, "a failed install never invokes the harness");
  const agentsEntry = [...content.entries()].find(([p]) => p.endsWith("AGENTS.md"));
  assert.ok(agentsEntry, "AGENTS.md was written during the partial install and must still be present after restore");
  assert.equal(agentsEntry[1], "prior agents content", "the already-modified AGENTS.md must be restored to its prior content, not left holding the contract");
});

test("runCell: contract installation failure is an infra_error and the harness is never invoked", async () => {
  let harnessInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    contractIO: {
      readFile: () => null,
      writeFile: () => { throw new Error("disk full"); },
      removeFile: () => {},
    },
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /disk full/);
  assert.equal(harnessInvoked, false);
});

test("runCell: contract is restored even after a harness timeout", async () => {
  const removed: string[] = [];
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    contractIO: {
      readFile: () => null,
      writeFile: () => {},
      removeFile: (p) => { removed.push(p); },
    },
    invokeHarness: async () => ({ success: false, timed_out: true, exit_code: -1, stdout: "", stderr: "", duration: 60 }),
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "timeout");
  assert.equal(removed.length, 2, "both root-instruction paths must be restored even after a timeout");
});

test("runCell: contract paths never appear in changed_paths, even if the real diff would include them", async () => {
  const fixture = validateFixture(
    {
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      allowed_change_paths: ["core/scripts/gh.ts"],
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
    invokeHarness: async () => successResult(),
    getChangedPaths: async () => ["core/scripts/gh.ts", "AGENTS.md", "CLAUDE.md"],
  };
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.deepEqual(result.outcome.detail?.changed_paths, ["core/scripts/gh.ts"]);
});

test("runCell: installs the process-level command boundary shim before the first harness invocation", async () => {
  let shimInstalledFor: string | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    installBoundaryShim: (worktreeDir) => { shimInstalledFor = worktreeDir; return `${worktreeDir}/.shim`; },
    invokeHarness: async () => {
      assert.ok(shimInstalledFor, "the boundary shim must be installed before the harness is invoked");
      return successResult();
    },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});

test("runCell: boundary shim installation failure is an infra_error and the harness is never invoked", async () => {
  let harnessInvoked = false;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    installBoundaryShim: () => { throw new Error("could not write shim"); },
    invokeHarness: async () => { harnessInvoked = true; return successResult(); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "infra_error");
  assert.match(result.outcome.error ?? "", /could not write shim/);
  assert.equal(harnessInvoked, false);
});

test("runCell: a process-boundary denial is surfaced as boundaryEvidence and does not change result_class", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
    readBoundaryDenials: () => [
      { command: "git", argv: ["worktree", "add", "../nested"], category: "nested-worktree", at: "2026-01-01T00:00:00.000Z" },
    ],
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.boundaryEvidence?.denials.length, 1);
  assert.equal(result.boundaryEvidence?.denials[0].category, "nested-worktree");
});

test("runCell: a process-boundary denial is recorded on the trajectory's diagnostic actions list, not just boundaryEvidence", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => {
      await assert.rejects(() => args.gh.addLabel(1, "pipeline:ready-to-deploy"));
      return successResult();
    },
    readBoundaryDenials: () => [
      { command: "git", argv: ["worktree", "add", "../nested"], category: "nested-worktree", at: "2026-01-01T00:00:00.000Z" },
    ],
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.ok(
    result.trajectory.actions.some((a) => a.includes("nested-worktree")),
    "the process-boundary denial must be recorded on the trajectory's diagnostic actions list",
  );
  assert.ok(
    result.trajectory.actions.some((a) => a.includes("addLabel")),
    "the gh-surface refusal must be recorded on the trajectory's diagnostic actions list",
  );
});

test("runCell: no denials and no gh refusals → boundaryEvidence is absent, not an empty object", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
    readBoundaryDenials: () => [],
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.boundaryEvidence, undefined);
});

test("runCell: a gh refusal reaches boundaryEvidence.gh_refusals alongside any process denials", async () => {
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
  assert.equal(result.boundaryEvidence?.gh_refusals.length, 1);
  assert.equal(result.boundaryEvidence?.gh_refusals[0].operation, "addLabel");
});

test("runCell: a boundary-evidence collection failure is reported distinctly, never as 'no denials'", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
    readBoundaryDenials: () => { throw new Error("denial log unreadable"); },
  };
  const result = await runCell(FAKE_CFG, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.equal(result.boundaryEvidence, undefined);
  assert.match(result.boundaryEvidenceError ?? "", /denial log unreadable/);
});

test("runCell: the manifest's resolved sandbox_mode reaches the harness invocation and effectiveConfig", async () => {
  const manifest = validateManifest(
    {
      schema_version: 1,
      experiment_id: "exp1",
      fixture_ids: ["f1"],
      mode: "review",
      treatments: { harness: ["codex"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 60,
      output_dir: ".agent-pipeline/evals",
      sandbox_mode: "external-bypass",
    },
    new Set(["f1"]),
  );
  let seenSandboxMode: string | undefined;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async (args) => { seenSandboxMode = args.sandboxMode; return successResult(); },
  };
  const result = await runCell(FAKE_CFG, makeCell({ treatment: { harness: "codex" } }), makeFixture(), manifest, deps);
  assert.equal(seenSandboxMode, "external-bypass");
  assert.equal(result.effectiveConfig.sandbox_mode, "external-bypass");
});

test("runCell: a treatment shelling out to a nested worktree/pipeline advance is denied by the real default boundary — no injected fake", async () => {
  // Exercises the real installBoundaryShim + boundaryEnv + readBoundaryDenials
  // path end-to-end — a fake standing in for the boundary itself would prove
  // nothing about whether a real child process is actually denied. Uses a
  // real, disposable tmp directory as the cell worktree (rather than the
  // shared FAKE_CFG's nonexistent path) since a real `git`/`pipeline` spawn
  // needs a real cwd to run in; contractIO stays a harmless in-memory fake
  // since contract behavior is not this test's focus.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const execFileAsync = promisify(execFile);
  const tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-eval-boundary-"));
  const cfg = { repo_dir: tmpRepoDir } as unknown as import("../scripts/types.ts").PipelineConfig;
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => { fs.mkdirSync(o.path, { recursive: true }); return o; },
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    installBoundaryShim: undefined,
    readBoundaryDenials: undefined,
    invokeHarness: async (args) => {
      let denied = false;
      try {
        await execFileAsync("git", ["worktree", "add", "../nested"], { cwd: args.worktreeDir, env: args.env });
      } catch {
        denied = true;
      }
      assert.equal(denied, true, "git worktree add must be denied inside the cell");
      try {
        await execFileAsync("pipeline", ["advance", "607"], { cwd: args.worktreeDir, env: args.env });
        assert.fail("pipeline advance must be denied inside the cell");
      } catch {
        // expected
      }
      return successResult();
    },
  };
  const result = await runCell(cfg, makeCell(), makeFixture(), MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
  assert.ok(result.boundaryEvidence, "the denied attempts must be recorded as boundary evidence");
  const categories = result.boundaryEvidence?.denials.map((d) => d.category).sort();
  assert.deepEqual(categories, ["nested-worktree", "pipeline-advance"]);
});

test("runCell: a live environment dependency does not block or require a simulated stand-in", async () => {
  const deps: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => successResult(),
  };
  const fixture = makeFixture("f1", "review", [envDep({ name: "github-api", mode: "live" })]);
  const result = await runCell(FAKE_CFG, makeCell(), fixture, MANIFEST, deps);
  assert.equal(result.outcome.result_class, "completed");
});
