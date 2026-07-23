// Visual-gate stage (#395) unit tests.
//
// All side-effecting calls (GitHub API, command execution, worktree lookup,
// artifact fs) are injected as stubs via VisualGateDeps. No network,
// git, or subprocess operations happen in these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import {
  advanceVisual,
  publishBlobUrl,
  resolveArtifactsDir,
  selectPublishFiles,
  VISUAL_PUBLISH_COMMIT_PREFIX,
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
      publish: false,
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
    copyArtifacts: async (_abs, files) => files.map((rel) => ({ rel, ok: true })),
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

test("visual-gate: visual-fix round → harness produces no new commit → blocks (harness-failure), visual NOT re-run", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });
  let runCalled = 0;

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runVisual = async () => { runCalled++; return failResult("visual checks failed"); };
  deps.invoke = async () => okInvoke();
  deps.gitHead = async () => "same-sha"; // HEAD never advances: no harness commit
  deps.gitDirty = async () => false;
  deps.salvage = async () => ({ salvaged: false });

  const out = await advanceVisual(cfg, 701, {}, deps);

  assert.equal(runCalled, 1, "the visual command must not be re-run after a failed fix round");
  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "harness-failure");
  assert.ok(log.blocked[0].reason.includes("no new commits"));
});

test("visual-gate (#521): visual-fix round → salvage attempt fails → its failure reason is threaded into the block reason", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 2 });

  const deps = makeDeps(log, []);
  Object.assign(deps, cleanFixDeps());
  deps.runVisual = async () => failResult("visual checks failed");
  deps.invoke = async () => okInvoke();
  deps.gitHead = async () => "same-sha"; // HEAD never advances: no harness commit
  deps.gitDirty = async () => false;
  deps.salvage = async () => ({ salvaged: false, failureReason: "git add failed: ignored nested paths" });

  const out = await advanceVisual(cfg, 701, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.ok(log.blocked[0].reason.includes("no new commits"));
  assert.ok(
    log.blocked[0].reason.includes("Salvage of uncommitted work also failed: git add failed: ignored nested paths"),
    `blocked reason must disclose the salvage failure; got: ${log.blocked[0].reason}`,
  );
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

test("visual-gate: enabled with a whitespace-only command → blocked (visual-gate-misconfigured), no runVisual", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, command: "   " });
  const deps = makeDeps(log, [passResult()]);
  const origRun = deps.runVisual;
  let runCalled = 0;
  deps.runVisual = async (...a) => { runCalled++; return origRun!(...a); };

  const out = await advanceVisual(cfg, 502, {}, deps);

  assert.equal(out.advanced, false);
  assert.equal(log.blocked.length, 1);
  assert.equal(log.blocked[0].kind, "visual-gate-misconfigured");
  assert.equal(runCalled, 0, "a whitespace-only command must never reach sh -c");
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
      return files.map((rel) => ({ rel, ok: true }));
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

