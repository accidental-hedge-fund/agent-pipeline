// Internal representative-pack loader and proof projector for durable hybrid
// v2 (required-live vs closed Layer A-allowed). Historical hybrid v1 remains
// a decoder for v1.33.0 evidence only. The deployment runner owns live I/O.
// This module accepts only closed, candidate-bound records from that runner.
// It has no CLI that accepts caller-authored pass receipts, scenario status,
// or metrics.

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const FRG_PACK_ASSET_SCHEMA_VERSION = 1;
export const FRG_PACK_BUNDLE_SCHEMA_VERSION = 1;
export const FRG_PACK_PROVENANCE_SCHEMA_VERSION = 1;
/** Current pack policy. Not pinned to one SemVer. */
export const FRG_HYBRID_V2_POLICY_ID = "factory-gate-v1-hybrid-v2";
/** Historical 1.33.0 hybrid v1 identity. Readable for that version only. */
export const FRG_HYBRID_PILOT_POLICY_ID = "factory-gate-v1-hybrid-v1";
export const FRG_HYBRID_PILOT_VERSION = "1.33.0";
export const FRG_HYBRID_REPLACEMENT_ISSUE = 908;
/**
 * Frozen sha256 of `factory-gate-v1/manifest.json` under hybrid v1
 * (pre-#1036 `pilot_policy` id/release pin). Decode v1.33.0 evidence only.
 */
export const FRG_HYBRID_V1_MANIFEST_SHA256 =
  "d1fc4bfb4852a600875693e666ffbede65314dda045846d1513fb13da03f9b6a";
/**
 * sha256 of the current `factory-gate-v1/manifest.json` (hybrid v2).
 * Drift-guarded against `loadFrgPack().manifest_sha256`.
 */
export const FRG_HYBRID_V2_MANIFEST_SHA256 =
  "27f65953f20032c7b8d6d86ae1e69e26f951e6f5fed25e499a9a8f51463f2e2e";
/**
 * Frozen historical hybrid-v1 Layer A probe ids.
 * Decode `factory-gate-v1-hybrid-v1` / 1.33.0 evidence only.
 * Do not alias this to the current v2 list — a later v2 matrix change
 * must not rewrite validation of immutable v1.33.0 evidence.
 */
export const FRG_HYBRID_V1_LAYER_A_PROBE_IDS = [
  "capacity-blocked-retain",
  "restart-hydration",
  "openspec-multi-change",
  "managed-worktree-dirt",
  "local-docs-parity",
  "forge-http-5xx-backoff",
  "ci-pending-red-recovery",
  "fix-rereview-cycle",
  "same-head-noop-reentry",
  "pr-supersession",
  "release-plan-row",
  "release-tag-guard",
  "recovery-controller-one-item-route",
  "recovery-controller-one-item-action",
  "recovery-controller-multi-item",
] as const;
/**
 * Current durable hybrid-v2 Layer A probe ids.
 * Independently versioned from {@link FRG_HYBRID_V1_LAYER_A_PROBE_IDS}.
 */
export const FRG_HYBRID_LAYER_A_PROBE_IDS = [
  "capacity-blocked-retain",
  "restart-hydration",
  "openspec-multi-change",
  "managed-worktree-dirt",
  "local-docs-parity",
  "forge-http-5xx-backoff",
  "ci-pending-red-recovery",
  "fix-rereview-cycle",
  "same-head-noop-reentry",
  "pr-supersession",
  "release-plan-row",
  "release-tag-guard",
  "recovery-controller-one-item-route",
  "recovery-controller-one-item-action",
  "recovery-controller-multi-item",
] as const;
export const FRG_HYBRID_LIVE_SCENARIO_IDS = [
  "clean-item-throughput",
  "blocker-taxonomy",
  "empty-depends-on-stack-honesty",
] as const;
export const FRG_HYBRID_LIVE_COMPOSITION_IDS = ["openspec-bearing-item"] as const;

export function isFrgHybridV2PolicyId(id: string): boolean {
  return id === FRG_HYBRID_V2_POLICY_ID;
}

export function isFrgHybridV1PolicyId(id: string): boolean {
  return id === FRG_HYBRID_PILOT_POLICY_ID;
}

/** Expected pack-manifest SHA for a known hybrid policy. Undefined if unknown. */
export function expectedHybridManifestSha256(policyId: string): string | undefined {
  if (isFrgHybridV1PolicyId(policyId)) return FRG_HYBRID_V1_MANIFEST_SHA256;
  if (isFrgHybridV2PolicyId(policyId)) return FRG_HYBRID_V2_MANIFEST_SHA256;
  return undefined;
}

/**
 * Closed Layer A probe matrix for a known hybrid policy.
 * Historical v1 uses the frozen v1 list; current v2 uses the current list.
 */
export function expectedHybridLayerAProbeIds(
  policyId: string,
): readonly string[] | undefined {
  if (isFrgHybridV1PolicyId(policyId)) return FRG_HYBRID_V1_LAYER_A_PROBE_IDS;
  if (isFrgHybridV2PolicyId(policyId)) return FRG_HYBRID_LAYER_A_PROBE_IDS;
  return undefined;
}

/** True when `version` is strictly after the 1.33.0 hybrid-v1 pin. */
export function isPostHybridPilotVersion(version: string | undefined): boolean {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [maj, min, pat] = version.split(".").map(Number);
  const [pMaj, pMin, pPat] = FRG_HYBRID_PILOT_VERSION.split(".").map(Number);
  if (maj !== pMaj) return (maj ?? 0) > (pMaj ?? 0);
  if (min !== pMin) return (min ?? 0) > (pMin ?? 0);
  return (pat ?? 0) > (pPat ?? 0);
}

/**
 * Hybrid pack_provenance is required for 1.33.0 (historical v1 or current v2)
 * and for every later release (durable hybrid v2). Pre-1.33.0 evidence may omit it.
 */
