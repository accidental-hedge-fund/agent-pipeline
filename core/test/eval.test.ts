// Eval-gate stage (#12) unit tests.
//
// All side-effecting calls (GitHub API, command execution, worktree lookup)
// are injected as stubs via EvalDeps. No network or filesystem operations needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceEval, truncate, type EvalDeps, type EvalRunResult } from "../scripts/stages/eval.ts";
import { readBundle } from "../scripts/evidence-bundle.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";
import type { HarnessResult } from "../scripts/harness.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface CallLog {
  transitions: Array<{ from: string; to: string }>;
  silentTransitions: Array<{ from: string; to: string }>;
  blocked: Array<{ reason: string; kind?: string }>;
  comments: string[];
}

function makeCallLog(): CallLog {
  return { transitions: [], silentTransitions: [], blocked: [], comments: [] };
}

function baseCfg(overrides: Partial<PipelineConfig["eval_gate"]> = {}, shipchecKEnabled = false): PipelineConfig {
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
    shipcheck_gate: {
      enabled: shipchecKEnabled,
      mode: "advisory",
      max_rounds: 1,
      rubric_path: ".github/shipcheck-rubric.md",
      block_on_partial: false,
    },
    review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3 },
    doctor: { runOnStart: false, failFast: false },
    format_gate: [],
    harness_sandbox: false,
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
    setBlocked: async (_c, _n, reason, _stage, kind) => { log.blocked.push({ reason, kind }); },
    postComment: async (_c, _n, body) => { log.comments.push(body); },
    // No PR / no review history by default (#372 review-2 finding 1): a pass
    // never routes to pre-merge unless a test explicitly wires up a matching
    // eval-fix commit via `pendingReviewFixDeps`.
    getGhActor: async () => null,
    getIssueDetail: async () => ({ comments: [] }),
    getPrForIssue: async () => null,
    getPrCommits: async () => [],
  };
}

/**
 * Deps simulating an unreviewed eval-fix commit sitting on the PR: a trusted
 * review comment recorded `reviewedSha`, and a later commit matching the
 * prescribed eval-fix message for `issueNumber` landed after it. Used to
 * exercise the durable (GitHub-state-derived) pending-review routing without
 * relying on an in-memory flag (#372 review-2 finding 1).
 */
function pendingReviewFixDeps(issueNumber: number): Pick<EvalDeps, "getGhActor" | "getIssueDetail" | "getPrForIssue" | "getPrCommits"> {
  const reviewedSha = "a".repeat(40);
  return {
    getGhActor: async () => "pipeline-bot",
    getIssueDetail: async () => ({
      comments: [
        { author: "pipeline-bot", body: `## Review 2 — approve\n\n<!-- reviewed-sha: ${reviewedSha} -->` },
      ],
    }),
    getPrForIssue: async () => 900,
    getPrCommits: async () => [
      { oid: reviewedSha, messageHeadline: "feat: implement thing" },
      { oid: "b".repeat(40), messageHeadline: `fix: resolve eval-gate failures (#${issueNumber})` },
    ],
  };
}

// ---------------------------------------------------------------------------
// Eval-fix round fixtures (#372): a "clean" set of fix-round deps simulates a
// harness invocation that commits a well-formed fix and pushes successfully,
// so gate-mode multi-attempt tests can exercise the fix loop without spawning
// any real harness/git/network.
// ---------------------------------------------------------------------------

function okInvoke(): HarnessResult {
  return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
}

/** Deps for an eval-fix round that always succeeds: HEAD advances on every
 *  invoke call (simulating a harness commit), the worktree is clean, and the
 *  commit format / push checks pass. */
function cleanFixDeps(): Pick<
  EvalDeps,
  "invoke" | "gitHead" | "gitDirty" | "gitPush" | "gitCommitMessages" | "verifyEvalFix" | "salvage"
> {
  let head = 0;
  return {
    invoke: async () => okInvoke(),
    gitHead: async () => `head-${head++}`,
    gitDirty: async () => false,
    gitPush: async () => ({ code: 0, stderr: "" }),
    gitCommitMessages: async () => [],
    verifyEvalFix: async () => ({ ok: true }),
    salvage: async () => ({ salvaged: true }),
  };
}

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

