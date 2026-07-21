// Visual-gate stage (#395) unit tests.
//
// All side-effecting calls (GitHub API, command execution, worktree lookup,
// artifact fs) are injected as stubs via VisualGateDeps. No network,
// git, or subprocess operations happen in these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  advanceVisual,
  resolveArtifactsDir,
  type VisualGateDeps,
  type VisualRunResult,
} from "../scripts/stages/visual.ts";
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

function baseCfg(overrides: Partial<PipelineConfig["visual_gate"]> = {}): PipelineConfig {
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
    eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
    visual_gate: {
      enabled: true,
      command: "npx playwright test",
      mode: "gate",
      timeout: 900,
      max_attempts: 1,
      artifacts_dir: ".pipeline-visual",
      ...overrides,
    },
    shipcheck_gate: {
      enabled: false,
      mode: "advisory",
      max_rounds: 1,
      rubric_path: ".github/shipcheck-rubric.md",
      block_on_partial: false,
    },
    review_policy: { block_threshold: "medium", min_confidence: 0.7, max_adversarial_rounds: 3 },
    doctor: { runOnStart: false, failFast: false },
    format_gate: [],
    harness_sandbox: false,
  } as unknown as PipelineConfig;
}

type RunResult = VisualRunResult;

function passResult(output = "All visual checks passed"): RunResult {
  return { passed: true, timedOut: false, spawnError: false, output, durationSec: 1.2 };
}
function failResult(output = "2 visual checks failed"): RunResult {
  return { passed: false, timedOut: false, spawnError: false, output, durationSec: 1.5 };
}
function timeoutResult(): RunResult {
  return { passed: false, timedOut: true, spawnError: false, output: "[visual-gate timed out after 900s]", durationSec: 900 };
}
function spawnErrorResult(output = "[harness visual-gate] spawn error: command not found"): RunResult {
  return { passed: false, timedOut: false, spawnError: true, output, durationSec: 0 };
}

function makeDeps(
  log: CallLog,
  results: RunResult[],
  worktree: { path: string; slug: string } | null = { path: "/tmp/wt", slug: "42-slug" },
): VisualGateDeps {
  let call = 0;
  return {
    runVisual: async () => results[Math.min(call++, results.length - 1)],
    getForIssue: async () => worktree,
    transition: async (_c, _n, from, to) => { log.transitions.push({ from, to }); },
    silentTransition: async (_c, _n, from, to) => { log.silentTransitions.push({ from, to }); },
    setBlocked: async (_c, _n, reason, _stage, kind) => { log.blocked.push({ reason, kind }); },
    postComment: async (_c, _n, body) => { log.comments.push(body); },
    getGhActor: async () => null,
    getIssueDetail: async () => ({ comments: [] }),
    getPrForIssue: async () => null,
    getPrCommits: async () => [],
    listArtifacts: async () => [],
    copyArtifacts: async () => {},
  };
}

function pendingReviewFixDeps(issueNumber: number): Pick<VisualGateDeps, "getGhActor" | "getIssueDetail" | "getPrForIssue" | "getPrCommits"> {
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
      { oid: "b".repeat(40), messageHeadline: `fix: resolve visual-gate failures (#${issueNumber})` },
    ],
  };
}

function okInvoke(): HarnessResult {
  return { success: true, stdout: "", stderr: "", exit_code: 0, duration: 1, timed_out: false };
}

function cleanFixDeps(): Pick<
  VisualGateDeps,
  "invoke" | "gitHead" | "gitDirty" | "gitPush" | "gitCommitMessages" | "verifyVisualFix" | "salvage"
> {
  let head = 0;
  return {
    invoke: async () => okInvoke(),
    gitHead: async () => `head-${head++}`,
    gitDirty: async () => false,
    gitPush: async () => ({ code: 0, stderr: "" }),
    gitCommitMessages: async () => [],
    verifyVisualFix: async () => ({ ok: true }),
    salvage: async () => true,
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

test("visual-gate: skip path — disabled config → silent label swap to eval-gate, no comment, no runVisual", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false });
  let runCalled = 0;
  const deps = makeDeps(log, []);
  const origRun = deps.runVisual;
  deps.runVisual = async (...a) => { runCalled++; return origRun!(...a); };

  const out = await advanceVisual(cfg, 42, {}, deps);

  assert.equal(runCalled, 0, "runVisual must not be called when disabled");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "eval-gate");
  assert.equal(log.transitions.length, 0, "disabled path must not call transition (which posts a comment)");
  assert.equal(log.silentTransitions.length, 1, "disabled path must call silentTransition for label-only swap");
  assert.equal(log.silentTransitions[0].from, "visual-gate");
  assert.equal(log.silentTransitions[0].to, "eval-gate");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 0);
});

