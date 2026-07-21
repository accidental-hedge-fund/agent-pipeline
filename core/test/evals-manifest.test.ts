// Tests for manifest validation and deterministic matrix expansion
// (openspec/changes/stage-eval-runner). No real fs/git/subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ManifestValidationError,
  computeConfigHash,
  computePromptHash,
  expandPlan,
  loadManifest,
  treatmentId,
  validateManifest,
} from "../scripts/evals/manifest.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import type { Fixture } from "../scripts/evals/types.ts";

const SHA_A = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";
const SHA_B = "e22bb2882b5a1234567890abcdef1234567890ab";

function makeFixture(id: string, sha: string, stage: string): Fixture {
  return validateFixture(
    {
      fixture_id: id,
      schema_version: 1,
      base_commit: sha,
      task_input: "task",
      stage_entry_artifacts: { [stage]: { x: 1 } },
      public_checks: [],
      grader_refs: [],
      category: "c",
      risk: "low",
      provenance: "synthetic",
    },
    `${id}.json`,
  );
}

function validManifestRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    experiment_id: "exp1",
    fixture_ids: ["f1"],
    mode: "review",
    treatments: { harness: ["claude", "codex"] },
    replicates: 1,
    seed: 42,
    concurrency: 2,
    timeout: 300,
    output_dir: ".agent-pipeline/evals",
    ...overrides,
  };
}

test("validateManifest: a complete manifest is accepted", () => {
  const manifest = validateManifest(validManifestRaw(), new Set(["f1"]));
  assert.equal(manifest.experiment_id, "exp1");
  assert.equal(manifest.mode, "review");
});

test("validateManifest: missing required field is rejected by name", () => {
  const raw = validManifestRaw();
  delete raw.seed;
  assert.throws(() => validateManifest(raw, new Set(["f1"])), (err: unknown) => {
    assert.ok(err instanceof ManifestValidationError);
    assert.match((err as Error).message, /"seed"/);
    return true;
  });
});

test("validateManifest: missing output_dir is rejected by name, not defaulted (delta daf35a2c)", () => {
  const raw = validManifestRaw();
  delete raw.output_dir;
  assert.throws(() => validateManifest(raw, new Set(["f1"])), (err: unknown) => {
    assert.ok(err instanceof ManifestValidationError);
    assert.match((err as Error).message, /"output_dir"/);
    return true;
  });
});

test("validateManifest: experiment_id with path separators or '..' is rejected (delta 7282029b)", () => {
  for (const id of ["../evil", "a/b", "a\\b", "..", "x/../y"]) {
    const raw = validManifestRaw();
    raw.experiment_id = id;
    assert.throws(() => validateManifest(raw, new Set(["f1"])), (err: unknown) => {
      assert.ok(err instanceof ManifestValidationError, `expected rejection for ${JSON.stringify(id)}`);
      assert.match((err as Error).message, /"experiment_id"/);
      return true;
    });
  }
});

test("validateManifest: unknown mode is rejected", () => {
  const raw = validManifestRaw({ mode: "bogus-stage" });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), /mode/);
});

test("validateManifest: unknown fixture reference is rejected", () => {
  const raw = validManifestRaw({ fixture_ids: ["f1", "unknown-fixture"] });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), /unknown fixture "unknown-fixture"/);
});

test("validateManifest: unsupported schema_version is rejected", () => {
  const raw = validManifestRaw({ schema_version: 7 });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), /schema_version/);
});

test("validateManifest: end-to-end mode is accepted", () => {
  const manifest = validateManifest(validManifestRaw({ mode: "end-to-end" }), new Set(["f1"]));
  assert.equal(manifest.mode, "end-to-end");
});

test("validateManifest: unknown treatment axis is rejected", () => {
  const raw = validManifestRaw({ treatments: { language: ["ts"] } });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), /unknown treatment axis/);
});

test("loadManifest: reads from an injected file reader (no real fs)", () => {
  const text = JSON.stringify(validManifestRaw());
  const manifest = loadManifest("/fake/manifest.json", new Set(["f1"]), { readFile: () => text });
  assert.equal(manifest.experiment_id, "exp1");
});

test("treatmentId: deterministic slug independent of key insertion order", () => {
  const id1 = treatmentId({ effort: "high", harness: "claude" });
  const id2 = treatmentId({ harness: "claude", effort: "high" });
  assert.equal(id1, id2);
  assert.equal(id1, "harness=claude,effort=high");
});

test("expandPlan: produces one cell per fixture x treatment x replicate", () => {
  const fixtures = new Map([
    ["f1", makeFixture("f1", SHA_A, "review")],
    ["f2", makeFixture("f2", SHA_B, "review")],
  ]);
  const manifest = validateManifest(
    validManifestRaw({ fixture_ids: ["f1", "f2"], treatments: { harness: ["claude", "codex"] }, replicates: 2 }),
    new Set(fixtures.keys()),
  );
  const plan = expandPlan(manifest, fixtures);
  assert.equal(plan.cells.length, 2 /* fixtures */ * 2 /* harnesses */ * 2 /* replicates */);
  const ids = new Set(plan.cells.map((c) => c.cell_id));
  assert.equal(ids.size, plan.cells.length, "every cell_id must be unique");
});