// #372 review-2 finding 1: the durable pending-review derivation must fail
// closed (route to pre-merge) rather than silently advancing when GitHub
// state can't be read — proving it does not just pass because the real
// `getPrCommits`/`getGhActor` happen to be reachable (no lingering reliance
// on local gh auth being active).
test("eval-gate: exit 0 + gate mode + PR commit lookup fails → fails closed, routes to pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("evals: 10/10 passed")]);
  deps.getPrForIssue = async () => 900;
  deps.getGhActor = async () => "pipeline-bot";
  deps.getIssueDetail = async () => ({
    comments: [{ author: "pipeline-bot", body: `## Review 2 — approve\n\n<!-- reviewed-sha: ${"a".repeat(40)} -->` }],
  });
  deps.getPrCommits = async () => { throw new Error("network error: gh not authenticated"); };

  const out = await advanceEval(cfg, 43, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "pre-merge", "an unverifiable review state must fail closed to pre-merge, not advance directly");
});

test("eval-gate: non-zero exit + gate mode → setBlocked, no forward transition", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("3 evals failed")]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 44, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "comment must say FAIL");
  assert.equal(invokeCalled, 0, "max_attempts: 1 must perform no fix round — first failure blocks");
});

test("eval-gate: non-zero exit + advisory mode → comment posted, transitions to ready-to-deploy", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("1 eval failed")]);
  const appended: string[] = [];

  const out = await advanceEval(cfg, 45, { runDir: "/runs/45", runStoreDeps: appendOnlyRunStore(appended) }, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "advisory comment must say FAIL");
  assert.ok(log.comments[0].includes("advisory"), "advisory comment must include mode");
  const events = appendedEvents(appended);
  assert.deepEqual(
    events
      .filter((event) => event.type === "gate_result")
      .map((event) => ({ type: event.type, gate: event.gate, result: event.result, mode: event.mode })),
    [{ type: "gate_result", gate: "eval-gate", result: "fail", mode: "advisory" }],
  );
  const accounting = events.find((event) => event.type === "stage_accounting");
  assert.ok(accounting, "eval subprocess should emit stage accounting when runDir is provided");
  assert.equal(accounting.stage, "eval-gate");
  assert.equal(accounting.harness, "eval-gate");
  assert.equal(accounting.outcome, "failure");
  assert.equal(accounting.blocker_kind, "eval-gate-failed");
  assert.equal(accounting.cost_source, "unknown");
  assert.equal(accounting.cost_usd, null);
});

// #372: a gate-mode retry is now preceded by a fix round rather than a plain
// re-run of the same command.
// Review 1 finding 1 (#372): a pass reached after a pushed eval-fix commit
// must route back through pre-merge for review, not straight to the next
// stage — the fix commit is a developer commit the review-SHA gate hasn't
// seen yet. This regression test fails against the pre-fix behavior, which
// advanced directly to ready-to-deploy.
test("eval-gate: gate-mode fail with budget remaining → fix round invoked → re-run passes → routes to pre-merge for review", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;
  let invokeCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  Object.assign(deps, pendingReviewFixDeps(46));
  deps.runEval = async () => {
    runCalled++;
    return runCalled === 1 ? failResult("attempt 1 failed") : passResult("attempt 2 passed");
  };
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(runCalled, 2, "must run the eval command twice");
  assert.equal(invokeCalled, 1, "must invoke the fix harness exactly once between the two eval runs");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "pre-merge", "an eval-fix commit must clear pre-merge review before ready-to-deploy");
  assert.equal(log.blocked.length, 0);
  assert.ok(log.comments[0].includes("PASS"));
});

// Regression test for #372 review-2 finding 1: an in-memory "fix round ran
// this invocation" flag is lost across a crash/interruption between a
// fix-round push and the transition call, or a later invocation resuming at
// eval-gate. This test simulates exactly that: NO fix round runs in this
// invocation (first-attempt pass, invoke never called), but a prior
// invocation already pushed an unreviewed eval-fix commit onto the PR. The
// pass must still route to pre-merge for review, not advance directly — the
// pre-fix (in-memory-flag) behavior would incorrectly advance straight to
// ready-to-deploy here since `fixCommitLanded` would be false.
test("eval-gate: first-attempt pass with an unreviewed eval-fix commit already on the PR (from a prior invocation) → routes to pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let invokeCalled = 0;

  const deps = makeDeps(log, [passResult("attempt 1 passed")]);
  Object.assign(deps, pendingReviewFixDeps(46));
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(invokeCalled, 0, "no fix round should run in this invocation");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "pre-merge", "an unreviewed eval-fix commit from a prior invocation must still route to pre-merge");
  assert.equal(log.blocked.length, 0);
});

