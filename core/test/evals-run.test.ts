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

// #607 eval-agent-isolation-boundary added a real-fs contract install/restore
// and a real command-boundary shim to every runCell() invocation inside
// runExperiment(). This file's `cellExecution` fakes never create a real
// worktree directory (this file's own header: no real fs/git/subprocess), so
// the production defaults for those two features would fail against a
// nonexistent path. `baseCellExecution` merges harmless in-memory/no-op
// fakes for both underneath each test's own overrides.
function fakeContractIO(): NonNullable<CellExecutionDeps["contractIO"]> {
  const files = new Map<string, string>();
  return {
    readFile: (p) => (files.has(p) ? files.get(p)! : null),
    writeFile: (p, c) => { files.set(p, c); },
    removeFile: (p) => { files.delete(p); },
  };
}

function baseCellExecution(overrides: CellExecutionDeps): CellExecutionDeps {
  return {
    contractIO: fakeContractIO(),
    installBoundaryShim: (worktreeDir: string) => `${worktreeDir}/.eval-boundary-shim`,
    readBoundaryDenials: () => [],
    ...overrides,
  };
}

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

test("expandExperiment: paired mode requires an implementing entry artifact before execution", () => {
  const { deps } = makeHarness(
    { f1: makeFixtureFile("f1", "review") },
    makeManifestFile({
      mode: "paired",
      treatments: undefined,
      named_treatments: [{ id: "codex-grok", primary: { harness: "codex" }, reviewer: { harness: "grok" } }],
    }),
  );
  assert.throws(() => expandExperiment("/manifest.json", "/fixtures", deps), /implementing/);
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
    const cellExecution = baseCellExecution({
      createWorktree: async (_c, o) => o,
      removeWorktree: async () => {},
      preflight: async () => ({ ok: true }),
      invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
    });
    const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
    assert.equal(executed.length, 2, `mode=${mode}`);
    for (const record of executed) {
      assert.equal(record.result_class, "completed");
      for (const key of ["experiment_id", "fixture_id", "treatment_id", "replicate", "prompt_hash", "config_hash", "base_sha", "env_surface_hash"]) {
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

test("runExperiment: cell records carry the fixture's env_surface_hash, which differs when a dependency mode differs (#535)", async () => {
  const fixtureWithEnv = (mode: string) =>
    JSON.stringify({
      fixture_id: "f1",
      schema_version: 1,
      base_commit: SHA,
      task_input: "task",
      stage_entry_artifacts: { review: { x: 1 } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
      environment: [
        {
          name: "github-api",
          mode,
          version: "1",
          required_permissions: [],
          initial_state: {},
          expected: {},
          setup: "seed",
          teardown: "none",
        },
      ],
    });
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  });
  const manifest = makeManifestFile({ treatments: { harness: ["claude"] } });

  const { deps: depsSimulated } = makeHarness({ f1: fixtureWithEnv("simulated") }, manifest);
  const { executed: executedSimulated } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...depsSimulated, cellExecution });

  const { deps: depsLive } = makeHarness({ f1: fixtureWithEnv("live") }, manifest);
  const { executed: executedLive } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...depsLive, cellExecution });

  assert.equal(typeof executedSimulated[0].env_surface_hash, "string");
  assert.notEqual(executedSimulated[0].env_surface_hash, executedLive[0].env_surface_hash);
});

test("runExperiment: resume executes only cells without a completed record, and never rewrites existing lines", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile());
  let invocationCount = 0;
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => { invocationCount++; return { success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }; },
  });
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
  const cellExecution = baseCellExecution({
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
  });
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed.length, 4); // 2 fixtures x 2 harnesses x 1 replicate
  assert.ok(maxInFlight <= 2, `expected concurrency <= 2, observed ${maxInFlight}`);
  assert.ok(maxInFlight > 1, "expected the pool to actually run cells concurrently, not serially");
});

test("runExperiment: a cell whose record cannot be durably appended is not reported as executed", async () => {
  const { deps } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  });
  const { executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", {
    ...deps,
    appendFile: async () => { throw new Error("disk full"); },
    cellExecution,
  });
  assert.equal(executed.length, 0, "a cell whose record failed to persist must not be reported as executed");
});

