// Stage-mode / end-to-end / paired prompt materialization
// (openspec/changes/stage-eval-runner, eval-ordered-primary-reviewer-pairs #601).
//
// Deliberately does NOT call into core/scripts/stages/*.ts's production entry
// points: those assume state written by a live predecessor stage (a real PR,
// issue comments, a running worktree from an earlier round). Instead, each
// stage is entered from the fixture's frozen stage-entry artifact and/or live
// handoffs within a paired cell, by materializing a prompt and invoking the
// harness in the cell's isolated worktree.
//
// Paired modes (#601) reuse production prompt builders/templates so the eval
// contract cannot drift from production. Implementation and fix may append
// only the eval no-commit/no-push execution override.

import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import {
  buildFixPrompt,
  buildImplementingPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
  buildPlanningPrompt,
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
} from "../prompts/index.ts";
import type { PipelineConfig } from "../types.ts";
import {
  EVAL_STAGE_NAMES,
  isPairedEvalMode,
  type EvalMode,
  type EvalStageName,
  type Fixture,
} from "./types.ts";

const STAGE_INSTRUCTIONS: Record<EvalStageName, string> = {
  planning: "Produce an implementation plan for the following issue.",
  "plan-review": "Review the following implementation plan for correctness and completeness.",
  implementing: "Implement the following plan in this repository.",
  review: "Review the following diff for correctness, safety, and adherence to the plan.",
  fix: "Resolve the following review finding with a minimal, surgical diff.",
  shipcheck: "Verify the following change is ready to ship: re-run checks and confirm no regressions.",
};

// The production reviewer prompts (`review_standard.md`, `review_adversarial.md`)
// state the structured verdict contract by substituting `REVIEW_VERDICT_SCHEMA_BLOCK`
// for `{{schema_block}}` plus this exact JSON-only instruction (#606). Without it,
// an eval reviewer is asked for a review but never told the output contract, so a
// compliant harness returns prose the eval's parser cannot read. Populated for the
// `review` stage only — every other stage's materialized text is unchanged.
const REVIEW_OUTPUT_CONTRACT = [
  "",
  "Return ONLY valid JSON matching this schema (no markdown fences, no commentary outside the JSON):",
  "",
  "```",
  REVIEW_VERDICT_SCHEMA_BLOCK,
  "```",
].join("\n");

/**
 * Eval-only execution override appended to implement/fix prompts in paired
 * modes (#601). Does not replace the production content contract — only
 * constrains git/GitHub side effects so the agent stays inside the eval worktree.
 */
export const EVAL_NO_COMMIT_PUSH_OVERRIDE = `

## Evaluation execution constraints (mandatory)

You are running inside an isolated evaluation worktree. You MUST NOT:
- create git commits
- push to any remote
- open, edit, label, or comment on GitHub issues or pull requests
- invoke \`gh\` or \`pipeline\` commands

Make file edits in the worktree only. Do not attempt production pipeline side effects.
`;

/** Materialize the exact prompt text sent to the harness for one stage,
 *  from the fixture's frozen inputs alone. */
export function materializeStagePrompt(stage: EvalStageName, fixture: Fixture): string {
  const artifact = fixture.stage_entry_artifacts[stage];
  const parts = [
    STAGE_INSTRUCTIONS[stage],
    "",
    `## Task`,
    fixture.task_input,
  ];
  if (artifact !== undefined) {
    parts.push("", `## Stage input`, JSON.stringify(artifact, null, 2));
  }
  if (stage === "review") {
    parts.push(REVIEW_OUTPUT_CONTRACT);
  }
  return parts.join("\n");
}

/** Materialize the sequence of per-stage prompts end-to-end mode invokes, in
 *  pipeline order, restricted to the stages the fixture actually supplies
 *  entry artifacts for. */
export function materializeEndToEndPrompts(fixture: Fixture): Array<{ stage: EvalStageName; prompt: string }> {
  return EVAL_STAGE_NAMES
    .filter((stage) => fixture.stage_entry_artifacts[stage] !== undefined)
    .map((stage) => ({ stage, prompt: materializeStagePrompt(stage, fixture) }));
}

/** The stage(s) a given eval mode invokes, in order. `end-to-end` invokes the
 *  full available sequence; a single stage mode invokes exactly that stage
 *  and no other. Paired modes are orchestrated by the executor with live
 *  handoffs — they return no frozen single-stage list. */
export function stagesForMode(mode: EvalMode, fixture: Fixture): EvalStageName[] {
  if (mode === "end-to-end") {
    return materializeEndToEndPrompts(fixture).map((p) => p.stage);
  }
  if (isPairedEvalMode(mode)) {
    return [];
  }
  return [mode];
}

// ---------------------------------------------------------------------------
// Paired-mode production prompt builders (#601)
// ---------------------------------------------------------------------------

export interface PairedPromptContext {
  cfg: PipelineConfig;
  fixture: Fixture;
  /** Stable eval run id substituted into implement/fix trailers. */
  pipelineRunId: string;
  issueNumber?: number;
  title?: string;
  /** Primary (implementer) harness name for plan-review/revision headers. */
  implementer: string;
  /** Reviewer harness name for plan-review/revision headers. */
  reviewer: string;
}

function taskTitle(fixture: Fixture, title?: string): string {
  return title ?? `eval:${fixture.fixture_id}`;
}

function taskBody(fixture: Fixture): string {
  return fixture.task_input || "(no description)";
}

