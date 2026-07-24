// Tests for fixture loading/validation (openspec/changes/stage-eval-runner —
// eval-fixture-contract). No real fs/git/subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeEnvSurfaceHash,
  FixtureValidationError,
  loadFixture,
  validateFixture,
  validateFixtureEntersStage,
} from "../scripts/evals/fixture.ts";

const VALID_SHA = "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd";

function validFixtureRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixture_id: "f1",
    schema_version: 1,
    base_commit: VALID_SHA,
    task_input: "Do the thing.",
    stage_entry_artifacts: { review: { diff: "..." } },
    public_checks: [],
    grader_refs: [],
    category: "cli-feature",
    risk: "low",
    provenance: "synthetic",
    ...overrides,
  };
}

test("validateFixture: a complete fixture is accepted", () => {
  const fixture = validateFixture(validFixtureRaw(), "f1.json");
  assert.equal(fixture.fixture_id, "f1");
  assert.equal(fixture.base_commit, VALID_SHA);
  assert.equal(fixture.provenance, "synthetic");
});

test("validateFixture: missing required field is rejected by name", () => {
  const raw = validFixtureRaw();
  delete raw.category;
  assert.throws(() => validateFixture(raw, "f1.json"), (err: unknown) => {
    assert.ok(err instanceof FixtureValidationError);
    assert.match((err as Error).message, /"category"/);
    return true;
  });
});

test("validateFixture: abbreviated SHA is rejected", () => {
  const raw = validFixtureRaw({ base_commit: "b63d9ba" });
  assert.throws(() => validateFixture(raw, "f1.json"), /full, immutable/);
});

test("validateFixture: branch name as base_commit is rejected", () => {
  const raw = validFixtureRaw({ base_commit: "main" });
  assert.throws(() => validateFixture(raw, "f1.json"), /full, immutable/);
});

test("validateFixture: invalid provenance is rejected", () => {
  const raw = validFixtureRaw({ provenance: "made-up" });
  assert.throws(() => validateFixture(raw, "f1.json"), /provenance/);
});

test("validateFixture: unsupported schema_version is rejected", () => {
  const raw = validFixtureRaw({ schema_version: 99 });
  assert.throws(() => validateFixture(raw, "f1.json"), /schema_version/);
});

test("validateFixture: no stage-entry artifacts at all is rejected", () => {
  const raw = validFixtureRaw({ stage_entry_artifacts: {} });
  assert.throws(() => validateFixture(raw, "f1.json"), /stage_entry_artifacts/);
});

test("validateFixture: unknown stage key in stage_entry_artifacts is rejected", () => {
  const raw = validFixtureRaw({ stage_entry_artifacts: { bogus: {} } });
  assert.throws(() => validateFixture(raw, "f1.json"), /unknown stage key/);
});

test("validateFixtureEntersStage: fixture lacking the targeted stage's artifacts is rejected", () => {
  const fixture = validateFixture(validFixtureRaw({ stage_entry_artifacts: { review: {} } }), "f1.json");
  assert.throws(
    () => validateFixtureEntersStage(fixture, "fix"),
    (err: unknown) => {
      assert.ok(err instanceof FixtureValidationError);
      assert.match((err as Error).message, /stage_entry_artifacts/);
      assert.match((err as Error).message, /"fix"/);
      return true;
    },
  );
});

test("validateFixtureEntersStage: fixture with the targeted stage's artifacts passes", () => {
  const fixture = validateFixture(validFixtureRaw({ stage_entry_artifacts: { review: {} } }), "f1.json");
  assert.doesNotThrow(() => validateFixtureEntersStage(fixture, "review"));
});

test("loadFixture: reads and validates from an injected file reader (no real fs)", () => {
  const text = JSON.stringify(validFixtureRaw());
  const fixture = loadFixture("/fake/f1.json", { readFile: () => text });
  assert.equal(fixture.fixture_id, "f1");
});

test("loadFixture: malformed JSON is rejected", () => {
  assert.throws(
    () => loadFixture("/fake/f1.json", { readFile: () => "{not json" }),
    FixtureValidationError,
  );
});

// --- eval-graders-and-comparative-reporting field extensions ---