test("visual-gate: artifacts_dir that is a symlink escaping the worktree → error surfaced, no read/copy attempted", async () => {
  const worktreeDir = await mkdtemp(join(tmpdir(), "visual-symlink-wt-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "visual-symlink-outside-"));
  try {
    await writeFile(join(outsideDir, "secret.png"), "not-a-real-image");
    await symlink(outsideDir, join(worktreeDir, ".pipeline-visual"), "dir");

    const log = makeCallLog();
    const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, artifacts_dir: ".pipeline-visual" });
    let listCalled = 0;
    let copyCalled = 0;
    const deps = makeDeps(log, [passResult("checks passed")], { path: worktreeDir, slug: "symlink-slug" });
    deps.listArtifacts = async () => { listCalled++; return []; };
    deps.copyArtifacts = async () => { copyCalled++; };

    const out = await advanceVisual(cfg, 803, {}, deps);

    assert.equal(out.advanced, true);
    assert.equal(listCalled, 0, "a symlinked artifacts_dir escaping the worktree must never be listed");
    assert.equal(copyCalled, 0, "a symlinked artifacts_dir escaping the worktree must never be copied from");
    assert.ok(log.comments[0].includes("no artifacts captured"));
  } finally {
    await rm(worktreeDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Per-file copy-failure surfacing (d50013b8)
// ---------------------------------------------------------------------------

test("visual-gate: a file whose copy fails is reported copy-failed, not captured", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1 });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [
    { rel: "ok.png", size: 100 },
    { rel: "broken.png", size: 100 },
  ];
  deps.copyArtifacts = async (_abs, files) =>
    files.map((rel) => ({ rel, ok: rel !== "broken.png" }));

  const out = await advanceVisual(cfg, 810, { runDir: "/runs/810" }, deps);

  assert.equal(out.advanced, true);
  assert.ok(log.comments[0].includes("ok.png"));
  assert.ok(log.comments[0].includes("broken.png (copy failed)"), "copy-failed file must be annotated, not listed as a bare captured file");
  assert.ok(!log.comments[0].includes("- broken.png\n"), "copy-failed file must never appear as a plain captured entry");
});

// ---------------------------------------------------------------------------
// Publish bound selection (pure)
// ---------------------------------------------------------------------------

test("selectPublishFiles: bounds by file count, per-file size, and total size", () => {
  const files = ["a.png", "b.png", "c.png"];
  const sizes = { "a.png": 1024, "b.png": 3 * 1024 * 1024, "c.png": 1024 };

  const { toPublish, overBound } = selectPublishFiles(files, sizes);

  assert.deepEqual(toPublish, ["a.png", "c.png"], "b.png exceeds the per-file cap and must be excluded");
  assert.deepEqual(overBound, ["b.png"]);
});

test("selectPublishFiles: total-byte bound excludes files once the cumulative budget is exceeded", () => {
  // Each file is under the 2MB per-file cap, but six of them exceed the 10MB total budget.
  const files = ["a.png", "b.png", "c.png", "d.png", "e.png", "f.png"];
  const perFileBytes = 1.9 * 1024 * 1024;
  const sizes = Object.fromEntries(files.map((f) => [f, perFileBytes]));

  const { toPublish, overBound } = selectPublishFiles(files, sizes);

  assert.deepEqual(toPublish, ["a.png", "b.png", "c.png", "d.png", "e.png"]);
  assert.deepEqual(overBound, ["f.png"], "the 6th file would push the cumulative total over the 10MB budget");
});

test("selectPublishFiles: file-count bound stops at PUBLISH_MAX_FILES", () => {
  const files = Array.from({ length: 25 }, (_, i) => `f${i}.png`);
  const sizes = Object.fromEntries(files.map((f) => [f, 10]));

  const { toPublish, overBound } = selectPublishFiles(files, sizes);

  assert.equal(toPublish.length, 20);
  assert.equal(overBound.length, 5);
});

test("publishBlobUrl: builds a branch-relative blob URL under the evidence path", () => {
  const url = publishBlobUrl("acme/widget", "pipeline/46-slug", "screenshot.png");
  assert.equal(url, "https://github.com/acme/widget/blob/pipeline/46-slug/.pipeline-visual-evidence/screenshot.png");
});

// ---------------------------------------------------------------------------
// Publish step (#463)
// ---------------------------------------------------------------------------

function publishGitDeps(
  overrides: Partial<
    Pick<VisualGateDeps, "copyForPublish" | "removeEvidenceDir" | "gitAddForce" | "gitCommit" | "gitDirty" | "gitPush">
  > = {},
): Pick<VisualGateDeps, "copyForPublish" | "removeEvidenceDir" | "gitAddForce" | "gitCommit" | "gitDirty" | "gitPush"> {
  return {
    copyForPublish: async () => {},
    removeEvidenceDir: async () => false,
    gitAddForce: async () => ({ code: 0, stderr: "" }),
    gitCommit: async () => ({ code: 0, stderr: "" }),
    gitDirty: async () => true,
    gitPush: async () => ({ code: 0, stderr: "" }),
    ...overrides,
  };
}

test("visual-gate: publish disabled (default) — no publish git ops, manifest stays bare paths", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: false });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  let addCalled = 0;
  Object.assign(deps, publishGitDeps({ gitAddForce: async () => { addCalled++; return { code: 0, stderr: "" }; } }));

  const out = await advanceVisual(cfg, 820, { runDir: "/runs/820" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 0, "publish disabled must never call git add");
  assert.ok(log.comments[0].includes("- screenshot.png\n") || log.comments[0].trimEnd().endsWith("- screenshot.png"));
  assert.ok(!log.comments[0].includes("]("), "manifest must not contain a link when publish is disabled");
});

