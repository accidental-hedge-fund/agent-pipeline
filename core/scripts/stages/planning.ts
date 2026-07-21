// Planning stage: ready → planning → plan-review → implementing → review-1.
//
// Steps:
//   1. Generate the plan via the primary/implementer harness (just text, no code).
//   2. Post the plan as a comment, transition ready → planning.
//   3. Transition planning → plan-review and invoke the secondary/reviewer harness.
//   4. Send reviewer feedback back to the primary harness and require a revised plan.
//   5. Create the worktree.
//   6. Transition plan-review → implementing.
//   7. Run the primary implementer harness in the worktree against the revised impl prompt.
//   8. Verify commits exist, push branch, create PR, transition implementing → review-1.

import {
  addLabel,
  createPr,
  extractHumanPlanComments,
  getIssueDetail,
  getOpenIssues,
  getPrForBranch,
  getPrForIssue,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import {
  buildContextSnapshot,
  renderContextSnapshotBlock,
  detectConflicts,
  renderConflictWarningBlock,
  CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT,
  PRE_PLANNING_CONTEXT_HEADER,
} from "../issue-context-snapshot.ts";
import * as path from "node:path";
import { invoke, formatStderrExcerpt, papercutIdentityEnv, type HarnessResult, type InvokeOptions } from "../harness.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import { expandAutoEffort, resolveReviewerModelForHarness, reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { invokeStageExecutor, resolveStageExecutor, type ExecutorHttpDeps } from "../executors.ts";
import {
  branchName,
  createWorktree,
  getForIssue,
  getOnDiskForIssue,
  gitInWorktree,
  hasCommitsAhead,
  removeWorktree,
  slugify,
} from "../worktree.ts";
import { detectAndInstall, type SetupResult } from "../worktree-setup.ts";
import {
  buildImplementingPrompt,
  buildPlanningOpenspecPrompt,
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
} from "../prompts/index.ts";
import { runTestGate } from "../testgate.ts";
import { runFormatGate, runFormatAndTestGates } from "./format-gate.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { detectIgnoredArtifacts } from "../ignored-artifact-warning.ts";
import * as openspec from "../openspec.ts";
import * as last30days from "../last30days.ts";
import { setLivePlanningMarker, clearLivePlanningMarker, isLivePlanningActive } from "../lock.ts";
import {
  verifyHarnessCommits,
  verifyPlanRevisionOutput,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import type { Harness, Outcome, PipelineConfig, Stage, StageOutcome } from "../types.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { recordStage } from "../evidence-bundle.ts";
import { INJECTION_PATTERNS } from "../artifact-sanitize.ts";

// ---------------------------------------------------------------------------
// OpenSpec project-config commit — exported for unit testing (#352)
// ---------------------------------------------------------------------------

/**
 * Injectable seams for {@link commitOpenspecProjectConfig}.
 * All three default to the real `gitInWorktree` wrappers.
 */
export interface CommitOpenspecConfigDeps {
  /** `git status --porcelain -- openspec/config.yaml` — returns raw output. */
  gitStatus?: (wtPath: string) => Promise<string>;
  /** `git add -- openspec/config.yaml` */
  gitAdd?: (wtPath: string) => Promise<void>;
  /** `git commit -m <message> -- <path>` in the worktree — path is always "openspec/config.yaml". */
  gitCommit?: (wtPath: string, message: string, path: string) => Promise<void>;
}

async function defaultConfigGitStatus(wtPath: string): Promise<string> {
  const res = await gitInWorktree(
    wtPath,
    ["status", "--porcelain", "--", "openspec/config.yaml"],
    { ignoreFailure: true },
  );
  return res.stdout;
}

async function defaultConfigGitAdd(wtPath: string): Promise<void> {
  await gitInWorktree(wtPath, ["add", "--", "openspec/config.yaml"]);
}

async function defaultConfigGitCommit(wtPath: string, message: string, path: string): Promise<void> {
  await gitInWorktree(wtPath, ["commit", "-m", message, "--", path]);
}

/**
 * When `openspec/config.yaml` is untracked or modified after OpenSpec authoring,
 * commit it so the test gate does not see it as a dirty file. When the file is
 * already tracked and unmodified (or absent), this is a no-op (#352).
 *
 * The commit is scoped to `openspec/config.yaml` only, carries `Issue:` /
 * `Pipeline-Run:` trailers, and is placed BEFORE `verifyHarnessCommits` so it
 * falls inside the verified commit range and satisfies the `allowPattern:
 * /^openspec\//` guard.
 */
export async function commitOpenspecProjectConfig(
  wtPath: string,
  issueNumber: number,
  pipelineRunId: string,
  deps: CommitOpenspecConfigDeps = {},
): Promise<void> {
  const doGitStatus = deps.gitStatus ?? defaultConfigGitStatus;
  const doGitAdd = deps.gitAdd ?? defaultConfigGitAdd;
  const doGitCommit = deps.gitCommit ?? defaultConfigGitCommit;

  const status = (await doGitStatus(wtPath)).trim();
  if (!status) return; // already tracked and unmodified — no-op

  await doGitAdd(wtPath);
  await doGitCommit(
    wtPath,
    withTrailers(`chore: track openspec/config.yaml (#${issueNumber})`, issueNumber, pipelineRunId),
    "openspec/config.yaml",
  );
}

// ---------------------------------------------------------------------------
// Worktree bootstrap (create + dependency install) — exported for unit testing
// ---------------------------------------------------------------------------

export interface BootstrapWorktreeDeps {
  createWorktree?: (cfg: PipelineConfig, issueNumber: number, slug: string) => Promise<{ path: string; branch: string }>;
  detectAndInstall?: (worktreePath: string, cfg: Pick<PipelineConfig, "setup_command">) => Promise<SetupResult>;
  removeWorktree?: (cfg: PipelineConfig, issueNumber: number, slug: string) => Promise<void>;
}

export type BootstrapResult =
  | { ok: true; wt: { path: string; branch: string }; setupCommand?: string }
  | { ok: false; reason: string; tag: "worktree-creation-failed" | "worktree-setup-failed" };

/**
 * Create a worktree and run the dependency install step. On install failure,
 * removes the just-created worktree before returning so that `countActive()`
 * on the next retry does not count this failed issue against the capacity limit
 * (fixing finding 1 from review-2: stale worktree blocks retry at max_concurrent).
 *
 * Called at the start of both planning paths so install failures block before
 * any planning, review, or test stage executes (finding 2 from review-2).
 */
export async function bootstrapWorktree(
  cfg: PipelineConfig,
  issueNumber: number,
  slug: string,
  deps: BootstrapWorktreeDeps = {},
): Promise<BootstrapResult> {
  const cwFn = deps.createWorktree ?? createWorktree;
  const daiFn = deps.detectAndInstall ?? detectAndInstall;
  const rwFn = deps.removeWorktree ?? removeWorktree;

  let wt: { path: string; branch: string };
  try {
    wt = await cwFn(cfg, issueNumber, slug);
    console.log(`[pipeline] #${issueNumber}: worktree at ${wt.path}`);
  } catch (err) {
    return { ok: false, reason: (err as Error).message, tag: "worktree-creation-failed" };
  }

  try {
    const setup = await daiFn(wt.path, cfg);
    if (!setup.skipped) {
      console.log(`[pipeline] #${issueNumber}: worktree setup complete (${setup.command})`);
    }
    return { ok: true, wt, setupCommand: setup.skipped ? undefined : setup.command };
  } catch (err) {
    await rwFn(cfg, issueNumber, slug).catch(() => {});
    return { ok: false, reason: (err as Error).message, tag: "worktree-setup-failed" };
  }
}

export interface AdvanceOpts {
  dryRun?: boolean;
  /** Optional model override forwarded to harnesses that support it. */
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
  /** Evidence-bundle run/state dir (#147); when set, the test gate records its
   *  command runs under the active implementation stage. Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#155). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` so events also stream to stdout under
   *  `--json-events` (#155). Undefined → events go to events.jsonl only. */
  runStoreDeps?: RunStoreDeps;
  /** Injectable HTTP deps for external stage executor dispatch (#314). Tests
   *  supply a fake `fetchImpl` so no real network call is made. */
  executorHttpDeps?: ExecutorHttpDeps;
}

// ---------------------------------------------------------------------------
// PlanningPhaseHooks — strategy interface parameterizing runPlanningPhases
// ---------------------------------------------------------------------------

/**
 * Strategy interface that parameterizes the shared planning-phase runner for
 * both freeform and OpenSpec flows. Each hook corresponds to a step where the
 * two flows diverge.
 */
export interface PlanningPhaseHooks {
  /**
   * Author the planning artifact (freeform plan or OpenSpec change). Called after
   * the worktree is created and carry-forward context is gathered.
   */
  authorArtifact(
    cfg: PipelineConfig,
    issueNumber: number,
    wt: { path: string; branch: string },
    opts: AdvanceOpts,
    carryForward: string,
    pipelineRunId: string,
    deps: RunPlanningPhasesDeps,
    contextSnapshot?: string,
    crossRepoContext?: string,
  ): Promise<
    | {
        ok: true;
        /** Text posted in the `## Implementation Plan` comment (may include a decorative header). */
        planText: string;
        /**
         * Raw plan text passed to review and revision prompts. When absent, `planText` is
         * used; for OpenSpec the comment body has a decorative prefix that is stripped here.
         */
        promptPlanText?: string;
        specContext: string;
        readyToPlanningMsg: string;
      }
    | { ok: false; reason: string; tag: string }
  >;

  /**
   * Validate the artifact after authoring (e.g. OpenSpec structural check).
   * Freeform always returns `{ ok: true }`.
   */
  validateArtifact(wt: { path: string }): Promise<
    | { ok: true }
    | { ok: false; reason: string; tag: string; blockStage: Stage }
  >;

  /**
   * Re-validate and re-read the artifact after plan revision. Returns the
   * (potentially updated) planText and specContext.
   */
  revalidateArtifact(wt: { path: string }, revisionStdout: string): Promise<
    | { ok: true; updatedPlanText: string; updatedSpecContext: string }
    | { ok: false; reason: string; tag: string }
  >;

  /** Build the PR body from the plan excerpt and harness names. */
  buildPrBody(
    cfg: PipelineConfig,
    issueNumber: number,
    title: string,
    planExcerpt: string,
    primary: string,
    reviewer: string,
  ): string;

  /** Build the transition message for the implementing → review-1 transition. */
  buildTransitionMessage(prNumber: number, primary: string, reviewer: string): string;

  /** Transition message for planning → plan-review. */
  planToReviewMsg(primary: string, reviewer: string): string;

  /** Transition message for plan-review/planning → implementing. */
  preImplTransitionMsg(primary: string, reviewer: string, planReviewEnabled: boolean): string;

  /** Header lines for the `## Revised Implementation Plan` comment. */
  revisedPlanHeaderLines(primary: string, reviewer: string, humanComments: { author: string }[]): string[];

  /** Build the implementation plan string passed to the implementing prompt. */
  buildImplPlan(wt: { path: string }, revisedPlanText: string): string | Promise<string>;

  /**
   * Returns the working directory for the plan reviewer. When absent, defaults
   * to `cfg.repo_dir`. OpenSpec implementations return `wt.path` so the
   * reviewer can inspect the just-authored change files in the issue worktree.
   */
  planReviewCwd?(wt: { path: string }): string;

  /**
   * Override how the plan-revision harness is invoked. When absent, falls back
   * to `invokePlanStep` (which uses `cfg.repo_dir` for non-sandboxed runs). The
   * OpenSpec implementation sets this so the revision harness runs in `wt.path`
   * and can update the OpenSpec change files in the issue worktree.
   */
  invokeRevision?(
    primary: Harness,
    wt: { path: string },
    prompt: string,
    cfg: PipelineConfig,
    opts: AdvanceOpts,
    deps: RunPlanningPhasesDeps,
    issueNumber?: number,
  ): Promise<HarnessResult>;
}

// ---------------------------------------------------------------------------
// RunPlanningPhasesDeps — injectable seams for runPlanningPhases
// ---------------------------------------------------------------------------

type RunPlanningPhasesDeps = BootstrapWorktreeDeps &
  PlanStepDeps &
  ImplementerInvokeDeps &
  ResumeFromImplementingDeps &
  CrossRepoContextDeps &
  CommitOpenspecConfigDeps & {
    getIssueDetail?: typeof getIssueDetail;
    setBlocked?: typeof setBlocked;
    transition?: typeof transition;
    postComment?: typeof postComment;
    addLabel?: typeof addLabel;
    invokeReviewer?: typeof invokeReviewer;
    hasCommitsAhead?: typeof hasCommitsAhead;
    gitInWorktree?: typeof gitInWorktree;
    recordStage?: typeof recordStage;
    appendEvent?: typeof appendEvent;
    /** Overrides `openspec.isInitialized` for unit tests that cannot set up a real worktree. */
    openspecIsInitialized?: (path: string) => boolean;
  };

interface PlanningLifecycle {
  stage: Stage;
  headBefore: string;
  closed: boolean;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function currentHead(
  wtPath: string | undefined,
  gitFn: typeof gitInWorktree,
): Promise<string> {
  if (!wtPath) return "";
  const result = await gitFn(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return result.stdout.trim();
}

async function commitsSince(
  wtPath: string | undefined,
  baseBranch: string,
  headBefore: string,
  gitFn: typeof gitInWorktree,
): Promise<string[]> {
  if (!wtPath) return [];
  const rangeStart = headBefore || `origin/${baseBranch}`;
  const result = await gitFn(
    wtPath,
    ["log", "--pretty=format:%H", `${rangeStart}..HEAD`],
    { ignoreFailure: true },
  );
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function startPlanningLifecycle(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  opts: AdvanceOpts,
  deps: RunPlanningPhasesDeps,
  wtPath?: string,
): Promise<PlanningLifecycle> {
  const at = nowIso();
  const doRecordStage = deps.recordStage ?? recordStage;
  const doAppendEvent = deps.appendEvent ?? appendEvent;
  const doGit = deps.gitInWorktree ?? gitInWorktree;
  if (opts.stateDir) {
    await doRecordStage(opts.stateDir, issueNumber, { stage, enteredAt: at }).catch(() => {});
  }
  if (opts.runDir) {
    await doAppendEvent(
      opts.runDir,
      { schema_version: RUN_SCHEMA_VERSION, type: "stage_start", at, stage },
      opts.runStoreDeps,
    ).catch(() => {});
  }
  return {
    stage,
    headBefore: await currentHead(wtPath, doGit),
    closed: false,
  };
}

async function completePlanningLifecycle(
  cfg: PipelineConfig,
  issueNumber: number,
  lifecycle: PlanningLifecycle,
  opts: AdvanceOpts,
  deps: RunPlanningPhasesDeps,
  outcome: StageOutcome,
  wtPath?: string,
): Promise<void> {
  if (lifecycle.closed) return;
  lifecycle.closed = true;
  const at = nowIso();
  const doRecordStage = deps.recordStage ?? recordStage;
  const doAppendEvent = deps.appendEvent ?? appendEvent;
  const doGit = deps.gitInWorktree ?? gitInWorktree;
  const commits = await commitsSince(wtPath, cfg.base_branch, lifecycle.headBefore, doGit);
  if (opts.stateDir) {
    await doRecordStage(opts.stateDir, issueNumber, {
      stage: lifecycle.stage,
      exitedAt: at,
      outcome,
      commits,
    }).catch(() => {});
  }
  if (opts.runDir) {
    await doAppendEvent(
      opts.runDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        type: "stage_complete",
        at,
        stage: lifecycle.stage,
        outcome,
        commits,
      },
      opts.runStoreDeps,
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shared planning-phase runner — exported for tests
// ---------------------------------------------------------------------------

/**
 * Shared implementation of the planning → plan-review → implementing → review-1
 * sequence, parameterized by `PlanningPhaseHooks` so both the freeform and
 * OpenSpec flows can delegate here without duplicating the state machine.
 */
export async function runPlanningPhases(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  body: string,
  pipelineRunId: string,
  opts: AdvanceOpts,
  hooks: PlanningPhaseHooks,
  deps: RunPlanningPhasesDeps = {},
): Promise<Outcome> {
  const doSetBlocked = deps.setBlocked ?? setBlocked;
  const doTransition = deps.transition ?? transition;
  const doPostComment = deps.postComment ?? postComment;
  const doAddLabel = deps.addLabel ?? addLabel;
  const doInvokeReviewer = deps.invokeReviewer ?? invokeReviewer;
  const doHasCommitsAhead = deps.hasCommitsAhead ?? hasCommitsAhead;
  const doGitInWorktree = deps.gitInWorktree ?? gitInWorktree;

  const primary: Harness = cfg.harnesses.implementer;
  const reviewer: string = cfg.harnesses.reviewer;
  let wt: { path: string; branch: string } | undefined;
  let activeLifecycle = await startPlanningLifecycle(cfg, issueNumber, "planning", opts, deps);

  if (!opts.dryRun) {
    await doTransition(cfg, issueNumber, "ready", "planning", `Planning started by ${primary}.`);
  }

  // Tag the primary harness early for visibility in transition/blocker comments.
  try {
    await doAddLabel(cfg, issueNumber, `harness:${primary}`);
  } catch {
    /* idempotent */
  }

  try {

  // ---- Step 0: optional carry-forward context (last30days) + cross-repo context ----
  const [carryForward, crossRepoContext] = await Promise.all([
    gatherCarryForward(cfg, issueNumber, title, body),
    gatherCrossRepoContext(cfg, issueNumber, deps),
  ]);

  // ---- Worktree bootstrap: create + dependency install ----
  // NOTE: snapshot is gathered AFTER bootstrap so any human comments posted
  // during the bootstrap window (dep installs can be slow) are captured (#318).
  const slug = slugify(title) || `issue-${issueNumber}`;
  const bootstrap = await bootstrapWorktree(cfg, issueNumber, slug, deps);
  if (!bootstrap.ok) {
    const bootstrapMsg = bootstrap.tag === "worktree-creation-failed"
      ? `Worktree creation failed: ${bootstrap.reason}`
      : `Worktree setup failed: ${bootstrap.reason}`;
    await doSetBlocked(cfg, issueNumber, bootstrapMsg, "planning", bootstrap.tag);
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked");
    return { advanced: false, status: "blocked", reason: bootstrap.reason };
  }
  wt = bootstrap.wt;
  activeLifecycle.headBefore = await currentHead(wt.path, doGitInWorktree);
  if (opts.runDir) {
    await appendEvent(opts.runDir, { schema_version: RUN_SCHEMA_VERSION, type: "worktree_created", at: nowIso(), _localPath: wt.path }, opts.runStoreDeps).catch(() => {});
  }

  // ---- Step 0b: pre-planning context snapshot (human comments) ----
  // Gathered after bootstrap so comments posted during the bootstrap window are included.
  const contextSnapshot = await gatherContextSnapshot(cfg, issueNumber, body, deps);

  // ---- Author the planning artifact ----
  const authorResult = await hooks.authorArtifact(cfg, issueNumber, wt, opts, carryForward, pipelineRunId, deps, contextSnapshot, crossRepoContext);
  if (!authorResult.ok) {
    await doSetBlocked(cfg, issueNumber, authorResult.reason, "planning", authorResult.tag);
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
    return { advanced: false, status: "blocked", reason: authorResult.reason };
  }
  let planText = authorResult.planText;
  // `promptPlanText` is the version passed to review/revision prompts — for OpenSpec
  // the comment includes a decorative header that should not appear in prompts.
  let promptPlanText = authorResult.promptPlanText ?? planText;
  let specContext = authorResult.specContext;

  // ---- Validate the artifact structurally ----
  const validateResult = await hooks.validateArtifact(wt);
  if (!validateResult.ok) {
    await doSetBlocked(cfg, issueNumber, validateResult.reason, validateResult.blockStage, validateResult.tag);
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
    return { advanced: false, status: "blocked", reason: validateResult.reason };
  }
  // #352 (round 2): openspec.validateItem inside validateArtifact can also trigger
  // ensureDefaultConfig, leaving config.yaml dirty after the authorArtifact commit.
  // Repeat the config-commit so no validate call leaves the file untracked.
  await commitOpenspecProjectConfig(wt.path, issueNumber, pipelineRunId, deps);

  // ---- Post plan comment ----
  const planComment = `## Implementation Plan\n\n${planText}${footer(cfg)}`;
  await doPostComment(cfg, issueNumber, planComment);

  // ---- Plan review + revision (skippable via steps.plan_review) ----
  let revisedPlan = planText;
  let preImplStage: Stage = "planning";
  if (cfg.steps.plan_review) {
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "advanced", wt.path);
    await doTransition(
      cfg,
      issueNumber,
      "planning",
      "plan-review",
      hooks.planToReviewMsg(primary, reviewer),
    );
    activeLifecycle = await startPlanningLifecycle(cfg, issueNumber, "plan-review", opts, deps, wt.path);
    preImplStage = "plan-review";

    const reviewPrompt = buildPlanReviewPrompt({ cfg, issueNumber, title, body, plan: promptPlanText, reviewer, implementer: primary, specContext, contextSnapshot });
    // #39: same-harness fallback — if the reviewer CLI is unspawnable, the
    // implementing harness reviews the plan, clearly labeled below.
    // OpenSpec hooks supply planReviewCwd=wt.path so the reviewer can inspect
    // the just-authored change files; freeform uses cfg.repo_dir.
    const planReviewCwd = hooks.planReviewCwd ? hooks.planReviewCwd(wt) : cfg.repo_dir;
    const planReviewModel = resolveReviewerModelForHarness(
      opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review,
      reviewer,
      reviewerModelSourceWasAuto(cfg, opts.model),
    );
    // Plan-review's effort is sourced from cfg.plan_review_effort (derived from
    // effort.planning, classified Adversarial/Definitive — see stage-routing.ts),
    // with a structured review_harness.effort override taking precedence when set.
    const planReviewEffort = expandAutoEffort(cfg.harnesses.reviewerEffort, "plan-review", "claude") ?? cfg.plan_review_effort;
    // External stage executor delegation (#314): a `stage_executors` assignment
    // for plan-review bypasses the local reviewer harness (and its #39
    // self-review fallback) entirely — a deliberate operator choice, never
    // silently degraded.
    const planReviewAssignment = resolveStageExecutor(cfg, "plan-review");
    const { result: reviewResult, effectiveReviewer: planReviewer, selfReview: planSelfReview } =
      planReviewAssignment
        ? {
            result: (await invokeStageExecutor(
              "plan-review",
              cfg,
              reviewPrompt,
              {
                timeoutSec: cfg.plan_review_timeout,
                accounting: opts.runDir
                  ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: issueNumber, stage: "plan-review", modelSlot: "review" }
                  : undefined,
              },
              opts.executorHttpDeps,
            ))!,
            effectiveReviewer: planReviewAssignment.name,
            selfReview: false,
          }
        : await doInvokeReviewer(reviewer, primary, planReviewCwd, reviewPrompt, {
            timeoutSec: cfg.plan_review_timeout,
            model: planReviewModel,
            reasoningEffort: planReviewEffort,
            accounting: accountingForInvoke(opts, issueNumber, "plan-review", "review", planReviewModel),
          });
    if (!reviewResult.success || !reviewResult.stdout.trim()) {
      const reason = reviewResult.timed_out
        ? `Plan review timed out after ${reviewResult.duration.toFixed(0)}s`
        : `Plan review failed (exit ${reviewResult.exit_code})`;
      const stderrExcerpt = formatStderrExcerpt(reviewResult.stderr);
      const blockMsg = planSelfReview
        ? `Neither the cross-harness reviewer (${reviewer}) nor the implementing harness (${primary}) is installed/spawnable for a plan self-review — ${reason}${stderrExcerpt}`
        : `Plan-review harness (${reviewer}) failed: ${reason}${stderrExcerpt}`;
      await doSetBlocked(cfg, issueNumber, blockMsg, "plan-review", "harness-failure");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason };
    }
    const planReview = reviewResult.stdout.trim();
    if (!planReview.includes("## Plan Review Verdict")) {
      const reason = `plan-review output missing required "## Plan Review Verdict" section — the reviewer returned prose instead of a structured verdict`;
      await doSetBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason };
    }
    const planReviewBanner = planSelfReview ? `${selfReviewBanner(reviewer, planReviewer)}\n\n` : "";
    await doPostComment(cfg, issueNumber, `## Plan Review\n\n${planReviewBanner}**Reviewer**: ${planReviewer}\n**Implementer**: ${primary}\n\n${planReview}${footer(cfg)}`);

    // #26: re-fetch comments so any human feedback left on the posted plan
    // during the reviewer run flows into the revision alongside the reviewer's.
    const doGetIssueDetail = deps.getIssueDetail ?? getIssueDetail;
    const humanComments = extractHumanPlanComments(
      (await doGetIssueDetail(cfg, issueNumber)).comments,
      planComment,
    );

    const revisionPrompt = buildPlanRevisionPrompt({ cfg, issueNumber, title, body, plan: promptPlanText, feedback: planReview, reviewer, implementer: primary, humanFeedback: formatHumanFeedback(humanComments), specContext });
    const revisionResult = hooks.invokeRevision
      ? await hooks.invokeRevision(primary, wt, revisionPrompt, cfg, opts, deps, issueNumber)
      : await invokePlanStep(primary, wt.path, revisionPrompt, cfg, opts, { invoke: deps.invoke }, { issue: issueNumber, stage: "plan-review" });
    if (!revisionResult.success || !revisionResult.stdout.trim()) {
      const reason = revisionResult.timed_out
        ? `Plan revision timed out after ${revisionResult.duration.toFixed(0)}s`
        : `Plan revision failed (exit ${revisionResult.exit_code})`;
      await doSetBlocked(cfg, issueNumber, `Plan revision by ${primary} failed: ${reason}`, "plan-review", "harness-failure");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason };
    }
    // Verify the plan-revision output includes the required acknowledgement section (#68).
    const ackCheck = verifyPlanRevisionOutput(revisionResult.stdout, planReview);
    if (!ackCheck.ok) {
      await doSetBlocked(cfg, issueNumber, ackCheck.reason, "plan-review", "needs-human");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason: ackCheck.reason };
    }
    if (ackCheck.warning) {
      console.warn(`[pipeline] #${issueNumber}: plan-revision warning — ${ackCheck.warning}`);
    }

    // Re-validate and re-read artifact after revision (OpenSpec re-reads proposal; freeform is a no-op).
    const rv = await hooks.revalidateArtifact(wt, revisionResult.stdout.trim());
    if (!rv.ok) {
      await doSetBlocked(cfg, issueNumber, rv.reason, "plan-review", rv.tag);
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason: rv.reason };
    }
    revisedPlan = rv.updatedPlanText;
    specContext = rv.updatedSpecContext || specContext;
    // #352 (round 2): revalidateArtifact calls openspec.validateItem which can also
    // trigger ensureDefaultConfig — commit any dirty config.yaml it leaves behind.
    await commitOpenspecProjectConfig(wt.path, issueNumber, pipelineRunId, deps);

    if (!validateHumanFeedbackAck(revisedPlan, humanComments)) {
      const commenters = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
      const reason = `Plan revision by ${primary} is missing the required "${HUMAN_FEEDBACK_ACK_HEADER}" section for human comments from ${commenters}`;
      await doSetBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason };
    }
    await doPostComment(
      cfg,
      issueNumber,
      `## Revised Implementation Plan\n\n${hooks.revisedPlanHeaderLines(primary, reviewer, humanComments).join("\n")}\n\n${revisedPlan}${footer(cfg)}`,
    );
  } else {
    console.log(`[pipeline] #${issueNumber}: plan-review step disabled; implementing from the original artifact`);
  }

  // ---- → implementing ----
  await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "advanced", wt.path);
  await doTransition(
    cfg,
    issueNumber,
    preImplStage,
    "implementing",
    hooks.preImplTransitionMsg(primary, reviewer, cfg.steps.plan_review),
  );
  activeLifecycle = await startPlanningLifecycle(cfg, issueNumber, "implementing", opts, deps, wt.path);

  // ---- Build implementation plan and invoke implementer harness ----
  const implPlan = await hooks.buildImplPlan(wt, revisedPlan);
  const implPrompt = buildImplementingPrompt({ cfg, issueNumber, title, body, plan: implPlan, pipelineRunId, docsEnabled: cfg.steps.docs, specContext });
  const implHeadBefore = (
    await doGitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const result = await invokeImplementer(primary, wt.path, implPrompt, cfg, opts, { invoke: deps.invoke }, { issue: issueNumber, stage: "implementing" });

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await doSetBlocked(
      cfg,
      issueNumber,
      `Implementation harness (${primary}) failed: ${reason}`,
      "implementing",
      "harness-failure",
    );
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
    return { advanced: false, status: "blocked", reason };
  }

  console.log(
    `[pipeline] #${issueNumber}: implementation done (${result.duration.toFixed(0)}s, harness=${primary})`,
  );

  // #131: the implementer may have done the work without committing — salvage
  // real uncommitted changes into a commit before the no-commit checks below.
  await salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "implement", implHeadBefore);

  // ---- Verify commits ----
  const ahead = await doHasCommitsAhead(wt.path, cfg.base_branch);
  if (!ahead) {
    await doSetBlocked(
      cfg,
      issueNumber,
      `Implementation harness (${primary}) completed but produced no commits.`,
      "implementing",
      "no-commits",
    );
    await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
    return { advanced: false, status: "blocked", reason: "no commits produced" };
  }

  // ---- Verify implementation commit references the issue (#68) ----
  if (implHeadBefore) {
    const implCheck = await enforceImplCommitRef(issueNumber, wt.path, implHeadBefore);
    if (!implCheck.ok) {
      await doSetBlocked(cfg, issueNumber, implCheck.reason, "implementing", "needs-human");
      await completePlanningLifecycle(cfg, issueNumber, activeLifecycle, opts, deps, "blocked", wt.path);
      return { advanced: false, status: "blocked", reason: implCheck.reason };
    }
  }

  // #445: advisory-only — warn when the implementing commit(s) left a
  // gitignored, change-referenced artifact uncommitted. Never blocks.
  if (implHeadBefore) {
    const implHeadAfter = (
      await doGitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
    ).stdout.trim();
    await detectIgnoredArtifacts(wt.path, implHeadBefore, implHeadAfter, {
      emitEvent: (files) =>
        opts.runDir
          ? appendEvent(
              opts.runDir,
              { schema_version: RUN_SCHEMA_VERSION, type: "ignored_artifact_warning", at: nowIso(), stage: "implementing", files },
              opts.runStoreDeps,
            ).catch(() => {})
          : undefined,
    });
  }

  // ---- Build PR body and hand off to post-implementation steps ----
  const planExcerpt = revisedPlan.length > 2000 ? revisedPlan.slice(0, 2000) + "\n\n[…plan truncated]" : revisedPlan;
  const prBody = hooks.buildPrBody(cfg, issueNumber, title, planExcerpt, primary, reviewer);

  const resumeOutcome = await resumeFromImplementing(cfg, issueNumber, wt, {
    prTitle: `[Pipeline] ${title} (#${issueNumber})`,
    prBody,
    transitionMessage: (prNumber) => hooks.buildTransitionMessage(prNumber, primary, reviewer),
    pipelineRunId,
    stateDir: opts.stateDir,
    runDir: opts.runDir,
    runStoreDeps: opts.runStoreDeps,
  }, deps);
  await completePlanningLifecycle(
    cfg,
    issueNumber,
    activeLifecycle,
    opts,
    deps,
    resumeOutcome.advanced ? "advanced" : resumeOutcome.status === "blocked" ? "blocked" : resumeOutcome.status === "error" ? "error" : "skipped",
    wt.path,
  );
  return resumeOutcome;
  } catch (err) {
    await completePlanningLifecycle(
      cfg,
      issueNumber,
      activeLifecycle,
      opts,
      deps,
      "error",
      wt?.path,
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// advance — freeform entry point
// ---------------------------------------------------------------------------

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts = {},
): Promise<Outcome> {
  // Set a repo-stable marker so that a concurrent process using a different
  // domain (different worktree basename) can distinguish a live planning run
  // from a crash-stranded one (#271 review-2 finding 1).
  setLivePlanningMarker(cfg.repo, issueNumber);
  try {
    if (openspec.shouldPlanWithOpenspec(cfg, cfg.repo_dir)) {
      return await advanceOpenspec(cfg, issueNumber, opts);
    }

    const detail = await getIssueDetail(cfg, issueNumber);
    const title = detail.title;
    const body = detail.body;

    const primary: Harness = cfg.harnesses.implementer;
    // `reviewer` may be a custom reviewer CLI (`review_harness`, #40), so it is a
    // `string`; the implementer fallback (`primary`) is always a built-in Harness.
    const reviewer: string = cfg.harnesses.reviewer;
    const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

    console.log(`[pipeline] #${issueNumber}: planning (impl=${primary}, plan-review=${reviewer})`);

    if (opts.dryRun) {
      console.log(`[pipeline] #${issueNumber}: [dry-run] would plan + ${reviewer} plan-review + ${primary} plan revision + implement + open PR`);
      return { advanced: true, from: "ready", to: "review-1", summary: "[dry-run] planning + plan-review" };
    }

    const hooks = makeFreeformPlanningHooks(cfg, title, body);
    return await runPlanningPhases(cfg, issueNumber, title, body, pipelineRunId, opts, hooks);
  } finally {
    clearLivePlanningMarker(cfg.repo, issueNumber);
  }
}

// ---------------------------------------------------------------------------
// OpenSpec planning flow (active when the target repo uses OpenSpec).
//
// Differs from the freeform flow above: the worktree is created FIRST (OpenSpec
// artifacts are files under `openspec/changes/<id>/`), the implementer authors a
// change (proposal/tasks/spec deltas) instead of a freeform plan, the change is
// validated structurally, and its proposal drives the cross-harness plan-review.
// ---------------------------------------------------------------------------

async function advanceOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts,
): Promise<Outcome> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const { title, body } = detail;
  const primary: Harness = cfg.harnesses.implementer;
  // `reviewer` may be a custom reviewer CLI (`review_harness`, #40), so it is a
  // `string`; the implementer fallback (`primary`) is always a built-in Harness.
  const reviewer: string = cfg.harnesses.reviewer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  console.log(
    `[pipeline] #${issueNumber}: planning (OpenSpec; impl=${primary}, plan-review=${reviewer})`,
  );

  if (opts.dryRun) {
    console.log(
      `[pipeline] #${issueNumber}: [dry-run] would author + ${reviewer} review + revise an OpenSpec change + implement + open PR`,
    );
    return { advanced: true, from: "ready", to: "review-1", summary: "[dry-run] openspec planning" };
  }

  // Capture the list of existing change dirs BEFORE the worktree is created.
  // The worktree is a fresh checkout of the same branch, so listing from cfg.repo_dir
  // gives the correct baseline (no in-flight changes exist in the primary checkout).
  const beforeList = openspec.listChangeDirs(cfg.repo_dir);

  const hooks = makeOpenspecPlanningHooks(cfg, title, body, beforeList);
  return runPlanningPhases(cfg, issueNumber, title, body, pipelineRunId, opts, hooks);
}

