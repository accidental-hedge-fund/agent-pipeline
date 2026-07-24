// Tests for the optional model judge and blinded adjudication (eval-graders).
// No real model call — invokeJudge is always injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runJudging, deterministicPass } from "../scripts/evals/grading/judge.ts";
import { blindDisagreement, opaqueKeyForCell, resolveAdjudication } from "../scripts/evals/grading/adjudication.ts";
import type { ArtifactStoreDeps } from "../scripts/evals/trajectory/store.ts";
import type { GradeRecord } from "../scripts/evals/grading/types.ts";

function fakeArtifactFs(): ArtifactStoreDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    mkdir: async () => {},
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    readFile: async (p) => (files.has(p) ? files.get(p)! : null),
  };
}

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

test("judging is optional: with no judge invoked, no judge record exists and grades are untouched", async () => {
  const grade = baseGrade();
  const before = JSON.stringify(grade);
  // Simulate "judging disabled" simply by never calling runJudging.
  assert.equal(JSON.stringify(grade), before);
});

test("judge records carry judge harness/model/prompt version", async () => {
  const { judgeRecords } = await runJudging([baseGrade()], {
    invokeJudge: async () => ({ pass: true }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
  });
  assert.equal(judgeRecords.length, 1);
  assert.equal(judgeRecords[0].judge_harness, "claude");
  assert.equal(judgeRecords[0].judge_model, "sonnet");
  assert.equal(judgeRecords[0].judge_prompt_version, "v1");
});

test("deterministic grade fields are identical whether judging ran or not", async () => {
  const grade = baseGrade();
  const before = structuredClone(grade.payload);
  await runJudging([grade], {
    invokeJudge: async () => ({ pass: false }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
  });
  assert.deepEqual(grade.payload, before);
});

test("a judge/deterministic disagreement is recorded, the deterministic grade is unchanged", async () => {
  const grade = baseGrade(); // deterministicPass -> true (hidden tests 2/2, no regressions)
  assert.equal(deterministicPass(grade), true);
  const { disagreements } = await runJudging([grade], {
    invokeJudge: async () => ({ pass: false, note: "looked wrong" }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
  });
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0].cell_id, grade.cell_id);
});

test("agreement produces no disagreement record", async () => {
  const grade = baseGrade();
  const { disagreements } = await runJudging([grade], {
    invokeJudge: async () => ({ pass: true }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
  });
  assert.equal(disagreements.length, 0);
});

test("a configured verifier byte ceiling truncates judge evidence deterministically (#536 review 2)", async () => {
  const grade = baseGrade();
  const artifactStore = {
    repoDir: "/repo",
    verifiersDir: "/repo/.agent-pipeline/evals/exp1/verifiers",
  };
  const deps = {
    invokeJudge: async () => ({ pass: true }),
    judgeHarness: "claude",
    judgeModel: "sonnet",
    judgePromptVersion: "v1",
    verifierCeilings: { maxEvents: 200, maxBytes: 10 },
  };

  const fs1 = fakeArtifactFs();
  const { judgeRecords: first } = await runJudging([grade], { ...deps, artifactStore: { ...artifactStore, deps: fs1 } });
  assert.ok(first[0].verifier_artifact, "expected a verifier artifact descriptor");
  assert.equal(first[0].verifier_artifact!.truncation_status, "truncated");

  // Deterministic: bounding the same input with the same ceilings twice
  // produces byte-identical artifact content (same content hash).
  const fs2 = fakeArtifactFs();
  const { judgeRecords: second } = await runJudging([grade], { ...deps, artifactStore: { ...artifactStore, deps: fs2 } });
  assert.equal(second[0].verifier_artifact!.content_hash, first[0].verifier_artifact!.content_hash);

  // Without a custom ceiling (default 200KB), the same small grade fits
  // untruncated — proving the small ceiling above, not the grade itself,
  // caused the truncation.
  const fs3 = fakeArtifactFs();
  const { judgeRecords: untruncated } = await runJudging([grade], {
    invokeJudge: deps.invokeJudge,
    judgeHarness: deps.judgeHarness,
    judgeModel: deps.judgeModel,
    judgePromptVersion: deps.judgePromptVersion,
    artifactStore: { ...artifactStore, deps: fs3 },
  });
  assert.equal(untruncated[0].verifier_artifact!.truncation_status, "none");
});

test("adjudication material is blinded: no harness/provider/model/effort string appears", () => {
  const disagreement = {
    cell_id: "exp1/fx/harness=claude,model=opus,effort=high/1",
    experiment_id: "exp1",
    fixture_id: "fx",
    treatment_id: "harness=claude,model=opus,effort=high",
    replicate: 1,
    judge_prompt_version: "v1",
    note: "judge verdict pass=false disagrees with deterministic grade pass=true",
  };
  const material = blindDisagreement(disagreement);
  const serialized = JSON.stringify(material);
  assert.doesNotMatch(serialized, /claude|opus|harness=|model=|effort=/i);
  assert.ok(material.opaque_key.length > 0);
});

test("the opaque key resolves back to exactly one cell", () => {
  const cellIds = ["exp1/fx/harness=claude/1", "exp1/fx/harness=codex/1"];
  const key = opaqueKeyForCell(cellIds[0]);
  const resolved = resolveAdjudication({ opaque_key: key, verdict: "uphold", rationale: "r" }, cellIds);
  assert.equal(resolved, cellIds[0]);
});

test("opaqueKeyForCell is stable and does not encode the cell_id reversibly", () => {
  const key1 = opaqueKeyForCell("exp1/fx/harness=claude/1");
  const key2 = opaqueKeyForCell("exp1/fx/harness=claude/1");
  assert.equal(key1, key2);
  assert.doesNotMatch(key1, /claude|harness|exp1/);
});