test("visual-gate: publish enabled — captured artifacts are committed and pushed, manifest links to the blob URL", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  let addRel = "";
  let commitMsg = "";
  let pushed = false;
  Object.assign(
    deps,
    publishGitDeps({
      gitAddForce: async (_cwd, relPath) => { addRel = relPath; return { code: 0, stderr: "" }; },
      gitCommit: async (_cwd, message) => { commitMsg = message; return { code: 0, stderr: "" }; },
      gitPush: async () => { pushed = true; return { code: 0, stderr: "" }; },
    }),
  );

  const out = await advanceVisual(cfg, 821, { runDir: "/runs/821" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addRel, ".pipeline-visual-evidence");
  assert.equal(commitMsg, `${VISUAL_PUBLISH_COMMIT_PREFIX}821`);
  assert.equal(pushed, true);
  assert.ok(
    log.comments[0].includes(
      "[screenshot.png](https://github.com/acme/widget/blob/pipeline/821-42-slug/.pipeline-visual-evidence/screenshot.png)",
    ),
    `comment must link to the published blob URL, got: ${log.comments[0]}`,
  );
});

test("visual-gate: publish enabled but nothing captured → no publish commit", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [];
  let addCalled = 0;
  Object.assign(deps, publishGitDeps({ gitAddForce: async () => { addCalled++; return { code: 0, stderr: "" }; } }));

  const out = await advanceVisual(cfg, 822, { runDir: "/runs/822" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 0, "no captured artifacts must never trigger a publish commit");
});

test("visual-gate: publish push failure is surfaced in the comment and does not block a passing gate", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  Object.assign(
    deps,
    publishGitDeps({ gitPush: async () => ({ code: 1, stderr: "remote rejected" }) }),
  );

  const out = await advanceVisual(cfg, 823, { runDir: "/runs/823" }, deps);

  assert.equal(out.advanced, true, "a publish failure must never turn a passing gate into a block");
  assert.equal(log.blocked.length, 0);
  assert.ok(log.comments[0].includes("**Publish**: failed"), "publish failure must be surfaced in the evidence comment");
  assert.ok(log.comments[0].includes("screenshot.png (not published: publish failed)"));
});

test("visual-gate: over-bound file is annotated 'not published' and is not committed", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [
    { rel: "small.png", size: 100 },
    { rel: "huge.png", size: 3 * 1024 * 1024 },
  ];
  let addCalled = 0;
  Object.assign(deps, publishGitDeps({ gitAddForce: async (cwd, rel) => { addCalled++; return { code: 0, stderr: "" }; } }));

  const out = await advanceVisual(cfg, 824, { runDir: "/runs/824" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 1, "an in-bound file must still trigger a publish commit even when a sibling is over-bound");
  assert.ok(log.comments[0].includes("huge.png (not published: exceeds bound)"));
  assert.ok(log.comments[0].includes("[small.png]("), "the in-bound file must still be published and linked");
});

test("visual-gate: an all-over-bound deciding run still replaces stale published evidence (#463 review 1)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  // Every captured file this run exceeds the per-file bound, but a prior run
  // left evidence published on the branch — it must be pruned, not left stale.
  deps.listArtifacts = async () => [{ rel: "huge.png", size: 3 * 1024 * 1024 }];
  let addCalled = 0;
  let committed = false;
  let pushed = false;
  Object.assign(
    deps,
    publishGitDeps({
      removeEvidenceDir: async () => true,
      gitAddForce: async () => { addCalled++; return { code: 0, stderr: "" }; },
      gitCommit: async (_cwd, message) => { committed = true; return { code: 0, stderr: "" }; },
      gitPush: async () => { pushed = true; return { code: 0, stderr: "" }; },
    }),
  );

  const out = await advanceVisual(cfg, 826, { runDir: "/runs/826" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 1, "the evidence-directory deletion must still be staged when everything is over-bound");
  assert.equal(committed, true, "the deletion of stale evidence must be committed");
  assert.equal(pushed, true, "the deletion of stale evidence must be pushed");
  assert.ok(log.comments[0].includes("huge.png (not published: exceeds bound)"));
});

