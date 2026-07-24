// Integration tests wiring trajectory/verifier artifacts into the runner,
// grader, judge, and comparative-reporting layers (#536,
// eval-trajectory-artifacts tasks 3-6, 8). Every dependency is injected — no
// real fs, git, subprocess, model call, or network.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { runExperiment, type RunExperimentDeps } from "../scripts/evals/run.ts";
import { experimentDir } from "../scripts/evals/results.ts";
import { gradeExperiment, type GradeExperimentDeps } from "../scripts/evals/grading/grade.ts";
import { runJudging, writeJudgeResults } from "../scripts/evals/grading/judge.ts";
import { generateSummary } from "../scripts/evals/reporting/report.ts";
import { verifyArtifactHash } from "../scripts/evals/trajectory/store.ts";
import type { CellExecutionDeps } from "../scripts/evals/executor.ts";
import type { CellRecord, ExperimentManifest, Fixture, RunPlan } from "../scripts/evals/types.ts";
import type { GradeRecord } from "../scripts/evals/grading/types.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const FAKE_CFG = { repo_dir: "/fake/repo" } as import("../scripts/types.ts").PipelineConfig;

function makeFixtureFile(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    fixture_id: "f1",
    schema_version: 1,
    base_commit: SHA,
    task_input: "task",
    stage_entry_artifacts: { review: { x: 1 } },
    public_checks: [],
    grader_refs: [{ grader: "review", version: "1" }],
    category: "c",
    risk: "low",
    provenance: "synthetic",
    ...overrides,
  });
}

function makeManifestFile(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1"],
    mode: "review",
    treatments: { harness: ["claude"] },
    replicates: 1,
    seed: 42,
    concurrency: 1,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
    ...overrides,
  });
}

/** An in-memory fs shared by run/grade — the same shape store.ts/results.ts
 *  need (mkdir/writeFile/readFile/appendFile), so it doubles as
 *  RunExperimentDeps and GradeExperimentDeps without adaptation. */
function makeFakeFs(fixtureText: string, manifestText: string) {
  const outFiles = new Map<string, string>();
  const deps = {
    listFixtureFiles: () => ["/fixtures/f1.json"],
    // Deliberately NOT an async function: loadFixture() (LoadFixtureDeps)
    // calls this synchronously and JSON.parses the return value directly, so
    // an async wrapper here would hand it a pending Promise instead of the
    // fixture text. The other call sites (results.ts/store.ts) `await` this
    // same value, which resolves a plain string immediately — matching
    // evals-run.test.ts's makeHarness convention.
    readFile: ((p: string) => {
      if (p === "/manifest.json") return manifestText;
      if (p === "/fixtures/f1.json") return fixtureText;
      return outFiles.has(p) ? outFiles.get(p)! : null;
    }) as never,
    mkdir: async () => {},
    writeFile: async (p: string, content: string) => { outFiles.set(p, content); },
    appendFile: async (p: string, content: string) => { outFiles.set(p, (outFiles.get(p) ?? "") + content); },
  };
  return { deps, outFiles };
}

test("runExperiment: a completed cell's record carries a trajectory_artifact descriptor, and the artifact file is written", async () => {
  const { deps, outFiles } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "review output text", stderr: "", duration: 1 }),
  };
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  assert.equal(executed.length, 1);
  const record = executed[0];
  assert.ok(record.trajectory_artifact, "expected a trajectory_artifact descriptor on the cell record");
  const descriptor = record.trajectory_artifact!;
  assert.ok(descriptor.path.includes("trajectories/"));
  assert.equal(descriptor.schema_version, 1);

  const absPath = path.join(FAKE_CFG.repo_dir, descriptor.path);
  assert.ok(outFiles.has(absPath), "the artifact file itself must be written");
  const artifactContent = outFiles.get(absPath)!;
  assert.match(artifactContent, /review output text/);

  const verified = await verifyArtifactHash(FAKE_CFG.repo_dir, descriptor, {
    readFile: async (p: string) => (outFiles.has(p) ? outFiles.get(p)! : null),
  });
  assert.equal(verified, true);
  void manifest;
});

