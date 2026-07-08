// Test/build gate (#15): run the target repo's own test/build command inside the
// worktree, and on failure drive a bounded generate→test→fix loop with the
// implementer harness until it passes or attempts are exhausted. A persistent
// failure blocks the item BEFORE a PR is opened (planning) or BEFORE it advances
// (fix rounds) — so broken changes never reach review. Repos with no detectable
// test/build command (and no explicit override) are skipped entirely.

import * as fs from "node:fs";
import * as path from "node:path";
import type { spawn } from "node:child_process";
import {
  invoke as defaultInvoke,
  runCapped,
  type HarnessResult,
  type InvokeOptions,
} from "./harness.ts";
import { gitInWorktree } from "./worktree.ts";
import { buildTestFixPrompt } from "./prompts/index.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "./verify-harness-commits.ts";
import { makePipelineRunId, validateCommitTrailers } from "./traceability.ts";
import { trySalvageUncommittedWork } from "./salvage-harness-work.ts";
import { makeCommandRecord, recordCommand } from "./evidence-bundle.ts";
import { buildFailureBlockReason, includeBuildArtifacts, type BuildSideEffectsDeps } from "./build-side-effects.ts";
import { buildStageAccountingRecord } from "./accounting.ts";
import { emitStageAccounting, type RunStoreDeps } from "./run-store.ts";
import type { Harness, PipelineConfig } from "./types.ts";

/** A command split into program + argv — never a raw string at spawn time. */
export interface ParsedCommand {
  cmd: string;
  args: string[];
}

export interface RunTestsResult {
  passed: boolean;
  output: string;
  durationSec: number;
  /** True when the command's output capture ended abnormally — a spawn/capture
   *  error (no clean process exit code was ever observed) rather than a
   *  cleanly-observed exit (zero or non-zero) (#384). Drives the gate's bounded
   *  tooling-failure retry instead of charging a fix attempt. */
  toolingError: boolean;
}

export interface TestGateResult {
  /** True when the gate did not run (disabled, or no command detected). */
  skipped: boolean;
  /** Whether the test/build command ultimately passed. Absent when skipped. */
  passed?: boolean;
  /** Number of fix-harness invocations performed (0 if it passed first try). */
  attempts?: number;
  /** Captured failure output / reason, set only when `passed` is false. */
  blockReason?: string;
  /** True when `blockReason` reports a tooling/capture failure (bounded
   *  tooling retries exhausted without ever observing a clean exit) rather
   *  than a genuine test/build failure (#384). Consumed by
   *  `testGateBlockReason` to pick the matching wording. */
  toolingFailure?: boolean;
}

/** Signature of the harness `invoke` — injectable so the loop is unit-testable. */
export type InvokeFn = (
  harness: Harness,
  worktreeDir: string,
  prompt: string,
  opts?: InvokeOptions,
) => Promise<HarnessResult>;

/** Seams overridable in tests; default to the real implementations in prod. */
export interface TestGateDeps {
  invoke?: InvokeFn;
  runTests?: (cwd: string, command: ParsedCommand, timeoutSec: number, killProcessGroup?: boolean) => Promise<RunTestsResult>;
  detectTestCommand?: (repoDir: string) => ParsedCommand | null;
  gitHead?: (cwd: string) => Promise<string>;
  gitDirty?: (cwd: string) => Promise<boolean>;
  /** Verify commit message format after each test-fix attempt (#68). Injectable for tests. */
  verifyTestFix?: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
  /** Return the full commit messages for every commit reachable from HEAD but
   *  not from `baseRef`. Used to validate traceability trailers on commits the
   *  fix harness creates. Returns [] when `baseRef` equals HEAD (no new commits)
   *  or when the git command fails (non-git directory). */
  gitCommitMessages?: (cwd: string, baseRef: string) => Promise<string[]>;
  /** Salvage uncommitted test-fix work into a commit (#131). Returns true when
   *  a salvage commit was created. Injectable for tests. */
  salvage?: (
    wtPath: string,
    issueNumber: number,
    pipelineRunId: string,
    stageLabel: string,
  ) => Promise<boolean>;
  /** Return raw `git status --porcelain` output for dirty-path surfacing in block
   *  reasons (#352). Injectable so tests can verify path inclusion without real git. */
  gitStatusPorcelain?: (cwd: string) => Promise<string>;
  /** Build-artifact side-effect inclusion deps (#387). Folds any uncommitted
   *  artifact changes produced by a repo-declared `build_command` into a
   *  fix-attempt's commit before the test command re-runs. A no-op when
   *  `cfg.build_command` is unset. Tests inject fakes so no real git/build
   *  subprocess is invoked. */
  buildSideEffects?: BuildSideEffectsDeps;
}

