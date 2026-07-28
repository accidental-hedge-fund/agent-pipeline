// Experiment manifest loading/validation and deterministic matrix expansion
// (openspec/changes/stage-eval-runner).

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import {
  EVAL_STAGE_NAMES,
  SANDBOX_MODES,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  type Cell,
  type EvalMode,
  type ExperimentManifest,
  type Fixture,
  type HarnessCoordinate,
  type NamedTreatment,
  type RunPlan,
  type SandboxMode,
  type Treatment,
  type TreatmentAxes,
} from "./types.ts";
import { ModelEndpointParamsSchema } from "../config.ts";

export class ManifestValidationError extends Error {
  constructor(field: string, detail: string) {
    super(`Manifest: invalid field "${field}" — ${detail}`);
    this.name = "ManifestValidationError";
  }
}

const AXIS_KEYS = ["harness", "provider", "model", "effort", "executor", "params"] as const;

/** Validate a raw parsed manifest object against the known fixture ids.
 *  Throws ManifestValidationError naming the offending field on the first
 *  problem found; no cell is ever produced for an invalid manifest. */
export function validateManifest(raw: unknown, knownFixtureIds: Set<string>): ExperimentManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new ManifestValidationError("(root)", "manifest must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const requireString = (field: string): string => {
    const v = obj[field];
    if (typeof v !== "string" || v.length === 0) {
      throw new ManifestValidationError(field, "required non-empty string field is missing");
    }
    return v;
  };
  const requireNumber = (field: string): number => {
    const v = obj[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ManifestValidationError(field, "required numeric field is missing");
    }
    return v;
  };

  const schemaVersion = requireNumber("schema_version");
  if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(schemaVersion as 1)) {
    throw new ManifestValidationError(
      "schema_version",
      `unsupported schema_version ${schemaVersion} (supported: ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(", ")})`,
    );
  }

  const experimentId = requireString("experiment_id");
  // The id becomes a path segment under output_dir (delta finding 7282029b):
  // separators or ".." would let writes escape <output_dir>/<experiment-id>/.
  if (/[/\\]/.test(experimentId) || experimentId.includes("..")) {
    throw new ManifestValidationError(
      "experiment_id",
      "must be a single path-safe segment (no path separators or '..')",
    );
  }

  const fixtureIds = obj.fixture_ids;
  if (!Array.isArray(fixtureIds) || fixtureIds.length === 0 || fixtureIds.some((f) => typeof f !== "string")) {
    throw new ManifestValidationError("fixture_ids", "required non-empty string[] field is missing or malformed");
  }
  for (const fid of fixtureIds as string[]) {
    if (!knownFixtureIds.has(fid)) {
      throw new ManifestValidationError("fixture_ids", `references unknown fixture "${fid}"`);
    }
  }

  const mode = obj.mode;
  if (typeof mode !== "string" || (mode !== "end-to-end" && mode !== "paired" && !(EVAL_STAGE_NAMES as readonly string[]).includes(mode))) {
    throw new ManifestValidationError(
      "mode",
      `must be "end-to-end", "paired", or one of: ${EVAL_STAGE_NAMES.join(", ")} — got ${JSON.stringify(mode)}`,
    );
  }

  const treatmentsRaw = obj.treatments;
  const namedRaw = obj.named_treatments;
  if (treatmentsRaw !== undefined && namedRaw !== undefined) {
    throw new ManifestValidationError("treatments", "must not be declared together with named_treatments");
  }
  let treatments: TreatmentAxes | undefined;
  let namedTreatments: NamedTreatment[] | undefined;
  if (treatmentsRaw !== undefined) {
    if (typeof treatmentsRaw !== "object" || treatmentsRaw === null || Array.isArray(treatmentsRaw)) {
      throw new ManifestValidationError("treatments", "must be an object when present");
    }
    const treatmentsObj = treatmentsRaw as Record<string, unknown>;
    treatments = {};
    let hasAnyAxis = false;
    for (const key of Object.keys(treatmentsObj)) {
      if (!(AXIS_KEYS as readonly string[]).includes(key)) throw new ManifestValidationError("treatments", `unknown treatment axis "${key}"`);
      const values = treatmentsObj[key];
      if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) throw new ManifestValidationError("treatments", `axis "${key}" must be a non-empty string[]`);
      if (key === "params") for (const raw of values as string[]) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch (err) { throw new ManifestValidationError("treatments", `axis "params" entry ${JSON.stringify(raw)} is not valid JSON: ${(err as Error).message}`); }
        const result = ModelEndpointParamsSchema.safeParse(parsed);
        if (!result.success) {
          const issue = result.error.issues[0];
          throw new ManifestValidationError("treatments", `axis "params" entry ${JSON.stringify(raw)} is invalid: ${issue?.path?.join(".") || "<params>"}: ${issue?.message ?? "invalid value"}`);
        }
      }
      treatments[key as keyof TreatmentAxes] = values as string[];
      hasAnyAxis = true;
    }
    if (!hasAnyAxis) throw new ManifestValidationError("treatments", "at least one treatment axis is required");
  } else if (namedRaw !== undefined) {
    if (!Array.isArray(namedRaw) || namedRaw.length === 0) throw new ManifestValidationError("named_treatments", "must be a non-empty array when present");
    const coordinate = (raw: unknown, field: string): HarnessCoordinate => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ManifestValidationError(field, "must be an object");
      const value = raw as Record<string, unknown>;
      if (Object.keys(value).some((k) => !["harness", "model", "effort"].includes(k))) throw new ManifestValidationError(field, "contains an unknown coordinate field");
      if (typeof value.harness !== "string" || value.harness.length === 0) throw new ManifestValidationError(field, "requires a non-empty harness");
      if (value.model !== undefined && typeof value.model !== "string") throw new ManifestValidationError(field, "model must be a string when present");
      if (value.effort !== undefined && typeof value.effort !== "string") throw new ManifestValidationError(field, "effort must be a string when present");
      return { harness: value.harness, ...(typeof value.model === "string" ? { model: value.model } : {}), ...(typeof value.effort === "string" ? { effort: value.effort } : {}) };
    };
    const seen = new Set<string>();
    namedTreatments = namedRaw.map((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ManifestValidationError(`named_treatments[${index}]`, "must be an object");
      const value = raw as Record<string, unknown>;
      if (Object.keys(value).some((k) => !["id", "primary", "reviewer"].includes(k))) throw new ManifestValidationError(`named_treatments[${index}]`, "contains an unknown field");
      if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.id)) throw new ManifestValidationError(`named_treatments[${index}].id`, "must be a path-safe identifier");
      if (seen.has(value.id)) throw new ManifestValidationError("named_treatments", `duplicates id "${value.id}"`);
      seen.add(value.id);
      const primary = coordinate(value.primary, `named_treatments[${index}].primary`);
      const reviewer = value.reviewer === undefined ? undefined : coordinate(value.reviewer, `named_treatments[${index}].reviewer`);
      if (mode === "paired" && !reviewer) throw new ManifestValidationError(`named_treatments[${index}].reviewer`, "is required for paired mode");
      return { id: value.id, primary, ...(reviewer ? { reviewer } : {}) };
    });
  } else {
    throw new ManifestValidationError("treatments", "either treatments or named_treatments is required");
  }
  if (mode === "paired" && !namedTreatments) throw new ManifestValidationError("named_treatments", "is required for paired mode");

  const replicates = requireNumber("replicates");
  if (!Number.isInteger(replicates) || replicates < 1) {
    throw new ManifestValidationError("replicates", "must be a positive integer");
  }
  const seed = requireNumber("seed");
  const concurrency = requireNumber("concurrency");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ManifestValidationError("concurrency", "must be a positive integer");
  }
  const timeout = requireNumber("timeout");
  if (timeout <= 0) {
    throw new ManifestValidationError("timeout", "must be a positive number of seconds");
  }
  const outputDir = requireString("output_dir");

  // Execution sandbox mode (#607 — eval-agent-isolation-boundary): optional,
  // defaulting to "managed" so an existing manifest that omits the field
  // stays valid and unchanged in behavior. An unsupported value is rejected
  // naming the field, before any treatment executes.
  let sandboxMode: SandboxMode = "managed";
  if (obj.sandbox_mode !== undefined) {
    if (typeof obj.sandbox_mode !== "string" || !(SANDBOX_MODES as readonly string[]).includes(obj.sandbox_mode)) {
      throw new ManifestValidationError(
        "sandbox_mode",
        `must be one of: ${SANDBOX_MODES.join(", ")} — got ${JSON.stringify(obj.sandbox_mode)}`,
      );
    }
    sandboxMode = obj.sandbox_mode as SandboxMode;
  }

  return {
    schema_version: schemaVersion,
    experiment_id: experimentId,
    fixture_ids: fixtureIds as string[],
    mode: mode as EvalMode,
    ...(treatments ? { treatments } : {}),
    ...(namedTreatments ? { named_treatments: namedTreatments } : {}),
    replicates,
    seed,
    concurrency,
    timeout,
    output_dir: outputDir,
    sandbox_mode: sandboxMode,
  };
}