// ---------------------------------------------------------------------------
// Hook builders — exported for tests; advance/advanceOpenspec call these
// ---------------------------------------------------------------------------

/**
 * Build the PlanningPhaseHooks for the freeform path. Captures cfg, title, and
 * body so authorArtifact can rebuild the planning prompt without the hook needing
 * separate parameters for them.
 */
export function makeFreeformPlanningHooks(cfg: PipelineConfig, title: string, body: string): PlanningPhaseHooks {
  return {
    async authorArtifact(innerCfg, issueNumber, wt, opts, carryForward, _pipelineRunId, deps, contextSnapshot, crossRepoContext) {
      const primary: Harness = innerCfg.harnesses.implementer;
      const planPrompt = buildPlanningPrompt({ cfg: innerCfg, issueNumber, title, body, carryForward, contextSnapshot, crossRepoContext });
      let planResult: HarnessResult;
      try {
        planResult = await invokePlanStep(primary, wt.path, planPrompt, innerCfg, opts, { invoke: deps.invoke }, { issue: issueNumber, stage: "planning" });
      } catch (err) {
        const e = err as Error;
        return { ok: false, reason: `Plan generation failed: ${e.message}`, tag: "harness-failure" };
      }
      if (!planResult.success || !planResult.stdout.trim()) {
        const reason = planResult.timed_out
          ? `Plan generation timed out after ${planResult.duration.toFixed(0)}s`
          : `Plan generation failed (exit ${planResult.exit_code})`;
        return { ok: false, reason, tag: "harness-failure" };
      }
      return {
        ok: true,
        planText: planResult.stdout.trim(),
        specContext: openspec.openspecContext(cfg, cfg.repo_dir),
        readyToPlanningMsg: "Implementation plan generated.",
      };
    },

    async validateArtifact(_wt) {
      return { ok: true };
    },

    async revalidateArtifact(_wt, revisionStdout) {
      return { ok: true, updatedPlanText: revisionStdout, updatedSpecContext: "" };
    },

    buildPrBody(_innerCfg, issueNumber, _title, planExcerpt, primary, reviewer) {
      return [
        `Closes #${issueNumber}`,
        "",
        `## Summary`,
        `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
        "",
        `**Implemented by**: ${primary}`,
        `**Plan reviewed by**: ${reviewer}`,
        "",
        `## Revised Implementation Plan`,
        planExcerpt,
      ].join("\n") + footer(cfg);
    },

    buildTransitionMessage(prNumber, primary, reviewer) {
      return `${cfg.implementation_ready_message} PR #${prNumber} created by ${primary}. Plan reviewed by ${reviewer}.`;
    },

    planToReviewMsg(primary, reviewer) {
      return `Plan generated by ${primary}. ${reviewer} reviewing before implementation.`;
    },

    preImplTransitionMsg(primary, reviewer, withReview) {
      return withReview
        ? `Plan reviewed by ${reviewer}, revised by ${primary}. Implementation starting with ${primary}.`
        : `Plan-review step disabled. Implementation starting with ${primary} from the original plan.`;
    },

    revisedPlanHeaderLines(primary, reviewer, humanComments) {
      return revisedPlanHeader(primary, reviewer, humanComments);
    },

    buildImplPlan(_wt, revisedPlanText) {
      return revisedPlanText;
    },
  };
}

