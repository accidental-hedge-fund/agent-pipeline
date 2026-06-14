// Eval-gate stage (#12): run the repo's eval harness after pre-merge, before
// ready-to-deploy. Disabled repos skip immediately with a log line.
//
// Exit code determines pass/fail — the pipeline never interprets scores.
// Gate mode (default) blocks on fail; advisory mode records the result and
// always advances, even after retries are exhausted.
// The configured `timeout` is a hard stage-level budget: each attempt receives
// only the remaining budget, so total wall-time never exceeds `timeout` seconds.
// The command is run through `sh -c` so normal shell syntax works.

import {
  getForIssue as defaultGetForIssue,
} from "../worktree.ts";
import {
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { runCapped } from "../harness.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { BlockerKind, Outcome, PipelineConfig, Stage } from "../types.ts";

const MAX_COMMENT_OUTPUT = 2000;

export interface AdvanceEvalOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir (#147); when set, the eval command is recorded
   *  under the "eval-gate" stage. Undefined → recording disabled. */
  stateDir?: string;
}

export interface EvalRunResult {
  passed: boolean;
  output: string;
  durationSec: number;
  /** True when the command hit the timeout budget (distinct from an ordinary harness failure). */
  timedOut: boolean;
  /** True when the process could not be spawned at all (missing binary, permission error, etc.). */
  spawnError: boolean;
}

// Injectable seams — default to real implementations in prod; replaced in unit tests.
export interface EvalDeps {
  runEval?: (
    shellCmd: string,
    cwd: string,
    timeoutSec: number,
  ) => Promise<EvalRunResult>;
  getForIssue?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ path: string; slug: string } | null>;
  transition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
    reason: string,
  ) => Promise<void>;
  /** Swap labels without posting a comment. Used for the disabled/skip path. */
  silentTransition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
  ) => Promise<void>;
  setBlocked?: (
    cfg: PipelineConfig,
    issueNumber: number,
    reason: string,
    stage: Stage | null,
    kind?: BlockerKind,
  ) => Promise<void>;
  postComment?: (
    cfg: PipelineConfig,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
}