// #372 pre-merge delta review, key 1469c9cd (part a): a fix commit pushed in
// THIS invocation must route to pre-merge unconditionally — even when every
// GitHub lookup in the durable re-derivation yields nothing (no PR, no actor,
// no comments). The pre-fix behavior advanced directly because the durable
// check returned false on the no-PR path before considering the just-pushed
// fix commit.
test("eval-gate: same-invocation eval-fix push + durable lookups yield nothing → still routes to pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  // makeDeps defaults: getPrForIssue → null, getGhActor → null, no comments.
  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => {
    runCalled++;
    return runCalled === 1 ? failResult("attempt 1 failed") : passResult("attempt 2 passed");
  };

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(runCalled, 2, "fix round ran between the two eval runs");
  assert.equal(out.advanced, true);
  assert.equal(
    (out as { to: string }).to,
    "pre-merge",
    "a just-pushed eval-fix commit must route to pre-merge even when GitHub state is unreadable",
  );
});

// #372 pre-merge delta review, key 1469c9cd (part b): an eval-fix commit
// present on the PR with NO trusted reviewed-SHA comment (e.g. the actor
// lookup fails, or review comments are missing) must be treated as pending
// review — the pre-fix behavior returned false ("no review has ever run —
// nothing to gate against") and advanced the unreviewed fix commit.
test("eval-gate: eval-fix commit on PR + no trusted reviewed-SHA state → treated as pending, routes to pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });

  const deps = makeDeps(log, [passResult("attempt 1 passed")]);
  deps.getPrForIssue = async () => 900;
  deps.getGhActor = async () => null; // no trusted actor → no trusted comments
  deps.getPrCommits = async () => [
    { oid: "a".repeat(40), messageHeadline: "feat: implement thing" },
    { oid: "b".repeat(40), messageHeadline: "fix: resolve eval-gate failures (#46)" },
  ];

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(
    (out as { to: string }).to,
    "pre-merge",
    "an eval-fix commit with unverifiable review state must fail closed to pre-merge",
  );
});

// #372 pre-merge delta review, key 816dc89f: advisory-mode passes advance to
// the configured next stage unchanged — the pending-review routing is a
// gate-mode concern (fix rounds never run in advisory mode). The pre-fix
// behavior rerouted an advisory pass to pre-merge when an old eval-fix
// commit was detected on the PR.
test("eval-gate: advisory-mode pass with an old eval-fix commit on the PR → advances to next stage, not pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });

  const deps = makeDeps(log, [passResult("attempt 1 passed")]);
  Object.assign(deps, pendingReviewFixDeps(46));

  const out = await advanceEval(cfg, 46, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(
    (out as { to: string }).to,
    "ready-to-deploy",
    "advisory passes must advance directly regardless of eval-fix history (spec: advisory behavior unchanged)",
  );
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

test("eval-gate: gate-mode fail → fix rounds exhausted (max_attempts reached) → setBlocked with final output", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 3 });
  let runCalled = 0;
  let invokeCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => { runCalled++; return failResult(`always fails (run ${runCalled})`); };
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 48, {}, deps);

  assert.equal(runCalled, 3, "must attempt max_attempts times");
  assert.equal(invokeCalled, 2, "must perform exactly max_attempts - 1 fix rounds");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "eval-gate-failed");
  assert.ok(log.blocked[0].reason.includes("always fails (run 3)"), "block reason must surface the final eval output");
});

// ---------------------------------------------------------------------------
// Eval-fix round failure paths (#372): a failed fix round blocks the item and
// never re-runs the eval command (no partial push).
// ---------------------------------------------------------------------------

test("eval-gate: eval-fix round → harness error → blocks (harness-failure), eval NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => { runCalled++; return failResult("evals failed"); };
  deps.invoke = async () => ({
    success: false, stdout: "", stderr: "boom", exit_code: 1, duration: 3, timed_out: false,
  });

  const out = await advanceEval(cfg, 700, {}, deps);

  assert.equal(runCalled, 1, "the eval command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
});

test("eval-gate: eval-fix round → harness produces no new commit → blocks (harness-failure), eval NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => { runCalled++; return failResult("evals failed"); };
  deps.invoke = async () => okInvoke();
  deps.gitHead = async () => "same-sha"; // HEAD never advances: no harness commit
  deps.gitDirty = async () => false; // and nothing left uncommitted to salvage
  deps.salvage = async () => ({ salvaged: false });

  const out = await advanceEval(cfg, 701, {}, deps);

  assert.equal(runCalled, 1, "the eval command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.ok(log.blocked[0].reason.includes("no new commits"));
});

