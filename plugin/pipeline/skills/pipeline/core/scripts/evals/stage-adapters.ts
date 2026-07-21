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

import { EVAL_STAGE_NAMES, type EvalMode, type EvalStageName, type Fixture } from "./types.ts";

const STAGE_INSTRUCTIONS: Record<EvalStageName, string> = {
  planning: "Produce an implementation plan for the following issue.",
  "plan-review": "Review the following implementation plan for correctness and completeness.",
  implementing: "Implement the following plan in this repository.",
  review: "Review the following diff for correctness, safety, and adherence to the plan.",
  fix: "Resolve the following review finding with a minimal, surgical diff.",
  shipcheck: "Verify the following change is ready to ship: re-run checks and confirm no regressions.",
};

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
  return [mode];
}