test("visual-gate: exit 0 + gate mode → transitions to eval-gate", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("10/10 visual checks passed")]);

  const out = await advanceVisual(cfg, 43, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "eval-gate");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("PASS"), "comment must say PASS");
  assert.ok(log.comments[0].includes("## Visual Gate"), "comment must be a Visual Gate comment");
});

test("visual-gate: exit 0 + gate mode + PR commit lookup fails → fails closed, routes to pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("10/10 visual checks passed")]);
  deps.getPrForIssue = async () => 900;
  deps.getGhActor = async () => "pipeline-bot";
  deps.getIssueDetail = async () => ({
    comments: [{ author: "pipeline-bot", body: `## Review 2 — approve\n\n<!-- reviewed-sha: ${"a".repeat(40)} -->` }],
  });
  deps.getPrCommits = async () => { throw new Error("network error: gh not authenticated"); };

  const out = await advanceVisual(cfg, 43, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "pre-merge", "an unverifiable review state must fail closed to pre-merge, not advance directly");
});

test("visual-gate: non-zero exit + gate mode → setBlocked, no forward transition", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("3 visual checks failed")]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 44, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "visual-gate-failed");
  assert.equal(log.transitions.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "comment must say FAIL");
  assert.equal(invokeCalled, 0, "max_attempts: 1 must perform no fix round — first failure blocks");
});

test("visual-gate: non-zero exit + advisory mode → comment posted, transitions to eval-gate", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });
  const deps = makeDeps(log, [failResult("1 visual check failed")]);
  const appended: string[] = [];

  const out = await advanceVisual(cfg, 45, { runDir: "/runs/45", runStoreDeps: appendOnlyRunStore(appended) }, deps);

  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "eval-gate");
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 1);
  assert.ok(log.comments[0].includes("FAIL"), "advisory comment must say FAIL");
  assert.ok(log.comments[0].includes("advisory"), "advisory comment must include mode");
  const events = appendedEvents(appended);
  assert.deepEqual(
    events
      .filter((event) => event.type === "gate_result")
      .map((event) => ({ type: event.type, gate: event.gate, result: event.result, mode: event.mode })),
    [{ type: "gate_result", gate: "visual-gate", result: "fail", mode: "advisory" }],
  );
  const accounting = events.find((event) => event.type === "stage_accounting");
  assert.ok(accounting, "visual subprocess should emit stage accounting when runDir is provided");
  assert.equal(accounting.stage, "visual-gate");
  assert.equal(accounting.harness, "visual-gate");
  assert.equal(accounting.outcome, "failure");
  assert.equal(accounting.blocker_kind, "visual-gate-failed");
});

test("visual-gate: gate-mode fail with budget remaining → fix round invoked → re-run passes → routes to pre-merge for review", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;
  let invokeCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  Object.assign(deps, pendingReviewFixDeps(46));
  deps.runVisual = async () => {
    runCalled++;
    return runCalled === 1 ? failResult("attempt 1 failed") : passResult("attempt 2 passed");
  };
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 46, {}, deps);

  assert.equal(runCalled, 2, "must run the visual command twice");
  assert.equal(invokeCalled, 1, "must invoke the fix harness exactly once between the two visual runs");
  assert.equal(out.advanced, true);
  assert.equal((out as { to: string }).to, "pre-merge", "a visual-fix commit must clear pre-merge review before eval-gate");
  assert.equal(log.blocked.length, 0);
  assert.ok(log.comments[0].includes("PASS"));
});

test("visual-gate: gate-mode fail → fix rounds exhausted (max_attempts reached) → setBlocked with final output", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 3 });
  let runCalled = 0;
  let invokeCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runVisual = async () => { runCalled++; return failResult(`always fails (run ${runCalled})`); };
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 48, {}, deps);

  assert.equal(runCalled, 3, "must attempt max_attempts times");
  assert.equal(invokeCalled, 2, "must perform exactly max_attempts - 1 fix rounds");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "visual-gate-failed");
  assert.ok(log.blocked[0].reason.includes("always fails (run 3)"), "block reason must surface the final visual output");
});