test("eval-gate (#521): eval-fix round → salvage attempt fails → its failure reason is threaded into the block reason", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => failResult("evals failed");
  deps.invoke = async () => okInvoke();
  deps.gitHead = async () => "same-sha"; // HEAD never advances: no harness commit
  deps.gitDirty = async () => false;
  deps.salvage = async () => ({ salvaged: false, failureReason: "git add failed: ignored nested paths" });

  const out = await advanceEval(cfg, 701, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.ok(log.blocked[0].reason.includes("no new commits"));
  assert.ok(
    log.blocked[0].reason.includes("Salvage of uncommitted work also failed: git add failed: ignored nested paths"),
    `blocked reason must disclose the salvage failure; got: ${log.blocked[0].reason}`,
  );
});

test("eval-gate: eval-fix round → worktree left dirty after fix → blocks (harness-failure), eval NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => { runCalled++; return failResult("evals failed"); };
  deps.invoke = async () => okInvoke();
  deps.gitDirty = async () => true; // fix committed but left leftover uncommitted changes

  const out = await advanceEval(cfg, 702, {}, deps);

  assert.equal(runCalled, 1, "the eval command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.ok(log.blocked[0].reason.includes("uncommitted"));
});

test("eval-gate: eval-fix round → push fails → blocks (push-failed), eval NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runEval = async () => { runCalled++; return failResult("evals failed"); };
  deps.invoke = async () => okInvoke();
  deps.gitPush = async () => ({ code: 1, stderr: "remote rejected" });

  const out = await advanceEval(cfg, 703, {}, deps);

  assert.equal(runCalled, 1, "the eval command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "push-failed");
  assert.ok(log.blocked[0].reason.includes("remote rejected"));
});

// ---------------------------------------------------------------------------
// Eval-fix prompt context (#372): the prompt names the failed gate, the
// configured command, and includes the bounded eval output.
// ---------------------------------------------------------------------------

test("eval-gate: eval-fix prompt embeds the gate name, command, and bounded output", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2, command: "pnpm run evals:ci" });
  let capturedPrompt = "";

  const deps = makeDeps(log, [failResult("assertion X failed"), passResult()]);
  Object.assign(deps, cleanFixDeps());
  deps.invoke = async (_harness, _wtPath, prompt) => {
    capturedPrompt = prompt;
    return okInvoke();
  };

  await advanceEval(cfg, 704, {}, deps);

  assert.ok(capturedPrompt.includes("eval-gate"), "prompt must identify the failed gate");
  assert.ok(capturedPrompt.includes("pnpm run evals:ci"), "prompt must include the configured command");
  assert.ok(capturedPrompt.includes("assertion X failed"), "prompt must include the eval output");
});

test("eval-gate: timeout in gate mode → blocked, no fix round even with budget remaining", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  const deps = makeDeps(log, [timeoutResult()]);
  const appended: string[] = [];
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 49, { runDir: "/runs/49", runStoreDeps: appendOnlyRunStore(appended) }, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1, "timeout must block in gate mode");
  assert.ok(log.comments[0].includes("FAIL"), "timeout comment must say FAIL");
  assert.equal(invokeCalled, 0, "a timeout must never route to a fix round");
  const accounting = appendedEvents(appended).find((event) => event.type === "stage_accounting");
  assert.equal(accounting?.outcome, "timeout");
  assert.equal(accounting?.blocker_kind, "harness-failure");
});

// Regression test for Finding 1: timeouts must ALWAYS block, even in advisory mode.
test("eval-gate: timeout in advisory mode → always blocks (tooling failure, not harness failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  const deps = makeDeps(log, [timeoutResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 491, {}, deps);

  assert.equal(out.advanced, false, "timeout must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on timeout");
  assert.equal(invokeCalled, 0, "a timeout must never route to a fix round");
});

test("eval-gate: spawn error in gate mode → blocked, no fix round even with budget remaining", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  const deps = makeDeps(log, [spawnErrorResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 4921, {}, deps);

  assert.equal(out.advanced, false, "spawn error must block in gate mode");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.equal(invokeCalled, 0, "a spawn error must never route to a fix round");
});

// Regression test for Finding 1: spawn/runner errors must ALWAYS block, even in advisory mode.
test("eval-gate: spawn error in advisory mode → always blocks (tooling failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  const deps = makeDeps(log, [spawnErrorResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 492, {}, deps);

  assert.equal(out.advanced, false, "spawn error must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on spawn error");
  assert.equal(invokeCalled, 0, "a spawn error must never route to a fix round");
});

// Regression test for Finding 1: ordinary eval failure in advisory mode still advances.
test("eval-gate: ordinary harness failure in advisory mode → still advances, no fix round", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("2 evals failed")]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceEval(cfg, 493, {}, deps);

  assert.equal(out.advanced, true, "ordinary eval failure in advisory mode must advance");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.transitions.length, 1);
  assert.equal(invokeCalled, 0, "advisory mode must never invoke a fix round");
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
    Object.assign(deps, cleanFixDeps());
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

