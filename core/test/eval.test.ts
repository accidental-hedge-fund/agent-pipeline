// Eval-gate stage (#12) unit tests.
//
// All side-effecting calls (GitHub API, command execution, worktree lookup)
// are injected as stubs via EvalDeps. No network or filesystem operations needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceEval, type EvalDeps, type EvalRunResult } from "../scripts/stages/eval.ts";
import { readBundle } from "../scripts/evidence-bundle.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface CallLog {
  transitions: Array<{ from: string; to: string }>;
  silentTransitions: Array<{ from: string; to: string }>;
  blocked: Array<{ reason: string }>;
  comments: string[];
}

function makeCallLog(): CallLog {
  return { transitions: [], silentTransitions: [], blocked: [], comments: [] };
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
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
    eval_gate: { enabled: true, command: "pnpm evals", mode: "gate", timeout: 300, max_attempts: 1, ...overrides },
  };
}

type RunResult = EvalRunResult;

function passResult(output = "All evals passed"): RunResult {
  return { passed: true, timedOut: false, spawnError: false, output, durationSec: 1.2 };
}
function failResult(output = "2 evals failed"): RunResult {
  return { passed: false, timedOut: false, spawnError: false, output, durationSec: 1.5 };
}
function timeoutResult(): RunResult {
  return { passed: false, timedOut: true, spawnError: false, output: "[eval-gate timed out after 300s]", durationSec: 300 };
}
function spawnErrorResult(output = "[harness eval-gate] spawn error: command not found"): RunResult {
  return { passed: false, timedOut: false, spawnError: true, output, durationSec: 0 };
}

function makeDeps(log: CallLog, results: RunResult[], worktree: { path: string; slug: string } | null = { path: "/tmp/wt", slug: "42-slug" }): EvalDeps {
  let call = 0;
  return {
    runEval: async () => results[Math.min(call++, results.length - 1)],
    getForIssue: async () => worktree,
    transition: async (_c, _n, from, to) => { log.transitions.push({ from, to }); },
    silentTransition: async (_c, _n, from, to) => { log.silentTransitions.push({ from, to }); },
    setBlocked: async (_c, _n, reason) => { log.blocked.push({ reason }); },
    postComment: async (_c, _n, body) => { log.comments.push(body); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("eval-gate: skip path — disabled config → silent label swap to ready-to-deploy, no comment, no runEval", async () => {
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
  assert.equal(log.transitions.length, 0, "disabled path must not call transition (which posts a comment)");
  assert.equal(log.silentTransitions.length, 1, "disabled path must call silentTransition for label-only swap");
  assert.equal(log.silentTransitions[0].from, "eval-gate");
  assert.equal(log.silentTransitions[0].to, "ready-to-deploy");
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

// Regression test for Finding 1: advisory mode must advance even when retries are exhausted.
// Previously the code blocked unconditionally when maxAttempts > 1, violating the advisory contract.
test("eval-gate: retries exhausted + advisory mode → advances to ready-to-deploy (never blocks)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  deps.runEval = async () => { runCalled++; return failResult("always fails"); };

  const out = await advanceEval(cfg, 47, {}, deps);

  assert.equal(runCalled, 2, "must attempt max_attempts times");
  assert.equal(out.advanced, true, "advisory must advance even after retries exhausted");
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0, "advisory must never block");
  assert.equal(log.transitions.length, 1);
});

// Also verify advisory advances with the default max_attempts (2) configuration.
test("eval-gate: retries exhausted + advisory mode + default max_attempts → advances", async () => {
  const log = makeCallLog();
  // Default max_attempts is 2 per DEFAULT_CONFIG — this was the failing scenario.
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  const deps = makeDeps(log, [failResult(), failResult()]);

  const out = await advanceEval(cfg, 471, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(log.blocked.length, 0);
});

test("eval-gate: retries exhausted + gate mode → setBlocked", async () => {
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

test("eval-gate: timeout in gate mode → blocked", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [timeoutResult()]);

  const out = await advanceEval(cfg, 49, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1, "timeout must block in gate mode");
  assert.ok(log.comments[0].includes("FAIL"), "timeout comment must say FAIL");
});

// Regression test for Finding 1: timeouts must ALWAYS block, even in advisory mode.
test("eval-gate: timeout in advisory mode → always blocks (tooling failure, not harness failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [timeoutResult()]);

  const out = await advanceEval(cfg, 491, {}, deps);

  assert.equal(out.advanced, false, "timeout must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on timeout");
});

// Regression test for Finding 1: spawn/runner errors must ALWAYS block, even in advisory mode.
test("eval-gate: spawn error in advisory mode → always blocks (tooling failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [spawnErrorResult()]);

  const out = await advanceEval(cfg, 492, {}, deps);

  assert.equal(out.advanced, false, "spawn error must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on spawn error");
});

// Regression test for Finding 1: ordinary eval failure in advisory mode still advances.
test("eval-gate: ordinary harness failure in advisory mode → still advances", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("2 evals failed")]);

  const out = await advanceEval(cfg, 493, {}, deps);

  assert.equal(out.advanced, true, "ordinary eval failure in advisory mode must advance");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.transitions.length, 1);
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

