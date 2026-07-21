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

test("runCell: review-mode findings are parsed from harness stdout into detail.findings", async () => {
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
  assert.deepEqual(result.outcome.detail?.findings, [{ file: "a.ts", severity: "high" }]);
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