test("runExperiment: the treatment trajectory artifact records each stage's materialized message, not just its output (review 1 finding bd71053b)", async () => {
  const { deps, outFiles } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "review output text", stderr: "", duration: 1 }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  const descriptor = executed[0].trajectory_artifact!;
  const artifact = JSON.parse(outFiles.get(path.join(FAKE_CFG.repo_dir, descriptor.path))!);
  assert.equal(artifact.stages.length, 1);
  assert.ok(typeof artifact.stages[0].message === "string" && artifact.stages[0].message.length > 0);
});

test("runExperiment: a timeout cell's trajectory artifact carries the terminal result_class and error even when the stage's own stderr was empty (review 1 finding bb8858eb)", async () => {
  const { deps, outFiles } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: false, timed_out: true, exit_code: 0, stdout: "", stderr: "", duration: 60 }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  assert.equal(executed[0].result_class, "timeout");
  const descriptor = executed[0].trajectory_artifact!;
  const artifact = JSON.parse(outFiles.get(path.join(FAKE_CFG.repo_dir, descriptor.path))!);
  assert.equal(artifact.result_class, "timeout");
  assert.ok(typeof artifact.error === "string" && artifact.error.length > 0);
});

test("runExperiment: an artifact collection failure is durably recorded on the cell record as trajectory_artifact_error, not only console.warn'd (review 1 finding 5ae0fa6e)", async () => {
  const { deps } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  };
  const failingDeps: RunExperimentDeps = {
    ...deps,
    cellExecution,
    writeFile: async (p: string, content: string) => {
      if (p.includes("trajectories")) throw new Error("disk full");
      return deps.writeFile(p, content);
    },
  } as RunExperimentDeps;
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", failingDeps);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].result_class, "completed", "a trajectory collection failure must never change result_class");
  assert.equal(executed[0].trajectory_artifact, undefined);
  assert.ok(
    typeof executed[0].trajectory_artifact_error === "string" && executed[0].trajectory_artifact_error.length > 0,
    "expected a durable trajectory_artifact_error when artifact collection failed",
  );
});

test("runExperiment: an API-executor cell also emits a trajectory artifact recording the invocation", async () => {
  const { deps } = makeFakeFs(
    makeFixtureFile({ stage_entry_artifacts: { review: { x: 1 } }, grader_refs: [{ grader: "review", version: "1" }] }),
    makeManifestFile({ mode: "review", treatments: { executor: ["ep1"] } }),
  );
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    invokeExecutor: async () => ({
      ok: true,
      result: { success: true, timed_out: false, exit_code: 0, stdout: "api output", stderr: "", duration: 0.5 },
    }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].detail?.execution_class, "api-key");
  assert.ok(executed[0].trajectory_artifact);
});

test("runExperiment: an infra_error cell (never reaches a harness) still gets a best-effort trajectory artifact", async () => {
  const { deps } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async () => { throw new Error("git worktree add failed"); },
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  assert.equal(executed.length, 1);
  assert.equal(executed[0].result_class, "infra_error");
  assert.ok(executed[0].trajectory_artifact, "even an infra_error cell should get a best-effort trajectory artifact");
});

test("runExperiment: tool-call telemetry is always marked unavailable (no harness driven by this engine exposes it) — never empty-successful", async () => {
  const { deps, outFiles } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  const descriptor = executed[0].trajectory_artifact!;
  const artifact = JSON.parse(outFiles.get(path.join(FAKE_CFG.repo_dir, descriptor.path))!);
  assert.equal(artifact.tool_events.availability.available, false);
  assert.ok(artifact.tool_events.availability.reason.length > 0);
  assert.deepEqual(artifact.tool_events.items, []);
});