// ---------------------------------------------------------------------------
// Salvage stage label (#131) — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Stage label for a salvaged test-fix commit. Includes the prescribed test-fix
 * commit subject so the salvage commit body satisfies
 * `enforceTestFixCommitFormat`'s message pattern (matched against subject +
 * body) and the loop proceeds to re-run the test command. Exported so tests
 * can pin the label against the gate's actual pattern.
 */
export function testFixSalvageStageLabel(issueNumber: number): string {
  return `test-fix (prescribed commit: "fix: resolve test/build failures (#${issueNumber})")`;
}

// ---------------------------------------------------------------------------
// Test-fix commit format gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Verifies that at least one commit in `headBefore..HEAD` matches the expected
 * test-fix commit message format. Exported so tests can exercise the gate
 * without mocking the full `runTestGate` call chain.
 */
export async function enforceTestFixCommitFormat(
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: new RegExp(
          `fix:\\s+resolve test/build failures \\(#${issueNumber}\\)`,
          "i",
        ),
        description: "Test-fix commit message does not match prescribed format",
      },
      // requireTrailers is intentionally absent here: trailer enforcement on
      // test-fix commits is handled separately by validateCommitTrailers in the
      // loop below (test_fix.md prescribes the Issue:/Pipeline-Run: trailers via
      // #20). This gate only asserts the prescribed commit-message format.
    },
    deps,
  );
}

const MAX_BLOCK_OUTPUT = 8000;

// Bounded retries for a test-command run whose output capture ends abnormally
// (no clean exit code observed — a spawn/capture error) before invoking the
// fix harness. Small and internal: this is a plumbing-transient safety net,
// not an operator-configurable knob (#384).
const MAX_TOOLING_RETRIES = 2;

// ---------------------------------------------------------------------------
// The bounded generate→test→fix loop.
// ---------------------------------------------------------------------------

/**
 * Run the repo's test/build command in `wtPath`. If it fails, invoke the
 * implementer harness with the failure output and re-run, up to
 * `cfg.test_gate.max_attempts` fix invocations. Returns the outcome; the caller
 * blocks the item when `!skipped && !passed`.
 *
 * `max_attempts` is the maximum number of fix-harness invocations. So for
 * `max_attempts: 3`: initial run → (fix → run) ×3. Passing after attempt N
 * yields `{passed: true, attempts: N}`; passing on the initial run yields
 * `{passed: true, attempts: 0}`.
 */