test("visual-gate: advisory-mode pass with an old visual-fix commit on the PR → advances to eval-gate, not pre-merge", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 1 });

  const deps = makeDeps(log, [passResult("attempt 1 passed")]);
  Object.assign(deps, pendingReviewFixDeps(46));

  const out = await advanceVisual(cfg, 46, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(
    (out as { to: string }).to,
    "eval-gate",
    "advisory passes must advance directly regardless of visual-fix history",
  );
});

test("visual-gate: retries exhausted + advisory mode → advances to eval-gate (never blocks)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  deps.runVisual = async () => { runCalled++; return failResult("always fails"); };

  const out = await advanceVisual(cfg, 47, {}, deps);

  assert.equal(runCalled, 2, "must attempt max_attempts times");
  assert.equal(out.advanced, true, "advisory must advance even after retries exhausted");
  assert.equal((out as { to: string }).to, "eval-gate");
  assert.equal(log.blocked.length, 0, "advisory must never block");
  assert.equal(log.transitions.length, 1);
});

// ---------------------------------------------------------------------------
// Fix round failure paths
// ---------------------------------------------------------------------------

test("visual-gate: visual-fix round → harness error → blocks (harness-failure), visual NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runVisual = async () => { runCalled++; return failResult("visual checks failed"); };
  deps.invoke = async () => ({
    success: false, stdout: "", stderr: "boom", exit_code: 1, duration: 3, timed_out: false,
  });

  const out = await advanceVisual(cfg, 700, {}, deps);

  assert.equal(runCalled, 1, "the visual command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
});

test("visual-gate: visual-fix round → push fails → blocks (push-failed), visual NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runVisual = async () => { runCalled++; return failResult("visual checks failed"); };
  deps.invoke = async () => okInvoke();
  deps.gitPush = async () => ({ code: 1, stderr: "remote rejected" });

  const out = await advanceVisual(cfg, 703, {}, deps);

  assert.equal(runCalled, 1, "the visual command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "push-failed");
  assert.ok(log.blocked[0].reason.includes("remote rejected"));
});

// ---------------------------------------------------------------------------
// Fix prompt context: names the gate, command, output, and artifacts
// ---------------------------------------------------------------------------

test("visual-gate: visual-fix prompt embeds the gate name, command, bounded output, and artifact manifest", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2, command: "npx playwright test --grep @smoke" });
  let capturedPrompt = "";

  const deps = makeDeps(log, [failResult("assertion X failed"), passResult()]);
  Object.assign(deps, cleanFixDeps());
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  deps.invoke = async (_harness, _wtPath, prompt) => {
    capturedPrompt = prompt;
    return okInvoke();
  };

  await advanceVisual(cfg, 704, {}, deps);

  assert.ok(capturedPrompt.includes("visual-gate"), "prompt must identify the failed gate");
  assert.ok(capturedPrompt.includes("npx playwright test --grep @smoke"), "prompt must include the configured command");
  assert.ok(capturedPrompt.includes("assertion X failed"), "prompt must include the visual output");
  assert.ok(capturedPrompt.includes("screenshot.png"), "prompt must include the artifact manifest");
});

// ---------------------------------------------------------------------------
// Tooling failures: timeout / spawn error always block, in either mode
// ---------------------------------------------------------------------------

test("visual-gate: timeout in gate mode → blocked, no fix round even with budget remaining", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  const deps = makeDeps(log, [timeoutResult()]);
  const appended: string[] = [];
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 49, { runDir: "/runs/49", runStoreDeps: appendOnlyRunStore(appended) }, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1, "timeout must block in gate mode");
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.ok(log.comments[0].includes("FAIL"), "timeout comment must say FAIL");
  assert.equal(invokeCalled, 0, "a timeout must never route to a fix round");
  const accounting = appendedEvents(appended).find((event) => event.type === "stage_accounting");
  assert.equal(accounting?.outcome, "timeout");
  assert.equal(accounting?.blocker_kind, "harness-failure");
});