test("runExperiment: hidden checks and seeded-defect ground truth never appear in the treatment trajectory artifact", async () => {
  const fixtureText = makeFixtureFile({
    public_checks: ["true"],
    hidden_checks: ["grep -q SEEDED_DEFECT_MARKER src/thing.ts"],
    seeded_defects: [{ defect_id: "d1", path: "src/thing.ts", line_start: 1, line_end: 2, expected_severity: "high" }],
  });
  const { deps, outFiles } = makeFakeFs(fixtureText, makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "no hidden material referenced here", stderr: "", duration: 1 }),
    runChecks: async () => ({ true: true, "grep -q SEEDED_DEFECT_MARKER src/thing.ts": true }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  const descriptor = executed[0].trajectory_artifact!;
  const raw = outFiles.get(path.join(FAKE_CFG.repo_dir, descriptor.path))!;
  assert.doesNotMatch(raw, /SEEDED_DEFECT_MARKER/);
  assert.doesNotMatch(raw, /d1/); // defect_id never leaks either
  // The record's own `detail.checks` legitimately carries the hidden-check
  // key (pre-existing behavior, out of #536's scope) — confirm the artifact
  // is what stays clean, not that detail.checks disappears.
  assert.ok("checks" in (executed[0].detail ?? {}));
});

test("runExperiment: resume never rewrites an existing trajectory artifact", async () => {
  const { deps, outFiles } = makeFakeFs(makeFixtureFile(), makeManifestFile());
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "stable output", stderr: "", duration: 1 }),
  };
  const first = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  const descriptor = first.executed[0].trajectory_artifact!;
  const absPath = path.join(FAKE_CFG.repo_dir, descriptor.path);
  const contentAfterFirst = outFiles.get(absPath);

  const second = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution } as RunExperimentDeps);
  assert.equal(second.executed.length, 0, "resume must not re-execute the completed cell");
  assert.equal(outFiles.get(absPath), contentAfterFirst, "the artifact file must be byte-identical after resume");
});

test("gradeExperiment: a grade record carries a verifier_artifact descriptor whose hash verifies, and evidence includes seeded defects (verifier-only material permitted here)", async () => {
  const fixtureText = makeFixtureFile({
    seeded_defects: [{ defect_id: "d1", path: "src/thing.ts", line_start: 1, line_end: 2, expected_severity: "high" }],
  });
  const manifestText = makeManifestFile();
  const runsRecord: CellRecord = {
    cell_id: "exp1/f1/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "f1",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "p",
    config_hash: "c",
    base_sha: SHA,
    env_surface_hash: "e",
    result_class: "completed",
    detail: { findings: [] },
  };
  const outFiles = new Map<string, string>();
  outFiles.set("/out/exp1/manifest.json", manifestText);
  outFiles.set("/out/exp1/runs.jsonl", `${JSON.stringify(runsRecord)}\n`);
  const deps: GradeExperimentDeps = {
    readFile: async (p) => (outFiles.has(p) ? outFiles.get(p)! : null),
    writeFile: async (p, content) => { outFiles.set(p, content); },
    mkdir: async () => {},
  };
  const fixtures = new Map<string, Fixture>([["f1", JSON.parse(fixtureText)]]);
  const { grades } = await gradeExperiment(FAKE_CFG, "/out", "exp1", fixtures, deps);
  assert.equal(grades.length, 1);
  const descriptor = grades[0].verifier_artifact;
  assert.ok(descriptor, "expected a verifier_artifact descriptor on the grade record");
  const absPath = path.join(FAKE_CFG.repo_dir, descriptor!.path);
  assert.ok(outFiles.has(absPath));
  assert.match(outFiles.get(absPath)!, /d1/, "seeded-defect ground truth belongs in the verifier artifact");
  const verified = await verifyArtifactHash(FAKE_CFG.repo_dir, descriptor!, {
    readFile: async (p: string) => (outFiles.has(p) ? outFiles.get(p)! : null),
  });
  assert.equal(verified, true);
});