export interface LoadManifestDeps {
  readFile?: (path: string) => string;
}

export function loadManifest(
  sourcePath: string,
  knownFixtureIds: Set<string>,
  deps: LoadManifestDeps = {},
): ExperimentManifest {
  const readFileFn = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const text = readFileFn(sourcePath);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ManifestValidationError("(root)", `${sourcePath} is not valid JSON: ${(err as Error).message}`);
  }
  return validateManifest(raw, knownFixtureIds);
}

/** Deterministic slug over the treatment axes, stable regardless of key order
 *  in the manifest — always emitted in AXIS_KEYS order. `params` is a parsed
 *  object rather than a string, so it is stringified deterministically
 *  (sorted keys) rather than relying on default object-to-string coercion. */
export function treatmentId(treatment: Treatment): string {
  if (treatment.id) return treatment.id;
  return AXIS_KEYS
    .filter((k) => treatment[k] !== undefined)
    .map((k) => `${k}=${k === "params" ? stableStringify(treatment.params) : treatment[k]}`)
    .join(",");
}

function cartesianTreatments(axes: TreatmentAxes): Treatment[] {
  const presentAxes = AXIS_KEYS.filter((k) => axes[k] !== undefined);
  let combos: Treatment[] = [{}];
  for (const axis of presentAxes) {
    const values = axes[axis]!;
    const next: Treatment[] = [];
    for (const combo of combos) {
      for (const value of values) {
        // The "params" axis carries JSON-encoded ModelEndpointParams strings
        // (already validated in validateManifest) — every other axis is the
        // raw treatment value itself.
        const resolvedValue: unknown = axis === "params" ? JSON.parse(value) : value;
        next.push({ ...combo, [axis]: resolvedValue });
      }
    }
    combos = next;
  }
  return combos;
}

