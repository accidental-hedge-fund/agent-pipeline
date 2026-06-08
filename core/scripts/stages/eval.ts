// Eval-gate stage (#12): run the repo's eval harness after pre-merge, before
// ready-to-deploy. Disabled repos skip immediately with a log line.
//
// Exit code determines pass/fail — the pipeline never interprets scores.
// Gate mode (default) blocks on fail; advisory mode records and advances.
// Retries apply to ALL failures; when ALL max_attempts are exhausted, the
// stage always blocks regardless of mode (consistent failure signals broken
// tooling or an ungated regression, not a transient hiccup).

import {
  getForIssue as defaultGetForIssue,
} from "../worktree.ts";
import {
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  transition as defaultTransition,
} from "../gh.ts";
import { runCapped } from "../harness.ts";
import { shellSplit } from "../testgate.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

const MAX_COMMENT_OUTPUT = 2000;

export interface AdvanceEvalOpts {
  dryRun?: boolean;
}

// Injectable seams — default to real implementations in prod; replaced in unit tests.
export interface EvalDeps {
  runEval?: (
    cmd: string,
    args: string[],
    cwd: string,
    timeoutSec: number,
  ) => Promise<{ passed: boolean; output: string; durationSec: number }>;
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
  setBlocked?: (
    cfg: PipelineConfig,
    issueNumber: number,
    reason: string,
    stage: Stage | null,
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
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const runFn = deps.runEval ?? defaultRunEval;

  // Skip path — enabled=false or block absent → transition forward immediately.
  if (!cfg.eval_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: eval-gate step disabled; skipping.`);
    await transitionFn(cfg, issueNumber, "eval-gate", "ready-to-deploy", "eval-gate step disabled; skipping.");
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: "eval-gate disabled" };
  }

  if (!cfg.eval_gate.command) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "`eval_gate.enabled` is true but no `command` is configured. Set `eval_gate.command` in `.github/pipeline.yml`.",
      "eval-gate",
    );
    return { advanced: false, status: "blocked", reason: "eval_gate.command not set" };
  }

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run eval: ${cfg.eval_gate.command}`);
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: "[dry-run]" };
  }

  // Resolve worktree (evals run inside the issue's code).
  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "eval-gate: no worktree found for this issue. The worktree may have been removed prematurely.",
      "eval-gate",
    );
    return { advanced: false, status: "blocked", reason: "no worktree" };
  }

  const command = shellSplit(cfg.eval_gate.command);
  const maxAttempts = cfg.eval_gate.max_attempts;
  const timeoutSec = cfg.eval_gate.timeout;

  let lastResult: { passed: boolean; output: string; durationSec: number } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(`[pipeline] #${issueNumber}: eval-gate retrying (attempt ${attempt}/${maxAttempts})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: eval-gate running \`${cfg.eval_gate.command}\``);
    }
    lastResult = await runFn(command.cmd, command.args, wt.path, timeoutSec);
    if (lastResult.passed) break;
  }

  const result = lastResult!;
  const outcome = result.passed ? "PASS" : "FAIL";
  const excerpt = truncate(result.output, MAX_COMMENT_OUTPUT);

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

  // All attempts failed. If we retried (maxAttempts > 1), retries are exhausted
  // → always block regardless of mode (consistent failure, not a transient hiccup).
  const retriesExhausted = maxAttempts > 1;
  if (retriesExhausted) {
    console.log(`[pipeline] #${issueNumber}: eval-gate failed after ${maxAttempts} attempts; blocking`);
    await setBlockedFn(
      cfg,
      issueNumber,
      `Eval gate failed after ${maxAttempts} attempts.\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
      "eval-gate",
    );
    return { advanced: false, status: "blocked", reason: `eval gate: retries exhausted (${maxAttempts} attempts)` };
  }

  // Single attempt (maxAttempts == 1) → apply gate/advisory routing.
  if (cfg.eval_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: eval-gate failed (advisory mode); advancing`);
    await transitionFn(cfg, issueNumber, "eval-gate", "ready-to-deploy", "Eval gate failed (advisory mode); advancing.");
    return { advanced: true, from: "eval-gate", to: "ready-to-deploy", summary: "eval failed (advisory)" };
  }

  console.log(`[pipeline] #${issueNumber}: eval-gate failed (gate mode); blocking`);
  await setBlockedFn(
    cfg,
    issueNumber,
    `Eval gate failed.\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
    "eval-gate",
  );
  return { advanced: false, status: "blocked", reason: "eval gate failed" };
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
  cmd: string,
  args: string[],
  cwd: string,
  timeoutSec: number,
): Promise<{ passed: boolean; output: string; durationSec: number }> {
  const res = await runCapped(cmd, args, cwd, timeoutSec, false, `eval-gate:${cmd}`);
  let output = combineOutput(res);
  if (res.timed_out) {
    output += `\n\n[eval-gate timed out after ${timeoutSec}s]`;
  }
  return { passed: res.success, output, durationSec: res.duration };
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