/**
 * Build the PlanningPhaseHooks for the OpenSpec path. Captures cfg, title, body,
 * and beforeList. Uses a mutable `changeId` variable that `authorArtifact` sets
 * and all subsequent hooks read.
 */
export function makeOpenspecPlanningHooks(
  cfg: PipelineConfig,
  title: string,
  body: string,
  beforeList: string[],
): PlanningPhaseHooks {
  let changeId = "";

  return {
    async authorArtifact(innerCfg, issueNumber, wt, opts, carryForward, pipelineRunId, deps, contextSnapshot, crossRepoContext) {
      const primary: Harness = innerCfg.harnesses.implementer;
      const doGit = deps.gitInWorktree ?? gitInWorktree;
      const isInit = deps.openspecIsInitialized ?? openspec.isInitialized;

      // ---- Bootstrap the OpenSpec workspace if the repo lacks one (opt-in). ----
      if (!isInit(wt.path)) {
        if (!innerCfg.openspec.bootstrap) {
          return {
            ok: false,
            reason:
              "OpenSpec is required (openspec.enabled: on) but this repo has no `openspec/` " +
              "workspace. Set `openspec.bootstrap: true` in .github/pipeline.yml, or run `openspec init`.",
            tag: "needs-human",
          };
        }
        console.log(`[pipeline] #${issueNumber}: bootstrapping OpenSpec (openspec init)`);
        const initRes = await openspec.init(wt.path);
        if (initRes.unavailable) {
          return {
            ok: false,
            reason:
              "OpenSpec bootstrap requested but the `openspec` CLI is not on PATH " +
              "(install: `npm i -g @fission-ai/openspec`).",
            tag: "needs-human",
          };
        }
        if (!initRes.success) {
          return { ok: false, reason: `openspec init failed:\n${initRes.output}`, tag: "needs-human" };
        }
        await doGit(wt.path, ["add", "-A"], { ignoreFailure: true });
        await doGit(
          wt.path,
          ["commit", "-m", withTrailers(`chore: openspec init for #${issueNumber}`, issueNumber, pipelineRunId)],
          { ignoreFailure: true },
        );
      }

      // ---- Author the OpenSpec change (intent only, no code). ----
      const osAuthorHeadBefore = (
        await doGit(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
      ).stdout.trim();

      const inv = deps.invoke ?? invoke;
      const planModel = opts.model ?? innerCfg.models.planning;
      const openspecPlanPrompt = buildPlanningOpenspecPrompt({ cfg: innerCfg, issueNumber, title, body, carryForward, contextSnapshot, crossRepoContext, pipelineRunId });
      // External stage executor delegation (#314) — see invokePlanStep's comment;
      // this is the OpenSpec-flow equivalent of the same "planning" call.
      const planResult =
        (await invokeStageExecutor(
          "planning",
          innerCfg,
          openspecPlanPrompt,
          {
            timeoutSec: innerCfg.implementation_timeout,
            accounting: opts.runDir
              ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: issueNumber, stage: "planning", modelSlot: "planning" }
              : undefined,
          },
          opts.executorHttpDeps,
        )) ??
        (await inv(
          primary,
          wt.path,
          openspecPlanPrompt,
          {
            timeoutSec: innerCfg.implementation_timeout,
            model: planModel,
            reasoningEffort: innerCfg.effort?.planning,
            sandbox: innerCfg.harness_sandbox,
            accounting: accountingForInvoke(opts, issueNumber, "planning", "planning", planModel),
          },
        ));
      if (!planResult.success) {
        const reason = planResult.timed_out
          ? `Plan generation timed out after ${planResult.duration.toFixed(0)}s`
          : `Plan generation failed (exit ${planResult.exit_code})`;
        return {
          ok: false,
          reason,
          tag: "harness-failure",
        };
      }

      // #131: salvage authoring work the harness left uncommitted before the
      // commit-range verification below (the change folder may exist only on disk).
      // Scope to openspec/ so only intent files are staged — aligns with the
      // path-constraint guard below and fixes the sandbox-lock contamination (#321).
      await salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "OpenSpec authoring", osAuthorHeadBefore, "openspec/");

      // #352: commit openspec/config.yaml when the CLI left it untracked/modified.
      // The openspec CLI writes this file lazily (ensureDefaultConfig) on the first
      // command invocation; the scoped salvage above only runs when HEAD did not
      // advance, so config.yaml can be left dirty even when the harness committed
      // its change. Commit it here — AFTER salvage, BEFORE verifyHarnessCommits —
      // so it falls inside the verified range and satisfies allowPattern:/^openspec\//
      await commitOpenspecProjectConfig(wt.path, issueNumber, pipelineRunId, deps);

      // ---- Discover the change the implementer created. ----
      const after = openspec.listChangeDirs(wt.path);
      const fresh = after.filter((c) => !beforeList.includes(c));
      const changeResult = enforceOpenspecChangeSingular(fresh, after);
      if (!changeResult.ok) {
        const blockMsg =
          changeResult.reason === "no openspec change created"
            ? "OpenSpec is active but the planning step produced no change under `openspec/changes/`. " +
              "Ensure the `openspec` CLI is installed and the repo is initialized (`openspec init`)."
            : changeResult.reason;
        return { ok: false, reason: blockMsg, tag: "needs-human" };
      }
      changeId = changeResult.changeId;

      // ---- Verify the authoring harness committed only openspec/ artifacts (#68). ----
      if (osAuthorHeadBefore) {
        const authorCheck = await verifyHarnessCommits(wt.path, osAuthorHeadBefore, {
          issueNumber,
          pathConstraint: {
            allowPattern: /^openspec\//,
            // tasks/ planning notes left dirty by the scoped salvage (#321) are expected
            allowDirtyPattern: /^tasks\//,
            description:
              "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
          },
        });
        if (!authorCheck.ok) {
          return { ok: false, reason: authorCheck.reason, tag: "needs-human" };
        }
      }

      console.log(`[pipeline] #${issueNumber}: OpenSpec change \`${changeId}\` drafted`);

      const proposal = openspec.readChangeFile(wt.path, changeId, "proposal.md")?.trim() || "(proposal.md not found)";

      return {
        ok: true,
        // planText includes the decorative header for the posted comment.
        planText: `_OpenSpec change \`${changeId}\` — proposal.md_\n\n${proposal}`,
        // promptPlanText is the raw proposal passed to review/revision prompts.
        promptPlanText: proposal,
        specContext: openspec.readSpecDeltas(wt.path, changeId),
        readyToPlanningMsg: `OpenSpec change \`${changeId}\` drafted by ${primary}.`,
      };
    },

    async validateArtifact(wt) {
      const v1 = await openspec.validateItem(wt.path, changeId);
      if (!v1.unavailable && !v1.valid) {
        return {
          ok: false,
          reason: `OpenSpec change \`${changeId}\` is invalid:\n${formatIssues(v1)}`,
          tag: "openspec-invalid",
          blockStage: "planning" as Stage,
        };
      }
      return { ok: true };
    },

    async revalidateArtifact(wt, _revisionStdout) {
      const v2 = await openspec.validateItem(wt.path, changeId);
      if (!v2.unavailable && !v2.valid) {
        return {
          ok: false,
          reason: `OpenSpec change \`${changeId}\` invalid after revision:\n${formatIssues(v2)}`,
          tag: "openspec-invalid",
        };
      }
      const revisedProposal = openspec.readChangeFile(wt.path, changeId, "proposal.md")?.trim() || _revisionStdout;
      return {
        ok: true,
        updatedPlanText: revisedProposal,
        updatedSpecContext: openspec.readSpecDeltas(wt.path, changeId),
      };
    },

    buildPrBody(_innerCfg, issueNumber, _title, planExcerpt, primary, reviewer) {
      return [
        `Closes #${issueNumber}`,
        "",
        `## Summary`,
        `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
        "",
        `**Implemented by**: ${primary}`,
        `**Plan reviewed by**: ${reviewer}`,
        `**OpenSpec change**: \`${changeId}\``,
        "",
        `## Proposal`,
        planExcerpt,
      ].join("\n") + footer(cfg);
    },

    buildTransitionMessage(prNumber, primary, reviewer) {
      return `${cfg.implementation_ready_message} PR #${prNumber} created by ${primary} (OpenSpec change \`${changeId}\`). Plan reviewed by ${reviewer}.`;
    },

    planToReviewMsg(primary, reviewer) {
      return `OpenSpec proposal by ${primary}. ${reviewer} reviewing intent before implementation.`;
    },

    preImplTransitionMsg(primary, reviewer, withReview) {
      return withReview
        ? `OpenSpec proposal reviewed by ${reviewer}, revised by ${primary}. Implementation starting with ${primary}.`
        : `Plan-review step disabled. Implementation starting with ${primary} from the drafted change.`;
    },

    revisedPlanHeaderLines(primary, reviewer, humanComments) {
      return [...revisedPlanHeader(primary, reviewer, humanComments), `_OpenSpec change \`${changeId}\`_`];
    },

    buildImplPlan(wt, revisedPlanText) {
      // Strip the "_OpenSpec change `id` — proposal.md_\n\n" prefix that was added by authorArtifact.
      // The actual proposal text is what follows the header line; for the impl plan we need
      // just the raw proposal without the markdown prefix.
      const proposal = revisedPlanText.replace(/^_OpenSpec change `[^`]+` — proposal\.md_\n\n/, "");
      const tasks = openspec.readChangeFile(wt.path, changeId, "tasks.md")?.trim() ?? "";
      return (
        `Implement OpenSpec change \`${changeId}\`. Work through the checklist in ` +
        `\`openspec/changes/${changeId}/tasks.md\`, keep that change folder committed, and satisfy its spec deltas.\n\n` +
        `${proposal}${tasks ? `\n\n## Tasks\n\n${tasks}` : ""}`
      );
    },

    // Plan review must also run from wt.path so the reviewer can read the
    // just-authored openspec/changes/<id>/ files (proposal, design, tasks).
    planReviewCwd(wt) { return wt.path; },

    // Run plan revision in the issue worktree so the harness can update the
    // OpenSpec change files (proposal.md, spec deltas, tasks.md) in wt.path.
    // Freeform does not implement this hook and falls back to invokePlanStep,
    // which uses cfg.repo_dir for non-sandboxed runs.
    async invokeRevision(primary, wt, prompt, innerCfg, opts, deps, issueNumber) {
      // External stage executor delegation (#314) — see invokePlanStep's
      // comment: revision is planning-role work and resolves the "planning"
      // assignment, regardless of the "plan-review" accounting label below.
      if (issueNumber !== undefined) {
        const delegated = await invokeStageExecutor(
          "planning",
          innerCfg,
          prompt,
          {
            timeoutSec: innerCfg.implementation_timeout,
            accounting: opts.runDir
              ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: issueNumber, stage: "plan-review", modelSlot: "planning" }
              : undefined,
          },
          opts.executorHttpDeps,
        );
        if (delegated) return delegated;
      }
      const inv = deps.invoke ?? invoke;
      return inv(primary, wt.path, prompt, {
        timeoutSec: innerCfg.implementation_timeout,
        model: opts.model ?? innerCfg.models.planning,
        reasoningEffort: innerCfg.effort?.planning,
        sandbox: innerCfg.harness_sandbox,
        accounting: issueNumber === undefined
          ? undefined
          : accountingForInvoke(opts, issueNumber, "plan-review", "planning", opts.model ?? innerCfg.models.planning),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// OpenSpec change-directory singularity gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Validates that the OpenSpec authoring harness produced exactly one new change
 * directory. When `fresh` is empty (no new change) the `all` list is checked for
 * a single pre-existing change (fallback for harnesses that modify rather than
 * create). Multiple new changes are always a hard block.
 *
 * Returns `{ ok: true, changeId }` or `{ ok: false, reason }`. Exported for
 * unit testing without mocking the full `advanceOpenspec` chain.
 */
export function enforceOpenspecChangeSingular(
  fresh: string[],
  all: string[],
): { ok: true; changeId: string } | { ok: false; reason: string } {
  if (fresh.length > 1) {
    return {
      ok: false,
      reason: `OpenSpec authoring produced ${fresh.length} new changes (${fresh.join(", ")}) — expected exactly one`,
    };
  }
  const changeId = fresh[0] ?? (all.length === 1 ? all[0] : undefined);
  if (!changeId) {
    return { ok: false, reason: "no openspec change created" };
  }
  return { ok: true, changeId };
}

// ---------------------------------------------------------------------------
// Shared post-implementation helper (#175): gate → push → create-or-find PR →
// transition implementing → review-1. Called from both the standard and
// OpenSpec implementing flows, and from the dispatch resume path.
// ---------------------------------------------------------------------------

/** Injectable seams for {@link resumeFromImplementing} — unit tests inject fakes. */
export interface ResumeFromImplementingDeps {
  runTestGate?: typeof runTestGate;
  /** Exact-branch PR lookup — scoped to wt.branch so stale same-issue PRs are never reused. */
  getPrForBranch?: typeof getPrForBranch;
  createPr?: typeof createPr;
  gitInWorktree?: typeof gitInWorktree;
  setBlocked?: typeof setBlocked;
  transition?: typeof transition;
  runFormatGate?: typeof runFormatGate;
}

/**
 * Run the post-implementation steps — test gate → push → create-or-find PR →
 * transition `implementing → review-1`. Called from both the standard and
 * OpenSpec flows, and from the dispatch resume path when re-entering at
 * `implementing` with an existing worktree that has commits ahead of base.
 *
 * PR lookup uses exact head-branch matching (getPrForBranch) so a stale PR
 * from a prior slug (pipeline/N-old-slug) is never mistaken for this run's PR.
 * If createPr throws due to a race (another actor created the PR between our
 * pre-check and the create call), the catch block re-checks before blocking.
 */
export async function resumeFromImplementing(
  cfg: PipelineConfig,
  issueNumber: number,
  wt: { path: string; branch: string },
  opts: {
    prTitle: string;
    prBody: string;
    /** Called with the final PR number to build the transition comment. */
    transitionMessage: (prNumber: number) => string;
    pipelineRunId: string;
    stateDir?: string;
    /** Run directory for JSONL event log (#155). Undefined → event appends disabled. */
    runDir?: string;
    /** Run-store deps carrying `stdoutWrite` so events also stream to stdout under
     *  `--json-events` (#155). Undefined → events go to events.jsonl only. */
    runStoreDeps?: RunStoreDeps;
  },
  deps: ResumeFromImplementingDeps = {},
): Promise<Outcome> {
  const gateRunner = deps.runTestGate ?? runTestGate;
  const prLookup = deps.getPrForBranch ?? getPrForBranch;
  const prCreator = deps.createPr ?? createPr;
  const gitOp = deps.gitInWorktree ?? gitInWorktree;
  const blocker = deps.setBlocked ?? setBlocked;
  const trans = deps.transition ?? transition;
  const fmtGateFn = deps.runFormatGate ?? runFormatGate;

  const branch = wt.branch;

  // ---- Format + test gates to convergence (#182) ----
  // The format/lint gate runs BEFORE the test gate (so tests see formatted code)
  // and both re-run until neither produces a new commit, so the pushed state is
  // simultaneously formatted and tested — no auto-format commit ships untested
  // and no test-fix commit ships unformatted.
  const gates = await runFormatAndTestGates(
    cfg, issueNumber, wt.path, "implementing", opts.pipelineRunId, opts.stateDir,
    { runFormatGate: fmtGateFn, runTestGate: gateRunner },
    opts.runDir, opts.runStoreDeps,
  );
  if (!gates.ok) {
    await blocker(
      cfg, issueNumber, gates.reason, "implementing",
      gates.source === "test" ? "test-gate-exhausted" : "needs-human",
    );
    return { advanced: false, status: "blocked", reason: gates.reason };
  }

  // ---- Push ----
  const push = await gitOp(wt.path, ["push", "-u", "origin", branch], { ignoreFailure: true });
  if (push.code !== 0) {
    await blocker(cfg, issueNumber, `Git push failed: ${push.stderr.trim()}`, "implementing", "push-failed");
    return { advanced: false, status: "blocked", reason: "push failed" };
  }

  // ---- Create or find PR (exact-branch check first to avoid duplicates on resume) ----
  let prNumber: number;
  // Track whether the PR is newly created this run so we emit pr_created vs pr_updated.
  let prIsNew = false;
  const existing = await prLookup(cfg, branch);
  if (existing) {
    prNumber = existing;
    console.log(`[pipeline] #${issueNumber}: PR #${prNumber} already exists for branch ${branch} — reusing`);
  } else {
    try {
      prNumber = await prCreator(cfg, { branch, title: opts.prTitle, body: opts.prBody });
      prIsNew = true;
      console.log(`[pipeline] #${issueNumber}: PR #${prNumber} created`);
    } catch (err) {
      // Race: another actor may have created the PR between our pre-check and
      // the create call. Re-check before blocking so an existing PR is reused.
      const raceWinner = await prLookup(cfg, branch);
      if (raceWinner) {
        prNumber = raceWinner;
        console.log(`[pipeline] #${issueNumber}: PR #${prNumber} created concurrently — reusing`);
      } else {
        const e = err as Error;
        await blocker(cfg, issueNumber, `PR creation failed: ${e.message}`, "implementing", "pr-creation-failed");
        return { advanced: false, status: "blocked", reason: e.message };
      }
    }
  }

  // ---- Emit pr_created or pr_updated event (#155) ----
  // Only pr_created when the PR was opened during this run; pr_updated for resume/reuse.
  if (opts.runDir) {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const evType = prIsNew ? "pr_created" : "pr_updated";
    await appendEvent(opts.runDir, { schema_version: RUN_SCHEMA_VERSION, type: evType, at, pr: prNumber }, opts.runStoreDeps).catch(() => {});
  }

  // ---- implementing → review-1 ----
  await trans(cfg, issueNumber, "implementing", "review-1", opts.transitionMessage(prNumber));

  return {
    advanced: true,
    from: "implementing",
    to: "review-1",
    summary: `PR #${prNumber} opened`,
  };
}

// ---------------------------------------------------------------------------
// Dispatch resume path (#175): re-entry at `implementing` when a worktree with
// commits exists. Called from `dispatch()` in pipeline.ts for the implementing
// case instead of returning the previous "nothing to do" waiting response.
// ---------------------------------------------------------------------------

/** Injectable seams for {@link dispatchResume} — unit tests inject fakes. */
export interface DispatchResumeDeps {
  getForIssue?: typeof getForIssue;
  hasCommitsAhead?: typeof hasCommitsAhead;
  getIssueDetail?: typeof getIssueDetail;
  resumeFromImplementing?: typeof resumeFromImplementing;
  /** Check if a live planning process is active for this repo+issue (repo-stable). */
  isLivePlanningActive?: typeof isLivePlanningActive;
  transition?: typeof transition;
  planningAdvance?: typeof advance;
}

/**
 * Dispatch resume for the `implementing` stage. Re-entry ordering:
 *   1. Live-planning marker present → a concurrent process owns the stage;
 *      return `waiting` naming the live owner (no worktree inspection).
 *   2. No live owner + worktree with commits ahead of base → resume the
 *      post-implementation steps (test gate → push → PR → review-1), #175.
 *   3. No live owner + no commits → crash-stranded: roll back to `ready` and
 *      restart the planning arc, identical to the `planning`/`plan-review`
 *      recovery (#271).
 */
export async function dispatchResume(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts,
  deps: DispatchResumeDeps = {},
): Promise<Outcome> {
  const getWt = deps.getForIssue ?? getOnDiskForIssue;
  const commitsAhead = deps.hasCommitsAhead ?? hasCommitsAhead;
  const fetchIssue = deps.getIssueDetail ?? getIssueDetail;
  const doResume = deps.resumeFromImplementing ?? resumeFromImplementing;
  const checkLive = deps.isLivePlanningActive ?? isLivePlanningActive;
  const trans = deps.transition ?? transition;
  const planningAdvance = deps.planningAdvance ?? advance;

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would resume from implementing: check gate + push + PR + review-1`);
    return { advanced: true, from: "implementing", to: "review-1", summary: "[dry-run] implementing resume" };
  }

  // Liveness first: a live owner may be mid-commit, so the worktree must not be
  // inspected or acted on at all while the marker is held.
  if (checkLive(cfg.repo, issueNumber)) {
    return {
      advanced: false,
      status: "waiting",
      reason: "implementing is owned by a live concurrent planning/implementing run — waiting for it to complete",
    };
  }

  const wt = await getWt(cfg, issueNumber);
  if (!wt || !(await commitsAhead(wt.path, cfg.base_branch))) {
    console.log(
      `[pipeline] #${issueNumber}: recovered stranded implementing attempt — restarting from ready`,
    );
    await trans(cfg, issueNumber, "implementing", "ready", "recovered crashed implementing attempt — restarting");
    return planningAdvance(cfg, issueNumber, {
      dryRun: opts.dryRun,
      model: opts.model,
      pipelineRunId: opts.pipelineRunId,
      stateDir: opts.stateDir,
      runDir: opts.runDir,
      runStoreDeps: opts.runStoreDeps,
    });
  }

  const primary: Harness = cfg.harnesses.implementer;
  const reviewer: string = cfg.harnesses.reviewer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  const detail = await fetchIssue(cfg, issueNumber);
  const { title } = detail;

  const prBody = [
    `Closes #${issueNumber}`,
    "",
    "## Summary",
    `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
    "",
    `**Implemented by**: ${primary}`,
    `**Plan reviewed by**: ${reviewer}`,
  ].join("\n") + footer(cfg);

  const resumeWt = { path: wt.path, branch: branchName(issueNumber, wt.slug) };

  return doResume(cfg, issueNumber, resumeWt, {
    prTitle: `[Pipeline] ${title} (#${issueNumber})`,
    prBody,
    transitionMessage: (prNumber) =>
      `${cfg.implementation_ready_message} PR #${prNumber} created by ${primary}. Plan reviewed by ${reviewer}. (Resumed at implementing stage.)`,
    pipelineRunId,
    stateDir: opts.stateDir,
    runDir: opts.runDir,
    runStoreDeps: opts.runStoreDeps,
  });
}

