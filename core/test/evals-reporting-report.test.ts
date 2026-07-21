// End-to-end tests for the report entry point (eval-comparative-reporting).
// No real fs — manifest/plan/runs/failures/grades are injected in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reportExperiment, type ReportIODeps } from "../scripts/evals/reporting/report.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import type { Fixture } from "../scripts/evals/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";

function fixture(id: string, category = "c", risk = "low"): Fixture {
  return validateFixture(
    {
      fixture_id: id,
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { review: { diff: "..." } },
      public_checks: [],
      grader_refs: [{ grader: "review", version: "1" }],
      category,
      risk,
      provenance: "synthetic",
    },
    `${id}.json`,
  );
}

function manifest() {
  return {
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1", "f2"],
    mode: "review",
    treatments: { harness: ["claude", "codex"] },
    replicates: 1,
    seed: 5,
    concurrency: 1,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
  };
}

function plan() {
  return {
    schema_version: 1,
    experiment_id: "exp1",
    seed: 5,
    cells: [
      { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", treatment: { harness: "claude" }, replicate: 1, mode: "review", base_sha: SHA },
      { cell_id: "c2", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=claude", treatment: { harness: "claude" }, replicate: 1, mode: "review", base_sha: SHA },
      { cell_id: "c3", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=codex", treatment: { harness: "codex" }, replicate: 1, mode: "review", base_sha: SHA },
      { cell_id: "c4", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=codex", treatment: { harness: "codex" }, replicate: 1, mode: "review", base_sha: SHA },
    ],
  };
}

function reviewGrade(cellId: string, treatmentId: string, fixtureId: string, f1: number) {
  return {
    cell_id: cellId,
    experiment_id: "exp1",
    fixture_id: fixtureId,
    treatment_id: treatmentId,
    replicate: 1,
    graders: [{ grader: "review", version: "1" }],
    payload: {
      kind: "review",
      grade: { true_positives: 1, false_positives: 0, false_negatives: 0, precision: 1, recall: 1, f1, severity_calibration: [] },
    },
  };
}

function makeDeps(files: Record<string, string>): ReportIODeps & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    readFile: async (p: string) => (p in files ? files[p] : null),
    writeFile: async (p: string, content: string) => {
      written[p] = content;
    },
    written,
  };
}

test("reportExperiment: writes summary.json without mutating its inputs", async () => {
  const runRecords = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [{ stage: "review", success: true, exit_code: 0, duration: 10 }] } },
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [{ stage: "review", success: true, exit_code: 0, duration: 20 }] } },
    { cell_id: "c3", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=codex", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [{ stage: "review", success: true, exit_code: 0, duration: 5 }] } },
  ];
  const grades = [
    reviewGrade("c1", "harness=claude", "f1", 0.9),
    reviewGrade("c2", "harness=claude", "f2", 0.7),
    reviewGrade("c3", "harness=codex", "f1", 0.5),
  ];
  const files = {
    "/out/exp1/manifest.json": JSON.stringify(manifest()),
    "/out/exp1/plan.json": JSON.stringify(plan()),
    "/out/exp1/runs.jsonl": runRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/failures.jsonl": "",
    "/out/exp1/grades.jsonl": grades.map((g) => JSON.stringify(g)).join("\n") + "\n",
  };
  const originalFiles = { ...files };
  const deps = makeDeps(files);
  const fixtures = new Map([
    ["f1", fixture("f1")],
    ["f2", fixture("f2")],
  ]);
  const summary = await reportExperiment("/out", "exp1", fixtures, { baselineTreatmentId: "harness=claude" }, deps);

  assert.equal(summary.baseline_treatment_id, "harness=claude");
  assert.equal(summary.schema_version, 1);
  assert.deepEqual(files, originalFiles); // inputs untouched
  assert.deepEqual(Object.keys(deps.written), ["/out/exp1/summary.json"]);
});