export function hybridProvenanceRequired(version: string | undefined): boolean {
  return version === FRG_HYBRID_PILOT_VERSION || isPostHybridPilotVersion(version);
}

export function isFrgRequiredLiveScenarioId(id: string): boolean {
  return (FRG_HYBRID_LIVE_SCENARIO_IDS as readonly string[]).includes(id);
}

export function isFrgRequiredLiveCompositionId(id: string): boolean {
  return (FRG_HYBRID_LIVE_COMPOSITION_IDS as readonly string[]).includes(id);
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TEST_FILE_RE = /^core\/test\/[A-Za-z0-9._-]+\.test\.ts$/;

export type FrgPackProofSource = "live" | "ledger" | "derived" | "layer_a";

export interface FrgPackTemplateManifest {
  id: string;
  title: string;
  file: string;
  sha256: string;
  clean_path: boolean;
}

export interface FrgPackAssetRef {
  id: string;
  file: string;
  sha256: string;
}

export interface FrgPackOutputTarget {
  id: string;
  observed?: number;
  threshold?: number;
}

export interface FrgPackProbeManifest {
  id: string;
  test_file: string;
  test_name: string;
  scenario_outputs: FrgPackOutputTarget[];
  composition_outputs: FrgPackOutputTarget[];
}

export interface FrgPackPilotPolicy {
  id: string;
  /** Historical hybrid v1 only. Durable hybrid v2 must not pin a SemVer. */
  release_version?: string;
  /** Historical hybrid v1 only (#908). Absent on durable hybrid v2. */
  replacement_issue?: number;
  live_scenario_ids: string[];
  live_composition_ids: string[];
  layer_a_probes: FrgPackProbeManifest[];
}

export interface FrgPackManifest {
  schema_version: number;
  pack_id: string;
  manifest_version: number;
  selector: { type: "label"; value: string };
  issue_labels: string[];
  minimum_fresh_issues: number;
  required_scenario_ids: string[];
  auto_scored_scenario_ids: string[];
  required_composition_ids: string[];
  pilot_policy: FrgPackPilotPolicy;
  templates: FrgPackTemplateManifest[];
  fault_recipes: FrgPackAssetRef[];
}

export interface FrgPackFaultRecipe {
  schema_version: number;
  recipe_id: string;
  summary: string;
  steps: Array<{ id: string; action: string }>;
  scenario_outputs: FrgPackOutputTarget[];
  composition_outputs: FrgPackOutputTarget[];
}

export interface LoadedFrgPack {
  root_dir: string;
  manifest: FrgPackManifest;
  manifest_sha256: string;
  template_bodies: ReadonlyMap<string, string>;
  recipes: ReadonlyMap<string, FrgPackFaultRecipe>;
}

export interface FrgPackReadDeps {
  readFile(filePath: string): Promise<string>;
}

const defaultReadDeps: FrgPackReadDeps = {
  readFile: (filePath) => fsp.readFile(filePath, "utf8"),
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "an" : "a non-empty"} string array`);
  }
  return value.map((entry, index) => stringValue(entry, `${field}[${index}]`));
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} contains duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function checkedSha(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!SHA256_RE.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return result;
}

function checkedGitSha(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!GIT_SHA_RE.test(result)) throw new Error(`${field} must be a full lowercase git object id`);
  return result;
}

function checkedId(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!SAFE_ID_RE.test(result) || result.includes("..")) throw new Error(`${field} must be a safe identifier`);
  return result;
}

function timestamp(value: unknown, field: string): string {
  const raw = stringValue(value, field);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO-8601 timestamp`);
  return new Date(ms).toISOString();
}

function checkedRelativePath(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (path.isAbsolute(result) || result.includes("\\")) {
    throw new Error(`${field} must be a portable relative path`);
  }
  const normalized = path.posix.normalize(result);
  if (normalized === ".." || normalized.startsWith("../") || normalized !== result) {
    throw new Error(`${field} must not escape the pack root`);
  }
  return result;
}

function parseJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${field} is not valid JSON: ${(error as Error).message}`);
  }
}

function parseAssetRef(raw: unknown, field: string): FrgPackAssetRef {
  const value = record(raw, field);
  return {
    id: checkedId(value.id, `${field}.id`),
    file: checkedRelativePath(value.file, `${field}.file`),
    sha256: checkedSha(value.sha256, `${field}.sha256`),
  };
}

function parseOutputTarget(
  raw: unknown,
  field: string,
  allowed: ReadonlySet<string>,
): FrgPackOutputTarget {
  const value = record(raw, field);
  const id = stringValue(value.id, `${field}.id`);
  if (!allowed.has(id)) throw new Error(`${field}.id ${JSON.stringify(id)} is not required`);
  const observed = value.observed === undefined
    ? undefined
    : finiteNonNegative(value.observed, `${field}.observed`);
  const threshold = value.threshold === undefined
    ? undefined
    : finiteNonNegative(value.threshold, `${field}.threshold`);
  if (threshold !== undefined && observed === undefined) {
    throw new Error(`${field}.threshold requires observed`);
  }
  return { id, observed, threshold };
}

function parseProbe(
  raw: unknown,
  index: number,
  scenarioIds: ReadonlySet<string>,
  compositionIds: ReadonlySet<string>,
): FrgPackProbeManifest {
  const field = `FRG pack manifest.pilot_policy.layer_a_probes[${index}]`;
  const value = record(raw, field);
  const testFile = checkedRelativePath(value.test_file, `${field}.test_file`);
  if (!TEST_FILE_RE.test(testFile)) {
    throw new Error(`${field}.test_file must name one core/test/*.test.ts file`);
  }
  if (!Array.isArray(value.scenario_outputs) || !Array.isArray(value.composition_outputs)) {
    throw new Error(`${field} outputs must be arrays`);
  }
  const scenarioOutputs = value.scenario_outputs.map((entry, outputIndex) =>
    parseOutputTarget(entry, `${field}.scenario_outputs[${outputIndex}]`, scenarioIds),
  );
  const compositionOutputs = value.composition_outputs.map((entry, outputIndex) =>
    parseOutputTarget(entry, `${field}.composition_outputs[${outputIndex}]`, compositionIds),
  );
  if (scenarioOutputs.length === 0 && compositionOutputs.length === 0) {
    throw new Error(`${field} must map at least one outcome`);
  }
  unique(scenarioOutputs.map((output) => output.id), `${field}.scenario_outputs`);
  unique(compositionOutputs.map((output) => output.id), `${field}.composition_outputs`);
  return {
    id: checkedId(value.id, `${field}.id`),
    test_file: testFile,
    test_name: stringValue(value.test_name, `${field}.test_name`),
    scenario_outputs: scenarioOutputs,
    composition_outputs: compositionOutputs,
  };
}

function parseManifest(raw: unknown): FrgPackManifest {
  const value = record(raw, "FRG pack manifest");
  if (value.schema_version !== FRG_PACK_ASSET_SCHEMA_VERSION || value.manifest_version !== 1) {
    throw new Error("FRG pack manifest schema_version and manifest_version must both be 1");
  }
  const selectorValue = record(value.selector, "FRG pack manifest.selector");
  if (selectorValue.type !== "label") throw new Error('FRG pack selector.type must be "label"');
  const selector = {
    type: "label" as const,
    value: stringValue(selectorValue.value, "FRG pack manifest.selector.value"),
  };
  const labels = stringArray(value.issue_labels, "FRG pack manifest.issue_labels");
  unique(labels, "FRG pack manifest.issue_labels");
  if (!labels.includes(selector.value)) throw new Error("FRG pack labels must include its selector label");
  const requiredScenarios = stringArray(value.required_scenario_ids, "FRG pack manifest.required_scenario_ids");
  const autoScenarios = stringArray(value.auto_scored_scenario_ids, "FRG pack manifest.auto_scored_scenario_ids");
  const requiredComposition = stringArray(value.required_composition_ids, "FRG pack manifest.required_composition_ids");
  unique(requiredScenarios, "FRG pack manifest.required_scenario_ids");
  unique(autoScenarios, "FRG pack manifest.auto_scored_scenario_ids");
  unique(requiredComposition, "FRG pack manifest.required_composition_ids");
  for (const id of autoScenarios) {
    if (!requiredScenarios.includes(id)) throw new Error(`auto-scored scenario ${id} is not required`);
  }

  const pilotRaw = record(value.pilot_policy, "FRG pack manifest.pilot_policy");
  if (pilotRaw.id !== FRG_HYBRID_V2_POLICY_ID) {
    throw new Error(
      `factory-gate-v1 current pack must declare ${FRG_HYBRID_V2_POLICY_ID} ` +
        `(historical ${FRG_HYBRID_PILOT_POLICY_ID} is not the current pack policy)`,
    );
  }
  if (pilotRaw.release_version !== undefined || pilotRaw.replacement_issue !== undefined) {
    throw new Error(
      "durable hybrid v2 must not pin release_version or replacement_issue",
    );
  }
  const liveScenarios = stringArray(
    pilotRaw.live_scenario_ids,
    "FRG pack manifest.pilot_policy.live_scenario_ids",
  );
  const liveComposition = stringArray(
    pilotRaw.live_composition_ids,
    "FRG pack manifest.pilot_policy.live_composition_ids",
  );
  unique(liveScenarios, "FRG pack manifest.pilot_policy.live_scenario_ids");
  unique(liveComposition, "FRG pack manifest.pilot_policy.live_composition_ids");
  for (const id of liveScenarios) {
    if (!requiredScenarios.includes(id)) throw new Error(`live scenario ${id} is not required`);
  }
  for (const id of liveComposition) {
    if (!requiredComposition.includes(id)) throw new Error(`live composition ${id} is not required`);
  }
  if (!Array.isArray(pilotRaw.layer_a_probes) || pilotRaw.layer_a_probes.length === 0) {
    throw new Error("FRG pack hybrid policy must define Layer A probes");
  }
  const layerAProbes = pilotRaw.layer_a_probes.map((entry, index) =>
    parseProbe(entry, index, new Set(requiredScenarios), new Set(requiredComposition)),
  );
  unique(layerAProbes.map((probe) => probe.id), "FRG pack probe ids");
  unique(
    layerAProbes.map((probe) => `${probe.test_file}\0${probe.test_name}`),
    "FRG pack exact probe tests",
  );
  const layerAScenarios = new Set(layerAProbes.flatMap((probe) => probe.scenario_outputs.map((output) => output.id)));
  const layerAComposition = new Set(layerAProbes.flatMap((probe) => probe.composition_outputs.map((output) => output.id)));
  for (const id of liveScenarios) {
    if (layerAScenarios.has(id)) throw new Error(`live scenario ${id} cannot also be Layer A`);
  }
  for (const id of liveComposition) {
    if (layerAComposition.has(id)) throw new Error(`live composition ${id} cannot also be Layer A`);
  }
  for (const id of requiredScenarios) {
    if (!liveScenarios.includes(id) && !layerAScenarios.has(id)) {
      throw new Error(`required scenario ${id} has no hybrid proof owner`);
    }
  }
  for (const id of requiredComposition) {
    if (!liveComposition.includes(id) && !layerAComposition.has(id)) {
      throw new Error(`required composition ${id} has no hybrid proof owner`);
    }
  }

  if (!Array.isArray(value.templates) || value.templates.length === 0) {
    throw new Error("FRG pack manifest.templates must be a non-empty array");
  }
  const templates = value.templates.map((entry, index): FrgPackTemplateManifest => {
    const field = `FRG pack manifest.templates[${index}]`;
    const item = record(entry, field);
    if (typeof item.clean_path !== "boolean") throw new Error(`${field}.clean_path must be boolean`);
    return {
      ...parseAssetRef(item, field),
      title: stringValue(item.title, `${field}.title`),
      clean_path: item.clean_path,
    };
  });
  if (!Array.isArray(value.fault_recipes) || value.fault_recipes.length === 0) {
    throw new Error("FRG pack manifest.fault_recipes must be a non-empty array");
  }
  const recipes = value.fault_recipes.map((entry, index) =>
    parseAssetRef(entry, `FRG pack manifest.fault_recipes[${index}]`),
  );
  unique(templates.map((item) => item.id), "FRG pack template ids");
  unique(recipes.map((item) => item.id), "FRG pack recipe ids");
  const minimumFreshIssues = positiveInteger(value.minimum_fresh_issues, "FRG pack manifest.minimum_fresh_issues");
  if (minimumFreshIssues < 2 || templates.length !== minimumFreshIssues) {
    throw new Error("factory-gate-v1 must define exactly its minimum fresh issue count");
  }
  if (!templates.every((template) => template.clean_path)) {
    throw new Error("every v1 pilot template must be a clean-path item");
  }
  return {
    schema_version: 1,
    pack_id: checkedId(value.pack_id, "FRG pack manifest.pack_id"),
    manifest_version: 1,
    selector,
    issue_labels: labels,
    minimum_fresh_issues: minimumFreshIssues,
    required_scenario_ids: requiredScenarios,
    auto_scored_scenario_ids: autoScenarios,
    required_composition_ids: requiredComposition,
    pilot_policy: {
      id: FRG_HYBRID_V2_POLICY_ID,
      live_scenario_ids: liveScenarios,
      live_composition_ids: liveComposition,
      layer_a_probes: layerAProbes,
    },
    templates,
    fault_recipes: recipes,
  };
}

function parseRecipe(raw: unknown, ref: FrgPackAssetRef, manifest: FrgPackManifest): FrgPackFaultRecipe {
  const field = `FRG recipe ${ref.id}`;
  const value = record(raw, field);
  if (value.schema_version !== 1 || value.recipe_id !== ref.id) {
    throw new Error(`${field} identity or schema does not match the manifest`);
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) throw new Error(`${field}.steps must be non-empty`);
  const steps = value.steps.map((entry, index) => {
    const step = record(entry, `${field}.steps[${index}]`);
    return {
      id: checkedId(step.id, `${field}.steps[${index}].id`),
      action: stringValue(step.action, `${field}.steps[${index}].action`),
    };
  });
  unique(steps.map((step) => step.id), `${field} step ids`);
  if (!Array.isArray(value.scenario_outputs) || !Array.isArray(value.composition_outputs)) {
    throw new Error(`${field} outputs must be arrays`);
  }
  const scenarioOutputs = value.scenario_outputs.map((entry, index) => {
    const output = record(entry, `${field}.scenario_outputs[${index}]`);
    return parseOutputTarget({ id: output.id }, `${field}.scenario_outputs[${index}]`, new Set(manifest.required_scenario_ids));
  });
  const compositionOutputs = value.composition_outputs.map((entry, index) => {
    const output = record(entry, `${field}.composition_outputs[${index}]`);
    return parseOutputTarget({ id: output.id }, `${field}.composition_outputs[${index}]`, new Set(manifest.required_composition_ids));
  });
  return {
    schema_version: 1,
    recipe_id: ref.id,
    summary: stringValue(value.summary, `${field}.summary`),
    steps,
    scenario_outputs: scenarioOutputs,
    composition_outputs: compositionOutputs,
  };
}

export function defaultFrgPackRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "frg-packs", "factory-gate-v1");
}

export async function loadFrgPack(
  rootDir = defaultFrgPackRoot(),
  deps: FrgPackReadDeps = defaultReadDeps,
): Promise<LoadedFrgPack> {
  const manifestText = await deps.readFile(path.join(rootDir, "manifest.json"));
  const manifest = parseManifest(parseJson(manifestText, "FRG pack manifest"));
  const templateBodies = new Map<string, string>();
  for (const template of manifest.templates) {
    const body = await deps.readFile(path.join(rootDir, template.file));
    if (sha256(body) !== template.sha256) throw new Error(`FRG template ${template.id} hash does not match manifest`);
    for (const placeholder of [
      "pack_id", "manifest_version", "manifest_sha256", "release_version",
      "pack_run_id", "template_id", "template_sha256",
    ]) {
      if (!body.includes(`{{${placeholder}}}`)) throw new Error(`FRG template ${template.id} is missing {{${placeholder}}}`);
    }
    templateBodies.set(template.id, body);
  }
  const recipes = new Map<string, FrgPackFaultRecipe>();
  for (const ref of manifest.fault_recipes) {
    const text = await deps.readFile(path.join(rootDir, ref.file));
    if (sha256(text) !== ref.sha256) throw new Error(`FRG recipe ${ref.id} hash does not match manifest`);
    recipes.set(ref.id, parseRecipe(parseJson(text, `FRG recipe ${ref.id}`), ref, manifest));
  }
  return {
    root_dir: rootDir,
    manifest,
    manifest_sha256: sha256(manifestText),
    template_bodies: templateBodies,
    recipes,
  };
}

function checkedReleaseVersion(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!SEMVER_RE.test(result)) throw new Error(`${field} must be X.Y.Z without a leading v`);
  return result;
}

function replaceTemplate(source: string, values: Readonly<Record<string, string>>, field: string): string {
  let result = source;
  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`{{${key}}}`, value);
  const unresolved = result.match(/{{[a-z0-9_]+}}/i);
  if (unresolved) throw new Error(`${field} has unresolved placeholder ${unresolved[0]}`);
  return result;
}

export interface RenderedFrgIssue {
  title: string;
  body: string;
  labels: string[];
  provenance: {
    pack_id: string;
    manifest_version: number;
    manifest_sha256: string;
    release_version: string;
    pack_run_id: string;
    template_id: string;
    template_sha256: string;
  };
}

export function renderFrgPackIssues(
  pack: LoadedFrgPack,
  input: { release_version: string; pack_run_id: string },
): RenderedFrgIssue[] {
  const releaseVersion = checkedReleaseVersion(input.release_version, "release_version");
  const packRunId = checkedId(input.pack_run_id, "pack_run_id");
  return pack.manifest.templates.map((template) => {
    const values = {
      pack_id: pack.manifest.pack_id,
      manifest_version: String(pack.manifest.manifest_version),
      manifest_sha256: pack.manifest_sha256,
      release_version: releaseVersion,
      pack_run_id: packRunId,
      template_id: template.id,
      template_sha256: template.sha256,
    };
    return {
      title: replaceTemplate(template.title, values, `FRG template ${template.id} title`),
      body: replaceTemplate(pack.template_bodies.get(template.id)!, values, `FRG template ${template.id} body`),
      labels: [...pack.manifest.issue_labels],
      provenance: {
        pack_id: pack.manifest.pack_id,
        manifest_version: pack.manifest.manifest_version,
        manifest_sha256: pack.manifest_sha256,
        release_version: releaseVersion,
        pack_run_id: packRunId,
        template_id: template.id,
        template_sha256: template.sha256,
      },
    };
  });
}

export interface VerifiedFrgPackRun {
  schema_version: 1;
  policy_id: string;
  pack_id: string;
  manifest_version: number;
  manifest_sha256: string;
  release_version: string;
  candidate_git_sha: string;
  pack_run_id: string;
  loop_run_id: string;
  repository: string;
  base_branch: string;
  started_at: string;
  contract: {
    artifact_sha256: string;
    selector: { type: "label"; value: string };
    issue_numbers: number[];
    items: Array<{ issue_number: number; depends_on: number[] }>;
  };
  ledger: {
    artifact_sha256: string;
    items: Array<{
      issue_number: number;
      state: string;
      advance_run_id: string;
      blocked_theme: string | null;
    }>;
  };
  events: { artifact_sha256: string; event_ids: string[]; issue_numbers: number[] };
  action_evidence: { artifact_sha256: string; action_ids: string[]; issue_numbers: number[] };
  issues: Array<{
    issue_number: number;
    issue_node_id: string;
    created_at: string;
    title: string;
    body: string;
    labels: string[];
    template_id: string;
    template_sha256: string;
    pr: {
      number: number;
      node_id: string;
      head_sha: string;
      base_branch: string;
      files: string[];
      checks: Array<{ id: string; name: string; head_sha: string; conclusion: string }>;
    };
  }>;
  probes: Array<{
    id: string;
    candidate_git_sha: string;
    test_file: string;
    test_name: string;
    command_argv_sha256: string;
    stdout_sha256: string;
    stderr_sha256: string;
    started_at: string;
    finished_at: string;
  }>;
}

export interface FrgPackProvenance {
  schema_version: 1;
  policy_id: string;
  /** Present on historical hybrid v1 evidence only. */
  replacement_issue?: number;
  pack_id: string;
  manifest_version: number;
  manifest_sha256: string;
  release_version: string;
  candidate_git_sha: string;
  pack_run_id: string;
  loop_run_id: string;
  repository: string;
  base_branch: string;
  started_at: string;
  contract_sha256: string;
  ledger_sha256: string;
  events_sha256: string;
  action_evidence_sha256: string;
  issues: Array<{
    issue_number: number;
    issue_node_id: string;
    template_id: string;
    template_sha256: string;
    created_at: string;
    advance_run_id: string;
    pr_number: number;
    pr_node_id: string;
    pr_head_sha: string;
    pr_files_sha256: string;
    check_run_ids: string[];
  }>;
  probes: Array<{
    id: string;
    test_file: string;
    test_name: string;
    candidate_git_sha: string;
    command_argv_sha256: string;
    stdout_sha256: string;
    stderr_sha256: string;
  }>;
  proofs: Array<{ id: string; source: FrgPackProofSource; artifact_sha256: string }>;
}

