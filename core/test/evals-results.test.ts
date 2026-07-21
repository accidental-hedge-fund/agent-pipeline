// Tests for the output filesystem contract (openspec/changes/stage-eval-runner,
// design.md decision 7). All fs access is an in-memory fake — no real fs/git/
// subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  appendCellRecord,
  experimentDir,
  readExistingRecords,
  writePlanArtifacts,
  type ResultsWriterDeps,
} from "../scripts/evals/results.ts";
import type { CellRecord, ExperimentManifest, RunPlan } from "../scripts/evals/types.ts";

function makeInMemoryFs(): { deps: ResultsWriterDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  const deps: ResultsWriterDeps = {
    mkdir: async () => {},
    writeFile: async (p, content) => { files.set(p, content); },
    appendFile: async (p, content) => { files.set(p, (files.get(p) ?? "") + content); },
    readFile: async (p) => files.get(p) ?? null,
  };
  return { deps, files };
}

const MANIFEST: ExperimentManifest = {
  schema_version: 1,
  experiment_id: "exp1",
  fixture_ids: ["f1"],
  mode: "review",
  treatments: { harness: ["claude"] },
  replicates: 1,
  seed: 1,
  concurrency: 1,
  timeout: 60,
  output_dir: ".agent-pipeline/evals",
};

const PLAN: RunPlan = { schema_version: 1, experiment_id: "exp1", seed: 1, cells: [] };

function makeRecord(overrides: Partial<CellRecord> = {}): CellRecord {
  return {
    cell_id: "exp1/f1/harness=claude/1",
    experiment_id: "exp1",
    fixture_id: "f1",
    treatment_id: "harness=claude",
    replicate: 1,
    prompt_hash: "hash-p",
    config_hash: "hash-c",
    base_sha: "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd",
    result_class: "completed",
    ...overrides,
  };
}

test("writePlanArtifacts: writes manifest.json and plan.json under <output_dir>/<experiment-id>/", async () => {
  const { deps, files } = makeInMemoryFs();
  await writePlanArtifacts("/out", MANIFEST, PLAN, deps);
  const dir = experimentDir("/out", "exp1");
  assert.ok(files.has(path.join(dir, "manifest.json")));
  assert.ok(files.has(path.join(dir, "plan.json")));
  assert.deepEqual(JSON.parse(files.get(path.join(dir, "manifest.json"))!), MANIFEST);
});

test("appendCellRecord: a completed record goes to runs.jsonl, not failures.jsonl", async () => {
  const { deps, files } = makeInMemoryFs();
  await appendCellRecord("/out", makeRecord({ result_class: "completed" }), deps);
  const dir = experimentDir("/out", "exp1");
  assert.ok(files.has(path.join(dir, "runs.jsonl")));
  assert.ok(!files.has(path.join(dir, "failures.jsonl")));
});

for (const resultClass of ["infra_error", "auth_error", "timeout"] as const) {
  test(`appendCellRecord: a ${resultClass} record goes to failures.jsonl, not runs.jsonl`, async () => {
    const { deps, files } = makeInMemoryFs();
    await appendCellRecord("/out", makeRecord({ result_class: resultClass, error: "boom" }), deps);
    const dir = experimentDir("/out", "exp1");
    assert.ok(files.has(path.join(dir, "failures.jsonl")));
    assert.ok(!files.has(path.join(dir, "runs.jsonl")));
  });
}

test("appendCellRecord: each line is independently parseable JSON, one object per line", async () => {
  const { deps, files } = makeInMemoryFs();
  await appendCellRecord("/out", makeRecord({ cell_id: "c1" }), deps);
  await appendCellRecord("/out", makeRecord({ cell_id: "c2" }), deps);
  const dir = experimentDir("/out", "exp1");
  const lines = files.get(path.join(dir, "runs.jsonl"))!.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("appendCellRecord: append-only — an existing line is never rewritten by a later append", async () => {
  const { deps, files } = makeInMemoryFs();
  await appendCellRecord("/out", makeRecord({ cell_id: "c1" }), deps);
  const dir = experimentDir("/out", "exp1");
  const firstLine = files.get(path.join(dir, "runs.jsonl"))!;
  await appendCellRecord("/out", makeRecord({ cell_id: "c2" }), deps);
  const afterSecond = files.get(path.join(dir, "runs.jsonl"))!;
  assert.ok(afterSecond.startsWith(firstLine), "the first record's bytes must be an unmodified prefix");
});

test("appendCellRecord: every record carries all seven join keys", async () => {
  const { deps, files } = makeInMemoryFs();
  await appendCellRecord("/out", makeRecord(), deps);
  const dir = experimentDir("/out", "exp1");
  const parsed = JSON.parse(files.get(path.join(dir, "runs.jsonl"))!.trim());
  for (const key of ["experiment_id", "fixture_id", "treatment_id", "replicate", "prompt_hash", "config_hash", "base_sha"]) {
    assert.ok(key in parsed, `record must contain ${key}`);
  }
});

test("readExistingRecords: reads and merges both streams", async () => {
  const { deps } = makeInMemoryFs();
  await appendCellRecord("/out", makeRecord({ cell_id: "c1", result_class: "completed" }), deps);
  await appendCellRecord("/out", makeRecord({ cell_id: "c2", result_class: "infra_error", error: "x" }), deps);
  const records = await readExistingRecords("/out", "exp1", deps);
  assert.deepEqual(new Set(records.map((r) => r.cell_id)), new Set(["c1", "c2"]));
});

test("readExistingRecords: no prior output → empty array, not a thrown error", async () => {
  const { deps } = makeInMemoryFs();
  const records = await readExistingRecords("/out", "exp1", deps);
  assert.deepEqual(records, []);
});

test("appendCellRecord: a write failure is logged and swallowed, not thrown (non-fatal-write convention)", async () => {
  const deps: ResultsWriterDeps = {
    mkdir: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
  };
  await assert.doesNotReject(() => appendCellRecord("/out", makeRecord(), deps));
});

test("appendCellRecord: returns true when the record is durably written", async () => {
  const { deps } = makeInMemoryFs();
  const persisted = await appendCellRecord("/out", makeRecord(), deps);
  assert.equal(persisted, true);
});

test("appendCellRecord: returns false when the write fails, so a caller can avoid reporting the cell as executed", async () => {
  const deps: ResultsWriterDeps = {
    mkdir: async () => {},
    appendFile: async () => { throw new Error("disk full"); },
  };
  const persisted = await appendCellRecord("/out", makeRecord(), deps);
  assert.equal(persisted, false);
});
