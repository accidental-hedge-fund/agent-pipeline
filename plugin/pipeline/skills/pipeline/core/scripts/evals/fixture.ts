// Fixture loading/validation (openspec/changes/stage-eval-runner — eval-fixture-contract).
//
// Types are stripped at runtime (no tsc step), so every invariant here is a
// real runtime check, not a compile-time one.

import * as fs from "node:fs";
import {
  EVAL_STAGE_NAMES,
  SUPPORTED_FIXTURE_SCHEMA_VERSIONS,
  type EvalStageName,
  type Fixture,
} from "./types.ts";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

export class FixtureValidationError extends Error {
  constructor(fixtureId: string, field: string, detail: string) {
    super(`Fixture "${fixtureId}": invalid field "${field}" — ${detail}`);
    this.name = "FixtureValidationError";
  }
}

/** Validate a raw parsed fixture object. Throws FixtureValidationError naming
 *  the fixture and the offending field on the first problem found. */
export function validateFixture(raw: unknown, sourcePath: string): Fixture {
  if (typeof raw !== "object" || raw === null) {
    throw new FixtureValidationError(sourcePath, "(root)", "fixture must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const fixtureId = typeof obj.fixture_id === "string" ? obj.fixture_id : sourcePath;

  const requireString = (field: string): string => {
    const v = obj[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new FixtureValidationError(fixtureId, field, "required non-empty string field is missing");
    }
    return v;
  };
  const requireNumber = (field: string): number => {
    const v = obj[field];
    if (typeof v !== "number") {
      throw new FixtureValidationError(fixtureId, field, "required numeric field is missing");
    }
    return v;
  };
  const requireStringArray = (field: string): string[] => {
    const v = obj[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new FixtureValidationError(fixtureId, field, "required string[] field is missing or malformed");
    }
    return v;
  };

  requireString("fixture_id");
  const schemaVersion = requireNumber("schema_version");
  if (!SUPPORTED_FIXTURE_SCHEMA_VERSIONS.includes(schemaVersion as 1)) {
    throw new FixtureValidationError(
      fixtureId,
      "schema_version",
      `unsupported schema_version ${schemaVersion} (supported: ${SUPPORTED_FIXTURE_SCHEMA_VERSIONS.join(", ")})`,
    );
  }

  const baseCommit = requireString("base_commit");
  if (!FULL_SHA_RE.test(baseCommit)) {
    throw new FixtureValidationError(
      fixtureId,
      "base_commit",
      "a full, immutable 40-character commit SHA is required (not a branch, tag, or abbreviated SHA)",
    );
  }

  const taskInput = requireString("task_input");
  requireStringArray("public_checks");
  requireStringArray("grader_refs");
  requireString("category");
  requireString("risk");

  const provenance = obj.provenance;
  if (provenance !== "synthetic" && provenance !== "harvested") {
    throw new FixtureValidationError(
      fixtureId,
      "provenance",
      `must be exactly "synthetic" or "harvested", got ${JSON.stringify(provenance)}`,
    );
  }

  const stageEntryArtifacts = obj.stage_entry_artifacts;
  if (typeof stageEntryArtifacts !== "object" || stageEntryArtifacts === null || Array.isArray(stageEntryArtifacts)) {
    throw new FixtureValidationError(
      fixtureId,
      "stage_entry_artifacts",
      "required object field (keyed by stage name) is missing",
    );
  }
  const artifacts = stageEntryArtifacts as Record<string, unknown>;
  for (const key of Object.keys(artifacts)) {
    if (!(EVAL_STAGE_NAMES as readonly string[]).includes(key)) {
      throw new FixtureValidationError(
        fixtureId,
        "stage_entry_artifacts",
        `unknown stage key "${key}" (expected one of: ${EVAL_STAGE_NAMES.join(", ")})`,
      );
    }
  }
  if (Object.keys(artifacts).length === 0) {
    throw new FixtureValidationError(
      fixtureId,
      "stage_entry_artifacts",
      "fixture declares no stage-entry artifacts for any stage",
    );
  }

  return {
    fixture_id: fixtureId,
    schema_version: schemaVersion,
    base_commit: baseCommit,
    task_input: taskInput,
    stage_entry_artifacts: artifacts as Partial<Record<EvalStageName, unknown>>,
    public_checks: obj.public_checks as string[],
    grader_refs: obj.grader_refs as string[],
    category: obj.category as string,
    risk: obj.risk as string,
    provenance,
  };
}

/** Validate that a fixture declares stage-entry artifacts for the given stage.
 *  Called separately from validateFixture because the required stage is only
 *  known once the manifest that references the fixture has been read. */
export function validateFixtureEntersStage(fixture: Fixture, stage: EvalStageName): void {
  if (!(stage in fixture.stage_entry_artifacts) || fixture.stage_entry_artifacts[stage] === undefined) {
    throw new FixtureValidationError(
      fixture.fixture_id,
      "stage_entry_artifacts",
      `fixture declares no stage-entry artifacts for stage "${stage}"`,
    );
  }
}

export interface LoadFixtureDeps {
  readFile?: (path: string) => string;
}

/** Load and validate one fixture file from disk (JSON). */
export function loadFixture(sourcePath: string, deps: LoadFixtureDeps = {}): Fixture {
  const readFileFn = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const text = readFileFn(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new FixtureValidationError(sourcePath, "(root)", `not valid JSON: ${(err as Error).message}`);
  }
  return validateFixture(raw, sourcePath);
}