export async function runTestGate(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  deps: TestGateDeps = {},
  // Run identifier for the commit traceability trailers (#20) the fix harness is
  // instructed to add. Defaults to a fresh id so test/build-gate callers that
  // don't thread it still produce valid trailers; production callers
  // (planning/fix) pass the dispatch-wide id so all commits in a run match.
  pipelineRunId: string = makePipelineRunId(issueNumber),
  // Evidence-bundle stage label this gate's command runs are recorded under, and
  // the run/state dir to record into (#147). `stateDir` is undefined when the
  // orchestrator did not provide one (e.g. direct unit-test calls) — recording is
  // then a no-op, so the gate has no filesystem side effects in tests.
  stageLabel: string = "test-gate",
  stateDir?: string,
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
): Promise<TestGateResult> {
  if (!cfg.test_gate.enabled) return { skipped: true };

  const invokeFn = deps.invoke ?? defaultInvoke;
  const runTestsFn = deps.runTests ?? runTests;
  const detectFn = deps.detectTestCommand ?? detectTestCommand;
  const gitHeadFn = deps.gitHead ?? defaultGitHead;
  const gitDirtyFn = deps.gitDirty ?? defaultGitDirty;
  const gitStatusPorcelainFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const verifyTestFixFn =
    deps.verifyTestFix ??
    ((wt: string, hb: string) => enforceTestFixCommitFormat(issueNumber, wt, hb));
  const gitCommitMessagesFn = deps.gitCommitMessages ?? defaultGitCommitMessages;
  const salvageFn = deps.salvage ?? trySalvageUncommittedWork;

  // Operator-configured commands run through `bash -c "set -o pipefail; …"` so
  // shell operators (&&, ||, ;, pipes) work AND a failing stage in a pipeline
  // fails the gate. Without pipefail, POSIX sh returns only the LAST pipeline
  // stage's status, so `npm test | tee log` would report success even when
  // `npm test` failed and mask broken changes (#174). pipefail is a bash/ksh
  // feature — plain POSIX `sh`/dash cannot enforce it — so configured commands
  // require bash. Auto-detected commands spawn directly (no shell).
  const rawConfiguredCmd = cfg.test_gate.command;
  // Trim whitespace so `command: "   "` doesn't silently pass as a no-op shell
  // script (sh exits 0 on an empty body). Undefined stays undefined.
  const configuredCmd = rawConfiguredCmd?.trim() || undefined;

  // Block early on explicitly-set but empty/whitespace-only commands rather than
  // silently falling back to auto-detection (which would hide the misconfiguration).
  if (rawConfiguredCmd !== undefined && !configuredCmd) {
    return {
      skipped: false,
      passed: false,
      attempts: 0,
      blockReason: `test_gate.command is set but empty or whitespace-only ("${rawConfiguredCmd}"). Configure a valid command or remove the setting to use auto-detection.`,
    };
  }

  // `set -o pipefail` on its own line (not `;`-joined) so it applies even when
  // the configured command begins with a comment. The raw command is shown in
  // the log label below; this wrapper is internal.
  const command: ParsedCommand | null = configuredCmd
    ? { cmd: "bash", args: ["-c", `set -o pipefail\n${configuredCmd}`] }
    : detectFn(wtPath);
  if (!command) return { skipped: true };

  // Shell-backed commands require killProcessGroup so all descendants (e.g.
  // npm, pnpm, a test runner in an && chain or pipeline) are terminated on timeout.
  const killProcessGroup = !!configuredCmd;

  const label = configuredCmd ?? formatCommand(command);
  console.log(`[pipeline] #${issueNumber}: test gate running \`${label}\``);

  // Run the test/build command and record it in the evidence bundle (#147).
  // `runTests` has no exit code (it reports pass/fail), so synthesize 0/1.
  // Best-effort: recording never affects the gate outcome.
  const runAndRecord = async (): Promise<RunTestsResult> => {
    const startedAt = new Date();
    const res = await runTestsFn(wtPath, command, cfg.test_gate.timeout, killProcessGroup);
    const endedAt = new Date();
    if (stateDir) {
      await recordCommand(
        stateDir,
        issueNumber,
        stageLabel,
        makeCommandRecord(label, res.passed ? 0 : 1, res.durationSec * 1000, res.output),
      ).catch(() => {});
    }
    if (runDir) {
      // Capture the worktree HEAD at test time so ci_mode: local can verify
      // the PR head hasn't moved since this gate ran (#350 review-2).
      let prHeadSha: string | null = null;
      try { prHeadSha = await gitHeadFn(wtPath); } catch { /* non-fatal */ }
      await emitStageAccounting(
        runDir,
        buildStageAccountingRecord({
          runId: path.basename(runDir),
          issue: issueNumber,
          stage: stageLabel,
          harness: "test-gate",
          modelSlot: null,
          model: null,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: res.durationSec * 1000,
          commandCount: 1,
          subprocessCount: 1,
          outcome: res.passed ? "success" : res.toolingError ? "spawn_error" : "failure",
          // Mirrors eval.ts's recordEvalAccounting distinction (#372): a tooling
          // error (no clean exit observed) is a harness/capture-plumbing problem,
          // not the "fix attempts exhausted" test-gate class (#384).
          blockerKind: res.passed ? null : res.toolingError ? "harness-failure" : "test-gate-exhausted",
          prHeadSha,
        }),
        runStoreDeps,
      ).catch(() => {});
    }
    return res;
  };

  // Bounded retry for a run whose output capture ended abnormally (no clean
  // exit code observed — a spawn/capture error) rather than a genuine test
  // failure. Retries the command directly, without invoking the fix harness
  // and without touching the `max_attempts` fix budget (#384).
  const runWithToolingRetries = async (): Promise<{
    result: RunTestsResult;
    toolingExhausted: boolean;
  }> => {
    let result = await runAndRecord();
    let retries = 0;
    while (result.toolingError && retries < MAX_TOOLING_RETRIES) {
      retries++;
      console.log(
        `[pipeline] #${issueNumber}: test gate output capture ended abnormally ` +
          `(no clean exit observed); retrying the command (${retries}/${MAX_TOOLING_RETRIES}) ` +
          "instead of invoking the fix harness",
      );
      result = await runAndRecord();
    }
    return { result, toolingExhausted: result.toolingError };
  };

  // Require a clean worktree before the first trusted test run. If uncommitted
  // changes exist, what's tested diverges from what's committed, so the gate
  // result can't be trusted.
  if (await gitDirtyFn(wtPath)) {
    const porcelainOut = truncateHead((await gitStatusPorcelainFn(wtPath)).trim(), MAX_BLOCK_OUTPUT);
    const pathSuffix = porcelainOut ? `\n\nUncommitted paths:\n${porcelainOut}` : "";
    return {
      skipped: false,
      passed: false,
      attempts: 0,
      blockReason:
        "Worktree has uncommitted changes before the test gate ran. " +
        "All changes must be committed so test results can be trusted." +
        pathSuffix,
    };
  }

  const initialRun = await runWithToolingRetries();
  if (initialRun.toolingExhausted) {
    console.log(
      `[pipeline] #${issueNumber}: test gate tooling failure persisted after ${MAX_TOOLING_RETRIES} retries; blocking`,
    );
    return {
      skipped: false,
      passed: false,
      attempts: 0,
      blockReason: toolingFailureBlockReason(initialRun.result.output),
      toolingFailure: true,
    };
  }
  let { passed, output } = initialRun.result;
  if (passed) {
    // A passing run can still generate uncommitted artifacts (tsbuildinfo,
    // snapshots, lock-file updates). If it does, the committed state diverges
    // from what was tested — block so artifacts are committed and the gate reruns.
    if (await gitDirtyFn(wtPath)) {
      const porcelainOut = truncateHead((await gitStatusPorcelainFn(wtPath)).trim(), MAX_BLOCK_OUTPUT);
      const pathSuffix = porcelainOut ? `\n\nUncommitted paths:\n${porcelainOut}` : "";
      return {
        skipped: false,
        passed: false,
        attempts: 0,
        blockReason:
          "Test/build command left uncommitted changes in the working tree. " +
          "Commit any generated artifacts (snapshots, tsbuildinfo, lock-file updates) " +
          "so the gate certifies the exact committed state." +
          pathSuffix,
      };
    }
    console.log(`[pipeline] #${issueNumber}: test gate passed`);
    return { skipped: false, passed: true, attempts: 0 };
  }

  const harness = cfg.harnesses.implementer;
  for (let attempt = 1; attempt <= cfg.test_gate.max_attempts; attempt++) {
    console.log(
      `[pipeline] #${issueNumber}: test gate failed; fix attempt ${attempt}/${cfg.test_gate.max_attempts} (${harness})`,
    );

    const fixHeadBefore = await gitHeadFn(wtPath);

    const prompt = buildTestFixPrompt({
      cfg,
      issueNumber,
      command: label,
      attempt,
      maxAttempts: cfg.test_gate.max_attempts,
      output,
      pipelineRunId,
    });
    // Capture HEAD before the harness runs so we can inspect only its commits.
    const headBefore = await gitHeadFn(wtPath);
    const fixModel = cfg.models.fix;
    const fixRes = await invokeFn(harness, wtPath, prompt, {
      timeoutSec: cfg.fix_timeout,
      model: fixModel,
      sandbox: cfg.harness_sandbox,
      accounting: runDir
        ? {
            runDir,
            runStoreDeps,
            issue: issueNumber,
            stage: stageLabel,
            modelSlot: "fix",
            model: fixModel,
          }
        : undefined,
    });
    if (!fixRes.success) {
      const reason = fixRes.timed_out
        ? `Fix harness (${harness}) timed out after ${fixRes.duration.toFixed(0)}s on test-gate fix attempt ${attempt}.`
        : `Fix harness (${harness}) failed (exit ${fixRes.exit_code}) on test-gate fix attempt ${attempt}.`;
      return { skipped: false, passed: false, attempts: attempt, blockReason: reason };
    }

    // #131: the fix harness may have done the work without committing — salvage
    // real uncommitted changes into a commit before the clean-tree and commit
    // checks below. Only the no-new-commit case salvages; a harness that
    // committed AND left dirt still hits the dirty block (its commits must not
    // be silently amended with leftovers).
    const headAfterFix = await gitHeadFn(wtPath);
    if (headBefore && headAfterFix === headBefore && (await gitDirtyFn(wtPath))) {
      await salvageFn(wtPath, issueNumber, pipelineRunId, testFixSalvageStageLabel(issueNumber));
    }

    // Require a clean worktree after every fix attempt regardless of whether HEAD
    // advanced. If uncommitted changes remain, the test run would certify state
    // that can't be pushed as-is, defeating the gate's trust invariant.
    if (await gitDirtyFn(wtPath)) {
      return {
        skipped: false,
        passed: false,
        attempts: attempt,
        blockReason:
          "Fix harness left uncommitted changes in the working tree. " +
          "Test results can't be trusted — stage and commit the fix before re-running.",
      };
    }

    // Verify the test-fix commit message format (#68).
    if (fixHeadBefore) {
      const commitCheck = await verifyTestFixFn(wtPath, fixHeadBefore);
      if (!commitCheck.ok) {
        return { skipped: false, passed: false, attempts: attempt, blockReason: commitCheck.reason };
      }
    }

    // Validate that every commit the fix harness just created carries the
    // required Issue: and Pipeline-Run: traceability trailers. Skipped when
    // headBefore is empty (git unavailable in this environment) or when the
    // harness produced no new commits (messages list is empty).
    if (headBefore) {
      const newMessages = await gitCommitMessagesFn(wtPath, headBefore);
      const trailerErr = validateCommitTrailers(newMessages, issueNumber, pipelineRunId);
      if (trailerErr) {
        return { skipped: false, passed: false, attempts: attempt, blockReason: trailerErr };
      }
    }

    // ---- Build-artifact rebuild-and-fold (#387) ----
    // After this attempt's commit passes the clean-tree/commit-format/trailer
    // checks above and before the test command re-runs, fold any resulting
    // artifact changes from a declared build_command into that commit. A no-op
    // when cfg.build_command is unset or the attempt produced no new commit.
    const buildDeps = deps.buildSideEffects ?? {};
    const buildAttemptHead = headBefore && headAfterFix !== headBefore ? headAfterFix : null;
    if (cfg.build_command && buildAttemptHead) {
      const buildResult = await includeBuildArtifacts(wtPath, cfg.build_command, buildDeps);
      if (buildResult.ran && !buildResult.ok) {
        return {
          skipped: false,
          passed: false,
          attempts: attempt,
          blockReason: buildFailureBlockReason(cfg.build_command, buildResult.output),
        };
      }
      if (buildResult.ran && buildResult.ok && buildResult.amended) {
        console.log(
          `[pipeline] #${issueNumber}: folded build artifact(s) into test-fix attempt commit: ${buildResult.paths.join(", ")}`,
        );
      }
    }

    const retryRun = await runWithToolingRetries();
    if (retryRun.toolingExhausted) {
      console.log(
        `[pipeline] #${issueNumber}: test gate tooling failure persisted after ${MAX_TOOLING_RETRIES} retries; blocking`,
      );
      return {
        skipped: false,
        passed: false,
        attempts: attempt,
        blockReason: toolingFailureBlockReason(retryRun.result.output),
        toolingFailure: true,
      };
    }
    ({ passed, output } = retryRun.result);
    if (passed) {
      if (await gitDirtyFn(wtPath)) {
        return {
          skipped: false,
          passed: false,
          attempts: attempt,
          blockReason:
            "Test/build command left uncommitted changes in the working tree. " +
            "Commit any generated artifacts (snapshots, tsbuildinfo, lock-file updates) " +
            "so the gate certifies the exact committed state.",
        };
      }
      console.log(`[pipeline] #${issueNumber}: test gate passed after ${attempt} fix attempt(s)`);
      return { skipped: false, passed: true, attempts: attempt };
    }
  }

  return {
    skipped: false,
    passed: false,
    attempts: cfg.test_gate.max_attempts,
    blockReason: truncateTail(output, MAX_BLOCK_OUTPUT),
  };
}