// ---------------------------------------------------------------------------
// Uncommitted-work salvage pre-pass (#131)
// ---------------------------------------------------------------------------

/**
 * When the harness produced no new commit (`HEAD` still equals `headBefore`),
 * salvage any uncommitted work in the worktree into a commit so the downstream
 * commit-range checks validate it instead of blocking on "no commits". A clean
 * worktree salvages nothing and the caller's existing block path is unchanged.
 */
async function salvageIfNoNewCommit(
  wtPath: string,
  issueNumber: number,
  pipelineRunId: string,
  stageLabel: string,
  headBefore: string,
  scope?: string,
): Promise<void> {
  if (!headBefore) return;
  const headAfter = (
    await gitInWorktree(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  if (headAfter && headAfter === headBefore) {
    await trySalvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel, {}, scope);
  }
}

// ---------------------------------------------------------------------------
// Implementer harness invocation (#70) — exported for direct unit testing
// ---------------------------------------------------------------------------

/** Injectable seam for unit-testing {@link invokeImplementer} without a real harness. */
export interface ImplementerInvokeDeps {
  invoke?: typeof invoke;
}

interface InvokeAccountingStage {
  issue: number;
  stage: string;
}

/**
 * Invoke the implementer harness for the implementation step. The model is
 * resolved as `opts.model ?? cfg.models.implementing` — the per-repo
 * `models.implementing` slot, with a one-off CLI `--model` override winning (#70).
 * Both the standard and OpenSpec implementing paths route through here so the slot
 * is wired identically; a bare `opts.model` at either call site was the gap #70
 * closed (every other harness call already followed `opts.model ?? cfg.models.<slot>`).
 */
export async function invokeImplementer(
  harness: Harness,
  wtPath: string,
  prompt: string,
  cfg: PipelineConfig,
  opts: AdvanceOpts,
  deps: ImplementerInvokeDeps = {},
  accounting?: InvokeAccountingStage,
): Promise<HarnessResult> {
  // External stage executor delegation (#314): "implementing" is an
  // execution-environment stage — only an `agent-system` executor can be
  // assigned here (config.ts rejects a `model-endpoint` assignment at parse
  // time), so no model-endpoint branching is needed at this call site.
  if (accounting) {
    const delegated = await invokeStageExecutor(
      "implementing",
      cfg,
      prompt,
      {
        timeoutSec: cfg.implementation_timeout,
        accounting: opts.runDir
          ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: accounting.issue, stage: accounting.stage, modelSlot: "implementing" }
          : undefined,
      },
      opts.executorHttpDeps,
    );
    if (delegated) return delegated;
  }
  const inv = deps.invoke ?? invoke;
  const model = opts.model ?? cfg.models.implementing;
  return inv(harness, wtPath, prompt, {
    timeoutSec: cfg.implementation_timeout,
    model,
    reasoningEffort: cfg.effort?.implementing,
    sandbox: cfg.harness_sandbox,
    accounting: accounting
      ? accountingForInvoke(opts, accounting.issue, accounting.stage, "implementing", model)
      : undefined,
    env: papercutIdentityEnv(cfg, {
      runId: opts.runDir ? path.basename(opts.runDir) : null,
      issue: accounting?.issue ?? null,
      stage: accounting?.stage ?? "implementing",
      harness,
      model,
    }),
  });
}