export interface CollectedFrgObservations {
  schema_version: 1;
  scenarios: Array<{
    id: string;
    status: "pass" | "warn";
    source: FrgPackProofSource;
    proof_ids: string[];
    detail: string;
    observed: number | null;
    threshold: number | null;
  }>;
  composition: Array<{
    id: string;
    status: "pass";
    source: FrgPackProofSource;
    proof_ids: string[];
    detail: string;
    observed: number | null;
  }>;
  false_human_authority_count: number;
  pack_provenance: FrgPackProvenance;
}

function rejectCallerClaims(value: unknown, field = "FRG verified bundle"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectCallerClaims(entry, `${field}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (["pass", "result", "status", "metrics"].includes(key)) {
      throw new Error(`${field}.${key} is forbidden: the collector derives outcomes from records`);
    }
    rejectCallerClaims(entry, `${field}.${key}`);
  }
}

function numberArray(value: unknown, field: string, allowEmpty = false): number[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be ${allowEmpty ? "an" : "a non-empty"} positive integer array`);
  }
  const result = value.map((entry, index) => positiveInteger(entry, `${field}[${index}]`));
  unique(result.map(String), field);
  return result;
}

function exactNumberSet(actual: readonly number[], expected: readonly number[], field: string): void {
  const left = [...actual].sort((a, b) => a - b);
  const right = [...expected].sort((a, b) => a - b);
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new Error(`${field} must equal the fresh manifest issue set [${right.join(",")}]`);
  }
}