/** Captured-output failure excerpt for a bounded tooling-retry exhaustion —
 *  distinct from `testGateBlockReason`'s "failed after N fix attempt(s)"
 *  test-failure wording, so an operator/recovery harness can tell a capture
 *  plumbing transient from a real regression (#384). */
function toolingFailureBlockReason(output: string): string {
  return (
    "Test/build gate tooling failure: the test command's output capture terminated " +
    `abnormally (no clean process exit observed) after ${MAX_TOOLING_RETRIES} retries. ` +
    "This indicates a capture/spawn problem in the pipeline's own tooling, not a genuine " +
    "test failure.\n\n" +
    "```\n" +
    truncateTail(output, MAX_BLOCK_OUTPUT) +
    "\n```"
  );
}

/** Format a gate failure into a markdown blocker comment body. Generic across
 *  the planning (pre-PR) and fix (pre-advance) seams. A tooling-failure block
 *  (#384) is already a fully-formed, self-describing message — returned as-is
 *  rather than wrapped in the ordinary test-failure wording, so the two stay
 *  distinguishable. */
export function testGateBlockReason(gate: TestGateResult): string {
  if (gate.toolingFailure) {
    return gate.blockReason ?? "(no output captured)";
  }
  return (
    `Test/build gate failed after ${gate.attempts ?? 0} fix attempt(s); ` +
    "the repo's own test/build command is still failing, so the item was not advanced.\n\n" +
    "```\n" +
    (gate.blockReason ?? "(no output captured)") +
    "\n```"
  );
}