test("reportExperiment: baseline is named, non-baseline treatment carries a paired delta with n and interval", async () => {
  const runRecords = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
    { cell_id: "c3", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=codex", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
    { cell_id: "c4", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=codex", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
  ];
  const grades = [
    reviewGrade("c1", "harness=claude", "f1", 0.9),
    reviewGrade("c2", "harness=claude", "f2", 0.7),
    reviewGrade("c3", "harness=codex", "f1", 0.5),
    reviewGrade("c4", "harness=codex", "f2", 0.4),
  ];
  const files = {
    "/out/exp1/manifest.json": JSON.stringify(manifest()),
    "/out/exp1/plan.json": JSON.stringify(plan()),
    "/out/exp1/runs.jsonl": runRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/failures.jsonl": "",
    "/out/exp1/grades.jsonl": grades.map((g) => JSON.stringify(g)).join("\n") + "\n",
  };
  const deps = makeDeps(files);
  const fixtures = new Map([
    ["f1", fixture("f1")],
    ["f2", fixture("f2")],
  ]);
  const summary = await reportExperiment("/out", "exp1", fixtures, { baselineTreatmentId: "harness=claude" }, deps);

  const baseline = summary.treatments.find((t) => t.treatment_id === "harness=claude")!;
  const codex = summary.treatments.find((t) => t.treatment_id === "harness=codex")!;
  assert.equal(baseline.quality_delta_vs_baseline, null);
  assert.ok(codex.quality_delta_vs_baseline);
  assert.equal(codex.quality_delta_vs_baseline!.n, 2);
  assert.ok(codex.quality_delta_vs_baseline!.mean < 0); // codex scored lower on both fixtures
  assert.equal(codex.excluded_fixtures.length, 0);
});

test("reportExperiment: an infra_error cell counts toward reliability, not quality", async () => {
  const runRecords = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
  ];
  const failureRecords = [
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "infra_error", error: "boom" },
  ];
  const grades = [reviewGrade("c1", "harness=claude", "f1", 0.9)];
  const files = {
    "/out/exp1/manifest.json": JSON.stringify(manifest()),
    "/out/exp1/plan.json": JSON.stringify(plan()),
    "/out/exp1/runs.jsonl": runRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/failures.jsonl": failureRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/grades.jsonl": grades.map((g) => JSON.stringify(g)).join("\n") + "\n",
  };
  const deps = makeDeps(files);
  const fixtures = new Map([
    ["f1", fixture("f1")],
    ["f2", fixture("f2")],
  ]);
  const summary = await reportExperiment("/out", "exp1", fixtures, { baselineTreatmentId: "harness=claude" }, deps);
  const claude = summary.treatments.find((t) => t.treatment_id === "harness=claude")!;
  assert.equal(claude.reliability.planned, 2);
  assert.equal(claude.reliability.completed, 1);
  assert.equal(claude.reliability.infra_error_rate, 0.5);
});

test("reportExperiment: summarizing the same grades twice is byte-identical", async () => {
  const runRecords = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
    { cell_id: "c3", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=codex", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
  ];
  const grades = [reviewGrade("c1", "harness=claude", "f1", 0.9), reviewGrade("c3", "harness=codex", "f1", 0.5)];
  const files = {
    "/out/exp1/manifest.json": JSON.stringify(manifest()),
    "/out/exp1/plan.json": JSON.stringify(plan()),
    "/out/exp1/runs.jsonl": runRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/failures.jsonl": "",
    "/out/exp1/grades.jsonl": grades.map((g) => JSON.stringify(g)).join("\n") + "\n",
  };
  const fixtures = new Map([["f1", fixture("f1")]]);
  const run = async () => {
    const deps = makeDeps({ ...files });
    await reportExperiment("/out", "exp1", fixtures, { baselineTreatmentId: "harness=claude" }, deps);
    return deps.written["/out/exp1/summary.json"];
  };
  const first = await run();
  const second = await run();
  assert.equal(first, second);
});

test("reportExperiment: grouping by category produces one entry per distinct fixture category", async () => {
  const runRecords = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f2", treatment_id: "harness=claude", replicate: 1, prompt_hash: "h", config_hash: "c", base_sha: SHA, result_class: "completed", detail: { stages: [] } },
  ];
  const grades = [reviewGrade("c1", "harness=claude", "f1", 0.9), reviewGrade("c2", "harness=claude", "f2", 0.7)];
  const files = {
    "/out/exp1/manifest.json": JSON.stringify(manifest()),
    "/out/exp1/plan.json": JSON.stringify(plan()),
    "/out/exp1/runs.jsonl": runRecords.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "/out/exp1/failures.jsonl": "",
    "/out/exp1/grades.jsonl": grades.map((g) => JSON.stringify(g)).join("\n") + "\n",
  };
  const deps = makeDeps(files);
  const fixtures = new Map([
    ["f1", fixture("f1", "cat-a")],
    ["f2", fixture("f2", "cat-b")],
  ]);
  const summary = await reportExperiment("/out", "exp1", fixtures, { baselineTreatmentId: "harness=claude" }, deps);
  assert.deepEqual(
    summary.groups.category!.map((g) => g.value),
    ["cat-a", "cat-b"],
  );
});