test("validateFixture: a fixture declaring none of the new grading fields still validates", () => {
  const fixture = validateFixture(validFixtureRaw(), "f1.json");
  assert.equal(fixture.hidden_checks, undefined);
  assert.equal(fixture.seeded_defects, undefined);
  assert.equal(fixture.acceptance_criteria, undefined);
  assert.equal(fixture.allowed_change_paths, undefined);
  assert.deepEqual(fixture.grader_refs, []);
});

test("validateFixture: a check declared both public and hidden is rejected by name", () => {
  assert.throws(
    () =>
      validateFixture(
        validFixtureRaw({ public_checks: ["npm run ci"], hidden_checks: ["npm run ci"] }),
        "f1.json",
      ),
    (err: unknown) => err instanceof FixtureValidationError && /npm run ci/.test((err as Error).message),
  );
});

test("validateFixture: hidden_checks disjoint from public_checks is accepted", () => {
  const fixture = validateFixture(
    validFixtureRaw({ public_checks: ["npm run ci"], hidden_checks: ["node --test hidden.test.ts"] }),
    "f1.json",
  );
  assert.deepEqual(fixture.hidden_checks, ["node --test hidden.test.ts"]);
});

test("validateFixture: a duplicate seeded defect_id is rejected naming the fixture and the id", () => {
  assert.throws(
    () =>
      validateFixture(
        validFixtureRaw({
          seeded_defects: [
            { defect_id: "d1", path: "a.ts", line_start: 1, line_end: 2, expected_severity: "high" },
            { defect_id: "d1", path: "b.ts", line_start: 1, line_end: 2, expected_severity: "low" },
          ],
        }),
        "f1.json",
      ),
    (err: unknown) => err instanceof FixtureValidationError && /d1/.test((err as Error).message),
  );
});

test("validateFixture: a seeded defect missing its location is rejected", () => {
  assert.throws(
    () =>
      validateFixture(
        validFixtureRaw({
          seeded_defects: [{ defect_id: "d1", expected_severity: "high" }],
        }),
        "f1.json",
      ),
    (err: unknown) => err instanceof FixtureValidationError && /d1/.test((err as Error).message),
  );
});

test("validateFixture: a seeded defect missing expected_severity is rejected", () => {
  assert.throws(
    () =>
      validateFixture(
        validFixtureRaw({
          seeded_defects: [{ defect_id: "d1", path: "a.ts", line_start: 1, line_end: 2 }],
        }),
        "f1.json",
      ),
    (err: unknown) => err instanceof FixtureValidationError && /d1/.test((err as Error).message),
  );
});

test("validateFixture: a complete seeded defect is accepted", () => {
  const fixture = validateFixture(
    validFixtureRaw({
      seeded_defects: [{ defect_id: "d1", path: "a.ts", line_start: 1, line_end: 2, expected_severity: "high" }],
    }),
    "f1.json",
  );
  assert.equal(fixture.seeded_defects?.[0].defect_id, "d1");
});

test("validateFixture: a duplicate acceptance criterion id is rejected", () => {
  assert.throws(
    () =>
      validateFixture(
        validFixtureRaw({
          acceptance_criteria: [
            { id: "c1", statement: "a" },
            { id: "c1", statement: "b" },
          ],
        }),
        "f1.json",
      ),
    FixtureValidationError,
  );
});

test("validateFixture: an unsupported grader version is rejected naming the fixture, grader, and version", () => {
  assert.throws(
    () =>
      validateFixture(validFixtureRaw({ grader_refs: [{ grader: "review", version: "999" }] }), "f1.json"),
    (err: unknown) =>
      err instanceof FixtureValidationError && /review/.test((err as Error).message) && /999/.test((err as Error).message),
  );
});

test("validateFixture: an unrecognized grader name is rejected", () => {
  assert.throws(
    () => validateFixture(validFixtureRaw({ grader_refs: [{ grader: "made-up-grader", version: "1" }] }), "f1.json"),
    FixtureValidationError,
  );
});

test("validateFixture: a supported grader_ref version is accepted", () => {
  const fixture = validateFixture(
    validFixtureRaw({ grader_refs: [{ grader: "review", version: "1" }] }),
    "f1.json",
  );
  assert.deepEqual(fixture.grader_refs, [{ grader: "review", version: "1" }]);
});

test("validateFixture: allowed_change_paths is accepted when declared", () => {
  const fixture = validateFixture(
    validFixtureRaw({ allowed_change_paths: ["core/scripts/gh.ts"] }),
    "f1.json",
  );
  assert.deepEqual(fixture.allowed_change_paths, ["core/scripts/gh.ts"]);
});