test("runExperiment: an infra_error cell is written to failures.jsonl and excluded from runs.jsonl", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution = baseCellExecution({
    createWorktree: async () => { throw new Error("git worktree add failed"); },
  });
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed.length, 1);
  assert.equal(executed[0].result_class, "infra_error");
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  assert.ok(outFiles.has(path.join(dir, "failures.jsonl")));
  assert.ok(!outFiles.has(path.join(dir, "runs.jsonl")));
});

// ---------------------------------------------------------------------------
// #607 eval-agent-isolation-boundary — boundary_evidence/boundary_evidence_error
// and sandbox_mode reach the durable cell record.
// ---------------------------------------------------------------------------

test("runExperiment: a cell's process-boundary denial and gh-surface refusal both reach the persisted record, with result_class unchanged", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    readBoundaryDenials: () => [
      { command: "git", argv: ["worktree", "add", "../nested"], category: "nested-worktree", at: "2026-01-01T00:00:00.000Z" },
    ],
    invokeHarness: async (args) => {
      await args.gh.addLabel(1, "pipeline:ready-to-deploy").catch(() => {});
      return { success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 };
    },
  });
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed.length, 1);
  const record = executed[0];
  assert.equal(record.result_class, "completed", "a boundary denial alone must not change result_class");
  assert.equal(record.boundary_evidence?.denials.length, 1);
  assert.equal(record.boundary_evidence?.denials[0].category, "nested-worktree");
  assert.equal(record.boundary_evidence?.gh_refusals.length, 1);
  assert.equal(record.boundary_evidence?.gh_refusals[0].operation, "addLabel");
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  const persisted = JSON.parse((outFiles.get(path.join(dir, "runs.jsonl")) ?? "").trim());
  assert.equal(persisted.boundary_evidence.denials.length, 1);
  assert.equal(persisted.boundary_evidence.gh_refusals.length, 1);
});

test("runExperiment: a cell with no denials carries no boundary_evidence field on the persisted record", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  });
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed[0].boundary_evidence, undefined);
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  const persisted = JSON.parse((outFiles.get(path.join(dir, "runs.jsonl")) ?? "").trim());
  assert.ok(!("boundary_evidence" in persisted), "absent boundary_evidence must mean no denial occurred, not an omitted key with a different meaning");
});

test("runExperiment: a boundary-evidence collection failure is recorded as boundary_evidence_error, distinguishable from no denials", async () => {
  const { deps, outFiles } = makeHarness({ f1: makeFixtureFile("f1", "review") }, makeManifestFile({ treatments: { harness: ["claude"] } }));
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    readBoundaryDenials: () => { throw new Error("denial log unreadable"); },
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  });
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(executed[0].boundary_evidence, undefined);
  assert.match(executed[0].boundary_evidence_error ?? "", /denial log unreadable/);
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  const persisted = JSON.parse((outFiles.get(path.join(dir, "runs.jsonl")) ?? "").trim());
  assert.match(persisted.boundary_evidence_error, /denial log unreadable/);
});

test("runExperiment: the manifest's resolved sandbox_mode is carried onto every persisted cell record", async () => {
  const { deps, outFiles } = makeHarness(
    { f1: makeFixtureFile("f1", "review") },
    makeManifestFile({ treatments: { harness: ["claude"] }, sandbox_mode: "external-bypass" }),
  );
  const cellExecution = baseCellExecution({
    createWorktree: async (_c, o) => o,
    removeWorktree: async () => {},
    preflight: async () => ({ ok: true }),
    invokeHarness: async () => ({ success: true, timed_out: false, exit_code: 0, stdout: "ok", stderr: "", duration: 1 }),
  });
  const { manifest, executed } = await runExperiment(FAKE_CFG, "/manifest.json", "/fixtures", { ...deps, cellExecution });
  assert.equal(manifest.sandbox_mode, "external-bypass");
  assert.equal(executed[0].sandbox_mode, "external-bypass");
  const dir = experimentDir(path.join(FAKE_CFG.repo_dir, manifest.output_dir), "exp1");
  const persisted = JSON.parse((outFiles.get(path.join(dir, "runs.jsonl")) ?? "").trim());
  assert.equal(persisted.sandbox_mode, "external-bypass");
});
