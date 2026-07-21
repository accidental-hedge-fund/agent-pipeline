// Integration tests for the top-level `pipeline evals plan|run` orchestration
// (openspec/changes/stage-eval-runner). Every dependency (fixture/manifest
// reads, worktree creation, harness invocation, result-file writes) is
// injected — no real fs, git, subprocess, or network call.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { expandExperiment, planExperiment, runExperiment, type RunExperimentDeps } from "../scripts/evals/run.ts";
import { experimentDir } from "../scripts/evals/results.ts";
import type { CellExecutionDeps } from "../scripts/evals/executor.ts";

const SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const FAKE_CFG = { repo_dir: "/fake/repo" } as import("../scripts/types.ts").PipelineConfig;

function makeFixtureFile(id: string, stage = "review") {
  return JSON.stringify({
    fixture_id: id,
    schema_version: 1,
    base_commit: SHA,
    task_input: "task",
    stage_entry_artifacts: { [stage]: { x: 1 } },
    public_checks: [],
    grader_refs: [],
    category: "c",
    risk: "low",
    provenance: "synthetic",
  });
}

function makeManifestFile(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1"],
    mode: "review",
    treatments: { harness: ["claude", "codex"] },
    replicates: 1,
    seed: 42,
    concurrency: 2,
    timeout: 60,
    output_dir: ".agent-pipeline/evals",
    ...overrides,
  });
}

/** Build a self-contained fake filesystem: one manifest, N fixture files, and
 *  an in-memory result-store. Every deps hook required by expandExperiment/
 *  planExperiment/runExperiment is covered — nothing falls through to a real
 *  fs/git/subprocess call. */
function makeHarness(fixtureFiles: Record<string, string>, manifestText: string) {
  const outFiles = new Map<string, string>();
  const fixturePaths = Object.keys(fixtureFiles).map((id) => `/fixtures/${id}.json`);
  const deps: RunExperimentDeps = {
    listFixtureFiles: () => fixturePaths,
    readFile: ((p: string) => {
      if (p === "/manifest.json") return manifestText;
      const id = path.basename(p, ".json");
      if (fixtureFiles[id]) return fixtureFiles[id];
      // Fall through: a results-file read (readExistingRecords), backed by outFiles.
      return outFiles.has(p) ? outFiles.get(p)! : null;
    }) as never,
    mkdir: async () => {},
    writeFile: async (p, content) => { outFiles.set(p, content); },
    appendFile: async (p, content) => { outFiles.set(p, (outFiles.get(p) ?? "") + content); },
  };
  return { deps, outFiles };
}

test("expandExperiment: invalid fixture fails the experiment before execution, naming the fixture", () => {
  const { deps } = makeHarness({ f1: JSON.stringify({ fixture_id: "f1" }) }, makeManifestFile());
  assert.throws(() => expandExperiment("/manifest.json", "/fixtures", deps), /f1/);
});

test("planExperiment: writes manifest.json and plan.json before any cell runs, invokes no harness and creates no worktree", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1") }, makeManifestFile());
  const { manifest, plan } = await planExperiment(FAKE_CFG, "/manifest.json", "/fixtures", deps);
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  assert.ok(outFiles.has(path.join(dir, "manifest.json")));
  assert.ok(outFiles.has(path.join(dir, "plan.json")));
  assert.equal(plan.cells.length, 2); // 1 fixture x 2 harnesses x 1 replicate
});

test("expandPlan via expandExperiment: expanding twice from the same manifest produces identical cell_ids in the same order", () => {
  const { deps } = makeHarness({ f1: makeFixtureFile("f1"), f2: makeFixtureFile("f2") }, makeManifestFile({ fixture_ids: ["f1", "f2"] }));
  const { plan: plan1 } = expandExperiment("/manifest.json", "/fixtures", deps);
  const { plan: plan2 } = expandExperiment("/manifest.json", "/fixtures", deps);
  assert.deepEqual(plan1.cells.map((c) => c.cell_id), plan2.cells.map((c) => c.cell_id));
});

test("runExperiment: executes the full matrix, writes join keys, and performs zero GitHub writes in either mode", async () => {
  for (const mode of ["review", "end-to-end"]) {
    const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ mode }));
    const refusalCounts: number[] = [];
    const cellExecution: CellExecutionDeps = {
      createWorktree: async (_c, o) => o,
      removeWorktree: async () => {},
      preflight: async () => ({ ok: true }),
      invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
    };
    const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
    assert.equal(executed.length, 2, `mode=${mode}`);
    for (const record of executed) {
      assert.equal(record.result_class, "completed");
      for (const key of ["experiment_id", "fixture_id", "treatment_id", "replicate", "prompt_hash", "config_hash", "base_sha"]) {
        assert.ok(key in record, `mode=${mode}: record missing ${key}`);
      }
    }
    const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
    const runsLines = (outFiles.get(path.join(dir, "runs.jsonl")) ?? "").split("\n").filter(Boolean);
    assert.equal(runsLines.length, 2, `mode=${mode}`);
    assert.ok(!outFiles.has(path.join(dir, "failures.jsonl")), `mode=${mode}: no failures expected`);
    void refusalCounts;
  }
});

test("runExperiment: resume executes only cells without a completed record, and never rewrites existing lines", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile());
  let invocationCount = 0;
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { invocationCount++; return { success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }; },
  };
  const first = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(first.executed.length, 2);
  assert.equal(invocationCount, 2);

  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, first.manifest.output_dir), "exp1");
  const runsAfterFirst = outFiles.get(path.join(dir, "runs.jsonl"));

  // Re-invoke with the same in-memory store — every cell already has a record.
  const second = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(second.executed.length, 0, "resume must not re-execute completed cells");
  assert.equal(invocationCount, 2, "the harness must not be invoked again");
  assert.equal(outFiles.get(path.join(dir, "runs.jsonl")), runsAfterFirst, "existing records must be byte-identical after resume");
});

test("runExperiment: concurrency never exceeds the manifest's concurrency bound", async () => {
  const { deps } = makeHarness(
    { f1: makeFixtureFile("f1", "review"), f2: makeFixtureFile("f2", "review") },
    makeManifestFile({ fixture_ids: ["f1", "f2"], treatments: { harness: ["claude", "codex"] }, concurrency: 2 }),
  );
  let inFlight = 0;
  let maxInFlight = 0;
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 };
    },
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed.length, 4); // 2 fixtures x 2 harnesses x 1 replicate
  assert.ok(maxInFlight <= 2, `expected concurrency <= 2, observed ${maxInFlight}`);
  assert.ok(maxInFlight > 1, "expected the pool to actually run cells concurrently, not serially");
});

test("runExperiment: a cell whose record cannot be durably appended is not reported as executed", async () => {
  const { deps } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution: CellExecutionDeps = {
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  };
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", {
    ...deps,
    appendFile: async () => { throw new Error("disk full"); },
    cellExecution,
  });
  assert.equal(executed.length, 0, "a cell whose record failed to persist must not be reported as executed");
});

test("runExperiment: an infra_error cell is written to failures.jsonl and excluded from runs.jsonl", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution: CellExecutionDeps = {
    createWorktree: async () => { throw new Error("git worktree add failed"); },
  };
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].result_class, "infra_error");
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  assert.ok(outFiles.has(path.join(dir, "failures.jsonl")));
  assert.ok(!outFiles.has(path.join(dir, "runs.jsonl")));
});
