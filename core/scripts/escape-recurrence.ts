// Escape-recurrence tracking (#763): seed defect-class registry, pure mapper,
// fix-release boundary resolution, and post-boundary recurrence metrics.
//
// A class enters the recurrence *denominator* only when a fix-release boundary
// is known. Recurrence = at least one mapped occurrence strictly after that
// boundary. Classes without a boundary contribute to missing-boundary
// diagnostics, not to the ratio denominator. Unmapped signals are excluded.

/** Scoreboard-compatible rate triple (kept local to avoid scoreboard import cycle). */
export interface EscapeRecurrenceRateValue {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

// ---------------------------------------------------------------------------
// Seed registry (exact strings locked by tests)
// ---------------------------------------------------------------------------

export const SEED_DEFECT_CLASS_KEYS = [
  "delta-sha-gate",
  "openspec-archive",
  "salvage",
  "worktree",
] as const;

export type SeedDefectClassKey = (typeof SEED_DEFECT_CLASS_KEYS)[number];

export type DefectClassKey = string;

/** Extensible registry: seed keys plus any additional registered keys. */
const registryKeys = new Set<string>(SEED_DEFECT_CLASS_KEYS);

export function getDefectClassRegistry(): readonly string[] {
  return [...registryKeys].sort();
}

export function registerDefectClassKey(key: string): void {
  if (typeof key === "string" && key.trim()) registryKeys.add(key.trim());
}

/** Test helper — reset registry to seed keys only. */
export function resetDefectClassRegistryForTests(): void {
  registryKeys.clear();
  for (const k of SEED_DEFECT_CLASS_KEYS) registryKeys.add(k);
}

// ---------------------------------------------------------------------------
// Signal → registry key mapper
// ---------------------------------------------------------------------------

/**
 * Pure mapper from ledger / attribution / auto-file signals to a registry key.
 * Returns null when the signal does not map — unmapped occurrences MUST NOT
 * enter the escape-recurrence denominator.
 */
export function mapSignalToDefectClassKey(signal: {
  correction_key?: string | null;
  failure_class?: string | null;
  blocker_kind?: string | null;
  offramp_class?: string | null;
  reason_code?: string | null;
  message?: string | null;
  type?: string | null;
}): DefectClassKey | null {
  const candidates: string[] = [];
  for (const field of [
    signal.correction_key,
    signal.failure_class,
    signal.blocker_kind,
    signal.offramp_class,
    signal.reason_code,
    signal.message,
    signal.type,
  ]) {
    if (typeof field === "string" && field.trim()) candidates.push(field.trim().toLowerCase());
  }
  if (candidates.length === 0) return null;

  for (const raw of candidates) {
    // Exact registry hit
    if (registryKeys.has(raw)) return raw;
    // Common aliases / substrings from audited chains (2026-07-31)
    if (
      raw.includes("delta-sha") ||
      raw.includes("sha-gate") ||
      raw.includes("review-sha") ||
      raw === "delta_sha_gate" ||
      raw === "sha_gate"
    ) {
      return "delta-sha-gate";
    }
    if (
      raw.includes("openspec-archive") ||
      raw.includes("openspec_archive") ||
      raw.includes("openspec-stale") ||
      raw === "openspec-archive-apply-conflict"
    ) {
      return "openspec-archive";
    }
    if (raw.includes("salvage") || raw === "salvage-harness-work") {
      return "salvage";
    }
    if (
      raw.includes("worktree") ||
      raw === "worktree-missing" ||
      raw === "worktree-capacity" ||
      raw === "worktree-creation-failed"
    ) {
      return "worktree";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fix boundary + recurrence
// ---------------------------------------------------------------------------

export interface FixReleaseBoundary {
  class_key: DefectClassKey;
  /** Release tag / version string (e.g. v1.30.0). */
  effective_release: string;
  /** Optional ISO timestamp when the fix became effective. */
  effective_at: string | null;
  source: "control_attribution" | "release_observation";
}

export interface DefectOccurrence {
  class_key: DefectClassKey;
  /** ISO timestamp of the occurrence when known. */
  at: string | null;
  /** Producing release version when known (for post-boundary comparison). */
  producing_release: string | null;
  run_id?: string;
}

export interface EscapeRecurrenceKeyRow {
  class_key: DefectClassKey;
  has_fix_boundary: boolean;
  effective_release: string | null;
  recurrent: boolean;
  post_boundary_occurrences: number;
  total_occurrences: number;
  missing_boundary: boolean;
}

export interface EscapeRecurrenceResult {
  classes_with_fix_boundary: number;
  classes_with_post_fix_occurrence: number;
  ratio: EscapeRecurrenceRateValue;
  by_key: EscapeRecurrenceKeyRow[];
  unmapped_occurrence_count: number;
  missing_boundary_keys: string[];
  diagnostics: Array<{ code: string; message: string; class_key?: string }>;
}

function rate(numerator: number, denominator: number): EscapeRecurrenceRateValue {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

/** Compare two release labels loosely: strip leading `v`, then string compare
 *  only when both look like semver-ish; otherwise use effective_at timestamps. */
export function isStrictlyAfterBoundary(
  occurrence: DefectOccurrence,
  boundary: FixReleaseBoundary,
): boolean {
  if (occurrence.at && boundary.effective_at) {
    const occMs = Date.parse(occurrence.at);
    const boundMs = Date.parse(boundary.effective_at);
    if (Number.isFinite(occMs) && Number.isFinite(boundMs)) {
      return occMs > boundMs;
    }
  }
  if (occurrence.producing_release && boundary.effective_release) {
    return compareReleaseLabels(occurrence.producing_release, boundary.effective_release) > 0;
  }
  // Timestamp-only occurrence with release-only boundary: not provably after.
  if (occurrence.at && !boundary.effective_at && !occurrence.producing_release) {
    return false;
  }
  if (occurrence.producing_release && boundary.effective_release) {
    return compareReleaseLabels(occurrence.producing_release, boundary.effective_release) > 0;
  }
  return false;
}

/**
 * Parsed release label for SemVer-correct precedence (#763).
 * Build metadata is stripped (equal precedence). Prerelease is ordered
 * below the corresponding final release per SemVer 2.0.0.
 */
interface ParsedReleaseLabel {
  /** true when core X.Y.Z parsed; false for free-form labels */
  semver: boolean;
  core: [number, number, number];
  /** null = final release (no prerelease); array = prerelease identifiers */
  prerelease: Array<string | number> | null;
  /** Normalized free-form fallback when not semver */
  freeform: string;
}

function parseReleaseLabel(label: string): ParsedReleaseLabel {
  const freeform = label.trim().replace(/^v/i, "").toLowerCase();
  // Build metadata is ignored for precedence (SemVer §10).
  const noBuild = freeform.split("+")[0] ?? freeform;
  const m = noBuild.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) {
    return { semver: false, core: [0, 0, 0], prerelease: null, freeform };
  }
  const core: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!m[4]) {
    return { semver: true, core, prerelease: null, freeform };
  }
  const prerelease = m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { semver: true, core, prerelease, freeform };
}

/** Compare prerelease identifier lists per SemVer §11. */
function comparePrerelease(
  a: Array<string | number> | null,
  b: Array<string | number> | null,
): number {
  // No prerelease > any prerelease (final release is later than rc).
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // fewer identifiers → lower precedence
    if (i >= b.length) return 1;
    const x = a[i]!;
    const y = b[i]!;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      if (x !== y) return (x as number) - (y as number);
    } else if (xNum) {
      return -1; // numeric identifiers have lower precedence than non-numeric
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Return negative if a < b, 0 if equal, positive if a > b.
 * SemVer 2.0.0 precedence: build metadata ignored; prerelease < final release
 * with the same core version. Non-semver labels fall back to free-form compare.
 */
export function compareReleaseLabels(a: string, b: string): number {
  const pa = parseReleaseLabel(a);
  const pb = parseReleaseLabel(b);
  if (pa.semver && pb.semver) {
    for (let i = 0; i < 3; i++) {
      if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
    }
    return comparePrerelease(pa.prerelease, pb.prerelease);
  }
  // Mixed or non-semver: free-form string compare on normalized labels.
  if (pa.freeform === pb.freeform) return 0;
  return pa.freeform < pb.freeform ? -1 : 1;
}

/**
 * Resolve fix boundaries from control attributions (priority 1) then release
 * observations (priority 2). Only implemented dispositions with non-null
 * effective_release establish a boundary.
 */
export function resolveFixBoundaries(input: {
  attributions?: Array<{
    correction_key: string;
    disposition?: string;
    effective_release?: string | null;
    effective_at?: string | null;
  }>;
  releaseObservations?: Array<{
    class_key: string;
    effective_release: string;
    effective_at?: string | null;
  }>;
}): Map<DefectClassKey, FixReleaseBoundary> {
  const out = new Map<DefectClassKey, FixReleaseBoundary>();

  for (const attr of input.attributions ?? []) {
    const key = mapSignalToDefectClassKey({ correction_key: attr.correction_key });
    if (!key) continue;
    if (attr.disposition && attr.disposition !== "implemented") continue;
    const rel =
      typeof attr.effective_release === "string" && attr.effective_release.trim()
        ? attr.effective_release.trim()
        : null;
    if (!rel) continue;
    const existing = out.get(key);
    const candidate: FixReleaseBoundary = {
      class_key: key,
      effective_release: rel,
      effective_at:
        typeof attr.effective_at === "string" && attr.effective_at.trim()
          ? attr.effective_at.trim()
          : null,
      source: "control_attribution",
    };
    // Prefer earliest effective boundary when multiple exist.
    if (!existing) {
      out.set(key, candidate);
    } else if (
      candidate.effective_at &&
      existing.effective_at &&
      Date.parse(candidate.effective_at) < Date.parse(existing.effective_at)
    ) {
      out.set(key, candidate);
    } else if (
      compareReleaseLabels(candidate.effective_release, existing.effective_release) < 0
    ) {
      out.set(key, candidate);
    }
  }

  for (const obs of input.releaseObservations ?? []) {
    const key = mapSignalToDefectClassKey({ correction_key: obs.class_key, failure_class: obs.class_key });
    if (!key) continue;
    if (out.has(key)) continue; // control_attribution wins
    const rel = obs.effective_release?.trim();
    if (!rel) continue;
    out.set(key, {
      class_key: key,
      effective_release: rel,
      effective_at: obs.effective_at?.trim() || null,
      source: "release_observation",
    });
  }

  return out;
}

/**
 * Compute escape-recurrence aggregate. Only classes with a known fix boundary
 * enter the denominator. Unmapped occurrences are counted in residual only.
 */
export function computeEscapeRecurrence(input: {
  occurrences: DefectOccurrence[];
  boundaries: Map<DefectClassKey, FixReleaseBoundary>;
  /** Keys to always report rows for (defaults to seed registry). */
  reportKeys?: readonly string[];
}): EscapeRecurrenceResult {
  const reportKeys = input.reportKeys ?? getDefectClassRegistry();
  const byKeyOcc = new Map<DefectClassKey, DefectOccurrence[]>();
  let unmapped = 0;

  for (const occ of input.occurrences) {
    if (!occ.class_key || !registryKeys.has(occ.class_key)) {
      // Also accept occurrences already mapped but not in registry (extensible)
      if (!occ.class_key) {
        unmapped++;
        continue;
      }
    }
    if (!byKeyOcc.has(occ.class_key)) byKeyOcc.set(occ.class_key, []);
    byKeyOcc.get(occ.class_key)!.push(occ);
  }

  const diagnostics: EscapeRecurrenceResult["diagnostics"] = [];
  const missing_boundary_keys: string[] = [];
  const by_key: EscapeRecurrenceKeyRow[] = [];

  let denom = 0;
  let numer = 0;

  const keys = new Set([...reportKeys, ...byKeyOcc.keys(), ...input.boundaries.keys()]);
  for (const class_key of [...keys].sort()) {
    const boundary = input.boundaries.get(class_key) ?? null;
    const occs = byKeyOcc.get(class_key) ?? [];
    const has_fix_boundary = boundary !== null;
    let post = 0;
    if (boundary) {
      for (const occ of occs) {
        if (isStrictlyAfterBoundary(occ, boundary)) post++;
      }
    }
    const missing_boundary = !has_fix_boundary && occs.length > 0;
    if (missing_boundary) {
      missing_boundary_keys.push(class_key);
      diagnostics.push({
        code: "escape_recurrence_missing_boundary",
        message: `Defect class "${class_key}" has ${occs.length} occurrence(s) but no fix-release boundary`,
        class_key,
      });
    }
    const recurrent = has_fix_boundary && post > 0;
    if (has_fix_boundary) {
      denom++;
      if (recurrent) numer++;
    }
    // Always emit seed rows; emit others when they have boundary or occurrences.
    if (reportKeys.includes(class_key) || has_fix_boundary || occs.length > 0) {
      by_key.push({
        class_key,
        has_fix_boundary,
        effective_release: boundary?.effective_release ?? null,
        recurrent,
        post_boundary_occurrences: post,
        total_occurrences: occs.length,
        missing_boundary,
      });
    }
  }

  return {
    classes_with_fix_boundary: denom,
    classes_with_post_fix_occurrence: numer,
    ratio: rate(numer, denom),
    by_key,
    unmapped_occurrence_count: unmapped,
    missing_boundary_keys,
    diagnostics,
  };
}
