// Eval-gate stage (#12, #372): run the repo's eval harness after pre-merge,
// before ready-to-deploy. Disabled repos skip immediately with a log line.
//
// Exit code determines pass/fail — the pipeline never interprets scores.
// Gate mode (default): an ordinary (non-tooling) failure with attempts
// remaining routes to a bounded eval-fix round (implementer harness invoked
// with the eval output as context, commit verified and pushed, eval re-run)
// before blocking once `max_attempts` is exhausted. Advisory mode records the
// result and always advances, retrying the same command (no fix round) until
// attempts are exhausted.
// The configured `timeout` is a hard per-attempt budget: a successful fix
// round resets it, since fix-harness time is bounded separately by
// `fix_timeout`. Tooling failures (timeout/spawn error) always block
// immediately, in either mode, and never trigger a fix round.
// A pass reached after an eval-fix commit landed routes back through
// pre-merge (not directly to the next stage) so the existing review-SHA gate
// decides whether the unreviewed fix commit needs a fresh review round.
// The command is run through `sh -c` so normal shell syntax works.

import * as path from "node:path";
import {
  branchName,
  getOnDiskForIssue as defaultGetForIssue,
  gitInWorktree,
} from "../worktree.ts";
import {
  getGhActor as defaultGetGhActor,
  getIssueDetail as defaultGetIssueDetail,
  getPrCommits as defaultGetPrCommits,
  getPrForIssue as defaultGetPrForIssue,
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { invoke as defaultInvoke, runCapped, type HarnessResult, type InvokeOptions } from "../harness.ts";
import { buildEvalFixPrompt } from "../prompts/index.ts";
import { extractReviewedSha } from "./review-parsing.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import { makePipelineRunId, validateCommitTrailers } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { makeCommandRecord, makePromptRecord, recordCommand, recordPrompt } from "../evidence-bundle.ts";
import type { BlockerKind, Harness, Outcome, PipelineConfig, Stage } from "../types.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { buildStageAccountingRecord } from "../accounting.ts";
import { emitStageAccounting } from "../run-store.ts";

/** Next stage after eval-gate: shipcheck-gate when opted in, else ready-to-deploy. */
function nextAfterEval(cfg: PipelineConfig): Stage {
  return cfg.shipcheck_gate?.enabled ? "shipcheck-gate" : "ready-to-deploy";
}

const MAX_COMMENT_OUTPUT = 2000;

export interface AdvanceEvalOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir (#147); when set, the eval command is recorded
   *  under the "eval-gate" stage. Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#302). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events (#302). */
  runStoreDeps?: RunStoreDeps;
  /** Dispatch-wide run id for the eval-fix commit traceability trailers (#20, #372).
   *  Defaults to a fresh id so direct/unit-test callers that don't thread it still
   *  produce valid trailers. */
  pipelineRunId?: string;
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

/** Signature of the harness `invoke` — injectable so the eval-fix loop is unit-testable. */
export type InvokeFn = (
  harness: Harness,
  worktreeDir: string,
  prompt: string,
  opts?: InvokeOptions,
) => Promise<HarnessResult>;

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
  /** Implementer harness invoker for the eval-fix round (#372). Defaults to `invoke`
   *  from harness.ts. Injectable so the fix loop is unit-testable with no real harness. */
  invoke?: InvokeFn;
  /** Current HEAD SHA in the worktree. */
  gitHead?: (cwd: string) => Promise<string>;
  /** Whether the worktree has uncommitted changes. */
  gitDirty?: (cwd: string) => Promise<boolean>;
  /** `git push origin <branch>` after an eval-fix commit. */
  gitPush?: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
  /** Full commit messages for commits reachable from HEAD but not `baseRef`, used
   *  to validate the eval-fix commit(s) carry the required traceability trailers. */
  gitCommitMessages?: (cwd: string, baseRef: string) => Promise<string[]>;
  /** Salvage uncommitted eval-fix work into a commit (#131). Returns true when a
   *  salvage commit was created. */
  salvage?: (
    wtPath: string,
    issueNumber: number,
    pipelineRunId: string,
    stageLabel: string,
  ) => Promise<boolean>;
  /** Verify the eval-fix commit message format. Injectable for tests. */
  verifyEvalFix?: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
  /** Authenticated gh actor login, used to trust-filter review comments when
   *  deriving whether an eval-fix commit still needs review (#372 review-2
   *  finding 1). */
  getGhActor?: () => Promise<string | null>;
  /** Issue comments, used to extract the last reviewed SHA. */
  getIssueDetail?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ comments: { author: string; body: string }[] }>;
  /** Resolve the open PR for this issue, to read its commit history. */
  getPrForIssue?: (cfg: PipelineConfig, issueNumber: number) => Promise<number | null>;
  /** PR commits (oldest-first), used to detect an eval-fix commit landed since
   *  the last reviewed SHA. */
  getPrCommits?: (
    cfg: PipelineConfig,
    prNumber: number,
  ) => Promise<{ oid: string; messageHeadline: string }[]>;
}

