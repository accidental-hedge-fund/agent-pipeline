// Bound-input fingerprints `grill-fingerprint.v1` (#1072).
// Pure: no network, git, or subprocess.

import { canonicalJson, isSha256Prefixed, sha256Prefixed } from "./grill-hash.ts";
import type { TreatmentFingerprint } from "./harness-adapters/treatment-fingerprint.ts";

export const GRILL_FINGERPRINT_VERSION = "grill-fingerprint.v1" as const;

export interface GrillFingerprint {
  schema_version: typeof GRILL_FINGERPRINT_VERSION;
  title_sha256: string;
  applied_body_sha256: string;
  dependency_closure_sha256: string;
  integration_base_sha: string;
  context_md_sha256: string;
  provider_config_sha256: string;
  planning_treatment_sha256: string;
}

export interface ProviderConfigIdentity {
  implementer: string;
  reviewer: string;
  planning_model: string;
  planning_effort: string;
}

export interface DependencyClosureRecord {
  ids: number[];
  per_id: Array<{ id: number; title_sha256: string; body_sha256: string }>;
  fact_codes: string[];
}

export function hashProviderConfig(cfg: ProviderConfigIdentity): string {
  return sha256Prefixed(canonicalJson(cfg));
}

export function hashPlanningTreatment(fp: TreatmentFingerprint): string {
  return sha256Prefixed(canonicalJson(fp));
}

export function hashDependencyClosure(record: DependencyClosureRecord): string {
  const sortedIds = [...record.ids].sort((a, b) => a - b);
  const perId = [...record.per_id].sort((a, b) => a.id - b.id);
  const codes = [...record.fact_codes].sort();
  return sha256Prefixed(canonicalJson({ ids: sortedIds, per_id: perId, fact_codes: codes }));
}

export function buildGrillFingerprint(input: {
  title: string;
  appliedBody: string;
  dependencyClosure: DependencyClosureRecord;
  integrationBaseSha: string;
  contextMd: string;
  providerConfig: ProviderConfigIdentity;
  planningTreatment: TreatmentFingerprint;
}): GrillFingerprint {
  return {
    schema_version: GRILL_FINGERPRINT_VERSION,
    title_sha256: sha256Prefixed(input.title),
    applied_body_sha256: sha256Prefixed(input.appliedBody),
    dependency_closure_sha256: hashDependencyClosure(input.dependencyClosure),
    integration_base_sha: input.integrationBaseSha,
    context_md_sha256: sha256Prefixed(input.contextMd),
    provider_config_sha256: hashProviderConfig(input.providerConfig),
    planning_treatment_sha256: hashPlanningTreatment(input.planningTreatment),
  };
}

export function fingerprintStaleReasons(
  recorded: GrillFingerprint,
  current: GrillFingerprint,
): string[] {
  const reasons: string[] = [];
  const keys: (keyof GrillFingerprint)[] = [
    "title_sha256",
    "applied_body_sha256",
    "dependency_closure_sha256",
    "integration_base_sha",
    "context_md_sha256",
    "provider_config_sha256",
    "planning_treatment_sha256",
  ];
  for (const key of keys) {
    if (recorded[key] !== current[key]) reasons.push(key);
  }
  return reasons;
}

export function parseGrillFingerprint(
  raw: unknown,
): { ok: true; fingerprint: GrillFingerprint } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "fingerprint is not an object" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== GRILL_FINGERPRINT_VERSION) {
    return { ok: false, reason: `unknown fingerprint schema_version: ${String(o.schema_version)}` };
  }
  const required: (keyof GrillFingerprint)[] = [
    "title_sha256",
    "applied_body_sha256",
    "dependency_closure_sha256",
    "integration_base_sha",
    "context_md_sha256",
    "provider_config_sha256",
    "planning_treatment_sha256",
  ];
  for (const key of required) {
    if (typeof o[key] !== "string" || (o[key] as string).length === 0) {
      return { ok: false, reason: `fingerprint.${key} missing` };
    }
  }
  for (const key of [
    "title_sha256",
    "applied_body_sha256",
    "dependency_closure_sha256",
    "context_md_sha256",
    "provider_config_sha256",
    "planning_treatment_sha256",
  ] as const) {
    if (!isSha256Prefixed(o[key])) {
      return { ok: false, reason: `fingerprint.${key} is not sha256:<64hex>` };
    }
  }
  return {
    ok: true,
    fingerprint: {
      schema_version: GRILL_FINGERPRINT_VERSION,
      title_sha256: o.title_sha256 as string,
      applied_body_sha256: o.applied_body_sha256 as string,
      dependency_closure_sha256: o.dependency_closure_sha256 as string,
      integration_base_sha: o.integration_base_sha as string,
      context_md_sha256: o.context_md_sha256 as string,
      provider_config_sha256: o.provider_config_sha256 as string,
      planning_treatment_sha256: o.planning_treatment_sha256 as string,
    },
  };
}

export function dependencyRecordFromFacts(
  ids: number[],
  perId: DependencyClosureRecord["per_id"],
  factCodes: readonly string[],
): DependencyClosureRecord {
  return {
    ids,
    per_id: perId,
    fact_codes: [...factCodes],
  };
}