function stageArtifactText(fixture: Fixture, stage: EvalStageName, fallback = ""): string {
  const artifact = fixture.stage_entry_artifacts[stage];
  if (artifact === undefined || artifact === null) return fallback;
  if (typeof artifact === "string") return artifact;
  if (typeof artifact === "object" && artifact !== null) {
    const obj = artifact as Record<string, unknown>;
    if (typeof obj.plan === "string") return obj.plan;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.diff === "string") return obj.diff;
  }
  return JSON.stringify(artifact, null, 2);
}

/** Production planning prompt for pipeline-paired primary planning. */
export function materializePairedPlanningPrompt(ctx: PairedPromptContext): string {
  return buildPlanningPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
  });
}

/** Production plan-review prompt; plan is the live handoff from planning. */
export function materializePairedPlanReviewPrompt(ctx: PairedPromptContext, plan: string): string {
  return buildPlanReviewPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
    plan,
    reviewer: ctx.reviewer,
    implementer: ctx.implementer,
  });
}

/** Production plan-revision prompt when plan-review produced blocking feedback. */
export function materializePairedPlanRevisionPrompt(
  ctx: PairedPromptContext,
  plan: string,
  feedback: string,
): string {
  return buildPlanRevisionPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
    plan,
    feedback,
    reviewer: ctx.reviewer,
    implementer: ctx.implementer,
  });
}

/** Production implementing prompt + eval no-commit/no-push override. */
export function materializePairedImplementPrompt(ctx: PairedPromptContext, plan: string): string {
  const base = buildImplementingPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
    plan: plan || stageArtifactText(ctx.fixture, "implementing", ctx.fixture.task_input),
    pipelineRunId: ctx.pipelineRunId,
    docsEnabled: false,
  });
  return base + EVAL_NO_COMMIT_PUSH_OVERRIDE;
}

/**
 * Production standard review prompt on the **actual** primary worktree diff.
 * Never substitutes the fixture's frozen review stage-entry as the sole body.
 */
export function materializePairedStandardReviewPrompt(
  ctx: PairedPromptContext,
  plan: string,
  diff: string,
): string {
  return buildReviewStandardPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
    plan: plan || ctx.fixture.task_input,
    diff: diff || "(no changes)",
  });
}

/** Production adversarial review prompt on the current worktree diff. */
export function materializePairedAdversarialReviewPrompt(
  ctx: PairedPromptContext,
  diff: string,
  review1Summary?: string,
): string {
  return buildReviewAdversarialPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    body: taskBody(ctx.fixture),
    plan: ctx.fixture.task_input,
    diff: diff || "(no changes)",
    review1Summary,
  });
}

/** Production fix prompt + eval no-commit/no-push override. */
export function materializePairedFixPrompt(
  ctx: PairedPromptContext,
  findingsText: string,
  fixRound: 1 | 2,
  priorReviewHistory?: string,
): string {
  const base = buildFixPrompt({
    cfg: ctx.cfg,
    issueNumber: ctx.issueNumber ?? 0,
    title: taskTitle(ctx.fixture, ctx.title),
    reviewFindings: findingsText,
    priorReviewHistory,
    fixRound,
    pipelineRunId: ctx.pipelineRunId,
  });
  return base + EVAL_NO_COMMIT_PUSH_OVERRIDE;
}

/**
 * Resolve effective role coordinates for a paired cell: pair treatment wins
 * as the experimental variable; pipeline.yml/config supplies defaults for
 * fields the pair leaves unset (design D6).
 */
export function resolvePairedRoleCoordinates(
  cfg: PipelineConfig,
  role: "primary" | "reviewer",
  coordinate: { harness: string; model?: string; effort?: string },
): { harness: string; model?: string; effort?: string } {
  if (role === "primary") {
    return {
      harness: coordinate.harness,
      model: coordinate.model ?? cfg.models?.implementing,
      effort: coordinate.effort ?? cfg.effort?.implementing,
    };
  }
  // Reviewer: structured review_harness / harnesses settings fill gaps.
  return {
    harness: coordinate.harness,
    model: coordinate.model ?? cfg.harnesses?.reviewerModel ?? cfg.models?.review,
    effort: coordinate.effort ?? cfg.harnesses?.reviewerEffort ?? cfg.effort?.review,
  };
}

/**
 * Fail closed when production-style reviewer declarations conflict
 * (harnesses.reviewer vs review_harness naming different commands). Pair
 * coordinates still override the chosen harness as the experimental variable;
 * this only detects an unresolvable production config bug before overlay.
 */
export function detectConflictingReviewerDeclarations(cfg: PipelineConfig): string | null {
  // PipelineConfig carries already-resolved harnesses; conflict was thrown at
  // config load. Surface an explicit residual check when both raw-like fields
  // appear on a test/fake config via optional untyped extras.
  const extras = cfg as PipelineConfig & {
    review_harness?: string | { command?: string };
  };
  const repoReviewer = cfg.harnesses?.reviewer;
  const reviewHarness =
    typeof extras.review_harness === "string"
      ? extras.review_harness
      : extras.review_harness?.command;
  if (
    typeof repoReviewer === "string" &&
    typeof reviewHarness === "string" &&
    repoReviewer.length > 0 &&
    reviewHarness.length > 0 &&
    repoReviewer !== reviewHarness &&
    // Only fail when the experimental pair did not already pick a single harness —
    // residual raw conflict on cfg itself.
    true
  ) {
    // When both resolved to different names on a partial fake, report it.
    // Live PipelineConfig never leaves this inconsistent after resolveConfig.
    if ((cfg as { _rawReviewerConflict?: boolean })._rawReviewerConflict) {
      return `harnesses.reviewer ("${repoReviewer}") and review_harness ("${reviewHarness}") name different reviewer commands`;
    }
  }
  return null;
}
