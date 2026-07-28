// Stage-mode / end-to-end prompt materialization (openspec/changes/stage-eval-runner).
//
// Deliberately does NOT call into core/scripts/stages/*.ts's production entry
// points: those assume state written by a live predecessor stage (a real PR,
// issue comments, a running worktree from an earlier round — see
// design.md's Risks section and eval-fixture-contract's requirement that
// entering a stage require no artifact produced by a live predecessor run).
// Instead, each stage is entered directly from the fixture's frozen
// stage-entry artifact by materializing a prompt and invoking the harness in
// the cell's isolated worktree — which by construction never touches gh.

import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import { EVAL_STAGE_NAMES, type EvalMode, type EvalStageName, type Fixture } from "./types.ts";

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
 *  and no other. */
export function stagesForMode(mode: EvalMode, fixture: Fixture): EvalStageName[] {
  if (mode === "end-to-end") {
    return materializeEndToEndPrompts(fixture).map((p) => p.stage);
  }
  if (mode === "paired") return [];
  return [mode];
}

/** Prompt a paired evaluator's reviewer with the exact diff produced in its
 * own isolated worktree. The verdict shape is the production review schema,
 * so paired results can use the same conservative finding parser. */
export function materializePairedReviewPrompt(fixture: Fixture, diff: string, round: 1 | 2): string {
  return [
    `You are the ${round === 1 ? "first" : "final"} independent reviewer for this implementation.`,
    "Review the actual diff below for correctness, safety, and adherence to the task.",
    "Return JSON only, matching this schema. Do not claim approval when the diff is empty or the task is not met.",
    REVIEW_VERDICT_SCHEMA_BLOCK,
    "",
    "## Task",
    fixture.task_input,
    "",
    "## Actual diff",
    diff || "(no changes)",
  ].join("\n");
}

/** Give the primary only the reviewer findings it must address, not hidden
 * grader checks or any production-state affordance. */
export function materializePairedFixPrompt(fixture: Fixture, findings: unknown[]): string {
  return [
    "Address the blocking review findings with a minimal, surgical fix in the current worktree.",
    "Do not discard unrelated existing work.",
    "",
    "## Task",
    fixture.task_input,
    "",
    "## Blocking findings",
    JSON.stringify(findings, null, 2),
  ].join("\n");
}