test("gradeExperiment: regrading twice produces byte-identical grades.jsonl even with verifier artifacts (content-addressed dedup, no rewrite)", async () => {
  const fixtureText = makeFixtureFile();
  const manifestText = makeManifestFile();
  const runsRecord: CellRecord = {
    cell_id: "exp1/f1/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "f1",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "p",
    config_hash: "c",
    base_sha: SHA,
    env_surface_hash: "e",
    result_class: "completed",
    detail: { findings: [] },
  };
  const outFiles = new Map<string, string>();
  outFiles.set("/out/exp1/manifest.json", manifestText);
  outFiles.set("/out/exp1/runs.jsonl", `${JSON.stringify(runsRecord)}\n`);
  const deps: GradeExperimentDeps = {
    readFile: async (p) => (outFiles.has(p) ? outFiles.get(p)! : null),
    writeFile: async (p, content) => { outFiles.set(p, content); },
    mkdir: async () => {},
  };
  const fixtures = new Map<string, Fixture>([["f1", JSON.parse(fixtureText)]]);
  await gradeExperiment(FAKE_CFG, "/out", "exp1", fixtures, deps);
  const gradesFirst = outFiles.get("/out/exp1/grades.jsonl");
  const fileCountAfterFirst = outFiles.size;
  await gradeExperiment(FAKE_CFG, "/out", "exp1", fixtures, deps);
  const gradesSecond = outFiles.get("/out/exp1/grades.jsonl");
  assert.equal(gradesFirst, gradesSecond);
  assert.equal(outFiles.size, fileCountAfterFirst, "no new verifier artifact file should be written on regrade");
});

function baseGrade(overrides: Partial<GradeRecord> = {}): GradeRecord {
  return {
    cell_id: "exp1/fx/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude",
    replicate: 1,
    graders: [{ grader: "implementation-fix", version: "1" }],
    payload: {
      kind: "implementation-fix",
      grade: {
        hidden_tests: { passed: 2, total: 2 },
        acceptance: { criteria: [], completed: 0, total: 0 },
        regressions: 0,
        pre_existing_failures: 0,
        out_of_scope_changes: null,
      },
    },
    ...overrides,
  };
}

