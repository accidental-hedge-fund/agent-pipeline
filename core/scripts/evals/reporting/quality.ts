// A single [0,1] quality axis derived from a deterministic grade, used only
// by the reporting layer for pairing/interval/Pareto computation. This is a
// reporting-layer convention, not a grading-layer field — grades.jsonl never
// contains it, and it is never combined with duration or cost into one score
// (eval-comparative-reporting's "no combined weighted score").

import type { CompositeSubGradePayload, GradeRecord } from "../grading/types.ts";
import type { ImplementationFixGrade, PlanningGrade, ReviewGrade } from "../grading/types.ts";

function rate(numerator: number, total: number): number {
  return total === 0 ? 1 : numerator / total;
}

function scoreImplementationFix(g: ImplementationFixGrade): number {
  const hiddenRate = rate(g.hidden_tests.passed, g.hidden_tests.total);
  const acceptanceRate = rate(g.acceptance.completed, g.acceptance.total);
  const regressionPenalty = Math.min(1, g.regressions * 0.25);
  return Math.max(0, (hiddenRate + acceptanceRate) / 2 - regressionPenalty);
}

function scoreReview(g: ReviewGrade): number {
  return g.f1 ?? 0;
}

function scorePlanning(g: PlanningGrade): number {
  const coverageRate = rate(g.requirement_coverage.covered, g.requirement_coverage.total);
  const assumptionPenalty = Math.min(1, g.unsupported_assumptions * 0.1);
  return Math.max(0, (coverageRate + g.actionability.score + g.downstream_compatibility.score) / 3 - assumptionPenalty);
}

function scoreCompositeSubGrade(sub: CompositeSubGradePayload): number {
  return sub.kind === "review" ? scoreReview(sub.grade) : scorePlanning(sub.grade);
}

export function qualityScore(grade: GradeRecord): number {
  switch (grade.payload.kind) {
    case "implementation-fix":
      return scoreImplementationFix(grade.payload.grade);
    case "review":
      return scoreReview(grade.payload.grade);
    case "planning":
      return scorePlanning(grade.payload.grade);
    case "composite": {
      const scores = grade.payload.grades.map(scoreCompositeSubGrade);
      return scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }
}