test("visual-gate: timeout in advisory mode → always blocks (tooling failure, not gate failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  const deps = makeDeps(log, [timeoutResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 491, {}, deps);

  assert.equal(out.advanced, false, "timeout must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on timeout");
  assert.equal(invokeCalled, 0, "a timeout must never route to a fix round");
});

test("visual-gate: spawn error in gate mode → blocked, no fix round even with budget remaining", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  const deps = makeDeps(log, [spawnErrorResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 4921, {}, deps);

  assert.equal(out.advanced, false, "spawn error must block in gate mode");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.equal(invokeCalled, 0, "a spawn error must never route to a fix round");
});

test("visual-gate: spawn error in advisory mode → always blocks (tooling failure)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "advisory", max_attempts: 2 });
  const deps = makeDeps(log, [spawnErrorResult()]);
  let invokeCalled = 0;
  deps.invoke = async () => { invokeCalled++; return okInvoke(); };

  const out = await advanceVisual(cfg, 492, {}, deps);

  assert.equal(out.advanced, false, "spawn error must block even in advisory mode");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.transitions.length, 0, "must not advance on spawn error");
  assert.equal(invokeCalled, 0, "a spawn error must never route to a fix round");
});

test("visual-gate: no worktree → blocked", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: "npx playwright test" });
  const deps = makeDeps(log, [passResult()], null);

  const out = await advanceVisual(cfg, 50, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { reason: string }).reason, "no worktree");
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "worktree-missing");
});

test("visual-gate: enabled with no command → blocked (visual-gate-misconfigured)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: undefined });
  const deps = makeDeps(log, []);

  const out = await advanceVisual(cfg, 501, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "visual-gate-misconfigured");
});

// ---------------------------------------------------------------------------
// Dry-run: no GitHub writes
// ---------------------------------------------------------------------------

test("visual-gate: dry-run + disabled visual → no GitHub writes", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: false });
  const deps = makeDeps(log, []);

  const out = await advanceVisual(cfg, 51, { dryRun: true }, deps);

  assert.equal(out.advanced, true);
  assert.equal(log.transitions.length, 0, "dry-run must not call transition");
  assert.equal(log.blocked.length, 0, "dry-run must not call setBlocked");
  assert.equal(log.comments.length, 0, "dry-run must not post comments");
});

test("visual-gate: dry-run + enabled + command → no GitHub writes, no runVisual", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: "npx playwright test" });
  let runCalled = 0;
  const deps = makeDeps(log, []);
  deps.runVisual = async () => { runCalled++; return passResult(); };

  const out = await advanceVisual(cfg, 53, { dryRun: true }, deps);

  assert.equal(out.advanced, true);
  assert.equal(runCalled, 0, "dry-run must not invoke runVisual");
  assert.equal(log.transitions.length, 0);
  assert.equal(log.blocked.length, 0);
  assert.equal(log.comments.length, 0);
});

// ---------------------------------------------------------------------------
// Env-var context passed to the command
// ---------------------------------------------------------------------------

test("visual-gate: command receives PIPELINE_ISSUE/BRANCH/RUN_ID/ARTIFACTS_DIR and PIPELINE_PR_NUMBER when a PR exists", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const deps = makeDeps(log, []);
  deps.getPrForIssue = async () => 777;
  deps.runVisual = async (_cmd, _cwd, _timeout, env) => {
    capturedEnv = env;
    return passResult();
  };

  await advanceVisual(cfg, 46, { pipelineRunId: "46/2026-01-01T00:00:00Z" }, deps);

  assert.ok(capturedEnv, "runVisual must receive an env object");
  assert.equal(capturedEnv!.PIPELINE_ISSUE, "46");
  assert.equal(capturedEnv!.PIPELINE_BRANCH, "pipeline/46-42-slug");
  assert.equal(capturedEnv!.PIPELINE_RUN_ID, "46/2026-01-01T00:00:00Z");
  assert.equal(capturedEnv!.PIPELINE_PR_NUMBER, "777");
  assert.ok(capturedEnv!.PIPELINE_VISUAL_ARTIFACTS_DIR?.includes(".pipeline-visual"));
  assert.ok(
    isAbsolute(capturedEnv!.PIPELINE_VISUAL_ARTIFACTS_DIR as string),
    "artifacts dir env var must be an absolute path",
  );
});