// ---------------------------------------------------------------------------
// Running the command.
// ---------------------------------------------------------------------------

/**
 * Spawn the test/build command, capping output and enforcing a wall-clock
 * timeout. A non-zero exit, a timeout, or a spawn error all count as a
 * failure. When `killProcessGroup` is true (required for shell-backed
 * `bash -c` commands) the entire spawned process group is killed on timeout so
 * shell descendants do not outlive the gate.
 */
export async function runTests(
  cwd: string,
  command: ParsedCommand,
  timeoutSec: number,
  killProcessGroup = false,
  // Injectable spawn seam (#384), forwarded to runCapped — lets tests exercise
  // this real code path with a simulated capture-stream failure.
  spawnFn?: typeof spawn,
): Promise<RunTestsResult> {
  const res = await runCapped(
    command.cmd,
    command.args,
    cwd,
    timeoutSec,
    true,
    `test-gate:${command.cmd}`,
    { killProcessGroup, spawnFn },
  );
  let output = combineOutput(res);
  if (res.timed_out) {
    output = `${output}\n\n[test gate timed out after ${timeoutSec}s]`;
  }
  // A timeout is a distinct, already-handled failure mode (the command ran,
  // just too long) — a genuine spawn error (couldn't start at all) or a
  // capture-stream error (pipe broke before a clean exit was observed) are
  // both tooling errors (#384), not test failures.
  return {
    passed: res.success,
    output,
    durationSec: res.duration,
    toolingError: !!(res.spawn_error || res.capture_error),
  };
}