// ---------------------------------------------------------------------------
// Planning-step harness invocation (#21) — exported for unit testing
// ---------------------------------------------------------------------------

/** Injectable seam for unit-testing {@link invokePlanStep} without a real harness. */
export interface PlanStepDeps {
  invoke?: typeof invoke;
}

/**
 * Invoke the implementer harness for a plan-generation or plan-revision step.
 * When `cfg.harness_sandbox` is true AND the harness is "claude", the process
 * cwd is the issue worktree (`wtPath`), confining the sandbox to that tree.
 * For codex, `cfg.repo_dir` is always used regardless of the sandbox flag —
 * codex's `-C` arg must be identical whether sandbox is on or off (spec:
 * "sandboxed flag does not affect codex invocation"). When sandbox is false the
 * repo root is used for both harnesses, preserving the pre-change default.
 * The model uses the `models.planning` slot (same as the pre-change inline calls).
 */
export async function invokePlanStep(
  harness: Harness,
  wtPath: string,
  prompt: string,
  cfg: PipelineConfig,
  opts: AdvanceOpts,
  deps: PlanStepDeps = {},
  accounting?: InvokeAccountingStage,
): Promise<HarnessResult> {
  // External stage executor delegation (#314): this seam authors/revises the
  // PLAN — implementer/planning-role work regardless of whether the call is
  // logged under the "planning" or "plan-review" accounting stage (a revision
  // is still planning work; the actual reviewing call is wired separately in
  // runPlanningPhases). It therefore always resolves the "planning" assignment,
  // never "plan-review" (that name is reserved for the reviewer call).
  if (accounting) {
    const delegated = await invokeStageExecutor(
      "planning",
      cfg,
      prompt,
      {
        timeoutSec: cfg.implementation_timeout,
        accounting: opts.runDir
          ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: accounting.issue, stage: accounting.stage, modelSlot: "planning" }
          : undefined,
      },
      opts.executorHttpDeps,
    );
    if (delegated) return delegated;
  }
  const inv = deps.invoke ?? invoke;
  const dir = (cfg.harness_sandbox && harness === "claude") ? wtPath : cfg.repo_dir;
  const model = opts.model ?? cfg.models.planning;
  return inv(harness, dir, prompt, {
    timeoutSec: cfg.implementation_timeout,
    model,
    reasoningEffort: cfg.effort?.planning,
    sandbox: cfg.harness_sandbox,
    accounting: accounting
      ? accountingForInvoke(opts, accounting.issue, accounting.stage, "planning", model)
      : undefined,
  });
}