// --- environment-fidelity contract (eval-fixture-contract, #535) ---

function validEnvDep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "github-api",
    mode: "simulated",
    version: "1",
    required_permissions: [],
    initial_state: { issues: [] },
    expected: { outputs: "an issue list" },
    setup: "seed a fake issues.json",
    teardown: "none",
    ...overrides,
  };
}

test("validateFixture: a fixture declaring no environment entries stays valid", () => {
  const fixture = validateFixture(validFixtureRaw(), "f1.json");
  assert.equal(fixture.environment, undefined);
  assert.equal(typeof fixture.env_surface_hash, "string");
  assert.ok(fixture.env_surface_hash.length > 0);
});

test("validateFixture: a complete environment dependency is accepted and its mode exposed", () => {
  const fixture = validateFixture(validFixtureRaw({ environment: [validEnvDep()] }), "f1.json");
  assert.equal(fixture.environment?.[0].name, "github-api");
  assert.equal(fixture.environment?.[0].mode, "simulated");
});

test("validateFixture: an unknown environment dependency mode is rejected by name", () => {
  assert.throws(
    () => validateFixture(validFixtureRaw({ environment: [validEnvDep({ mode: "made-up" })] }), "f1.json"),
    (err: unknown) =>
      err instanceof FixtureValidationError &&
      /github-api/.test((err as Error).message) &&
      /mode/.test((err as Error).message),
  );
});

for (const missingField of ["version", "required_permissions", "initial_state", "expected", "setup", "teardown"]) {
  test(`validateFixture: an environment dependency missing "${missingField}" is rejected naming the fixture and field`, () => {
    const dep = validEnvDep();
    delete dep[missingField];
    assert.throws(
      () => validateFixture(validFixtureRaw({ environment: [dep] }), "f1.json"),
      (err: unknown) =>
        err instanceof FixtureValidationError &&
        /github-api/.test((err as Error).message) &&
        new RegExp(missingField).test((err as Error).message),
    );
  });
}

test("validateFixture: a capability_surface snapshot is accepted when complete", () => {
  const fixture = validateFixture(
    validFixtureRaw({
      capability_surface: {
        stage: "review",
        materialized_prompts: ["review this diff"],
        harness_config: { harness: "claude" },
        tools_hooks: ["Read"],
        repo_paths: ["core/scripts/evals/fixture.ts"],
        services_data: ["github-api"],
      },
    }),
    "f1.json",
  );
  assert.equal(fixture.capability_surface?.stage, "review");
});

test("validateFixture: an incomplete capability_surface is rejected", () => {
  assert.throws(
    () => validateFixture(validFixtureRaw({ capability_surface: { stage: "review" } }), "f1.json"),
    FixtureValidationError,
  );
});

test("computeEnvSurfaceHash: identical environment + surface hash identically", () => {
  const env = [validEnvDep()] as Parameters<typeof computeEnvSurfaceHash>[0];
  const surface = { stage: "review", materialized_prompts: [], harness_config: {}, tools_hooks: [], repo_paths: [], services_data: [] } as Parameters<typeof computeEnvSurfaceHash>[1];
  assert.equal(computeEnvSurfaceHash(env, surface), computeEnvSurfaceHash(env, surface));
});

test("computeEnvSurfaceHash: a single dependency mode change changes the hash", () => {
  const hashA = computeEnvSurfaceHash([validEnvDep() as any], undefined);
  const hashB = computeEnvSurfaceHash([validEnvDep({ mode: "live" }) as any], undefined);
  assert.notEqual(hashA, hashB);
});

test("computeEnvSurfaceHash: both fixtures absent environment/surface hash identically (stable baseline)", () => {
  assert.equal(computeEnvSurfaceHash(undefined, undefined), computeEnvSurfaceHash(undefined, undefined));
});

test("validateFixture: two fixtures identical except one dependency's mode produce different env_surface_hash", () => {
  const f1 = validateFixture(validFixtureRaw({ environment: [validEnvDep()] }), "f1.json");
  const f2 = validateFixture(validFixtureRaw({ environment: [validEnvDep({ mode: "live" })] }), "f1.json");
  assert.notEqual(f1.env_surface_hash, f2.env_surface_hash);
});