// ---------------------------------------------------------------------------
// Eval-fix round (#372): a gate-mode ordinary failure with attempts remaining
// invokes the implementer harness with the eval output as context, verifies
// and pushes the resulting commit, then lets the caller re-run the eval.
// Mirrors the fix/test-gate failure contract (harness error / no commit /
// dirty worktree / push failure all block; never a partial push).
// ---------------------------------------------------------------------------

/** Cap on the eval output injected into the eval-fix prompt. Uses the stage's
 *  tail-biased `truncate` (below) so the pass/fail summary survives elision. */
const MAX_FIX_PROMPT_OUTPUT = 16_000;

/**
 * Stage label for a salvaged eval-fix commit. Includes the prescribed eval-fix
 * commit subject so the salvage commit body satisfies
 * `enforceEvalFixCommitFormat`'s message pattern and the loop proceeds to
 * re-run the eval command. Exported so tests can pin the label against the
 * gate's actual pattern.
 */
export function evalFixSalvageStageLabel(issueNumber: number): string {
  return `eval-fix (prescribed commit: "fix: resolve eval-gate failures (#${issueNumber})")`;
}

/**
 * Commit message pattern for a prescribed eval-fix commit. Shared by
 * {@link enforceEvalFixCommitFormat} (verifies the just-pushed commit) and
 * {@link evalFixCommitPendingReview} (durably detects an eval-fix commit that
 * landed in a prior invocation and hasn't cleared review yet).
 */
function evalFixCommitPattern(issueNumber: number): RegExp {
  return new RegExp(`fix:\\s+resolve eval-gate failures \\(#${issueNumber}\\)`, "i");
}

/**
 * Verifies that at least one commit in `headBefore..HEAD` matches the expected
 * eval-fix commit message format. Exported so tests can exercise the gate
 * without mocking the full `advanceEval` call chain.
 */
export async function enforceEvalFixCommitFormat(
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
        pattern: evalFixCommitPattern(issueNumber),
        description: "Eval-fix commit message does not match prescribed format",
      },
    },
    deps,
  );
}

/**
 * Durable replacement for an in-memory "a fix round ran this invocation" flag
 * (#372 review-2 finding 1): re-derives, purely from GitHub PR state, whether
 * an eval-fix commit has landed since the last reviewed SHA and so still
 * needs to clear pre-merge review before this pass may advance directly.
 *
 * This survives a crash/interruption between a fix-round push and this
 * stage's `transition` call, and a later invocation that resumes at
 * eval-gate after such an interruption — cases where a purely in-process
 * flag would reset to false and let an unreviewed fix commit slip through.
 *
 * Fails closed (returns `true` — route to pre-merge) on any lookup error, so
 * an unverifiable state never silently bypasses review.
 */