function accountingForInvoke(
  opts: AdvanceOpts,
  issue: number,
  stage: string,
  modelSlot: string,
  model: string | null,
): InvokeOptions["accounting"] | undefined {
  if (!opts.runDir) return undefined;
  return {
    runDir: opts.runDir,
    runStoreDeps: opts.runStoreDeps,
    issue,
    stage,
    modelSlot,
    model,
  };
}

// ---------------------------------------------------------------------------
// Implementation-commit reference gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Verifies that at least one commit in `headBefore..HEAD` references the issue
 * number. Exported so tests can exercise the gate without mocking the full
 * `advance` call chain.
 */
export async function enforceImplCommitRef(
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(wtPath, headBefore, { issueNumber }, deps);
}

function formatIssues(v: { issues: { item?: string; message: string }[]; raw: string }): string {
  return v.issues.length
    ? v.issues.map((i) => `- ${i.item ? `${i.item}: ` : ""}${i.message}`).join("\n")
    : v.raw;
}

// ---------------------------------------------------------------------------
// Pre-planning carry-forward context (optional; last30days)
// ---------------------------------------------------------------------------

const LAST30DAYS_SETUP_URL = "https://github.com/mvanhorn/last30days-skill#setup";

// Character cap for the body portion of the research topic. Bodies at or under
// the cap are appended verbatim; longer bodies are excerpted to the cap, trimmed
// at the last word boundary, and marked with `…`. Keeping the topic bounded
// avoids passing unbounded, noisy markdown to the skill's query builder.
const BODY_TOPIC_CAP = 400;