test("visual-gate: publish commit is scoped to the evidence path, not the full index (#463 review 2)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  let commitPath = "";
  Object.assign(
    deps,
    publishGitDeps({
      gitCommit: async (_cwd, message, relPath) => { commitPath = relPath; return { code: 0, stderr: "" }; },
    }),
  );

  const out = await advanceVisual(cfg, 827, { runDir: "/runs/827" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(commitPath, ".pipeline-visual-evidence", "the publish commit must be pathspec-scoped to the evidence dir, not the whole index");
});

test("visual-gate: a locally-committed-but-unpushed evidence set is retried and only reported published once the push succeeds (#463 review 2)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  let commitCalled = 0;
  let pushCalled = 0;
  Object.assign(
    deps,
    publishGitDeps({
      // Simulates a prior invocation that committed locally but failed to push:
      // the recopied evidence tree matches what's already committed, so the
      // worktree is clean this round.
      gitDirty: async () => false,
      gitCommit: async () => { commitCalled++; return { code: 0, stderr: "" }; },
      gitPush: async () => { pushCalled++; return { code: 0, stderr: "" }; },
    }),
  );

  const out = await advanceVisual(cfg, 828, { runDir: "/runs/828" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(commitCalled, 0, "nothing changed locally, so no new commit should be made");
  assert.equal(pushCalled, 1, "push must still be attempted to verify the prior local commit actually reached the remote");
  assert.ok(
    log.comments[0].includes("[screenshot.png]("),
    "once the retried push succeeds, the file must be reported published",
  );
});

test("visual-gate: an unpushed local commit whose retried push fails must not be reported published (#463 review 2)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "screenshot.png", size: 100 }];
  Object.assign(
    deps,
    publishGitDeps({
      gitDirty: async () => false,
      gitPush: async () => ({ code: 1, stderr: "remote rejected" }),
    }),
  );

  const out = await advanceVisual(cfg, 829, { runDir: "/runs/829" }, deps);

  assert.equal(out.advanced, true, "a publish push failure must never block a passing gate");
  assert.ok(
    !log.comments[0].includes("[screenshot.png]("),
    "a file must never be reported published while its push has not succeeded",
  );
  assert.ok(log.comments[0].includes("screenshot.png (not published: publish failed)"));
});

test("visual-gate: publish bounds are enforced against the size actually persisted by the copy, not the pre-copy listing (#463 review 2)", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  // The file is small at enumeration time...
  deps.listArtifacts = async () => [{ rel: "growing.png", size: 100 }];
  // ...but has grown past the 2MB per-file publish bound by the time it is
  // actually persisted into the run directory (e.g. a background writer).
  deps.copyArtifacts = async (_abs, files) =>
    files.map((rel) => ({ rel, ok: true, size: 3 * 1024 * 1024 }));
  let addCalled = 0;
  Object.assign(deps, publishGitDeps({ gitAddForce: async () => { addCalled++; return { code: 0, stderr: "" }; } }));

  const out = await advanceVisual(cfg, 830, { runDir: "/runs/830" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 0, "a file that grew past the publish bound during copy must never be committed");
  assert.ok(log.comments[0].includes("growing.png (not published: exceeds bound)"));
});

test("visual-gate: copy-failed files are excluded from publish", async () => {
  const log = makeCallLog();
  const cfg = baseCfg({ enabled: true, mode: "gate", max_attempts: 1, publish: true });
  const deps = makeDeps(log, [passResult("checks passed")]);
  deps.listArtifacts = async () => [{ rel: "broken.png", size: 100 }];
  deps.copyArtifacts = async (_abs, files) => files.map((rel) => ({ rel, ok: false }));
  let addCalled = 0;
  Object.assign(deps, publishGitDeps({ gitAddForce: async () => { addCalled++; return { code: 0, stderr: "" }; } }));

  const out = await advanceVisual(cfg, 825, { runDir: "/runs/825" }, deps);

  assert.equal(out.advanced, true);
  assert.equal(addCalled, 0, "a file that never made it into the run directory must never be published");
  assert.ok(log.comments[0].includes("broken.png (copy failed)"));
});
