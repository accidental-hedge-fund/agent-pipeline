// Tests for fixture loading/validation (openspec/changes/stage-eval-runner —
// eval-fixture-contract). No real fs/git/subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