function stableStringArrayHash(values: readonly string[]): string {
  return sha256(`${JSON.stringify([...values].sort())}\n`);
}

function outputProofs(
  probes: readonly FrgPackProbeManifest[],
  kind: "scenario_outputs" | "composition_outputs",
  id: string,
): { ids: string[]; observed: number | null; threshold: number | null } {
  const matches = probes
    .filter((probe) => probe[kind].some((output) => output.id === id))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (matches.length === 0) throw new Error(`hybrid policy has no Layer A probe for ${id}`);
  const outputs = matches.map((probe) => probe[kind].find((output) => output.id === id)!);
  const observedValues = [...new Set(outputs.map((output) => output.observed).filter((value) => value !== undefined))];
  const thresholdValues = [...new Set(outputs.map((output) => output.threshold).filter((value) => value !== undefined))];
  if (observedValues.length > 1 || thresholdValues.length > 1) {
    throw new Error(`hybrid policy has conflicting numeric proof values for ${id}`);
  }
  return {
    ids: matches.map((probe) => `probe:${probe.id}`),
    observed: observedValues[0] ?? null,
    threshold: thresholdValues[0] ?? null,
  };
}

export function collectFrgPackObservations(
  pack: LoadedFrgPack,
  raw: unknown,
): CollectedFrgObservations {
  rejectCallerClaims(raw);
  const bundle = record(raw, "FRG verified bundle");
  if (bundle.schema_version !== 1) throw new Error("FRG verified bundle.schema_version must be 1");
  const policy = pack.manifest.pilot_policy;
  if (bundle.policy_id !== policy.id) {
    throw new Error(
      `FRG verified bundle.policy_id must be ${policy.id} ` +
        `(historical ${FRG_HYBRID_PILOT_POLICY_ID} cannot score the current pack)`,
    );
  }
  const releaseVersion = checkedReleaseVersion(
    bundle.release_version,
    "FRG verified bundle.release_version",
  );
  if (
    bundle.pack_id !== pack.manifest.pack_id ||
    bundle.manifest_version !== pack.manifest.manifest_version ||
    bundle.manifest_sha256 !== pack.manifest_sha256
  ) {
    throw new Error("FRG verified bundle does not match the loaded manifest");
  }
  const candidateGitSha = checkedGitSha(bundle.candidate_git_sha, "FRG verified bundle.candidate_git_sha");
  const packRunId = checkedId(bundle.pack_run_id, "FRG verified bundle.pack_run_id");
  const loopRunId = checkedId(bundle.loop_run_id, "FRG verified bundle.loop_run_id");
  const repository = stringValue(bundle.repository, "FRG verified bundle.repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("FRG verified bundle.repository must be owner/name");
  }
  const baseBranch = stringValue(bundle.base_branch, "FRG verified bundle.base_branch");
  const startedAt = timestamp(bundle.started_at, "FRG verified bundle.started_at");

  const rendered = renderFrgPackIssues(pack, {
    release_version: releaseVersion,
    pack_run_id: packRunId,
  });
  const renderedByTemplate = new Map(rendered.map((issue) => [issue.provenance.template_id, issue] as const));

  const contract = record(bundle.contract, "FRG verified bundle.contract");
  const contractSha = checkedSha(contract.artifact_sha256, "FRG verified bundle.contract.artifact_sha256");
  const selector = record(contract.selector, "FRG verified bundle.contract.selector");
  if (selector.type !== pack.manifest.selector.type || selector.value !== pack.manifest.selector.value) {
    throw new Error("FRG loop contract selector does not match the fixed manifest selector");
  }
  const contractNumbers = numberArray(contract.issue_numbers, "FRG verified bundle.contract.issue_numbers");
  if (!Array.isArray(contract.items)) throw new Error("FRG verified bundle.contract.items must be an array");
  const contractItems = contract.items.map((entry, index) => {
    const item = record(entry, `FRG verified bundle.contract.items[${index}]`);
    return {
      issue_number: positiveInteger(item.issue_number, `FRG verified bundle.contract.items[${index}].issue_number`),
      depends_on: numberArray(item.depends_on, `FRG verified bundle.contract.items[${index}].depends_on`, true),
    };
  });
  exactNumberSet(contractItems.map((item) => item.issue_number), contractNumbers, "FRG loop contract items");

  const ledger = record(bundle.ledger, "FRG verified bundle.ledger");
  const ledgerSha = checkedSha(ledger.artifact_sha256, "FRG verified bundle.ledger.artifact_sha256");
  if (!Array.isArray(ledger.items)) throw new Error("FRG verified bundle.ledger.items must be an array");
  const ledgerItems = ledger.items.map((entry, index) => {
    const item = record(entry, `FRG verified bundle.ledger.items[${index}]`);
    const blockedTheme = item.blocked_theme === null
      ? null
      : stringValue(item.blocked_theme, `FRG verified bundle.ledger.items[${index}].blocked_theme`);
    if (item.state !== "ready") {
      throw new Error(`FRG live issue #${String(item.issue_number)} did not finish clean at ready-to-deploy`);
    }
    // Leftover blocked_theme after a recovered ready item is stale ledger
    // metadata. GitHub ready-to-deploy is authoritative (#1118 dogfood).
    return {
      issue_number: positiveInteger(item.issue_number, `FRG verified bundle.ledger.items[${index}].issue_number`),
      advance_run_id: checkedId(item.advance_run_id, `FRG verified bundle.ledger.items[${index}].advance_run_id`),
    };
  });
  exactNumberSet(ledgerItems.map((item) => item.issue_number), contractNumbers, "FRG loop ledger items");
  const ledgerByIssue = new Map(ledgerItems.map((item) => [item.issue_number, item] as const));

  const events = record(bundle.events, "FRG verified bundle.events");
  const eventsSha = checkedSha(events.artifact_sha256, "FRG verified bundle.events.artifact_sha256");
  const eventIds = stringArray(events.event_ids, "FRG verified bundle.events.event_ids");
  unique(eventIds, "FRG verified bundle.events.event_ids");
  exactNumberSet(numberArray(events.issue_numbers, "FRG verified bundle.events.issue_numbers"), contractNumbers, "FRG event issue set");
  const actions = record(bundle.action_evidence, "FRG verified bundle.action_evidence");
  const actionSha = checkedSha(actions.artifact_sha256, "FRG verified bundle.action_evidence.artifact_sha256");
  const actionIds = stringArray(actions.action_ids, "FRG verified bundle.action_evidence.action_ids");
  unique(actionIds, "FRG verified bundle.action_evidence.action_ids");
  exactNumberSet(numberArray(actions.issue_numbers, "FRG verified bundle.action_evidence.issue_numbers"), contractNumbers, "FRG action issue set");

  if (!Array.isArray(bundle.issues) || bundle.issues.length !== pack.manifest.templates.length) {
    throw new Error("FRG verified bundle must contain one live issue for each manifest template");
  }
  const issues = bundle.issues.map((entry, index) => {
    const field = `FRG verified bundle.issues[${index}]`;
    const issue = record(entry, field);
    const templateId = checkedId(issue.template_id, `${field}.template_id`);
    const expected = renderedByTemplate.get(templateId);
    if (!expected) throw new Error(`${field}.template_id is not in the manifest`);
    if (issue.template_sha256 !== expected.provenance.template_sha256) throw new Error(`${field} template hash does not match`);
    const createdAt = timestamp(issue.created_at, `${field}.created_at`);
    if (Date.parse(createdAt) < Date.parse(startedAt)) throw new Error(`${field} predates this pack run`);
    if (issue.title !== expected.title || issue.body !== expected.body) {
      throw new Error(`${field} does not equal the deterministic rendered issue`);
    }
    const labels = stringArray(issue.labels, `${field}.labels`);
    for (const label of expected.labels) {
      if (!labels.includes(label)) throw new Error(`${field} is missing required label ${label}`);
    }
    const issueNumber = positiveInteger(issue.issue_number, `${field}.issue_number`);
    const pr = record(issue.pr, `${field}.pr`);
    const headSha = checkedGitSha(pr.head_sha, `${field}.pr.head_sha`);
    if (pr.base_branch !== baseBranch) throw new Error(`${field}.pr.base_branch does not match the candidate base`);
    const files = stringArray(pr.files, `${field}.pr.files`);
    unique(files, `${field}.pr.files`);
    if (!Array.isArray(pr.checks) || pr.checks.length === 0) {
      throw new Error(`${field}.pr.checks must contain candidate-head check identities`);
    }
    const checks = pr.checks.map((checkRaw, checkIndex) => {
      const check = record(checkRaw, `${field}.pr.checks[${checkIndex}]`);
      const checkHead = checkedGitSha(check.head_sha, `${field}.pr.checks[${checkIndex}].head_sha`);
      if (checkHead !== headSha) throw new Error(`${field}.pr.checks[${checkIndex}] is bound to another head`);
      const conclusion = stringValue(check.conclusion, `${field}.pr.checks[${checkIndex}].conclusion`).toLowerCase();
      if (!new Set(["success", "neutral", "skipped"]).has(conclusion)) {
        throw new Error(`${field}.pr.checks[${checkIndex}] is not final and green`);
      }
      return {
        id: checkedId(String(check.id), `${field}.pr.checks[${checkIndex}].id`),
        name: stringValue(check.name, `${field}.pr.checks[${checkIndex}].name`),
        conclusion,
      };
    });
    unique(checks.map((check) => check.id), `${field}.pr.check ids`);
    return {
      issue_number: issueNumber,
      issue_node_id: checkedId(issue.issue_node_id, `${field}.issue_node_id`),
      template_id: templateId,
      template_sha256: expected.provenance.template_sha256,
      created_at: createdAt,
      advance_run_id: ledgerByIssue.get(issueNumber)?.advance_run_id ?? "",
      pr_number: positiveInteger(pr.number, `${field}.pr.number`),
      pr_node_id: checkedId(pr.node_id, `${field}.pr.node_id`),
      pr_head_sha: headSha,
      pr_files: files,
      checks,
    };
  });
  unique(issues.map((issue) => String(issue.issue_number)), "FRG live issue numbers");
  unique(issues.map((issue) => issue.issue_node_id), "FRG live issue node ids");
  unique(issues.map((issue) => issue.template_id), "FRG live issue templates");
  unique(issues.map((issue) => String(issue.pr_number)), "FRG live PR numbers");
  unique(issues.map((issue) => issue.pr_node_id), "FRG live PR node ids");
  exactNumberSet(issues.map((issue) => issue.issue_number), contractNumbers, "FRG live issue set");
  for (const issue of issues) {
    if (!issue.advance_run_id) throw new Error(`FRG live issue #${issue.issue_number} has no durable advance run identity`);
  }

  const openSpecIssue = issues.find((issue) => issue.template_id === "clean-openspec");
  if (!openSpecIssue) throw new Error("FRG live pack has no clean-openspec issue");
  const hasArchive = openSpecIssue.pr_files.some((file) => file.startsWith("openspec/changes/archive/"));
  const hasSpec = openSpecIssue.pr_files.some((file) => file.startsWith("openspec/specs/"));
  const activeChange = openSpecIssue.pr_files.some(
    (file) => file.startsWith("openspec/changes/") && !file.startsWith("openspec/changes/archive/"),
  );
  if (!hasArchive || !hasSpec || activeChange) {
    throw new Error("clean-openspec live PR must contain archived change and spec files with no active change path");
  }

  if (!Array.isArray(bundle.probes) || bundle.probes.length !== policy.layer_a_probes.length) {
    throw new Error("FRG verified bundle must contain every exact Layer A probe once");
  }
  const probeById = new Map(policy.layer_a_probes.map((probe) => [probe.id, probe] as const));
  const probes = bundle.probes.map((entry, index) => {
    const field = `FRG verified bundle.probes[${index}]`;
    const probe = record(entry, field);
    const id = checkedId(probe.id, `${field}.id`);
    const expected = probeById.get(id);
    if (!expected) {
      throw new Error(`${field}.id is not on the closed Layer A-allowed probe list`);
    }
    if (
      probe.candidate_git_sha !== candidateGitSha ||
      probe.test_file !== expected.test_file ||
      probe.test_name !== expected.test_name
    ) {
      throw new Error(`${field} is not bound to the exact candidate test probe`);
    }
    const probeStartedAt = timestamp(probe.started_at, `${field}.started_at`);
    const probeFinishedAt = timestamp(probe.finished_at, `${field}.finished_at`);
    if (Date.parse(probeStartedAt) < Date.parse(startedAt) || Date.parse(probeFinishedAt) < Date.parse(probeStartedAt)) {
      throw new Error(`${field} has an invalid run time binding`);
    }
    return {
      id,
      test_file: expected.test_file,
      test_name: expected.test_name,
      candidate_git_sha: candidateGitSha,
      command_argv_sha256: checkedSha(probe.command_argv_sha256, `${field}.command_argv_sha256`),
      stdout_sha256: checkedSha(probe.stdout_sha256, `${field}.stdout_sha256`),
      stderr_sha256: checkedSha(probe.stderr_sha256, `${field}.stderr_sha256`),
    };
  });
  unique(probes.map((probe) => probe.id), "FRG verified bundle probe ids");

  const scenarios = pack.manifest.required_scenario_ids
    .filter((id) => !pack.manifest.auto_scored_scenario_ids.includes(id))
    .map((id) => {
      if (id === "empty-depends-on-stack-honesty") {
        const emptyCount = contractItems.filter((item) => item.depends_on.length === 0).length;
        return {
          id,
          status: emptyCount >= 2 ? "warn" as const : "pass" as const,
          source: "derived" as const,
          proof_ids: ["live:contract"],
          detail: emptyCount >= 2
            ? `${emptyCount} fresh pack items have empty depends_on; the runner reports the stack risk without claiming dependencies`
            : "the exact live contract has no multi-item empty-dependency stacking signal",
          observed: emptyCount,
          threshold: null,
        };
      }
      const proof = outputProofs(policy.layer_a_probes, "scenario_outputs", id);
      return {
        id,
        status: "pass" as const,
        source: "layer_a" as const,
        proof_ids: proof.ids,
        detail: `candidate-bound Layer A probes: ${proof.ids.join(",")}`,
        observed: proof.observed,
        threshold: proof.threshold,
      };
    });

  const composition = pack.manifest.required_composition_ids.map((id) => {
    if (id === "openspec-bearing-item") {
      return {
        id,
        status: "pass" as const,
        source: "live" as const,
        proof_ids: [`live:openspec-pr:${openSpecIssue.pr_number}`],
        detail: `fresh issue #${openSpecIssue.issue_number} PR #${openSpecIssue.pr_number} contains archived OpenSpec and spec files on head ${openSpecIssue.pr_head_sha}`,
        observed: null,
      };
    }
    const proof = outputProofs(policy.layer_a_probes, "composition_outputs", id);
    return {
      id,
      status: "pass" as const,
      source: "layer_a" as const,
      proof_ids: proof.ids,
      detail: `candidate-bound Layer A probes: ${proof.ids.join(",")}`,
      observed: proof.observed,
    };
  });

  const orderedIssues = [...issues].sort((left, right) => left.template_id.localeCompare(right.template_id));
  const orderedProbes = [...probes].sort((left, right) => left.id.localeCompare(right.id));
  const proofs: FrgPackProvenance["proofs"] = [
    { id: "live:contract", source: "live", artifact_sha256: contractSha },
    { id: "ledger:final", source: "ledger", artifact_sha256: ledgerSha },
    { id: "live:events", source: "live", artifact_sha256: eventsSha },
    { id: "live:action-evidence", source: "live", artifact_sha256: actionSha },
    {
      id: `live:openspec-pr:${openSpecIssue.pr_number}`,
      source: "live",
      artifact_sha256: stableStringArrayHash(openSpecIssue.pr_files),
    },
    ...orderedProbes.map((probe) => ({
      id: `probe:${probe.id}`,
      source: "layer_a" as const,
      artifact_sha256: sha256(
        `${probe.command_argv_sha256}:${probe.stdout_sha256}:${probe.stderr_sha256}`,
      ),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id));

  return {
    schema_version: 1,
    scenarios,
    composition,
    false_human_authority_count: 0,
    pack_provenance: {
      schema_version: 1,
      policy_id: policy.id,
      pack_id: pack.manifest.pack_id,
      manifest_version: pack.manifest.manifest_version,
      manifest_sha256: pack.manifest_sha256,
      release_version: releaseVersion,
      candidate_git_sha: candidateGitSha,
      pack_run_id: packRunId,
      loop_run_id: loopRunId,
      repository,
      base_branch: baseBranch,
      started_at: startedAt,
      contract_sha256: contractSha,
      ledger_sha256: ledgerSha,
      events_sha256: eventsSha,
      action_evidence_sha256: actionSha,
      issues: orderedIssues.map((issue) => ({
        issue_number: issue.issue_number,
        issue_node_id: issue.issue_node_id,
        template_id: issue.template_id,
        template_sha256: issue.template_sha256,
        created_at: issue.created_at,
        advance_run_id: issue.advance_run_id,
        pr_number: issue.pr_number,
        pr_node_id: issue.pr_node_id,
        pr_head_sha: issue.pr_head_sha,
        pr_files_sha256: stableStringArrayHash(issue.pr_files),
        check_run_ids: issue.checks.map((check) => check.id).sort(),
      })),
      probes: orderedProbes,
      proofs,
    },
  };
}

export function serializeFrgPackObservations(observations: CollectedFrgObservations): string {
  return `${JSON.stringify(observations, null, 2)}\n`;
}