// ---------------------------------------------------------------------------
// Detection: first match wins. Explicit `test_gate.command` (handled by the
// caller) takes precedence over everything here.
// ---------------------------------------------------------------------------

export function detectTestCommand(repoDir: string): ParsedCommand | null {
  const pkgPath = path.join(repoDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const cmd = detectFromPackageJson(repoDir, pkgPath);
    if (cmd) return cmd;
  }
  if (fs.existsSync(path.join(repoDir, "go.mod"))) {
    return { cmd: "go", args: ["test", "./..."] };
  }
  if (fs.existsSync(path.join(repoDir, "Cargo.toml"))) {
    return { cmd: "cargo", args: ["test"] };
  }
  if (hasPytest(repoDir)) {
    return { cmd: "pytest", args: [] };
  }
  const makefile = path.join(repoDir, "Makefile");
  if (fs.existsSync(makefile) && hasMakeTestTarget(makefile)) {
    return { cmd: "make", args: ["test"] };
  }
  return null;
}

function detectFromPackageJson(repoDir: string, pkgPath: string): ParsedCommand | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const rawScripts = pkg && typeof pkg === "object" ? (pkg as { scripts?: unknown }).scripts : null;
  const scripts: Record<string, unknown> =
    rawScripts && typeof rawScripts === "object" ? (rawScripts as Record<string, unknown>) : {};
  const pm = detectPackageManager(repoDir);

  // A real `test` script wins — but skip the npm placeholder / echo stubs.
  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  if (testScript.trim() && !isStubScript(testScript)) {
    return { cmd: pm, args: ["run", "test"] };
  }

  // Otherwise fall back to a build/typecheck script if one exists.
  for (const key of ["build:check", "typecheck", "type-check", "build"]) {
    const v = scripts[key];
    if (typeof v === "string" && v.trim()) {
      return { cmd: pm, args: ["run", key] };
    }
  }
  return null;
}