/** Pure expansion of a manifest + its referenced fixtures into an explicit run
 *  plan. Deterministic: fixtures in manifest order, treatments in Cartesian
 *  axis order, replicates 1..N — the same manifest and fixtures always
 *  produce the same plan (design.md decision 1/2). */
export function expandPlan(manifest: ExperimentManifest, fixtures: Map<string, Fixture>): RunPlan {
  const cells: Cell[] = [];
  const treatments = manifest.named_treatments
    ? manifest.named_treatments.map((t) => manifest.mode === "paired"
      ? ({ id: t.id, primary: t.primary, ...(t.reviewer ? { reviewer: t.reviewer } : {}) })
      : ({ id: t.id, harness: t.primary.harness, ...(t.primary.model ? { model: t.primary.model } : {}), ...(t.primary.effort ? { effort: t.primary.effort } : {}) }))
    : cartesianTreatments(manifest.treatments!);
  for (const fixtureId of manifest.fixture_ids) {
    const fixture = fixtures.get(fixtureId);
    if (!fixture) {
      throw new ManifestValidationError("fixture_ids", `references unknown fixture "${fixtureId}"`);
    }
    for (const treatment of treatments) {
      const tid = treatmentId(treatment);
      for (let replicate = 1; replicate <= manifest.replicates; replicate++) {
        cells.push({
          cell_id: `${manifest.experiment_id}/${fixtureId}/${tid}/${replicate}`,
          experiment_id: manifest.experiment_id,
          fixture_id: fixtureId,
          treatment_id: tid,
          treatment,
          replicate,
          mode: manifest.mode,
          base_sha: fixture.base_commit,
        });
      }
    }
  }
  return {
    schema_version: manifest.schema_version,
    experiment_id: manifest.experiment_id,
    seed: manifest.seed,
    cells,
  };
}

/** Deterministic JSON stringification, stable regardless of object key order —
 *  shared by hash derivations across the eval layer (manifest config_hash,
 *  fixture env_surface_hash) so identical inputs always hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash of the materialized prompt text actually sent for a cell — not the
 *  template file — so a prompt-template edit shows up as a hash difference. */
export function computePromptHash(materializedPrompt: string): string {
  return createHash("sha256").update(materializedPrompt).digest("hex");
}

/** Hash of the effective, resolved per-cell config — not the config file —
 *  so a config-default change shows up as a hash difference. */
export function computeConfigHash(effectiveConfig: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(effectiveConfig)).digest("hex");
}