test("visual-gate: no open PR → PIPELINE_PR_NUMBER is absent from the command's environment", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const deps = makeDeps(log, []);
  deps.getPrForIssue = async () => null;
  deps.runVisual = async (_cmd, _cwd, _timeout, env) => {
    capturedEnv = env;
    return passResult();
  };

  await advanceVisual(cfg, 46, {}, deps);

  assert.equal(capturedEnv!.PIPELINE_PR_NUMBER, undefined);
});

// ---------------------------------------------------------------------------
// Artifact capture and manifest
// ---------------------------------------------------------------------------

test("resolveArtifactsDir: worktree-relative path resolves inside the worktree", () => {
  const res = resolveArtifactsDir("/repo/.worktrees/42-slug", ".pipeline-visual");
  assert.equal(res.ok, true);
});

test("resolveArtifactsDir: a path escaping the worktree root is rejected", () => {
  const res = resolveArtifactsDir("/repo/.worktrees/42-slug", "../../etc");
  assert.equal(res.ok, false);
});

test("resolveArtifactsDir: an absolute path outside the worktree is rejected", () => {
  const res = resolveArtifactsDir("/repo/.worktrees/42-slug", "/etc/passwd");
  assert.equal(res.ok, false);
});

test("visual-gate: artifacts captured and listed in the comment + evidence bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-evidence-test-"));
  try {
    const log = makeCallLog();
    const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
    const deps = makeDeps(log, [passResult("checks passed")]);
    deps.listArtifacts = async () => [
      { rel: "screenshot.png", size: 100 },
      { rel: "trace.zip", size: 200 },
    ];
    let copiedTo = "";
    let copiedFiles: string[] = [];
    deps.copyArtifacts = async (_abs, files, destDir) => {
      copiedTo = destDir;
      copiedFiles = files;
    };

    const out = await advanceVisual(cfg, 800, { stateDir: dir, runDir: "/runs/800" }, deps);

    assert.equal(out.advanced, true);
    assert.ok(log.comments[0].includes("screenshot.png"));
    assert.ok(log.comments[0].includes("trace.zip"));
    assert.deepEqual(copiedFiles, ["screenshot.png", "trace.zip"]);
    assert.ok(copiedTo.includes("visual"), "artifacts must be copied under the run directory's visual/ subpath");

    const bundle = await readBundle(dir, 800);
    assert.ok(bundle, "evidence bundle must exist");
    const visualEntry = bundle!.stages.find((s) => s.stage === "visual-gate");
    assert.ok(visualEntry, "visual-gate stage entry must be created");
    assert.ok(
      visualEntry!.commands[0].outputExcerpt.includes("screenshot.png") ||
        visualEntry!.commands[0].outputExcerpt.length > 0,
      "artifact manifest must reach the evidence bundle's command record",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visual-gate: missing/empty artifacts_dir → 'no artifacts captured' note, pass/fail unaffected", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [];

  const out = await advanceVisual(cfg, 801, {}, deps);

  assert.equal(out.advanced, true);
  assert.ok(log.comments[0].includes("no artifacts captured"));
});

test("visual-gate: secret-looking output is redacted before the comment is posted", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const secret = "sk-liveTestSecretValue1234567890";
  const oldEnv = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const deps = makeDeps(log, [failResult(`boom: OPENAI_API_KEY=${secret}`)]);

    await advanceVisual(cfg, 900, {}, deps);

    assert.ok(!log.comments[0].includes(secret), "the posted comment must not contain the raw secret value");
    assert.ok(log.comments[0].includes("[REDACTED]"), "the posted comment must show the redaction marker");
  } finally {
    if (oldEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldEnv;
  }
});

test("visual-gate: artifacts_dir escaping the worktree → error surfaced, no read/copy attempted", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, artifacts_dir: "../../outside" });
  let listCalled = 0;
  let copyCalled = 0;
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => { listCalled++; return []; };
  deps.copyArtifacts = async () => { copyCalled++; };

  const out = await advanceVisual(cfg, 802, {}, deps);

  assert.equal(out.advanced, true);
  assert.equal(listCalled, 0, "an escaping artifacts_dir must never be listed");
  assert.equal(copyCalled, 0, "an escaping artifacts_dir must never be copied from");
  assert.ok(log.comments[0].includes("no artifacts captured"));
});
