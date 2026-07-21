// Fixture loading/validation (openspec/changes/stage-eval-runner — eval-fixture-contract).
//
// Types are stripped at runtime (no tsc step), so every invariant here is a
// real runtime check, not a compile-time one.

import * as fs from "node:fs";
import {
  EVAL_STAGE_NAMES,
  SUPPORTED_FIXTURE_SCHEMA_VERSIONS,
  SUPPORTED_GRADER_VERSIONS,
  type AcceptanceCriterion,
  type EvalStageName,
  type Fixture,
  type GraderRef,
  type SeededDefect,
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
  const publicChecks = requireStringArray("public_checks");
  requireString("category");
  requireString("risk");

  const hiddenChecksRaw = obj.hidden_checks;
  let hiddenChecks: string[] | undefined;
  if (hiddenChecksRaw !== undefined) {
    if (!Array.isArray(hiddenChecksRaw) || hiddenChecksRaw.some((x) => typeof x !== "string")) {
      throw new FixtureValidationError(fixtureId, "hidden_checks", "must be a string[] when present");
    }
    hiddenChecks = hiddenChecksRaw as string[];
    const publicSet = new Set(publicChecks);
    for (const check of hiddenChecks) {
      if (publicSet.has(check)) {
        throw new FixtureValidationError(
          fixtureId,
          "hidden_checks",
          `check ${JSON.stringify(check)} is declared as both a public check and a hidden check`,
        );
      }
    }
  }

  const seededDefectsRaw = obj.seeded_defects;
  let seededDefects: SeededDefect[] | undefined;
  if (seededDefectsRaw !== undefined) {
    if (!Array.isArray(seededDefectsRaw)) {
      throw new FixtureValidationError(fixtureId, "seeded_defects", "must be an array when present");
    }
    const seenDefectIds = new Set<string>();
    seededDefects = seededDefectsRaw.map((raw, idx) => {
      if (typeof raw !== "object" || raw === null) {
        throw new FixtureValidationError(fixtureId, "seeded_defects", `entry ${idx} must be an object`);
      }
      const d = raw as Record<string, unknown>;
      const defectId = d.defect_id;
      if (typeof defectId !== "string" || defectId.length === 0) {
        throw new FixtureValidationError(fixtureId, "seeded_defects", `entry ${idx} is missing "defect_id"`);
      }
      if (seenDefectIds.has(defectId)) {
        throw new FixtureValidationError(
          fixtureId,
          "seeded_defects",
          `duplicate defect_id ${JSON.stringify(defectId)}`,
        );
      }
      seenDefectIds.add(defectId);
      if (typeof d.path !== "string" || d.path.length === 0) {
        throw new FixtureValidationError(
          fixtureId,
          "seeded_defects",
          `defect ${JSON.stringify(defectId)} is missing its location field "path"`,
        );
      }
      if (typeof d.line_start !== "number" || typeof d.line_end !== "number") {
        throw new FixtureValidationError(
          fixtureId,
          "seeded_defects",
          `defect ${JSON.stringify(defectId)} is missing its location field "line_start"/"line_end"`,
        );
      }
      if (typeof d.expected_severity !== "string" || d.expected_severity.length === 0) {
        throw new FixtureValidationError(
          fixtureId,
          "seeded_defects",
          `defect ${JSON.stringify(defectId)} is missing "expected_severity"`,
        );
      }
      return {
        defect_id: defectId,
        path: d.path,
        line_start: d.line_start,
        line_end: d.line_end,
        expected_severity: d.expected_severity,
      };
    });
  }

  const acceptanceCriteriaRaw = obj.acceptance_criteria;
  let acceptanceCriteria: AcceptanceCriterion[] | undefined;
  if (acceptanceCriteriaRaw !== undefined) {
    if (!Array.isArray(acceptanceCriteriaRaw)) {
      throw new FixtureValidationError(fixtureId, "acceptance_criteria", "must be an array when present");
    }
    const seenCriterionIds = new Set<string>();
    acceptanceCriteria = acceptanceCriteriaRaw.map((raw, idx) => {
      if (typeof raw !== "object" || raw === null) {
        throw new FixtureValidationError(fixtureId, "acceptance_criteria", `entry ${idx} must be an object`);
      }
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== "string" || c.id.length === 0) {
        throw new FixtureValidationError(fixtureId, "acceptance_criteria", `entry ${idx} is missing "id"`);
      }
      if (seenCriterionIds.has(c.id)) {
        throw new FixtureValidationError(
          fixtureId,
          "acceptance_criteria",
          `duplicate acceptance criterion id ${JSON.stringify(c.id)}`,
        );
      }
      seenCriterionIds.add(c.id);
      if (typeof c.statement !== "string" || c.statement.length === 0) {
        throw new FixtureValidationError(
          fixtureId,
          "acceptance_criteria",
          `criterion ${JSON.stringify(c.id)} is missing "statement"`,
        );
      }
      if (c.check_names !== undefined && (!Array.isArray(c.check_names) || c.check_names.some((x) => typeof x !== "string"))) {
        throw new FixtureValidationError(
          fixtureId,
          "acceptance_criteria",
          `criterion ${JSON.stringify(c.id)}'s "check_names" must be a string[] when present`,
        );
      }
      if (c.keywords !== undefined && (!Array.isArray(c.keywords) || c.keywords.some((x) => typeof x !== "string"))) {
        throw new FixtureValidationError(
          fixtureId,
          "acceptance_criteria",
          `criterion ${JSON.stringify(c.id)}'s "keywords" must be a string[] when present`,
        );
      }
      return {
        id: c.id,
        statement: c.statement,
        check_names: c.check_names as string[] | undefined,
        keywords: c.keywords as string[] | undefined,
      };
    });
  }

  const allowedChangePathsRaw = obj.allowed_change_paths;
  let allowedChangePaths: string[] | undefined;
  if (allowedChangePathsRaw !== undefined) {
    if (!Array.isArray(allowedChangePathsRaw) || allowedChangePathsRaw.some((x) => typeof x !== "string")) {
      throw new FixtureValidationError(fixtureId, "allowed_change_paths", "must be a string[] when present");
    }
    allowedChangePaths = allowedChangePathsRaw as string[];
  }

  const graderRefsRaw = obj.grader_refs;
  if (!Array.isArray(graderRefsRaw)) {
    throw new FixtureValidationError(fixtureId, "grader_refs", "required array field is missing");
  }
  const graderRefs: GraderRef[] = graderRefsRaw.map((raw, idx) => {
    if (typeof raw !== "object" || raw === null) {
      throw new FixtureValidationError(fixtureId, "grader_refs", `entry ${idx} must be an object with "grader"/"version"`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.grader !== "string" || r.grader.length === 0 || typeof r.version !== "string" || r.version.length === 0) {
      throw new FixtureValidationError(fixtureId, "grader_refs", `entry ${idx} must name a "grader" and a "version"`);
    }
    const supportedVersions = SUPPORTED_GRADER_VERSIONS[r.grader];
    if (!supportedVersions || !supportedVersions.includes(r.version)) {
      throw new FixtureValidationError(
        fixtureId,
        "grader_refs",
        `grader ${JSON.stringify(r.grader)} version ${JSON.stringify(r.version)} is not supported`,
      );
    }
    return { grader: r.grader, version: r.version };
  });

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
    public_checks: publicChecks,
    hidden_checks: hiddenChecks,
    seeded_defects: seededDefects,
    acceptance_criteria: acceptanceCriteria,
    allowed_change_paths: allowedChangePaths,
    grader_refs: graderRefs,
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
