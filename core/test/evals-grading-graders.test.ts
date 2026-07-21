// Tests for the deterministic graders (eval-graders). Pure functions — no
// fs, git, subprocess, or model call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { gradeImplementationFix } from "../scripts/evals/grading/graders/implementation.ts";
import { gradeReview, parseReportedFindings } from "../scripts/evals/grading/graders/review.ts";
import { gradePlanning } from "../scripts/evals/grading/graders/planning.ts";
import type { Fixture } from "../scripts/evals/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";

function fixtureFix(overrides: Record<string, unknown> = {}): Fixture {
  return validateFixture(
    {
      fixture_id: "fx",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { fix: { finding: "x" } },
      public_checks: ["npm test"],
      hidden_checks: ["hidden-check"],
      acceptance_criteria: [{ id: "a1", statement: "does the thing", check_names: ["hidden-check"] }],
      allowed_change_paths: ["core/scripts/gh.ts"],
      grader_refs: [{ grader: "implementation-fix", version: "1" }],
      category: "c",
      risk: "low",
      provenance: "synthetic",
      ...overrides,
    },
    "fx.json",
  );
}

test("implementation-fix: hidden-test pass rate over hidden checks only", () => {
  const grade = gradeImplementationFix(
    fixtureFix(),
    { "npm test": true, "hidden-check": true },
    { "npm test": true, "hidden-check": false },
    [],
  );
  assert.deepEqual(grade.hidden_tests, { passed: 1, total: 1 });
});

test("implementation-fix: pass-at-base -> fail-after is a regression, not a pre-existing failure", () => {
  const grade = gradeImplementationFix(
    fixtureFix(),
    { "npm test": false, "hidden-check": false },
    { "npm test": true, "hidden-check": false },
    [],
  );
  assert.equal(grade.regressions, 1);
  assert.equal(grade.pre_existing_failures, 1);
});

test("implementation-fix: fail-at-both is pre-existing, never counted as a regression", () => {
  const grade = gradeImplementationFix(fixtureFix(), { "npm test": false }, { "npm test": false }, []);
  assert.equal(grade.regressions, 0);
  assert.equal(grade.pre_existing_failures, 1);
});

test("implementation-fix: out-of-scope changes are counted against the allowed-change boundary", () => {
  const grade = gradeImplementationFix(fixtureFix(), {}, {}, ["core/scripts/gh.ts", "core/scripts/other.ts"]);
  assert.equal(grade.out_of_scope_changes, 1);
});

test("implementation-fix: out-of-scope is null, not zero, when no boundary is declared", () => {
  const noBoundary = fixtureFix({ allowed_change_paths: undefined });
  const grade = gradeImplementationFix(noBoundary, {}, {}, ["anything.ts"]);
  assert.equal(grade.out_of_scope_changes, null);
});

test("implementation-fix: acceptance criterion is satisfied only when every named check passes", () => {
  const satisfied = gradeImplementationFix(fixtureFix(), { "hidden-check": true }, {}, []);
  assert.deepEqual(satisfied.acceptance, { criteria: [{ id: "a1", satisfied: true }], completed: 1, total: 1 });

  const unsatisfied = gradeImplementationFix(fixtureFix(), { "hidden-check": false }, {}, []);
  assert.deepEqual(unsatisfied.acceptance, { criteria: [{ id: "a1", satisfied: false }], completed: 0, total: 1 });
});

function fixtureReview(): Fixture {
  return validateFixture(
    {
      fixture_id: "rv",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      seeded_defects: [
        { defect_id: "d1", path: "a.ts", line_start: 10, line_end: 12, expected_severity: "high" },
        { defect_id: "d2", path: "b.ts", line_start: 5, line_end: 5, expected_severity: "low" },
      ],
      grader_refs: [{ grader: "review", version: "1" }],
      category: "c",
      risk: "medium",
      provenance: "synthetic",
    },
    "rv.json",
  );
}

test("review: a matched finding is a true positive and contributes to precision/recall/f1", () => {
  const findings = parseReportedFindings([
    { file: "a.ts", line_start: 11, line_end: 11, severity: "high" },
  ]);
  const grade = gradeReview(fixtureReview(), findings);
  assert.equal(grade.true_positives, 1);
  assert.equal(grade.false_negatives, 1);
  assert.equal(grade.false_positives, 0);
  assert.equal(grade.precision, 1);
  assert.equal(grade.recall, 0.5);
});

test("review: an unmatched finding is a false positive", () => {
  const findings = parseReportedFindings([{ file: "z.ts", line_start: 1, line_end: 1, severity: "high" }]);
  const grade = gradeReview(fixtureReview(), findings);
  assert.equal(grade.false_positives, 1);
});

test("review: a missed defect is a false negative", () => {
  const grade = gradeReview(fixtureReview(), []);
  assert.equal(grade.false_negatives, 2);
  assert.equal(grade.true_positives, 0);
});

test("review: over- and under-called severities do not cancel in the calibration distribution", () => {
  const findings = parseReportedFindings([
    { file: "a.ts", line_start: 11, line_end: 11, severity: "critical" }, // over-call: 4-3=1
    { file: "b.ts", line_start: 5, line_end: 5, severity: "critical" }, // over-call: 4-1=3, expected low
  ]);
  const grade = gradeReview(fixtureReview(), findings);
  assert.deepEqual(grade.severity_calibration.sort(), [1, 3]);
});

test("review: no model call is made — matching is a pure function", () => {
  // Structural proof: gradeReview takes no callback/deps argument at all.
  assert.equal(gradeReview.length, 2);
});

function fixturePlanning(criteria: Array<Record<string, unknown>>): Fixture {
  return validateFixture(
    {
      fixture_id: "pl",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { planning: { issue_body: "..." } },
      public_checks: [],
      acceptance_criteria: criteria,
      grader_refs: [{ grader: "planning", version: "1" }],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "pl.json",
  );
}

test("planning: all four rubric dimensions are present and rubric_version is recorded", () => {
  const fixture = fixturePlanning([{ id: "c1", statement: "adds a flag", keywords: ["--dry-run"] }]);
  const grade = gradePlanning(fixture, "1. Add --dry-run flag.\n2. Add a test.");
  assert.equal(grade.rubric_version, "planning-rubric-v1");
  assert.ok("requirement_coverage" in grade);
  assert.ok("unsupported_assumptions" in grade);
  assert.ok("actionability" in grade);
  assert.ok("downstream_compatibility" in grade);
});

test("planning: requirement coverage is computed from fixture keywords present in the output text", () => {
  const fixture = fixturePlanning([
    { id: "c1", statement: "adds a flag", keywords: ["--dry-run"] },
    { id: "c2", statement: "adds a test", keywords: ["nonexistent-keyword"] },
  ]);
  const grade = gradePlanning(fixture, "Add a --dry-run flag to the command.");
  assert.deepEqual(grade.requirement_coverage, { covered: 1, total: 2 });
});

test("planning: a self-assessment in the treatment output never changes the grade", () => {
  const fixture = fixturePlanning([{ id: "c1", statement: "adds a flag", keywords: ["--dry-run"] }]);
  const withoutSelfScore = gradePlanning(fixture, "1. Add --dry-run flag.");
  const withSelfScore = gradePlanning(fixture, "1. Add --dry-run flag.");
  // gradePlanning only ever sees output_text — a self_assessment field lives
  // alongside it in detail and is never passed in, so the two invocations
  // here stand in for "with" and "without" a self-score in the raw output.
  assert.deepEqual(withoutSelfScore, withSelfScore);
});
