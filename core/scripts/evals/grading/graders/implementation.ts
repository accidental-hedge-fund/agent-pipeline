// Implementation/fix grader (eval-graders). Pure function of a completed
// cell's recorded detail, the fixture, and the base-commit check baseline —
// no model call, no I/O.

import { countOutOfScopeChanges } from "../checks.ts";
import type { Fixture } from "../../types.ts";
import type { AcceptanceCriterionResult, ImplementationFixGrade } from "../types.ts";

export function gradeImplementationFix(
  fixture: Fixture,
  candidateChecks: Record<string, boolean>,
  baselineChecks: Record<string, boolean>,
  changedPaths: string[] | undefined,
): ImplementationFixGrade {
  const hiddenChecks = fixture.hidden_checks ?? [];
  const hiddenPassed = hiddenChecks.filter((c) => candidateChecks[c] === true).length;

  const allChecks = [...fixture.public_checks, ...hiddenChecks];
  let regressions = 0;
  let preExistingFailures = 0;
  for (const check of allChecks) {
    const before = baselineChecks[check];
    const after = candidateChecks[check];
    if (before === undefined || after === undefined) continue;
    if (before === true && after === false) regressions++;
    else if (before === false && after === false) preExistingFailures++;
  }

  const criteria = fixture.acceptance_criteria ?? [];
  const criteriaResults: AcceptanceCriterionResult[] = criteria.map((c) => ({
    id: c.id,
    satisfied: (c.check_names ?? []).length > 0 && c.check_names!.every((name) => candidateChecks[name] === true),
  }));

  const outOfScope =
    fixture.allowed_change_paths === undefined
      ? null
      : countOutOfScopeChanges(changedPaths ?? [], fixture.allowed_change_paths);

  return {
    hidden_tests: { passed: hiddenPassed, total: hiddenChecks.length },
    acceptance: {
      criteria: criteriaResults,
      completed: criteriaResults.filter((r) => r.satisfied).length,
      total: criteriaResults.length,
    },
    regressions,
    pre_existing_failures: preExistingFailures,
    out_of_scope_changes: outOfScope,
  };
}