test("runJudging: a judge invocation emits its own verifier evidence artifact, independently addressable from the grader's", async () => {
  const outFiles = new Map<string, string>();
  const artifactStore = {
    repoDir: "/repo",
    verifiersDir: "/repo/.agent-pipeline/evals/exp1/verifiers",
    deps: {
      mkdir: async () => {},
      writeFile: async (p: string, c: string) => { outFiles.set(p, c); },
      readFile: async (p: string) => (outFiles.has(p) ? outFiles.get(p)! : null),
    },
  };
  const { judgeRecords, disagreements } = await runJudging([baseGrade()], {
    invokeJudge: async () => ({ pass: false, note: "looked wrong" }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
    artifactStore,
  });
  assert.equal(judgeRecords.length, 1);
  assert.ok(judgeRecords[0].verifier_artifact, "expected a verifier_artifact on the judge record");
  assert.equal(disagreements.length, 1);
  assert.ok(disagreements[0].verifier_artifact, "expected a verifier_artifact on the disagreement record");
  assert.equal(judgeRecords[0].verifier_artifact!.content_hash, disagreements[0].verifier_artifact!.content_hash);
  assert.ok(outFiles.size >= 1, "the judge verifier artifact file must be written");
});

test("runJudging: without an artifactStore, judging still works — no verifier_artifact, never a failure", async () => {
  const { judgeRecords } = await runJudging([baseGrade()], {
    invokeJudge: async () => ({ pass: true }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
  });
  assert.equal(judgeRecords.length, 1);
  assert.equal(judgeRecords[0].verifier_artifact, undefined);
});

test("writeJudgeResults: persists judges.jsonl and disagreements.jsonl under the experiment directory", async () => {
  const outFiles = new Map<string, string>();
  await writeJudgeResults(
    "/out",
    "exp1",
    [{ cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "t1", replicate: 1, judge_harness: "claude", judge_model: "sonnet", judge_prompt_version: "v1", verdict: { pass: true } }],
    [],
    {
      mkdir: async () => {},
      writeFile: async (p, c) => { outFiles.set(p, c); },
    },
  );
  assert.ok(outFiles.has(path.join("/out", "exp1", "judges.jsonl")));
  assert.ok(outFiles.has(path.join("/out", "exp1", "disagreements.jsonl")));
  assert.match(outFiles.get(path.join("/out", "exp1", "judges.jsonl"))!, /"cell_id":"c1"/);
});

// --- comparative reporting: opt-in linking (#536 task 6.1) -----------------

function manifestFor(): ExperimentManifest {
  return {
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1"],
    mode: "review",
    treatments: {},
    replicates: 1,
    seed: 1,
    concurrency: 1,
    timeout: 60,
    output_dir: "out",
  };
}
function planFor(cellIds: string[]): RunPlan {
  return {
    schema_version: 1,
    experiment_id: "exp1",
    seed: 1,
    cells: cellIds.map((id, i) => ({
      cell_id: id,
      experiment_id: "exp1",
      fixture_id: "f1",
      treatment_id: i === 0 ? "baseline" : "candidate",
      treatment: {},
      replicate: 1,
      mode: "review",
      base_sha: SHA,
    })),
  };
}

test("generateSummary: default output (linking disabled) is unaffected by trajectory_artifact/verifier_artifact fields being present on inputs", () => {
  const manifest = manifestFor();
  const plan = planFor(["c1", "c2"]);
  const runs: CellRecord[] = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "baseline", replicate: 1, prompt_hash: "p", config_hash: "c", base_sha: SHA, env_surface_hash: "e", result_class: "completed", detail: {}, trajectory_artifact: { path: "a", content_hash: "h", schema_version: 1, byte_count: 1, truncation_status: "none" } },
  ];
  const grades: GradeRecord[] = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "baseline", replicate: 1, graders: [{ grader: "review", version: "1" }], payload: { kind: "review", grade: { true_positives: 1, false_positives: 0, false_negatives: 0, precision: 1, recall: 1, f1: 1, severity_calibration: [] } }, verifier_artifact: { path: "b", content_hash: "h2", schema_version: 1, byte_count: 1, truncation_status: "none" } },
  ];
  const withLinkingDisabled = generateSummary(manifest, plan, runs, [], grades, new Map(), { baselineTreatmentId: "baseline" });
  const withoutFlagAtAll = generateSummary(manifest, plan, runs, [], grades, new Map(), { baselineTreatmentId: "baseline", linkArtifacts: false });
  assert.equal(JSON.stringify(withLinkingDisabled), JSON.stringify(withoutFlagAtAll));
  assert.ok(!("linked_artifacts" in withLinkingDisabled));
});

