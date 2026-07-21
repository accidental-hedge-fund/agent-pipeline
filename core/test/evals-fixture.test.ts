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
