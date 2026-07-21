// Tests for the evaluation-mode GitHub surface (openspec/changes/stage-eval-runner,
// design.md decision 4). No real fs/git/subprocess/network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GhWriteRefusedError,
  MUTATING_GH_OPERATIONS,
  createEvalGhSurface,
  createRecordingRefusalRecorder,
} from "../scripts/evals/gh-eval-surface.ts";

test("createEvalGhSurface: every mutating operation refuses and records the attempt", async () => {
  const recorder = createRecordingRefusalRecorder();
  const surface = createEvalGhSurface(recorder);
  for (const op of MUTATING_GH_OPERATIONS) {
    await assert.rejects(() => surface[op]("arg1", "arg2"), GhWriteRefusedError);
  }
  assert.equal(recorder.refusals.length, MUTATING_GH_OPERATIONS.length);
  assert.deepEqual(
    recorder.refusals.map((r) => r.operation).sort(),
    [...MUTATING_GH_OPERATIONS].sort(),
  );
});

test("createEvalGhSurface: refusal records the operation name and the call args", async () => {
  const recorder = createRecordingRefusalRecorder();
  const surface = createEvalGhSurface(recorder);
  await assert.rejects(() => surface.addLabel(42, "pipeline:ready"));
  assert.equal(recorder.refusals.length, 1);
  assert.equal(recorder.refusals[0].operation, "addLabel");
  assert.deepEqual(recorder.refusals[0].args, [42, "pipeline:ready"]);
});

test("GhWriteRefusedError: carries the operation name and a clear message", async () => {
  const recorder = createRecordingRefusalRecorder();
  const surface = createEvalGhSurface(recorder);
  try {
    await surface.mergePr(7);
    assert.fail("expected mergePr to be refused");
  } catch (err) {
    assert.ok(err instanceof GhWriteRefusedError);
    assert.equal(err.operation, "mergePr");
    assert.match(err.message, /refused/i);
  }
});