export async function advanceEval(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceEvalOpts = {},
  deps: EvalDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: eval-gate`);

  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const runFn = deps.runEval ?? defaultRunEval;

  // Dry-run: no GitHub writes, no command execution. Must come before any
  // transition/setBlocked/postComment call so --dry-run is truly read-only.
  if (opts.dryRun) {
    const cmdNote = cfg.eval_gate.enabled && cfg.eval_gate.command
      ? cfg.eval_gate.command
      : "(eval-gate disabled or no command configured)";
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run eval: ${cmdNote}`);
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: "[dry-run]" };
  }

  // Skip path — enabled=false → swap labels silently, no comment posted.
  // In normal flow, pre-merge already skips eval-gate when disabled; this is a
  // safety net for issues that somehow arrive here with an eval-gate label.
  if (!cfg.eval_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: eval-gate step disabled; skipping.`);
    await silentTransitionFn(cfg, issueNumber, "eval-gate", "ready-to-deploy");
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: "eval-gate disabled" };
  }

  if (!cfg.eval_gate.command) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "`eval_gate.enabled` is true but no `command` is configured. Set `eval_gate.command` in `.github/pipeline.yml`.",
      "eval-gate",
      "eval-gate-misconfigured",
    );
    return { advanced: false, status: "blocked", reason: "eval_gate.command not set" };
  }

  // Resolve worktree (evals run inside the issue's code).
  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "eval-gate: no worktree found for this issue. The worktree may have been removed prematurely.",
      "eval-gate",
      "worktree-missing",
    );
    return { advanced: false, status: "blocked", reason: "no worktree" };
  }

  const maxAttempts = cfg.eval_gate.max_attempts;
  const timeoutSec = cfg.eval_gate.timeout;
  // Hard stage-level deadline — each attempt gets only the remaining budget.
  const stageDeadlineMs = Date.now() + timeoutSec * 1000;

  let lastResult: EvalRunResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingSec = Math.max(0, (stageDeadlineMs - Date.now()) / 1000);
    if (remainingSec <= 0) {
      lastResult = {
        passed: false,
        timedOut: true,
        spawnError: false,
        output: `[eval-gate stage timeout (${timeoutSec}s) exceeded before attempt ${attempt}]`,
        durationSec: timeoutSec,
      };
      break;
    }

    if (attempt > 1) {
      console.log(`[pipeline] #${issueNumber}: eval-gate retrying (attempt ${attempt}/${maxAttempts})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: eval-gate running \`${cfg.eval_gate.command}\``);
    }
    lastResult = await runFn(cfg.eval_gate.command, wt.path, remainingSec);
    if (lastResult.passed) break;
  }

  const result = lastResult!;
  const outcome = result.passed ? "PASS" : "FAIL";
  const excerpt = truncate(result.output, MAX_COMMENT_OUTPUT);

  // Evidence bundle (#147): record the eval command run. `EvalRunResult` reports
  // pass/fail, not an exit code, so synthesize 0/1. Best-effort + gated on
  // opts.stateDir, so unit tests (which don't inject one) have no fs side effects.
  if (opts.stateDir) {
    await recordCommand(
      opts.stateDir,
      issueNumber,
      "eval-gate",
      makeCommandRecord(
        cfg.eval_gate.command,
        result.passed ? 0 : 1,
        result.durationSec * 1000,
        result.output,
      ),
    ).catch(() => {});
  }

  // Always record the result on the issue.
  const commentBody = buildEvalComment({
    outcome,
    mode: cfg.eval_gate.mode,
    durationSec: result.durationSec,
    excerpt,
  });
  await postCommentFn(cfg, issueNumber, commentBody);

  if (result.passed) {
    console.log(`[pipeline] #${issueNumber}: eval-gate passed in ${result.durationSec.toFixed(1)}s`);
    await transitionFn(cfg, issueNumber, "eval-gate", "ready-to-deploy", "Eval gate passed.");
    return {
      advanced: true,
      from: "eval-gate",
      to: "ready-to-deploy",
      summary: `eval passed in ${result.durationSec.toFixed(1)}s`,
    };
  }

  const attempts = maxAttempts > 1 ? ` after ${maxAttempts} attempts` : "";

  // Tooling failures (timeout or spawn error) are always blocking regardless of mode.
  // They indicate the eval harness itself could not run, not that the code failed evals.
  if (result.timedOut) {
    console.log(`[pipeline] #${issueNumber}: eval-gate timed out${attempts}; blocking`);
    await setBlockedFn(
      cfg,
      issueNumber,
      `Eval gate timed out${attempts} (${timeoutSec}s limit).\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
      "eval-gate",
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: `eval gate timed out${attempts}` };
  }

  if (result.spawnError) {
    console.log(`[pipeline] #${issueNumber}: eval-gate runner error${attempts}; blocking`);
    await setBlockedFn(
      cfg,
      issueNumber,
      `Eval gate runner/tooling error${attempts} — the eval command could not be executed.\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
      "eval-gate",
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: `eval gate runner error${attempts}` };
  }

  // Ordinary harness-owned failure (non-zero exit). Advisory mode records and advances.
  if (cfg.eval_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: eval-gate failed${attempts} (advisory mode); advancing`);
    await transitionFn(cfg, issueNumber, "eval-gate", "ready-to-deploy", `Eval gate failed${attempts} (advisory mode); advancing.`);
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: `eval failed (advisory)` };
  }

  console.log(`[pipeline] #${issueNumber}: eval-gate failed${attempts} (gate mode); blocking`);
  await setBlockedFn(
    cfg,
    issueNumber,
    `Eval gate failed${attempts}.\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
    "eval-gate",
    "eval-gate-failed",
  );
  return { advanced: false, status: "blocked", reason: `eval gate failed${attempts}` };
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function buildEvalComment(opts: {
  outcome: "PASS" | "FAIL";
  mode: "gate" | "advisory";
  durationSec: number;
  excerpt: string;
}): string {
  return [
    "## Eval Gate",
    "",
    `**Outcome**: ${opts.outcome}`,
    `**Mode**: ${opts.mode}`,
    `**Elapsed**: ${opts.durationSec.toFixed(1)}s`,
    "",
    "### Output",
    "```",
    opts.excerpt,
    "```",
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Default command runner (injectable for tests).
// ---------------------------------------------------------------------------

async function defaultRunEval(
  shellCmd: string,
  cwd: string,
  timeoutSec: number,
): Promise<EvalRunResult> {
  const res = await runCapped("sh", ["-c", shellCmd], cwd, timeoutSec, false, `eval-gate`, {
    killProcessGroup: true,
  });
  let output = combineOutput(res);
  if (res.timed_out) {
    output += `\n\n[eval-gate timed out after ${timeoutSec}s]`;
  }
  return {
    passed: res.success,
    timedOut: res.timed_out,
    spawnError: res.spawn_error ?? false,
    output,
    durationSec: res.duration,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "\n\n[…output truncated]";
}