// ---------------------------------------------------------------------------
// Finding 2 regression: eval-gate must route to shipcheck-gate when enabled
// ---------------------------------------------------------------------------

test("eval-gate: pass + shipcheck_gate.enabled:true → transitions to shipcheck-gate not ready-to-deploy", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 }, /* shipchecKEnabled */ true);
  const deps = makeDeps(log, [passResult("evals passed")]);

  const out = await advanceEval(cfg, 600, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "shipcheck-gate", "must route to shipcheck-gate when enabled");
  assert.equal(log.blocked.length, 0);
});

test("eval-gate: advisory fail + shipcheck_gate.enabled:true → transitions to shipcheck-gate", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 }, /* shipchecKEnabled */ true);
  const deps = makeDeps(log, [failResult("1 eval failed")]);

  const out = await advanceEval(cfg, 601, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "shipcheck-gate", "advisory fail must route to shipcheck-gate when enabled");
  assert.equal(log.blocked.length, 0);
});

test("eval-gate: disabled + shipcheck_gate.enabled:true → silent transition to shipcheck-gate", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false }, /* shipchecKEnabled */ true);
  const deps = makeDeps(log, []);

  const out = await advanceEval(cfg, 602, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "shipcheck-gate", "disabled eval must route to shipcheck-gate when enabled");
  assert.equal(log.silentTransitions[0].to, "shipcheck-gate");
  assert.equal(log.transitions.length, 0);
});

test("eval-gate: pass + shipcheck_gate.enabled:false → transitions to ready-to-deploy (unchanged behavior)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 }, /* shipchecKEnabled */ false);
  const deps = makeDeps(log, [passResult("evals passed")]);

  const out = await advanceEval(cfg, 603, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "ready-to-deploy", "must route to ready-to-deploy when shipcheck disabled");
});

// ---------------------------------------------------------------------------
// #373: truncate() must preserve the summary tail, not just the head.
// ---------------------------------------------------------------------------

test("truncate: within-limit input returned verbatim, no marker", () => {
  const s = "a".repeat(500);
  assert.equal(truncate(s, 2000), s);
});

test("truncate: exactly-at-limit input returned verbatim, no marker", () => {
  const s = "a".repeat(2000);
  assert.equal(truncate(s, 2000), s);
});

test("truncate: over-limit input keeps a summary sentinel that only appears in the final characters", () => {
  const sentinel = "SUMMARY: 3 failed, 97 passed";
  const noise = "x".repeat(5000);
  const s = `${noise}\n${sentinel}`;

  const out = truncate(s, 2000);

  assert.ok(out.includes(sentinel), "tail summary sentinel must survive truncation");
});

test("truncate: over-limit input contains a head fragment, an elision marker, and a tail fragment, within the source-character budget", () => {
  const head = "$ pnpm evals\nsetting up harness...\n";
  const middle = "x".repeat(5000);
  const tail = "\nSUMMARY: 3 failed, 97 passed";
  const s = `${head}${middle}${tail}`;

  const out = truncate(s, 2000);

  assert.ok(out.startsWith(head.slice(0, 10)), "must retain a leading head fragment");
  assert.ok(out.includes("truncated"), "must include an elision marker noting dropped content");
  assert.ok(out.endsWith(tail), "must retain the trailing tail fragment");

  // Source characters shown (excluding the marker text) must not exceed the cap.
  const markerMatch = out.match(/\[… (\d+) characters truncated …\]/);
  assert.ok(markerMatch, "marker must state how many characters were dropped");
  const dropped = Number(markerMatch![1]);
  assert.equal(dropped, s.length - 2000);
  const sourceCharsShown = s.length - dropped;
  assert.ok(sourceCharsShown <= 2000, "shown source characters must not exceed the cap");
});

// Regression: proves this test bites against the pre-#373 head-only slice(0, cap).
test("truncate: regression — a summary sentinel placed only in the final characters must not be dropped", () => {
  const sentinel = "FINAL SCORE: 42/100";
  const s = "noise ".repeat(1000) + sentinel;
  assert.ok(s.length > 2000, "fixture must exceed the cap to exercise truncation");

  const out = truncate(s, 2000);

  assert.ok(out.includes(sentinel));
  // The old implementation was `s.slice(0, cap) + "\n\n[…output truncated]"`, which
  // would never include a sentinel located only in the final characters.
  const oldBehavior = s.slice(0, 2000) + "\n\n[…output truncated]";
  assert.ok(!oldBehavior.includes(sentinel), "sanity check: old head-only slice must not contain the tail sentinel");
});