function detectPackageManager(repoDir: string): string {
  if (fs.existsSync(path.join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repoDir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** True for the npm placeholder and echo-only stubs (no executable after echo).
 *  Splits on compound shell operators so `echo "..." && vitest` is NOT a stub,
 *  while `echo "Error: no test specified" && exit 1` is. */
function isStubScript(script: string): boolean {
  const cmds = script.split(/&&|\|\|?|;/).map((s) => s.trim()).filter(Boolean);
  return cmds.every((cmd) => /^echo\b|^exit\b/.test(cmd));
}

/** pytest is only auto-detected with a concrete marker — `pyproject.toml`
 *  alone is NOT sufficient (it's used by many non-pytest Python projects). */
function hasPytest(repoDir: string): boolean {
  if (fs.existsSync(path.join(repoDir, "pytest.ini"))) return true;
  if (fs.existsSync(path.join(repoDir, "conftest.py"))) return true;
  const pyproject = path.join(repoDir, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    try {
      if (fs.readFileSync(pyproject, "utf8").includes("[tool.pytest")) return true;
    } catch {
      // unreadable → treat as no marker
    }
  }
  return false;
}

function hasMakeTestTarget(makefile: string): boolean {
  try {
    return /^test[ \t]*:/m.test(fs.readFileSync(makefile, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// shellSplit: parse the `test_gate.command` override into program + argv.
// Handles unquoted whitespace, single quotes (literal), and double quotes
// (with backslash escapes for \" and \\). No shell is ever spawned.
// ---------------------------------------------------------------------------

export function shellSplit(raw: string): ParsedCommand {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        const next = raw[i + 1];
        if (next === '"' || next === "\\") {
          cur += next;
          i++;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) tokens.push(cur);
  if (tokens.length === 0) {
    throw new Error("test_gate.command is empty after parsing");
  }
  return { cmd: tokens[0], args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function formatCommand(c: ParsedCommand): string {
  return [c.cmd, ...c.args].join(" ");
}

function combineOutput(res: HarnessResult): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

/** Head-only truncation, used only for the dirty-worktree porcelain path
 *  listing (#352) — an ordered file list where the head is the useful part.
 *  Left unchanged by #384; the captured-command-output excerpt below uses the
 *  tail-biased `truncateTail` instead. */
function truncateHead(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "\n\n[…output truncated]";
}

// Head+tail elision (#384), mirroring eval.ts's tail-biased truncate (#373): a
// test runner prints setup/per-test noise first and the pass/fail summary
// last, so a head-only slice cuts off the one part that tells the operator
// what failed. Keep a head fragment and a tail fragment, eliding the middle.
function truncateTail(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const headLen = Math.floor(cap / 3);
  const tailLen = cap - headLen;
  const dropped = s.length - cap;
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  return `${head}\n\n[… ${dropped} characters truncated …]\n\n${tail}`;
}

async function defaultGitHead(cwd: string): Promise<string> {
  const res = await gitInWorktree(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return res.stdout.trim();
}

async function defaultGitDirty(cwd: string): Promise<boolean> {
  const res = await gitInWorktree(cwd, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout.trim().length > 0;
}

async function defaultGitStatusPorcelain(cwd: string): Promise<string> {
  const res = await gitInWorktree(cwd, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout;
}

/** Return the full commit messages for commits reachable from HEAD but not from
 *  `baseRef`. Uses NUL-delimited output to safely handle multi-line messages.
 *  Returns [] when there are no new commits or when git is unavailable. */
async function defaultGitCommitMessages(cwd: string, baseRef: string): Promise<string[]> {
  const res = await gitInWorktree(
    cwd,
    ["log", "--format=%x00%B", `${baseRef}..HEAD`],
    { ignoreFailure: true },
  );
  if (!res.stdout.trim()) return [];
  return res.stdout.split("\x00").map((s) => s.trim()).filter(Boolean);
}
