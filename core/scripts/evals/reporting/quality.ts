// A single [0,1] quality axis derived from a deterministic grade, used only
// by the reporting layer for pairing/interval/Pareto computation. This is a
// reporting-layer convention, not a grading-layer field — grades.jsonl never
// contains it, and it is never combined with duration or cost into one score
// (eval-comparative-reporting's "no combined weighted score").

import type { GradeRecord } from "../grading/types.ts";

function rate(numerator: number, total: number): number {
  return total === 0 ? 1 : numerator / total;
}

export function qualityScore(grade: GradeRecord): number {
  switch (grade.payload.kind) {
    case "implementation-fix": {
      const g = grade.payload.grade;
      const hiddenRate = rate(g.hidden_tests.passed, g.hidden_tests.total);
      const acceptanceRate = rate(g.acceptance.completed, g.acceptance.total);
      const regressionPenalty = Math.min(1, g.regressions * 0.25);
      return Math.max(0, (hiddenRate + acceptanceRate) / 2 - regressionPenalty);
    }
    case "review":
      return grade.payload.grade.f1 ?? 0;
    case "planning": {
      const g = grade.payload.grade;
      const coverageRate = rate(g.requirement_coverage.covered, g.requirement_coverage.total);
      const assumptionPenalty = Math.min(1, g.unsupported_assumptions * 0.1);
      return Math.max(
        0,
        (coverageRate + g.actionability.score + g.downstream_compatibility.score) / 3 - assumptionPenalty,
      );
    }
  }
}