// Regression tests for Finding 2: dry-run must not mutate GitHub state even
// for disabled eval or missing command.
test("eval-gate: dry-run + disabled eval → no GitHub writes", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false });
  const deps = makeDeps(log, []);

  const out = await advanceEval(cfg, 51, { dryRun: true }, deps);

  assert.equal(out.advanced, true);
  assert.equal(log.transitions.length, 0, "dry-run must not call transition");
  assert.equal(log.blocked.length, 0, "dry-run must not call setBlocked");
  assert.equal(log.comments.length, 0, "dry-run must not post comments");
});

test("eval-gate: dry-run + no command configured → no GitHub writes", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: undefined });
  const deps = makeDeps(log, []);

  const out = await advanceEval(cfg, 52, { dryRun: true }, deps);

  assert.equal(out.advanced, true);
  assert.equal(log.transitions.length, 0, "dry-run must not call transition");
  assert.equal(log.blocked.length, 0, "dry-run must not call setBlocked");
  assert.equal(log.comments.length, 0, "dry-run must not post comments");
});

test("eval-gate: dry-run + enabled + command → no GitHub writes, no runEval", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: "pnpm evals" });
  let runCalled = 0;
  const deps = makeDeps(log, []);
  deps.runEval = async () => { runCalled++; return passResult(); };

  const out = await advanceEval(cfg, 53, { dryRun: true }, deps);

  assert.equal(out.advanced, true);
  assert.equal(runCalled, 0, "dry-run must not invoke runEval");
  assert.equal(log.transitions.length, 0);
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 0);
});

// ---------------------------------------------------------------------------
// Finding 6 regression: each eval retry attempt produces its own command record
// ---------------------------------------------------------------------------

test("eval-gate: each retry attempt recorded separately in evidence bundle (finding 6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eval-evidence-test-"));
  try {
    const log = makeCallLog();
    const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 3 });
    let attempt = 0;
    const deps = makeDeps(log, []);
    deps.runEval = async () => {
      attempt++;
      return attempt < 3 ? failResult(`attempt ${attempt} failed`) : passResult("attempt 3 passed");
    };

    const out = await advanceEval(cfg, 555, { stateDir: dir }, deps);

    assert.equal(out.advanced, true, "third attempt passes → should advance");

    const bundle = await readBundle(dir, 555);
    assert.ok(bundle, "evidence bundle must exist after eval run");
    const evalEntry = bundle!.stages.find((s) => s.stage === "eval-gate");
    assert.ok(evalEntry, "eval-gate stage entry must be created");
    assert.equal(evalEntry!.commands.length, 3, "three attempts must produce three command records");
    assert.equal(evalEntry!.commands[0].exitCode, 1, "attempt 1 must be recorded as failure");
    assert.equal(evalEntry!.commands[1].exitCode, 1, "attempt 2 must be recorded as failure");
    assert.equal(evalEntry!.commands[2].exitCode, 0, "attempt 3 must be recorded as success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