async function evalFixCommitPendingReview(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: {
    getGhActor: () => Promise<string | null>;
    getIssueDetail: (cfg: PipelineConfig, issueNumber: number) => Promise<{ comments: { author: string; body: string }[] }>;
    getPrForIssue: (cfg: PipelineConfig, issueNumber: number) => Promise<number | null>;
    getPrCommits: (cfg: PipelineConfig, prNumber: number) => Promise<{ oid: string; messageHeadline: string }[]>;
  },
): Promise<boolean> {
  try {
    const prNumber = await deps.getPrForIssue(cfg, issueNumber);
    if (!prNumber) return false;
    // Trust-filter to the authenticated actor's own comments, mirroring the
    // pre-merge review-SHA gate (#16) — an untrusted commenter must not be
    // able to forge a stale reviewed-SHA marker.
    const actor = await deps.getGhActor();
    const detail = await deps.getIssueDetail(cfg, issueNumber);
    const trusted = actor ? detail.comments.filter((c) => c.author === actor) : [];
    const reviewed = extractReviewedSha(trusted);
    if (!reviewed) return false; // no review has ever run for this issue — nothing to gate against
    const commits = await deps.getPrCommits(cfg, prNumber);
    const reviewedIdx = reviewed.sha ? commits.findIndex((c) => c.oid === reviewed.sha) : -1;
    // reviewedIdx === -1 (unverifiable comment, or reviewed SHA absent from
    // history) conservatively falls back to scanning every commit.
    const landedSince = reviewedIdx !== -1 ? commits.slice(reviewedIdx + 1) : commits;
    const pattern = evalFixCommitPattern(issueNumber);
    return landedSince.some((c) => pattern.test(c.messageHeadline));
  } catch {
    return true;
  }
}

interface EvalFixRoundDeps {
  invoke: InvokeFn;
  gitHead: (cwd: string) => Promise<string>;
  gitDirty: (cwd: string) => Promise<boolean>;
  gitPush: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
  gitCommitMessages: (cwd: string, baseRef: string) => Promise<string[]>;
  salvage: (wtPath: string, issueNumber: number, pipelineRunId: string, stageLabel: string) => Promise<boolean>;
  verifyEvalFix: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
}

type EvalFixRoundResult =
  | { ok: true }
  | { ok: false; reason: string; blockerKind: "harness-failure" | "push-failed" };

/**
 * Run a single eval-fix round: invoke the implementer harness with the eval
 * output as context, then verify + push the resulting commit. Returns
 * `{ ok: true }` only once a verified fix commit has been pushed — the caller
 * re-runs the eval command in that case. Never pushes a partial fix: a harness
 * error, no new commit (after salvage), a dirty worktree, or a failed push all
 * return `ok: false` and the caller blocks without re-running the eval.
 */
