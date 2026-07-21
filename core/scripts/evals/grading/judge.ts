// Optional model judge (eval-graders). Disabled by default; when it runs, it
// writes its own record and never moves a deterministic grade field
// (design.md decision 6). Judging exists to flag disagreement — disagreements
// are what a human adjudicates (adjudication.ts).

import type { GradeRecord, JudgeDisagreementRecord, JudgeRecord } from "./types.ts";

export interface JudgeVerdict {
  pass: boolean;
  note?: string;
}

export interface InvokeJudgeArgs {
  grade: GradeRecord;
}

export interface JudgeDeps {
  invokeJudge: (args: InvokeJudgeArgs) => Promise<JudgeVerdict>;
  judgeHarness: string;
  judgeModel: string;
  judgePromptVersion: string;
}

/** Whether a deterministic grade reads as a pass — used only to detect a
 *  judge disagreement, never to compute or alter the grade itself. */
export function deterministicPass(grade: GradeRecord): boolean {
  switch (grade.payload.kind) {
    case "implementation-fix": {
      const g = grade.payload.grade;
      const hiddenOk = g.hidden_tests.total === 0 || g.hidden_tests.passed === g.hidden_tests.total;
      const acceptanceOk = g.acceptance.total === 0 || g.acceptance.completed === g.acceptance.total;
      return hiddenOk && acceptanceOk && g.regressions === 0;
    }
    case "review": {
      const f1 = grade.payload.grade.f1;
      return f1 !== null && f1 >= 0.5;
    }
    case "planning": {
      const g = grade.payload.grade;
      return g.requirement_coverage.total === 0 || g.requirement_coverage.covered / g.requirement_coverage.total >= 0.5;
    }
  }
}

/** Run the optional model judge over every deterministic grade. Never
 *  invoked unless the caller opts in (pipeline evals grade --judge). Returns
 *  judge records and any judge/deterministic disagreements, both separate
 *  from `grades`. */
export async function runJudging(
  grades: GradeRecord[],
  deps: JudgeDeps,
): Promise<{ judgeRecords: JudgeRecord[]; disagreements: JudgeDisagreementRecord[] }> {
  const judgeRecords: JudgeRecord[] = [];
  const disagreements: JudgeDisagreementRecord[] = [];

  for (const grade of grades) {
    const verdict = await deps.invokeJudge({ grade });
    judgeRecords.push({
      cell_id: grade.cell_id,
      experiment_id: grade.experiment_id,
      fixture_id: grade.fixture_id,
      treatment_id: grade.treatment_id,
      replicate: grade.replicate,
      judge_harness: deps.judgeHarness,
      judge_model: deps.judgeModel,
      judge_prompt_version: deps.judgePromptVersion,
      verdict,
    });
    if (verdict.pass !== deterministicPass(grade)) {
      disagreements.push({
        cell_id: grade.cell_id,
        experiment_id: grade.experiment_id,
        fixture_id: grade.fixture_id,
        treatment_id: grade.treatment_id,
        replicate: grade.replicate,
        judge_prompt_version: deps.judgePromptVersion,
        note: `judge verdict pass=${verdict.pass} disagrees with deterministic grade pass=${deterministicPass(grade)}`,
      });
    }
  }

  return { judgeRecords, disagreements };
}
