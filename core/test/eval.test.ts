// Eval-gate stage (#12) unit tests.
//
// All side-effecting calls (GitHub API, command execution, worktree lookup)
// are injected as stubs via EvalDeps. No network or filesystem operations needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceEval, type EvalDeps } from "../scripts/stages/eval.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface CallLog {
  transitions: Array<{ from: string; to: string }>;
  blocked: Array<{ reason: string }>;
  comments: string[];
}

function makeCallLog(): CallLog {
  return { transitions: [], blocked: [], comments: [] };
}

function baseCfg(overrides: Partial<PipelineConfig["eval_gate"]> = {}): PipelineConfig {
  return {
    profile_name: "codex",
    invocation: "$pipeline",
    review_mode: "prompt-harness",
    marker_footer: "—",
    implementation_ready_message: "ready",
    conventions_default: "CLAUDE.md",
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_merge: false,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: true, command: "pnpm evals", mode: "gate", timeout: 300, max_attempts: 1, ...overrides },
  };
}

type RunResult = { passed: boolean; output: string; durationSec: number };

function passResult(output = "All evals passed"): RunResult {
  return { passed: true, output, durationSec: 1.2 };
}
function failResult(output = "2 evals failed"): RunResult {
  return { passed: false, output, durationSec: 1.5 };
}
function timeoutResult(): RunResult {
  return { passed: false, output: "[eval-gate timed out after 300s]", durationSec: 300 };
}

function makeDeps(log: CallLog, results: RunResult[], worktree: { path: string; slug: string } | null = { path: "/tmp/wt", slug: "42-slug" }): EvalDeps {
  let call = 0;
  return {
    runEval: async () => results[Math.min(call++, results.length - 1)],
    getForIssue: async () => worktree,
    transition: async (_c, _n, from, to) => { log.transitions.push({ from, to }); },
    setBlocked: async (_c, _n, reason) => { log.blocked.push({ reason }); },
    postComment: async (_c, _n, body) => { log.comments.push(body); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("eval-gate: skip path — disabled config → transitions to ready-to-deploy, no runEval", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false });
  let runCalled = 0;
  const deps = makeDeps(log, []);
  const origRun = deps.runEval;
  deps.runEval = async (...a) => { runCalled++; return origRun!(...a); };

  const out = await advanceEval(cfg, 42, {}, deps);

  assert.equal(runCalled, 0, "runEval must not be called when disabled");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.transitions.length, 1);
  assert.equal(log.transitions[0].from, "eval-gate");
  assert.equal(log.transitions[0].to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 0);
});

test("eval-gate: exit 0 + gate mode → transitions to ready-to-deploy", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("evals: 10/10 passed")]);

  const out = await advanceEval(cfg, 43, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("PASS"), "comment must say PASS");
});

test("eval-gate: non-zero exit + gate mode → setBlocked, no forward transition", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("3 evals failed")]);

  const out = await advanceEval(cfg, 44, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "comment must say FAIL");
});

test("eval-gate: non-zero exit + advisory mode → comment posted, transitions to ready-to-deploy", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("1 eval failed")]);

  const out = await advanceEval(cfg, 45, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "advisory comment must say FAIL");
  assert.ok(log.comments[0].includes("advisory"), "advisory comment must include mode");
});

test("eval-gate: retry on transient fail — first attempt fails, second passes → pass outcome", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  deps.runEval = async () => {
    runCalled++;
    return runCalled === 1 ? failResult("attempt 1 failed") : passResult("attempt 2 passed");
  };

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(runCalled, 2, "must attempt twice");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.ok(log.comments[0].includes("PASS"));
});

test("eval-gate: retries exhausted → setBlocked regardless of mode (advisory)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  deps.runEval = async () => { runCalled++; return failResult("always fails"); };

  const out = await advanceEval(cfg, 47, {}, deps);

  assert.equal(runCalled, 2, "must attempt max_attempts times");
  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1, "must block when retries exhausted");
  assert.equal(log.transitions.length, 0);
});

test("eval-gate: retries exhausted → setBlocked regardless of mode (gate)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 3 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  deps.runEval = async () => { runCalled++; return failResult("always fails"); };

  const out = await advanceEval(cfg, 48, {}, deps);

  assert.equal(runCalled, 3, "must attempt max_attempts times");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
});

test("eval-gate: timeout → treated as fail", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [timeoutResult()]);

  const out = await advanceEval(cfg, 49, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1, "timeout must block in gate mode");
  assert.ok(log.comments[0].includes("FAIL"), "timeout comment must say FAIL");
});

test("eval-gate: no worktree → blocked", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: "pnpm evals" });
  const deps = makeDeps(log, [passResult()], null);

  const out = await advanceEval(cfg, 50, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { reason: string }).reason, "no worktree");
  assert.equal(log.blocked.length, 1);
});
