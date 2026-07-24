// Fixture loading/validation (openspec/changes/stage-eval-runner — eval-fixture-contract).
//
// Types are stripped at runtime (no tsc step), so every invariant here is a
// real runtime check, not a compile-time one.

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import {
  ENVIRONMENT_DEPENDENCY_MODES,
  EVAL_STAGE_NAMES,
  SUPPORTED_FIXTURE_SCHEMA_VERSIONS,
  SUPPORTED_GRADER_VERSIONS,
  type AcceptanceCriterion,
  type CapabilitySurfaceInventory,
  type EnvironmentDependency,
  type EvalStageName,
  type Fixture,
  type GraderRef,
  type SeededDefect,
} from "./types.ts";
import { stableStringify } from "./manifest.ts";

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

  const environmentRaw = obj.environment;
  let environment: EnvironmentDependency[] | undefined;
  if (environmentRaw !== undefined) {
    if (!Array.isArray(environmentRaw)) {
      throw new FixtureValidationError(fixtureId, "environment", "must be an array when present");
    }
    environment = environmentRaw.map((raw, idx) => validateEnvironmentDependency(fixtureId, raw, idx));
  }

  const capabilitySurfaceRaw = obj.capability_surface;
  let capabilitySurface: CapabilitySurfaceInventory | undefined;
  if (capabilitySurfaceRaw !== undefined) {
    capabilitySurface = validateCapabilitySurface(fixtureId, capabilitySurfaceRaw);
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
    environment,
    capability_surface: capabilitySurface,
    env_surface_hash: computeEnvSurfaceHash(environment, capabilitySurface),
  };
}

/** Validate one `environment` dependency entry, rejecting an unknown `mode`
 *  or a missing required field by name (eval-fixture-contract #535) —
 *  mirroring the existing seeded-defect/acceptance-criterion rejection style. */
function validateEnvironmentDependency(fixtureId: string, raw: unknown, idx: number): EnvironmentDependency {
  if (typeof raw !== "object" || raw === null) {
    throw new FixtureValidationError(fixtureId, "environment", `entry ${idx} must be an object`);
  }
  const d = raw as Record<string, unknown>;
  const name = d.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new FixtureValidationError(fixtureId, "environment", `entry ${idx} is missing "name"`);
  }
  const fail = (field: string, detail: string): never => {
    throw new FixtureValidationError(fixtureId, "environment", `dependency ${JSON.stringify(name)} ${detail} (field "${field}")`);
  };
  const mode = d.mode;
  if (typeof mode !== "string" || !(ENVIRONMENT_DEPENDENCY_MODES as readonly string[]).includes(mode)) {
    fail("mode", `has an unknown mode ${JSON.stringify(mode)} (expected one of: ${ENVIRONMENT_DEPENDENCY_MODES.join(", ")})`);
  }
  if (typeof d.version !== "string" || d.version.length === 0) {
    fail("version", 'is missing a required non-empty "version"');
  }
  if (!Array.isArray(d.required_permissions) || d.required_permissions.some((p) => typeof p !== "string")) {
    fail("required_permissions", 'is missing a required string[] "required_permissions"');
  }
  if (!("initial_state" in d)) {
    fail("initial_state", 'is missing a required "initial_state"');
  }
  if (typeof d.expected !== "object" || d.expected === null || Array.isArray(d.expected)) {
    fail("expected", 'is missing a required "expected" object');
  }
  if (typeof d.setup !== "string" || d.setup.length === 0) {
    fail("setup", 'is missing a required non-empty "setup"');
  }
  if (typeof d.teardown !== "string" || d.teardown.length === 0) {
    fail("teardown", 'is missing a required non-empty "teardown"');
  }
  return {
    name,
    mode: mode as EnvironmentDependency["mode"],
    version: d.version as string,
    required_permissions: d.required_permissions as string[],
    initial_state: d.initial_state,
    expected: d.expected as { outputs?: unknown; errors?: unknown },
    setup: d.setup as string,
    teardown: d.teardown as string,
  };
}

/** Validate an (optional) resolved capability-surface snapshot embedded on a
 *  harvested fixture (eval-fixture-harvest #535). */
function validateCapabilitySurface(fixtureId: string, raw: unknown): CapabilitySurfaceInventory {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FixtureValidationError(fixtureId, "capability_surface", "must be an object when present");
  }
  const s = raw as Record<string, unknown>;
  const requireStringArrayField = (field: string): string[] => {
    const v = s[field];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new FixtureValidationError(fixtureId, "capability_surface", `is missing a required string[] "${field}"`);
    }
    return v;
  };
  if (typeof s.stage !== "string" || s.stage.length === 0) {
    throw new FixtureValidationError(fixtureId, "capability_surface", 'is missing a required non-empty "stage"');
  }
  const materializedPrompts = requireStringArrayField("materialized_prompts");
  if (typeof s.harness_config !== "object" || s.harness_config === null || Array.isArray(s.harness_config)) {
    throw new FixtureValidationError(fixtureId, "capability_surface", 'is missing a required object "harness_config"');
  }
  const toolsHooks = requireStringArrayField("tools_hooks");
  const repoPaths = requireStringArrayField("repo_paths");
  const servicesData = requireStringArrayField("services_data");
  return {
    stage: s.stage,
    materialized_prompts: materializedPrompts,
    harness_config: s.harness_config as Record<string, unknown>,
    tools_hooks: toolsHooks,
    repo_paths: repoPaths,
    services_data: servicesData,
  };
}

/** Provenance hash over the resolved environment-fidelity contract plus the
 *  resolved capability-surface inventory (eval-fixture-contract #535).
 *  Identical inputs (including "both absent") hash identically; a single
 *  dependency-mode or surface difference changes the hash. */
export function computeEnvSurfaceHash(
  environment: EnvironmentDependency[] | undefined,
  capabilitySurface: CapabilitySurfaceInventory | undefined,
): string {
  const basis = stableStringify({ environment: environment ?? [], capability_surface: capabilitySurface ?? null });
  return createHash("sha256").update(basis).digest("hex");
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