// Patterns that commonly indicate secrets or private data in issue bodies.
// Replacements use `[REDACTED]` to preserve prose structure while removing
// content that should not cross the pipeline→external-skill boundary.
const REDACT_PATTERNS: ReadonlyArray<RegExp> = [
  // URLs — can embed tokens, internal hostnames, or auth parameters
  /(?:https?|ftp):\/\/[^\s]+/gi,
  // Email addresses
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  // Bearer / Authorization header values
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // JWT-shaped strings: three base64url segments joined by dots
  /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Long hex strings (32+ chars) — API keys, session tokens, hashes
  /\b[0-9a-f]{32,}\b/gi,
  // key/token/secret/password assignments, e.g. `api_key=abc123` or `token: xyz`
  /(?:api[_-]?key|token|secret|password|passwd|auth)\s*[=:]\s*\S+/gi,
];

// Extra patterns for brief sanitization that extend artifact-sanitize.ts INJECTION_PATTERNS.
// sanitizeBriefForPrompt iterates INJECTION_PATTERNS first (canonical, drift-guarded), then these.
const BRIEF_SUPPLEMENTAL_PATTERNS: ReadonlyArray<RegExp> = [
  // "Ignore all previous/prior/above instructions" — the multi-word sequence (all + the
  // qualifier) is not matched by INJECTION_PATTERNS, which only handles ONE qualifier after
  // "ignore" (so "ignore all above instructions" slips through the canonical pattern).
  /ignore\s+all\s+(?:previous|prior|above)\s+instructions?/gi,
  // "Act as [anything]" — broader than INJECTION_PATTERNS' "act as if" to catch "act as a …" variants
  /act\s+as\b/gi,
  // <system> XML tag injection (not in INJECTION_PATTERNS)
  /<\/?system>/gi,
];

/**
 * Redact URLs, email addresses, and common secret patterns from `text` before
 * the content is forwarded to the last30days skill's external research runtime.
 * Replacements use the literal `[REDACTED]` so prose structure is preserved.
 */
