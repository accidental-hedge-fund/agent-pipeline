// Tests for the grading entry point (eval-graders). No real fs/git/subprocess
// — manifest/runs are injected in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { gradeExperiment, graderIdForMode, type GradeExperimentDeps } from "../scripts/evals/grading/grade.ts";
import type { Fixture } from "../scripts/evals/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const CFG = { repo_dir: "/fake/repo" } as import("../scripts/types.ts").PipelineConfig;

function fixtureFix(): Fixture {
  return validateFixture(
    {
      fixture_id: "fx",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { fix: { finding: "x" } },
      public_checks: ["npm test"],
      hidden_checks: ["hidden-check"],
      grader_refs: [{ grader: "implementation-fix", version: "1" }],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "fx.json",
  );
}

function fixtureUngraded(): Fixture {
  return validateFixture(
    {
      fixture_id: "ug",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { fix: { finding: "x" } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "ug.json",
  );
}

function manifestJson() {
  return JSON.stringify({
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["fx"],
    mode: "fix",
    treatments: { harness: ["claude"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
  });
}

function makeFilesFakeFs(files: Record<string, string>) {
  const written: Record<string, string> = {};
  return {
    readFile: async (p: string) => (p in files ? files[p] : null),
    writeFile: async (p: string, content: string) => {
      written[p] = content;
    },
    written,
  };
}

test("graderIdForMode maps modes to their grader, or none", () => {
  assert.equal(graderIdForMode("fix"), "implementation-fix");
  assert.equal(graderIdForMode("implementing"), "implementation-fix");
  assert.equal(graderIdForMode("review"), "review");
  assert.equal(graderIdForMode("planning"), "planning");
  assert.equal(graderIdForMode("shipcheck"), null);
  assert.equal(graderIdForMode("plan-review"), null);
  assert.equal(graderIdForMode("end-to-end"), null);
});

test("gradeExperiment: grades a completed cell and writes grades.jsonl additively", async () => {
  const runRecord = {
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: { stages: [], checks: { "npm test": true, "hidden-check": true } },
  };
  const files = {
    "/out/exp1/manifest.json": manifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  let baselineCalls = 0;
  const deps: GradeExperimentDeps = {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
    checkRunner: {
      runChecks: async () => {
        baselineCalls++;
        return { "npm test": true, "hidden-check": false };
      },
      createWorktree: async (_c, o) => o,
      removeWorktree: async () => {},
    },
  };
  const fixtures = new Map([["fx", fixtureFix()]]);
  const { grades, skipped } = await gradeExperiment(CFG, "/out", "exp1", fixtures, deps);

  assert.equal(skipped.length, 0);
  assert.equal(grades.length, 1);
  assert.equal(grades[0].payload.kind, "implementation-fix");
  assert.equal(baselineCalls, 1);
  assert.ok(fake.written["/out/exp1/grades.jsonl"].includes("implementation-fix"));
});

test("gradeExperiment: a completed cell whose fixture declares no grader_ref is skipped, not silently dropped", async () => {
  const runRecord = {
    cell_id: "exp1/ug/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "ug",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: { stages: [] },
  };
  const files = {
    "/out/exp1/manifest.json": manifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  const fixtures = new Map([["ug", fixtureUngraded()]]);
  const { grades, skipped } = await gradeExperiment(CFG, "/out", "exp1", fixtures, {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
  });
  assert.equal(grades.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /grader_ref/);
});

test("gradeExperiment: opens no runner-written file for writing — only reads manifest.json/runs.jsonl and writes grades.jsonl", async () => {
  const runRecord = {
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: { stages: [], checks: { "npm test": true, "hidden-check": true } },
  };
  const files = {
    "/out/exp1/manifest.json": manifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  const fixtures = new Map([["fx", fixtureFix()]]);
  await gradeExperiment(CFG, "/out", "exp1", fixtures, {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
    checkRunner: {
      runChecks: async () => ({}),
      createWorktree: async (_c, o) => o,
      removeWorktree: async () => {},
    },
  });
  assert.deepEqual(Object.keys(fake.written), ["/out/exp1/grades.jsonl"]);
});

test("gradeExperiment: a timeout cell is not graded — it is skipped for reliability reporting only", async () => {
  const runRecord = {
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "timeout",
    detail: { findings: [] },
  };
  const files = {
    "/out/exp1/manifest.json": manifestJson(),
    "/out/exp1/failures.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  const fixtures = new Map([["fx", fixtureFix()]]);
  const { grades, skipped } = await gradeExperiment(CFG, "/out", "exp1", fixtures, {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
  });
  assert.equal(grades.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /timeout/);
  assert.match(skipped[0].reason, /reliability only/);
});

function fixtureEndToEnd(): Fixture {
  return validateFixture(
    {
      fixture_id: "e2e",
      schema_version: 1,
      base_commit: SHA,
      task_input: "t",
      stage_entry_artifacts: { planning: { issue_body: "..." }, review: { diff: "..." } },
      public_checks: [],
      seeded_defects: [{ defect_id: "d1", path: "a.ts", line_start: 10, line_end: 12, expected_severity: "high" }],
      grader_refs: [
        { grader: "review", version: "1" },
        { grader: "planning", version: "1" },
      ],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    "e2e.json",
  );
}

function endToEndManifestJson() {
  return JSON.stringify({
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["e2e"],
    mode: "end-to-end",
    treatments: { harness: ["claude"] },
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
  });
}

test("gradeExperiment: a completed end-to-end cell emits a composite grade for its captured review and planning stage output", async () => {
  const runRecord = {
    cell_id: "exp1/e2e/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "e2e",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: {
      stages: [],
      output_text: "1. Add a flag.",
      findings: [{ file: "a.ts", line_start: 11, line_end: 11, severity: "high" }],
    },
  };
  const files = {
    "/out/exp1/manifest.json": endToEndManifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  const fixtures = new Map([["e2e", fixtureEndToEnd()]]);
  const { grades, skipped } = await gradeExperiment(CFG, "/out", "exp1", fixtures, {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
  });

  assert.equal(skipped.length, 0);
  assert.equal(grades.length, 1);
  assert.equal(grades[0].payload.kind, "composite");
  const kinds = grades[0].payload.kind === "composite" ? grades[0].payload.grades.map((g) => g.kind).sort() : [];
  assert.deepEqual(kinds, ["planning", "review"]);
  assert.deepEqual(
    grades[0].graders.map((g) => g.grader).sort(),
    ["planning", "review"],
  );
});

test("gradeExperiment: an end-to-end cell with no captured review/planning output and a fixture with no grader_ref is skipped", async () => {
  const runRecord = {
    cell_id: "exp1/ug/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "ug",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: { stages: [] },
  };
  const files = {
    "/out/exp1/manifest.json": endToEndManifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fake = makeFilesFakeFs(files);
  const fixtures = new Map([["ug", fixtureUngraded()]]);
  const { grades, skipped } = await gradeExperiment(CFG, "/out", "exp1", fixtures, {
    readFile: fake.readFile,
    writeFile: fake.writeFile,
  });
  assert.equal(grades.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no applicable grader/);
});

test("gradeExperiment: regrading the same records twice produces byte-identical grades.jsonl", async () => {
  const runRecord = {
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "h",
    config_hash: "c",
    base_sha: SHA,
    result_class: "completed",
    detail: { stages: [], checks: { "npm test": true, "hidden-check": true } },
  };
  const files = {
    "/out/exp1/manifest.json": manifestJson(),
    "/out/exp1/runs.jsonl": `${JSON.stringify(runRecord)}\n`,
  };
  const fixtures = new Map([["fx", fixtureFix()]]);
  const run = async () => {
    const fake = makeFilesFakeFs(files);
    await gradeExperiment(CFG, "/out", "exp1", fixtures, {
      readFile: fake.readFile,
      writeFile: fake.writeFile,
      checkRunner: {
        runChecks: async () => ({ "npm test": true, "hidden-check": false }),
        createWorktree: async (_c, o) => o,
        removeWorktree: async () => {},
      },
    });
    return fake.written["/out/exp1/grades.jsonl"];
  };
  const first = await run();
  const second = await run();
  assert.equal(first, second);
});
