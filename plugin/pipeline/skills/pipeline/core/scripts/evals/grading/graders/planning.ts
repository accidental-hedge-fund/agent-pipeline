// Planning grader (eval-graders). A versioned, deterministic rubric over the
// plan's own text — never the treatment's self-assessment (design.md
// decision 5). No model call.

import type { Fixture } from "../../types.ts";
import type { PlanningGrade } from "../types.ts";

export const PLANNING_RUBRIC_VERSION = "planning-rubric-v1";

const ASSUMPTION_SIGNAL_RE = /\bassum\w*\b/gi;
const ACTION_STEP_RE = /^\s*(?:[-*]|\d+[.)])\s+\S/gm;
const COMPATIBILITY_SIGNALS = ["test", "regression", "backward", "backwards", "migration", "compatib"];

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

/** Score a planning cell's output text against the fixture's declared
 *  requirement keywords. Deliberately reads only `outputText` — a treatment's
 *  self-assessment/self-score, if any, is never an input here (types.ts,
 *  eval-graders' "never consumes a treatment self-score" requirement). */
export function gradePlanning(fixture: Fixture, outputText: string): PlanningGrade {
  const criteriaWithKeywords = (fixture.acceptance_criteria ?? []).filter((c) => (c.keywords ?? []).length > 0);
  const lowerText = outputText.toLowerCase();
  const covered = criteriaWithKeywords.filter((c) => c.keywords!.every((k) => lowerText.includes(k.toLowerCase()))).length;

  const unsupportedAssumptions = countMatches(outputText, ASSUMPTION_SIGNAL_RE);

  const stepCount = countMatches(outputText, ACTION_STEP_RE);
  const actionabilityScore = Math.min(1, stepCount / 3);

  const matchedSignals = COMPATIBILITY_SIGNALS.filter((signal) => lowerText.includes(signal)).length;

  return {
    rubric_version: PLANNING_RUBRIC_VERSION,
    requirement_coverage: { covered, total: criteriaWithKeywords.length },
    unsupported_assumptions: unsupportedAssumptions,
    actionability: { step_count: stepCount, score: actionabilityScore },
    downstream_compatibility: {
      matched_signals: matchedSignals,
      total_signals: COMPATIBILITY_SIGNALS.length,
      score: matchedSignals / COMPATIBILITY_SIGNALS.length,
    },
  };
}