test("expandPlan: cell_id is deterministic from coordinates", () => {
  const fixtures = new Map([["f1", makeFixture("f1", SHA_A, "review")]]);
  const manifest = validateManifest(validManifestRaw(), new Set(fixtures.keys()));
  const plan = expandPlan(manifest, fixtures);
  for (const cell of plan.cells) {
    assert.equal(cell.cell_id, `${cell.experiment_id}/${cell.fixture_id}/${cell.treatment_id}/${cell.replicate}`);
  }
});

test("expandPlan: expanding the same manifest twice produces byte-identical plans", () => {
  const fixtures = new Map([
    ["f1", makeFixture("f1", SHA_A, "review")],
    ["f2", makeFixture("f2", SHA_B, "review")],
  ]);
  const manifest = validateManifest(
    validManifestRaw({ fixture_ids: ["f1", "f2"], treatments: { harness: ["claude", "codex"], effort: ["low", "high"] } }),
    new Set(fixtures.keys()),
  );
  const plan1 = expandPlan(manifest, fixtures);
  const plan2 = expandPlan(manifest, fixtures);
  assert.equal(JSON.stringify(plan1), JSON.stringify(plan2));
});

test("expandPlan: base_sha is carried from the fixture, per-fixture", () => {
  const fixtures = new Map([
    ["f1", makeFixture("f1", SHA_A, "review")],
    ["f2", makeFixture("f2", SHA_B, "review")],
  ]);
  const manifest = validateManifest(validManifestRaw({ fixture_ids: ["f1", "f2"] }), new Set(fixtures.keys()));
  const plan = expandPlan(manifest, fixtures);
  assert.ok(plan.cells.filter((c) => c.fixture_id === "f1").every((c) => c.base_sha === SHA_A));
  assert.ok(plan.cells.filter((c) => c.fixture_id === "f2").every((c) => c.base_sha === SHA_B));
});

// ---------------------------------------------------------------------------
// #434 review 1 finding e2de1c5f — a "params" treatment axis for per-cell
// request-parameter overrides (temperature, seed, max_output_tokens, etc.),
// validated against the same allowlist a committed executor's `params:` uses.
// ---------------------------------------------------------------------------

test("validateManifest: a params axis entry with an unknown key is rejected at manifest load", () => {
  const raw = validManifestRaw({
    treatments: { executor: ["openrouter-review"], params: [JSON.stringify({ temperatur: 0 })] },
  });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), (err: unknown) => {
    assert.ok(err instanceof ManifestValidationError);
    assert.match((err as Error).message, /params/);
    assert.match((err as Error).message, /temperatur/);
    return true;
  });
});

test("validateManifest: a params axis entry that is not valid JSON is rejected at manifest load", () => {
  const raw = validManifestRaw({
    treatments: { executor: ["openrouter-review"], params: ["not json"] },
  });
  assert.throws(() => validateManifest(raw, new Set(["f1"])), /not valid JSON/);
});

test("validateManifest: a valid params axis entry is accepted", () => {
  const raw = validManifestRaw({
    treatments: { executor: ["openrouter-review"], params: [JSON.stringify({ temperature: 0, seed: 7 })] },
  });
  const manifest = validateManifest(raw, new Set(["f1"]));
  assert.deepEqual(manifest.treatments.params, [JSON.stringify({ temperature: 0, seed: 7 })]);
});

test("expandPlan: distinct params axis entries expand to distinct cells with distinct treatment.params", () => {
  const fixtures = new Map([["f1", makeFixture("f1", SHA_A, "review")]]);
  const manifest = validateManifest(
    validManifestRaw({
      treatments: {
        executor: ["openrouter-review"],
        params: [JSON.stringify({ temperature: 0 }), JSON.stringify({ temperature: 1 })],
      },
    }),
    new Set(fixtures.keys()),
  );
  const plan = expandPlan(manifest, fixtures);
  assert.equal(plan.cells.length, 2);
  const treatmentParams = plan.cells.map((c) => c.treatment.params);
  assert.deepEqual(treatmentParams, [{ temperature: 0 }, { temperature: 1 }]);
  const ids = new Set(plan.cells.map((c) => c.cell_id));
  assert.equal(ids.size, 2, "distinct params must produce distinct cell_ids, not a collision");
});

test("expandPlan: replaying the same manifest resolves the same params, byte-identical (determinism)", () => {
  const fixtures = new Map([["f1", makeFixture("f1", SHA_A, "review")]]);
  const manifest = validateManifest(
    validManifestRaw({
      treatments: { executor: ["openrouter-review"], params: [JSON.stringify({ temperature: 0, seed: 7 })] },
    }),
    new Set(fixtures.keys()),
  );
  const plan1 = expandPlan(manifest, fixtures);
  const plan2 = expandPlan(manifest, fixtures);
  assert.equal(JSON.stringify(plan1), JSON.stringify(plan2));
});

test("computePromptHash: differing materialized prompts produce differing hashes", () => {
  assert.notEqual(computePromptHash("prompt A"), computePromptHash("prompt B"));
  assert.equal(computePromptHash("same"), computePromptHash("same"));
});

test("computeConfigHash: differing effective config produces differing hashes, key-order independent", () => {
  const h1 = computeConfigHash({ a: 1, b: 2 });
  const h2 = computeConfigHash({ b: 2, a: 1 });
  const h3 = computeConfigHash({ a: 1, b: 3 });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});