export function sanitizeBodyForResearch(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Redact known prompt-injection imperatives from a last30days brief before the
 * text is posted to GitHub or embedded in a planning prompt. Public discourse
 * (Reddit, X, HN, YouTube, GitHub) is untrusted: a crafted community post could
 * contain injection payloads intended to steer the planning agent. Replacements
 * use `[REDACTED]` so surrounding contextual text is preserved.
 */
export function sanitizeBriefForPrompt(text: string): string {
  let out = text;
  for (const pattern of INJECTION_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  for (const pattern of BRIEF_SUPPLEMENTAL_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Build the research topic string for the last30days skill from the issue's
 * full content (title + description).
 * - body absent/empty/whitespace-only → returns `title` unchanged (no regression).
 * - body ≤ BODY_TOPIC_CAP → appends sanitized body after the title.
 * - body > BODY_TOPIC_CAP → appends a sanitized excerpt capped at BODY_TOPIC_CAP,
 *   trimmed at the last word boundary, with a trailing `…` marking the truncation.
 *
 * The body is passed through `sanitizeBodyForResearch` before use to redact URLs,
 * emails, and common secret patterns before the topic crosses the pipeline boundary.
 */
export function buildResearchTopic(title: string, body?: string): string {
  const b = sanitizeBodyForResearch((body ?? "").trim());
  if (!b) return title;
  if (b.length <= BODY_TOPIC_CAP) return `${title}\n\n${b}`;
  let excerpt = b.slice(0, BODY_TOPIC_CAP).trimEnd();
  const lastSpace = excerpt.lastIndexOf(" ");
  if (lastSpace > 0) excerpt = excerpt.slice(0, lastSpace);
  return `${title}\n\n${excerpt}…`;
}

/** Returns a non-blocking hint for the two empty-brief cases in gatherCarryForward. Exported for unit tests. */
export function buildSetupHint(issueNumber: number, mode: "unavailable" | "no-signal"): string {
  const p = `[pipeline] #${issueNumber}: last30days:`;
  if (mode === "unavailable") {
    return (
      `${p} skill or Python not found; skipping (non-blocking). ` +
      `To install: \`npx skills add mvanhorn/last30days-skill -g\` (Codex/CLI hosts) or ` +
      `\`/plugin marketplace add mvanhorn/last30days-skill\` (Claude Code). ` +
      `Data-source keys (BRAVE_SEARCH_API_KEY, SCRAPECREATORS_API_KEY) are configured in the skill — see ${LAST30DAYS_SETUP_URL}`
    );
  }
  return (
    `${p} skill ran but returned no usable signal; skipping (non-blocking). ` +
    `Add data-source keys in the skill for better coverage: ` +
    `BRAVE_SEARCH_API_KEY (free Brave Search) and SCRAPECREATORS_API_KEY (fuller social/X). ` +
    `See ${LAST30DAYS_SETUP_URL}`
  );
}

/** Seam for unit-testing the two empty-brief branches without the skill installed. */
export interface CarryForwardDeps {
  run: typeof last30days.run;
}

/**
 * When `last30days.enabled`, run the last30days skill against the issue's full
 * content (title + description, bounded for long bodies) and carry the resulting
 * evidence brief forward: post it as an issue comment AND return it for injection
 * into the planning prompt. Always non-blocking — a missing skill, failure, or
 * empty/low-signal brief just returns "".
 *
 * `body` is optional: when absent, empty, or whitespace-only the research topic
 * is the title alone (identical to the pre-change baseline).
 */
export async function gatherCarryForward(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  body?: string,
  deps: CarryForwardDeps = { run: last30days.run },
): Promise<string> {
  if (!last30days.isEnabled(cfg)) return "";
  const researchTopic = buildResearchTopic(title, body);
  console.log(`[pipeline] #${issueNumber}: gathering last30days carry-forward context`);
  const res = await deps.run(researchTopic, { timeoutSec: cfg.last30days.timeout });
  if (res.unavailable) {
    console.log(buildSetupHint(issueNumber, "unavailable"));
    return "";
  }
  if (!res.success || !last30days.hasSignal(res.brief)) {
    console.log(buildSetupHint(issueNumber, "no-signal"));
    return "";
  }
  const sanitizedBrief = sanitizeBriefForPrompt(res.brief);
  await postComment(
    cfg,
    issueNumber,
    `## Pre-Planning Context — last30days\n\n_Topic: "${title}"_${res.stats ? `\n\n${res.stats}` : ""}\n\n${sanitizedBrief}${footer(cfg)}`,
  );
  console.log(`[pipeline] #${issueNumber}: last30days brief posted + carried into planning`);
  return sanitizedBrief;
}

// ---------------------------------------------------------------------------
// Cross-repo context (#312): open issues from declared repo_map repos
// ---------------------------------------------------------------------------

/** Injectable seam for unit-testing `gatherCrossRepoContext` without real gh calls. */
export interface CrossRepoContextDeps {
  getOpenIssues?: typeof getOpenIssues;
}

/**
 * When `cfg.repo_map` declares related repos, fetch open issues from each declared
 * repo (`depends_on` ∪ `depended_on_by`) and return a formatted context block for
 * injection into the planning prompt. Non-blocking: an unreachable repo logs a named
 * warning and is skipped; the run continues with whatever context was fetched.
 *
 * Returns "" when `repo_map` is absent/empty (no gh call is made).
 */
export async function gatherCrossRepoContext(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: CrossRepoContextDeps = {},
): Promise<string> {
  const repoMap = cfg.repo_map;
  if (!repoMap) return "";
  const allDeclared = [...(repoMap.depends_on ?? []), ...(repoMap.depended_on_by ?? [])];
  if (allDeclared.length === 0) return "";

  const getIssuesFn = deps.getOpenIssues ?? getOpenIssues;

  // Deduplicate repos; depends_on wins over depended_on_by for same repo.
  const repoSet = new Set<string>();
  for (const r of (repoMap.depended_on_by ?? [])) repoSet.add(r);
  for (const r of (repoMap.depends_on ?? [])) repoSet.add(r);

  console.log(`[pipeline] #${issueNumber}: gathering cross-repo context from ${repoSet.size} declared repo(s)`);

  const sections: string[] = [];

  for (const repo of repoSet) {
    let issues: Awaited<ReturnType<typeof getOpenIssues>>;
    try {
      issues = await getIssuesFn(repo);
    } catch (err) {
      console.warn(
        `[pipeline] #${issueNumber}: repo_map: ${repo} unreachable — continuing without its cross-repo context: ${(err as Error).message}`,
      );
      continue;
    }
    if (issues.length === 0) continue;
    const lines = issues.map((i) => {
      // Sanitize titles and labels before prompt injection: these originate from external
      // contributors in declared repos and must be treated as untrusted input.
      const safeTitle = sanitizeBriefForPrompt(i.title);
      const safeLabels = i.labels.map((l) => sanitizeBriefForPrompt(l));
      const labelStr = safeLabels.length > 0 ? ` [${safeLabels.join(", ")}]` : "";
      return `- #${i.number} ${safeTitle}${labelStr}`;
    });
    sections.push(`### ${repo}\n\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";

  const header = "## Cross-Repo Context (declared related repos — open issues only)";
  const result = `${header}\n\n${sections.join("\n\n")}`;
  console.log(`[pipeline] #${issueNumber}: cross-repo context gathered (${repoSet.size} repo(s))`);
  return result;
}

/**
 * Gather human-comment context snapshot for the planning stage (#318).
 * Fetches current issue comments, builds a snapshot, posts a
 * `## Pre-Planning Context` comment (idempotent: skipped when one already
 * exists), and returns the rendered block for prompt injection.
 */
async function gatherContextSnapshot(
  cfg: PipelineConfig,
  issueNumber: number,
  body: string,
  deps: RunPlanningPhasesDeps,
): Promise<string> {
  try {
    const doGetIssueDetail = deps.getIssueDetail ?? getIssueDetail;
    const doPostComment = deps.postComment ?? postComment;

    const detail = await doGetIssueDetail(cfg, issueNumber);
    const comments = detail.comments;

    // Idempotent: skip if a Pre-Planning Context snapshot comment already exists.
    // Use startsWith(header + '\n') to avoid matching the last30days comment
    // (## Pre-Planning Context — last30days) which has different text after the header.
    const existing = comments.find((c) =>
      c.body.trimStart().startsWith(PRE_PLANNING_CONTEXT_HEADER + '\n'),
    );
    if (existing) {
      // Re-use the body (strip the header) as the rendered block.
      const stripped = existing.body.slice(PRE_PLANNING_CONTEXT_HEADER.length).trimStart();
      return stripped;
    }

    const maxChars = cfg.context_snapshot?.max_chars ?? CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT;
    const snapshot = buildContextSnapshot(comments, maxChars);
    const rendered = renderContextSnapshotBlock(snapshot);

    if (!rendered) return '';

    const conflicts = detectConflicts(snapshot, body);
    const conflictBlock = renderConflictWarningBlock(conflicts);

    const commentBody = `${PRE_PLANNING_CONTEXT_HEADER}\n\n${rendered}${conflictBlock}${footer(cfg)}`;
    await doPostComment(cfg, issueNumber, commentBody);
    console.log(`[pipeline] #${issueNumber}: pre-planning context snapshot posted (${snapshot.entries.length} human comment(s))`);

    return rendered + conflictBlock;
  } catch (err) {
    // Non-fatal: snapshot is advisory; don't block planning if this fails.
    console.warn(`[pipeline] #${issueNumber}: context snapshot collection failed (non-fatal): ${(err as Error).message}`);
    return '';
  }
}

function footer(cfg: PipelineConfig): string {
  return `\n\n---\n${cfg.marker_footer}`;
}

// ---------------------------------------------------------------------------
// Human plan feedback (#26)
// ---------------------------------------------------------------------------

/** Exact section heading the revised plan must contain when human comments are present. */
export const HUMAN_FEEDBACK_ACK_HEADER = "## Human Feedback Acknowledgement";

/**
 * Returns `true` when no acknowledgement is required (no human comments) or when
 * the revised plan contains the required acknowledgement section header.
 * Returns `false` when human comments were present but the section is missing —
 * the caller must block or reject the revision. Exported for tests.
 */
export function validateHumanFeedbackAck(
  revisedPlan: string,
  humanComments: { author: string }[],
): boolean {
  if (humanComments.length === 0) return true;
  return revisedPlan.includes(HUMAN_FEEDBACK_ACK_HEADER);
}

/**
 * Render human comments left on the posted plan as `@login: body` blocks for the
 * revision prompt's human-feedback section, or `undefined` when there are none
 * (so `buildPlanRevisionPrompt` omits the section entirely). Exported for tests.
 */
export function formatHumanFeedback(
  humanComments: { author: string; body: string }[],
): string | undefined {
  if (humanComments.length === 0) return undefined;
  return humanComments.map((c) => `@${c.author}: ${c.body}`).join("\n\n");
}

/**
 * Attribution lines for the `## Revised Implementation Plan` comment. Appends a
 * `**Human feedback from**: @login, …` line (deduped) when human comments were
 * incorporated; returns the base attribution unchanged when there were none, so
 * the comment is byte-for-byte identical to today's on the no-feedback path.
 * Exported for tests.
 */
export function revisedPlanHeader(
  implementer: string,
  reviewer: string,
  humanComments: { author: string }[],
): string[] {
  const lines = [`**Updated by**: ${implementer}`, `**Based on review by**: ${reviewer}`];
  if (humanComments.length > 0) {
    const logins = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
    lines.push(`**Human feedback from**: ${logins}`);
  }
  return lines;
}