async function runEvalFixRound(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  slug: string,
  attempt: number,
  maxAttempts: number,
  evalOutput: string,
  pipelineRunId: string,
  opts: AdvanceEvalOpts,
  deps: EvalFixRoundDeps,
): Promise<EvalFixRoundResult> {
  const harness = cfg.harnesses.implementer;
  console.log(
    `[pipeline] #${issueNumber}: eval-gate failed; fix round ${attempt}/${maxAttempts - 1} (${harness})`,
  );

  const excerpt = truncate(evalOutput, MAX_FIX_PROMPT_OUTPUT);
  const prompt = buildEvalFixPrompt({
    cfg,
    issueNumber,
    command: cfg.eval_gate.command,
    attempt,
    maxAttempts,
    output: excerpt,
    pipelineRunId,
  });
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      "eval-gate",
      makePromptRecord(`eval-fix-${attempt}`, harness, prompt),
    ).catch(() => {});
  }

  const headBefore = await deps.gitHead(wtPath);
  const fixModel = cfg.models.fix;
  const fixRes = await deps.invoke(harness, wtPath, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: fixModel,
    sandbox: cfg.harness_sandbox,
    accounting: opts.runDir
      ? {
          runDir: opts.runDir,
          runStoreDeps: opts.runStoreDeps,
          issue: issueNumber,
          stage: "eval-gate",
          modelSlot: "fix",
          model: fixModel,
        }
      : undefined,
  });

  if (!fixRes.success) {
    const reason = fixRes.timed_out
      ? `Fix harness (${harness}) timed out after ${fixRes.duration.toFixed(0)}s on eval-gate fix round ${attempt}.`
      : `Fix harness (${harness}) failed (exit ${fixRes.exit_code}) on eval-gate fix round ${attempt}.`;
    return { ok: false, reason, blockerKind: "harness-failure" };
  }

  // #131: the harness may have done the work without committing — salvage real
  // uncommitted changes into a commit instead of discarding it.
  let headAfter = await deps.gitHead(wtPath);
  if (headBefore && headAfter && headBefore === headAfter) {
    const salvaged = await deps.salvage(wtPath, issueNumber, pipelineRunId, evalFixSalvageStageLabel(issueNumber));
    if (!salvaged) {
      return {
        ok: false,
        reason: `eval-gate fix round ${attempt} reported success but produced no new commits.`,
        blockerKind: "harness-failure",
      };
    }
    headAfter = await deps.gitHead(wtPath);
  }

  // Require a clean worktree after the fix round regardless of whether HEAD
  // advanced — an eval re-run must not certify uncommitted state.
  if (await deps.gitDirty(wtPath)) {
    return {
      ok: false,
      reason:
        `eval-gate fix round ${attempt} left uncommitted changes in the working tree. ` +
        "Eval results can't be trusted — stage and commit the fix before re-running.",
      blockerKind: "harness-failure",
    };
  }

  if (headBefore) {
    const commitCheck = await deps.verifyEvalFix(wtPath, headBefore);
    if (!commitCheck.ok) {
      return { ok: false, reason: commitCheck.reason, blockerKind: "harness-failure" };
    }

    const newMessages = await deps.gitCommitMessages(wtPath, headBefore);
    const trailerErr = validateCommitTrailers(newMessages, issueNumber, pipelineRunId);
    if (trailerErr) {
      return { ok: false, reason: trailerErr, blockerKind: "harness-failure" };
    }
  }

  const branch = branchName(issueNumber, slug);
  const push = await deps.gitPush(wtPath, branch);
  if (push.code !== 0) {
    return {
      ok: false,
      reason: `Git push failed after eval-gate fix: ${push.stderr.trim()}`,
      blockerKind: "push-failed",
    };
  }

  return { ok: true };
}

function eventTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function recordGateResult(
  opts: AdvanceEvalOpts,
  result: "pass" | "fail" | "skipped",
  mode: PipelineConfig["eval_gate"]["mode"],
  reason?: string,
): Promise<void> {
  if (!opts.runDir) return;
  await appendEvent(
    opts.runDir,
    {
      schema_version: RUN_SCHEMA_VERSION,
      type: "gate_result",
      at: eventTimestamp(),
      gate: "eval-gate",
      result,
      mode,
      reason,
    },
    opts.runStoreDeps,
  ).catch(() => {});
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
  const invokeFn = deps.invoke ?? defaultInvoke;
  const gitHeadFn = deps.gitHead ?? defaultGitHead;
  const gitDirtyFn = deps.gitDirty ?? defaultGitDirty;
  const gitPushFn = deps.gitPush ?? defaultGitPush;
  const gitCommitMessagesFn = deps.gitCommitMessages ?? defaultGitCommitMessages;
  const salvageFn = deps.salvage ?? trySalvageUncommittedWork;
  const verifyEvalFixFn =
    deps.verifyEvalFix ?? ((wtPath: string, headBefore: string) => enforceEvalFixCommitFormat(issueNumber, wtPath, headBefore));
  const getGhActorFn = deps.getGhActor ?? defaultGetGhActor;
  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getPrForIssueFn = deps.getPrForIssue ?? defaultGetPrForIssue;
  const getPrCommitsFn = deps.getPrCommits ?? defaultGetPrCommits;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  // Dry-run: no GitHub writes, no command execution. Must come before any
  // transition/setBlocked/postComment call so --dry-run is truly read-only.
  if (opts.dryRun) {
    const cmdNote = cfg.eval_gate.enabled && cfg.eval_gate.command
      ? cfg.eval_gate.command
      : "(eval-gate disabled or no command configured)";
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run eval: ${cmdNote}`);
    const dryTo = nextAfterEval(cfg);
    return { advanced: true, from: "eval-gate", to: dryTo, summary: "[dry-run]" };
  }

  // Skip path — enabled=false → swap labels silently, no comment posted.
  // In normal flow, pre-merge already skips eval-gate when disabled; this is a
  // safety net for issues that somehow arrive here with an eval-gate label.
  if (!cfg.eval_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: eval-gate step disabled; skipping.`);
    const skipTo = nextAfterEval(cfg);
    await silentTransitionFn(cfg, issueNumber, "eval-gate", skipTo);
    await recordGateResult(opts, "skipped", cfg.eval_gate.mode, "disabled");
    return { advanced: true, from: "eval-gate", to: skipTo, summary: "eval-gate disabled" };
  }

  if (!cfg.eval_gate.command) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "`eval_gate.enabled` is true but no `command` is configured. Set `eval_gate.command` in `.github/pipeline.yml`.",
      "eval-gate",
      "eval-gate-misconfigured",
    );
    return { advanced: false, status: "blocked", reason: "eval_gate.command not set", blockerKind: "eval-gate-misconfigured" };
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
    return { advanced: false, status: "blocked", reason: "no worktree", blockerKind: "worktree-missing" };
  }

  const maxAttempts = cfg.eval_gate.max_attempts;
  const timeoutSec = cfg.eval_gate.timeout;
  // Hard stage-level deadline — each attempt gets only the remaining budget.
  // Reset after a successful eval-fix round (#372): fix-round time is bounded
  // separately by fix_timeout and must not eat into the eval run's own budget.
  let stageDeadlineMs = Date.now() + timeoutSec * 1000;

  let lastResult: EvalRunResult | null = null;
  let fixRoundBlocked: { reason: string; blockerKind: "harness-failure" | "push-failed" } | null = null;

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
      // Record the timeout as a failed attempt before breaking.
      if (opts.stateDir) {
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "eval-gate",
          makeCommandRecord(cfg.eval_gate.command, 1, 0, lastResult.output),
        ).catch(() => {});
      }
      await recordEvalAccounting(opts, issueNumber, cfg.eval_gate.command, lastResult, new Date(), new Date());
      break;
    }

    if (attempt > 1) {
      console.log(`[pipeline] #${issueNumber}: eval-gate retrying (attempt ${attempt}/${maxAttempts})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: eval-gate running \`${cfg.eval_gate.command}\``);
    }
    const startedAt = new Date();
    lastResult = await runFn(cfg.eval_gate.command, wt.path, remainingSec);
    const endedAt = new Date();

    // Record each attempt immediately so retries are not collapsed into one record.
    if (opts.stateDir) {
      await recordCommand(
        opts.stateDir,
        issueNumber,
        "eval-gate",
        makeCommandRecord(
          cfg.eval_gate.command,
          lastResult.passed ? 0 : 1,
          lastResult.durationSec * 1000,
          lastResult.output,
        ),
      ).catch(() => {});
    }
    await recordEvalAccounting(opts, issueNumber, cfg.eval_gate.command, lastResult, startedAt, endedAt);

    if (lastResult.passed) break;
    // Tooling failures (timeout/spawn error) never route to a fix round, in
    // either mode — they mean the harness itself couldn't run.
    if (lastResult.timedOut || lastResult.spawnError) break;
    // Advisory mode keeps the existing plain-retry cushion (no fix round):
    // out of scope per #372, unchanged.
    if (cfg.eval_gate.mode !== "gate") continue;
    // Gate mode with no attempts remaining: fall through to the terminal block.
    if (attempt >= maxAttempts) break;

    // Gate-mode ordinary failure with an attempt remaining: route to a fix
    // round instead of blocking, then re-run the eval against the fixed code.
    const fixResult = await runEvalFixRound(
      cfg,
      issueNumber,
      wt.path,
      wt.slug,
      attempt,
      maxAttempts,
      lastResult.output,
      pipelineRunId,
      opts,
      {
        invoke: invokeFn,
        gitHead: gitHeadFn,
        gitDirty: gitDirtyFn,
        gitPush: gitPushFn,
        gitCommitMessages: gitCommitMessagesFn,
        salvage: salvageFn,
        verifyEvalFix: verifyEvalFixFn,
      },
    );
    if (!fixResult.ok) {
      fixRoundBlocked = { reason: fixResult.reason, blockerKind: fixResult.blockerKind };
      break;
    }
    stageDeadlineMs = Date.now() + timeoutSec * 1000;
  }

  if (fixRoundBlocked) {
    console.log(`[pipeline] #${issueNumber}: eval-gate fix round failed; blocking`);
    // Branch on literal kind strings (rather than passing the variable through)
    // so the static "every setBlocked call passes an explicit BlockerKind" guard
    // (blocked-recipes.test.ts) can verify each call site by source inspection.
    if (fixRoundBlocked.blockerKind === "push-failed") {
      await setBlockedFn(cfg, issueNumber, fixRoundBlocked.reason, "eval-gate", "push-failed");
    } else {
      await setBlockedFn(cfg, issueNumber, fixRoundBlocked.reason, "eval-gate", "harness-failure");
    }
    await recordGateResult(opts, "fail", cfg.eval_gate.mode, "fix_round_failed");
    return {
      advanced: false,
      status: "blocked",
      reason: fixRoundBlocked.reason,
      blockerKind: fixRoundBlocked.blockerKind,
    };
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

    // A pass reached after an eval-fix commit landed is a developer commit
    // that hasn't cleared review yet. Re-derive this purely from GitHub PR
    // state (rather than an in-memory "ran a fix round this invocation" flag,
    // which is lost across a crash/interruption or a later resumed
    // invocation — #372 review-2 finding 1) and route back through pre-merge
    // so its existing review-SHA gate (#16) decides whether a fresh review
    // round is required before the item can reach eval-gate — and
    // ready-to-deploy — again.
    const pendingReview = await evalFixCommitPendingReview(cfg, issueNumber, {
      getGhActor: getGhActorFn,
      getIssueDetail: getIssueDetailFn,
      getPrForIssue: getPrForIssueFn,
      getPrCommits: getPrCommitsFn,
    });
    if (pendingReview) {
      await transitionFn(
        cfg,
        issueNumber,
        "eval-gate",
        "pre-merge",
        `Eval gate passed in ${result.durationSec.toFixed(1)}s after an eval-fix commit. Routing back through pre-merge for review before advancing.`,
      );
      await recordGateResult(opts, "pass", cfg.eval_gate.mode, "fix_commit_needs_review");
      return {
        advanced: true,
        from: "eval-gate",
        to: "pre-merge",
        summary: `eval passed after fix round in ${result.durationSec.toFixed(1)}s; routed to pre-merge for review`,
      };
    }

    const passTo = nextAfterEval(cfg);
    await transitionFn(cfg, issueNumber, "eval-gate", passTo, `Eval gate passed. Advancing to ${passTo}.`);
    await recordGateResult(opts, "pass", cfg.eval_gate.mode);
    return {
      advanced: true,
      from: "eval-gate",
      to: passTo,
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
    await recordGateResult(opts, "fail", cfg.eval_gate.mode, "timeout");
    return { advanced: false, status: "blocked", reason: `eval gate timed out${attempts}`, blockerKind: "harness-failure" };
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
    await recordGateResult(opts, "fail", cfg.eval_gate.mode, "spawn_error");
    return { advanced: false, status: "blocked", reason: `eval gate runner error${attempts}`, blockerKind: "harness-failure" };
  }

  // Ordinary harness-owned failure (non-zero exit). Advisory mode records and advances.
  if (cfg.eval_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: eval-gate failed${attempts} (advisory mode); advancing`);
    const advisoryTo = nextAfterEval(cfg);
    await transitionFn(cfg, issueNumber, "eval-gate", advisoryTo, `Eval gate failed${attempts} (advisory mode); advancing to ${advisoryTo}.`);
    await recordGateResult(opts, "fail", cfg.eval_gate.mode, "advisory_failure");
    return { advanced: true, from: "eval-gate", to: advisoryTo, summary: `eval failed (advisory)` };
  }

  console.log(`[pipeline] #${issueNumber}: eval-gate failed${attempts} (gate mode); blocking`);
  const evalFailDetail = `Eval gate failed${attempts}.`;
  await setBlockedFn(
    cfg,
    issueNumber,
    `${evalFailDetail}\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
    "eval-gate",
    "eval-gate-failed",
  );
  await recordGateResult(opts, "fail", cfg.eval_gate.mode, "gate_failure");
  return { advanced: false, status: "blocked", reason: `eval gate failed${attempts}`, blockerKind: "eval-gate-failed" };
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

async function recordEvalAccounting(
  opts: AdvanceEvalOpts,
  issueNumber: number,
  command: string,
  result: EvalRunResult,
  startedAt: Date,
  endedAt: Date,
): Promise<void> {
  if (!opts.runDir) return;
  await emitStageAccounting(
    opts.runDir,
    buildStageAccountingRecord({
      runId: path.basename(opts.runDir),
      issue: issueNumber,
      stage: "eval-gate",
      harness: "eval-gate",
      modelSlot: null,
      model: null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: result.durationSec * 1000,
      commandCount: 1,
      subprocessCount: 1,
      outcome: result.passed ? "success" : result.timedOut ? "timeout" : result.spawnError ? "spawn_error" : "failure",
      blockerKind: result.passed
        ? null
        : result.timedOut || result.spawnError
          ? "harness-failure"
          : "eval-gate-failed",
      usage: { command },
    }),
    opts.runStoreDeps,
  ).catch(() => {});
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
// Default git implementations for the eval-fix round (injectable for tests).
// ---------------------------------------------------------------------------

async function defaultGitHead(cwd: string): Promise<string> {
  const res = await gitInWorktree(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return res.stdout.trim();
}

async function defaultGitDirty(cwd: string): Promise<boolean> {
  const res = await gitInWorktree(cwd, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout.trim().length > 0;
}

async function defaultGitPush(cwd: string, branch: string): Promise<{ code: number; stderr: string }> {
  const res = await gitInWorktree(cwd, ["push", "origin", branch], { ignoreFailure: true });
  return { code: res.code, stderr: res.stderr };
}

/** Return the full commit messages for commits reachable from HEAD but not from
 *  `baseRef`. Uses NUL-delimited output to safely handle multi-line messages.
 *  Returns [] when there are no new commits or when git is unavailable. */
async function defaultGitCommitMessages(cwd: string, baseRef: string): Promise<string[]> {
  const res = await gitInWorktree(
    cwd,
    ["log", `--format=%x00%B`, `${baseRef}..HEAD`],
    { ignoreFailure: true },
  );
  if (!res.stdout.trim()) return [];
  return res.stdout.split("\x00").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

// Head+tail elision (#373): eval harnesses print setup/per-case noise first and
// the pass/fail summary last, so a head-only slice(0, cap) shows boilerplate and
// drops the one part that tells the operator what regressed. Keep a head fragment
// (command/setup context) and a tail fragment (summary), with the middle elided.
export function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const headLen = Math.floor(cap / 3);
  const tailLen = cap - headLen;
  const dropped = s.length - cap;
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  return `${head}\n\n[… ${dropped} characters truncated …]\n\n${tail}`;
}
