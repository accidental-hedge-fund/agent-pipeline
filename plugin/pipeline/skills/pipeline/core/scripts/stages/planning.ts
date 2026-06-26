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
  getPrForBranch,
  getPrForIssue,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke, formatStderrExcerpt, type HarnessResult } from "../harness.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
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
import * as openspec from "../openspec.ts";
import * as last30days from "../last30days.ts";
import { setLivePlanningMarker, clearLivePlanningMarker } from "../lock.ts";
import {
  verifyHarnessCommits,
  verifyPlanRevisionOutput,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import type { Harness, Outcome, PipelineConfig, Stage } from "../types.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { INJECTION_PATTERNS } from "../artifact-sanitize.ts";
import { emitHumanIntervention } from "../intervention.ts";

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
   *  command runs under the "planning" stage. Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#155). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` so events also stream to stdout under
   *  `--json-events` (#155). Undefined → events go to events.jsonl only. */
  runStoreDeps?: RunStoreDeps;
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
  ): Promise<HarnessResult>;
}

// ---------------------------------------------------------------------------
// RunPlanningPhasesDeps — injectable seams for runPlanningPhases
// ---------------------------------------------------------------------------

type RunPlanningPhasesDeps = BootstrapWorktreeDeps &
  PlanStepDeps &
  ImplementerInvokeDeps &
  ResumeFromImplementingDeps & {
    getIssueDetail?: typeof getIssueDetail;
    setBlocked?: typeof setBlocked;
    transition?: typeof transition;
    postComment?: typeof postComment;
    addLabel?: typeof addLabel;
    invokeReviewer?: typeof invokeReviewer;
    hasCommitsAhead?: typeof hasCommitsAhead;
    gitInWorktree?: typeof gitInWorktree;
    /** Overrides `openspec.isInitialized` for unit tests that cannot set up a real worktree. */
    openspecIsInitialized?: (path: string) => boolean;
  };

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

  // ---- Step 0: optional carry-forward context (last30days) ----
  const carryForward = await gatherCarryForward(cfg, issueNumber, title, body);

  // ---- Worktree bootstrap: create + dependency install ----
  const slug = slugify(title) || `issue-${issueNumber}`;
  const bootstrap = await bootstrapWorktree(cfg, issueNumber, slug, deps);
  if (!bootstrap.ok) {
    const bootstrapMsg = bootstrap.tag === "worktree-creation-failed"
      ? `Worktree creation failed: ${bootstrap.reason}`
      : `Worktree setup failed: ${bootstrap.reason}`;
    await doSetBlocked(cfg, issueNumber, bootstrapMsg, "ready", bootstrap.tag);
    await emitHumanIntervention(opts.runDir, {
      kind: "auth-tooling-preflight-failure",
      stage: "ready",
      issue: issueNumber,
      detail: bootstrapMsg,
    }, opts.runStoreDeps).catch(() => {});
    return { advanced: false, status: "blocked", reason: bootstrap.reason };
  }
  const wt = bootstrap.wt;
  if (opts.runDir) {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendEvent(opts.runDir, { schema_version: RUN_SCHEMA_VERSION, type: "worktree_created", at, _localPath: wt.path }, opts.runStoreDeps).catch(() => {});
  }

  // ---- Author the planning artifact ----
  const authorResult = await hooks.authorArtifact(cfg, issueNumber, wt, opts, carryForward, pipelineRunId, deps);
  if (!authorResult.ok) {
    await doSetBlocked(cfg, issueNumber, authorResult.reason, "ready", authorResult.tag);
    await emitHumanIntervention(opts.runDir, {
      kind: "ambiguous-issue",
      stage: "ready",
      issue: issueNumber,
      detail: authorResult.reason,
    }, opts.runStoreDeps).catch(() => {});
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
    return { advanced: false, status: "blocked", reason: validateResult.reason };
  }

  // ---- Transition ready → planning, post plan comment ----
  await doTransition(cfg, issueNumber, "ready", "planning", authorResult.readyToPlanningMsg);
  const planComment = `## Implementation Plan\n\n${planText}${footer(cfg)}`;
  await doPostComment(cfg, issueNumber, planComment);

  // Tag the primary harness early for visibility in transition/blocker comments.
  try {
    await doAddLabel(cfg, issueNumber, `harness:${primary}`);
  } catch {
    /* idempotent */
  }

  // ---- Plan review + revision (skippable via steps.plan_review) ----
  let revisedPlan = planText;
  let preImplStage: Stage = "planning";
  if (cfg.steps.plan_review) {
    await doTransition(
      cfg,
      issueNumber,
      "planning",
      "plan-review",
      hooks.planToReviewMsg(primary, reviewer),
    );
    preImplStage = "plan-review";

    const reviewPrompt = buildPlanReviewPrompt({ cfg, issueNumber, title, body, plan: promptPlanText, reviewer, implementer: primary, specContext });
    // #39: same-harness fallback — if the reviewer CLI is unspawnable, the
    // implementing harness reviews the plan, clearly labeled below.
    // OpenSpec hooks supply planReviewCwd=wt.path so the reviewer can inspect
    // the just-authored change files; freeform uses cfg.repo_dir.
    const planReviewCwd = hooks.planReviewCwd ? hooks.planReviewCwd(wt) : cfg.repo_dir;
    const { result: reviewResult, effectiveReviewer: planReviewer, selfReview: planSelfReview } =
      await doInvokeReviewer(reviewer, primary, planReviewCwd, reviewPrompt, {
        timeoutSec: cfg.plan_review_timeout,
        model: opts.model ?? cfg.models.review,
        reasoningEffort: "medium",
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
      return { advanced: false, status: "blocked", reason };
    }
    const planReview = reviewResult.stdout.trim();
    if (!planReview.includes("## Plan Review Verdict")) {
      const reason = `plan-review output missing required "## Plan Review Verdict" section — the reviewer returned prose instead of a structured verdict`;
      await doSetBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      await emitHumanIntervention(opts.runDir, {
        kind: "product-judgment-required",
        stage: "plan-review",
        issue: issueNumber,
        detail: reason,
      }, opts.runStoreDeps).catch(() => {});
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
      ? await hooks.invokeRevision(primary, wt, revisionPrompt, cfg, opts, deps)
      : await invokePlanStep(primary, wt.path, revisionPrompt, cfg, opts, { invoke: deps.invoke });
    if (!revisionResult.success || !revisionResult.stdout.trim()) {
      const reason = revisionResult.timed_out
        ? `Plan revision timed out after ${revisionResult.duration.toFixed(0)}s`
        : `Plan revision failed (exit ${revisionResult.exit_code})`;
      await doSetBlocked(cfg, issueNumber, `Plan revision by ${primary} failed: ${reason}`, "plan-review", "harness-failure");
      return { advanced: false, status: "blocked", reason };
    }
    // Verify the plan-revision output includes the required acknowledgement section (#68).
    const ackCheck = verifyPlanRevisionOutput(revisionResult.stdout, planReview);
    if (!ackCheck.ok) {
      await doSetBlocked(cfg, issueNumber, ackCheck.reason, "plan-review", "needs-human");
      return { advanced: false, status: "blocked", reason: ackCheck.reason };
    }
    if (ackCheck.warning) {
      console.warn(`[pipeline] #${issueNumber}: plan-revision warning — ${ackCheck.warning}`);
    }

    // Re-validate and re-read artifact after revision (OpenSpec re-reads proposal; freeform is a no-op).
    const rv = await hooks.revalidateArtifact(wt, revisionResult.stdout.trim());
    if (!rv.ok) {
      await doSetBlocked(cfg, issueNumber, rv.reason, "plan-review", rv.tag);
      return { advanced: false, status: "blocked", reason: rv.reason };
    }
    revisedPlan = rv.updatedPlanText;
    specContext = rv.updatedSpecContext || specContext;

    if (!validateHumanFeedbackAck(revisedPlan, humanComments)) {
      const commenters = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
      const reason = `Plan revision by ${primary} is missing the required "${HUMAN_FEEDBACK_ACK_HEADER}" section for human comments from ${commenters}`;
      await doSetBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      await emitHumanIntervention(opts.runDir, {
        kind: "plan-review-feedback",
        stage: "plan-review",
        issue: issueNumber,
        detail: reason,
      }, opts.runStoreDeps).catch(() => {});
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
  await doTransition(
    cfg,
    issueNumber,
    preImplStage,
    "implementing",
    hooks.preImplTransitionMsg(primary, reviewer, cfg.steps.plan_review),
  );

  // ---- Build implementation plan and invoke implementer harness ----
  const implPlan = await hooks.buildImplPlan(wt, revisedPlan);
  const implPrompt = buildImplementingPrompt({ cfg, issueNumber, title, body, plan: implPlan, pipelineRunId, docsEnabled: cfg.steps.docs, specContext });
  const implHeadBefore = (
    await doGitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const result = await invokeImplementer(primary, wt.path, implPrompt, cfg, opts, { invoke: deps.invoke });

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
    return { advanced: false, status: "blocked", reason: "no commits produced" };
  }

  // ---- Verify implementation commit references the issue (#68) ----
  if (implHeadBefore) {
    const implCheck = await enforceImplCommitRef(issueNumber, wt.path, implHeadBefore);
    if (!implCheck.ok) {
      await doSetBlocked(cfg, issueNumber, implCheck.reason, "implementing", "needs-human");
      return { advanced: false, status: "blocked", reason: implCheck.reason };
    }
  }

  // ---- Build PR body and hand off to post-implementation steps ----
  const planExcerpt = revisedPlan.length > 2000 ? revisedPlan.slice(0, 2000) + "\n\n[…plan truncated]" : revisedPlan;
  const prBody = hooks.buildPrBody(cfg, issueNumber, title, planExcerpt, primary, reviewer);

  return resumeFromImplementing(cfg, issueNumber, wt, {
    prTitle: `[Pipeline] ${title} (#${issueNumber})`,
    prBody,
    transitionMessage: (prNumber) => hooks.buildTransitionMessage(prNumber, primary, reviewer),
    pipelineRunId,
    stateDir: opts.stateDir,
    runDir: opts.runDir,
    runStoreDeps: opts.runStoreDeps,
  }, deps);
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
    async authorArtifact(innerCfg, issueNumber, wt, opts, carryForward, _pipelineRunId, deps) {
      const primary: Harness = innerCfg.harnesses.implementer;
      const planPrompt = buildPlanningPrompt({ cfg: innerCfg, issueNumber, title, body, carryForward });
      let planResult: HarnessResult;
      try {
        planResult = await invokePlanStep(primary, wt.path, planPrompt, innerCfg, opts, { invoke: deps.invoke });
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
    async authorArtifact(innerCfg, issueNumber, wt, opts, carryForward, pipelineRunId, deps) {
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
      const planResult = await inv(
        primary,
        wt.path,
        buildPlanningOpenspecPrompt({ cfg: innerCfg, issueNumber, title, body, carryForward, pipelineRunId }),
        {
          timeoutSec: innerCfg.implementation_timeout,
          model: opts.model ?? innerCfg.models.planning,
          sandbox: innerCfg.harness_sandbox,
        },
      );
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
      await salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "OpenSpec authoring", osAuthorHeadBefore);

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
    async invokeRevision(primary, wt, prompt, innerCfg, opts, deps) {
      const inv = deps.invoke ?? invoke;
      return inv(primary, wt.path, prompt, {
        timeoutSec: innerCfg.implementation_timeout,
        model: opts.model ?? innerCfg.models.planning,
        sandbox: innerCfg.harness_sandbox,
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
    cfg, issueNumber, wt.path, "planning", opts.pipelineRunId, opts.stateDir,
    { runFormatGate: fmtGateFn, runTestGate: gateRunner },
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
}

/**
 * Dispatch resume for the `implementing` stage: check whether the issue has an
 * existing worktree with commits ahead of the base branch. If so, run the
 * post-implementation steps (test gate → push → PR → review-1) without
 * re-planning or re-implementing. If not, return the existing "nothing to do"
 * waiting response (no regression for mid-flight runs).
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

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would resume from implementing: check gate + push + PR + review-1`);
    return { advanced: true, from: "implementing", to: "review-1", summary: "[dry-run] implementing resume" };
  }

  const wt = await getWt(cfg, issueNumber);
  if (!wt || !(await commitsAhead(wt.path, cfg.base_branch))) {
    return {
      advanced: false,
      status: "waiting",
      reason: "implementing is set mid-flight by the planning/plan-review handler; nothing to do at this point.",
    };
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
): Promise<void> {
  if (!headBefore) return;
  const headAfter = (
    await gitInWorktree(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  if (headAfter && headAfter === headBefore) {
    await trySalvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel);
  }
}

// ---------------------------------------------------------------------------
// Implementer harness invocation (#70) — exported for direct unit testing
// ---------------------------------------------------------------------------

/** Injectable seam for unit-testing {@link invokeImplementer} without a real harness. */
export interface ImplementerInvokeDeps {
  invoke?: typeof invoke;
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
): Promise<HarnessResult> {
  const inv = deps.invoke ?? invoke;
  return inv(harness, wtPath, prompt, {
    timeoutSec: cfg.implementation_timeout,
    model: opts.model ?? cfg.models.implementing,
    sandbox: cfg.harness_sandbox,
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
): Promise<HarnessResult> {
  const inv = deps.invoke ?? invoke;
  const dir = (cfg.harness_sandbox && harness === "claude") ? wtPath : cfg.repo_dir;
  return inv(harness, dir, prompt, {
    timeoutSec: cfg.implementation_timeout,
    model: opts.model ?? cfg.models.planning,
    sandbox: cfg.harness_sandbox,
  });
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