test("generateSummary: linking enabled adds linked_artifacts for a failed cell and a review false-negative, without changing any aggregate", () => {
  const manifest = manifestFor();
  const plan = planFor(["c1", "c2", "c3"]);
  const runs: CellRecord[] = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "baseline", replicate: 1, prompt_hash: "p", config_hash: "c", base_sha: SHA, env_surface_hash: "e", result_class: "completed", detail: {} },
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f1", treatment_id: "candidate", replicate: 1, prompt_hash: "p", config_hash: "c", base_sha: SHA, env_surface_hash: "e", result_class: "completed", detail: {}, trajectory_artifact: { path: "t2", content_hash: "th2", schema_version: 1, byte_count: 1, truncation_status: "none" } },
  ];
  const failures: CellRecord[] = [
    { cell_id: "c3", experiment_id: "exp1", fixture_id: "f1", treatment_id: "candidate", replicate: 1, prompt_hash: "p", config_hash: "c", base_sha: SHA, env_surface_hash: "e", result_class: "timeout", error: "boom", trajectory_artifact: { path: "t3", content_hash: "th3", schema_version: 1, byte_count: 1, truncation_status: "none" } },
  ];
  const grades: GradeRecord[] = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "baseline", replicate: 1, graders: [{ grader: "review", version: "1" }], payload: { kind: "review", grade: { true_positives: 1, false_positives: 0, false_negatives: 0, precision: 1, recall: 1, f1: 1, severity_calibration: [] } } },
    { cell_id: "c2", experiment_id: "exp1", fixture_id: "f1", treatment_id: "candidate", replicate: 1, graders: [{ grader: "review", version: "1" }], payload: { kind: "review", grade: { true_positives: 0, false_positives: 0, false_negatives: 1, precision: null, recall: 0, f1: 0, severity_calibration: [] } }, verifier_artifact: { path: "v2", content_hash: "vh2", schema_version: 1, byte_count: 1, truncation_status: "none" } },
    {
      cell_id: "c4",
      experiment_id: "exp1",
      fixture_id: "f1",
      treatment_id: "candidate",
      replicate: 1,
      graders: [{ grader: "review", version: "1" }, { grader: "planning", version: "1" }],
      payload: {
        kind: "composite",
        grades: [
          { kind: "review", grade: { true_positives: 0, false_positives: 0, false_negatives: 1, precision: null, recall: 0, f1: 0, severity_calibration: [] } },
        ],
      },
      verifier_artifacts: [
        { grader: "review", version: "1", artifact: { path: "cv-review", content_hash: "cvh-review", schema_version: 1, byte_count: 1, truncation_status: "none" } },
        { grader: "planning", version: "1", artifact: { path: "cv-planning", content_hash: "cvh-planning", schema_version: 1, byte_count: 1, truncation_status: "none" } },
      ],
    },
  ];

  const disabled = generateSummary(manifest, plan, runs, failures, grades, new Map(), { baselineTreatmentId: "baseline" });
  const enabled = generateSummary(manifest, plan, runs, failures, grades, new Map(), { baselineTreatmentId: "baseline", linkArtifacts: true }, []);

  // Aggregates unchanged.
  assert.deepEqual(disabled.treatments, enabled.treatments);
  assert.deepEqual(disabled.pareto, enabled.pareto);
  assert.deepEqual(disabled.groups, enabled.groups);

  assert.ok(enabled.linked_artifacts && enabled.linked_artifacts.length >= 2);
  const byCellId = new Map(enabled.linked_artifacts!.map((e) => [e.cell_id, e]));
  const c3 = byCellId.get("c3");
  assert.ok(c3, "the failed/timed-out cell must be flagged");
  assert.ok(c3!.reasons.some((r) => r.startsWith("failed:")));
  assert.equal(c3!.treatment_artifact?.path, "t3");

  const c2 = byCellId.get("c2");
  assert.ok(c2, "the false-negative cell must be flagged");
  assert.ok(c2!.reasons.includes("false_positive_or_negative"));
  assert.equal(c2!.verifier_artifacts[0]?.path, "v2");

  // A composite grade's per-sub-grader artifacts (review 1 finding c7218eb4)
  // are linked too, not just a single-grader payload's verifier_artifact.
  const c4 = byCellId.get("c4");
  assert.ok(c4, "the composite grade's false-negative cell must be flagged");
  assert.ok(c4!.reasons.includes("false_positive_or_negative"));
  const c4Paths = c4!.verifier_artifacts.map((a) => a.path).sort();
  assert.deepEqual(c4Paths, ["cv-planning", "cv-review"]);
});

test("generateSummary: summarizing the same grades twice with linking enabled is byte-identical", () => {
  const manifest = manifestFor();
  const plan = planFor(["c1"]);
  const failures: CellRecord[] = [
    { cell_id: "c1", experiment_id: "exp1", fixture_id: "f1", treatment_id: "baseline", replicate: 1, prompt_hash: "p", config_hash: "c", base_sha: SHA, env_surface_hash: "e", result_class: "infra_error", error: "x" },
  ];
  const first = generateSummary(manifest, plan, [], failures, [], new Map(), { baselineTreatmentId: "baseline", linkArtifacts: true }, []);
  const second = generateSummary(manifest, plan, [], failures, [], new Map(), { baselineTreatmentId: "baseline", linkArtifacts: true }, []);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
