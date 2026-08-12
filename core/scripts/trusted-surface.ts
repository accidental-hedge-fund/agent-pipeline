// Trusted-surface rebind (#691).
//
// Pure path classification + trusted revision resolution + decision aggregation.
// A candidate must not silently weaken verifier-sensitive material used to judge
// itself. Outcomes: passthrough | rebound | blocked.
//
// All I/O is injectable. Unit tests supply path lists, base readers, and engine
// identity — no real network/git/subprocess.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Schema versions and class registry
// ---------------------------------------------------------------------------

export const PATH_CLASS_SCHEMA_VERSION = 1 as const;
export const TRUSTED_SURFACE_DECISION_SCHEMA_VERSION = 1 as const;

/** Built-in verifier-sensitive path classes (schema v1). */
export const TRUSTED_SURFACE_CLASS_IDS = [
  "engine_core",
  "engine_prompts",
  "repo_policy",
  "gate_commands",
  "evidence_schemas",
  "eval_rubrics",
  "ownership_authority",
] as const;

export type TrustedSurfaceClassId = (typeof TRUSTED_SURFACE_CLASS_IDS)[number];

export type TrustedSourceKind = "installed_engine" | "base_ref" | "engine_default";

export type TrustedSurfaceOutcome = "passthrough" | "rebound" | "blocked";

export type ClassResolutionStatus =
  | "untouched"
  | "rebound"
  | "resolved"
  | "failed";

/** Built-in matching globs per class (engine-defined; candidate cannot redefine). */
export const BUILTIN_CLASS_GLOBS: Record<TrustedSurfaceClassId, readonly string[]> = {
  engine_core: [
    "core/scripts/**",
    "core/package.json",
    "plugin/scripts/**",
    "plugin/package.json",
    "hosts/**",
    "scripts/build.mjs",
    "scripts/pipeline-launcher.mjs",
    "scripts/install.mjs",
  ],
  engine_prompts: [
    "core/scripts/prompts/**",
    "plugin/scripts/prompts/**",
  ],
  repo_policy: [
    ".github/pipeline.yml",
    ".github/pipeline.yaml",
    ".github/pipeline/**",
  ],
  gate_commands: [
    "scripts/**/*gate*",
    "scripts/**/*test*",
    "scripts/**/*ci*",
    "scripts/ci-*.mjs",
    "scripts/*-smoke.mjs",
    ".github/workflows/**",
    "Makefile",
    "package.json",
    "core/package.json",
  ],
  evidence_schemas: [
    "**/evidence*schema*",
    "**/schemas/**/*evidence*",
    "core/scripts/evidence-*.ts",
    "core/scripts/tester-evidence.ts",
    "core/scripts/evidence-subject.ts",
    "core/scripts/evidence-bundle.ts",
    "plugin/scripts/evidence-*.ts",
    "plugin/scripts/tester-evidence.ts",
    "plugin/scripts/evidence-subject.ts",
    "plugin/scripts/evidence-bundle.ts",
  ],
  eval_rubrics: [
    "**/*rubric*",
    "**/rubrics/**",
    ".github/shipcheck-rubric.md",
    "**/evals/**/*rubric*",
    "core/scripts/evals/**",
    "plugin/scripts/evals/**",
  ],
  ownership_authority: [
    "CODEOWNERS",
    ".github/CODEOWNERS",
    "**/ownership*.yml",
    "**/ownership*.yaml",
    "**/ownership*.json",
    "**/authority*.yml",
    "**/authority*.yaml",
    "**/authority*.json",
    "core/scripts/production-engine-pin.ts",
    "plugin/scripts/production-engine-pin.ts",
  ],
};

/** Trusted-source kind for each built-in class. */
export const BUILTIN_CLASS_TRUSTED_SOURCE: Record<
  TrustedSurfaceClassId,
  TrustedSourceKind
> = {
  engine_core: "installed_engine",
  engine_prompts: "installed_engine",
  repo_policy: "base_ref",
  gate_commands: "base_ref",
  evidence_schemas: "base_ref",
  eval_rubrics: "base_ref",
  ownership_authority: "base_ref",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustedSurfaceExtraPath {
  class: TrustedSurfaceClassId;
  globs: string[];
}

export interface TrustedSurfaceConfig {
  /** Additive only — extends built-in globs; never disables classes. */
  extra_paths: TrustedSurfaceExtraPath[];
}

export const DEFAULT_TRUSTED_SURFACE_CONFIG: TrustedSurfaceConfig = {
  extra_paths: [],
};

/** Installed engine pin inputs for engine-class trusted hashes. */
export interface TrustedEnginePin {
  version: string;
  templates_fingerprint: string;
  root?: string;
  commit_sha?: string | null;
}

export interface ClassDecisionRecord {
  class_id: TrustedSurfaceClassId;
  trusted_source: TrustedSourceKind;
  /** Digest of trusted material when resolved. */
  trusted_content_hash: string | null;
  /** Digest of candidate material when the candidate touches this class. */
  candidate_content_hash: string | null;
  status: ClassResolutionStatus;
  /** Paths in this class that the candidate changed. */
  triggering_paths: string[];
  /** Machine reason when status is failed. */
  failure_reason?: string;
}

export interface TrustedSurfaceReason {
  /** Machine-oriented code. */
  code: string;
  /** Human-readable summary. */
  summary: string;
}

export interface TrustedSurfaceDecision {
  schema_version: typeof TRUSTED_SURFACE_DECISION_SCHEMA_VERSION;
  path_class_schema_version: typeof PATH_CLASS_SCHEMA_VERSION;
  outcome: TrustedSurfaceOutcome;
  candidate_sha: string;
  base_sha: string | null;
  triggering_paths: string[];
  classes: ClassDecisionRecord[];
  /** Stable digest of trusted content map used for judging; null when blocked without pin. */
  effective_verifier_hash: string | null;
  reason: TrustedSurfaceReason;
}

/** Injectable inputs for pure decision computation. */
export interface ComputeTrustedSurfaceInput {
  candidate_paths: readonly string[];
  candidate_sha: string;
  base_sha: string | null;
  /** Installed engine pin (required for engine classes). */
  engine_pin: TrustedEnginePin | null;
  /**
   * Read trusted content for a path at the integration base.
   * - Return `string` when the blob is present and readable.
   * - Return `null` when the path is **confirmed absent** at base.
   * - **Throw** when the base object is unreadable / resolution failed —
   *   callers must not collapse unreadable into absent (that would rebound
   *   to engine_default incorrectly).
   */
  read_base_content?: (path: string) => string | null;
  /**
   * Optional candidate content reader for recording candidate_content_hash.
   * Never used as the trusted source. Throw-safe (errors → null hash side).
   */
  read_candidate_content?: (path: string) => string | null;
  /**
   * When false and any base_ref class is touched, resolution fails closed.
   * Default true when base_sha is a full SHA.
   */
  base_readable?: boolean;
  /** Additive extra globs from config (must already be schema-validated). */
  extra_paths?: readonly TrustedSurfaceExtraPath[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function normalizeFullSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const t = sha.trim();
  if (!FULL_SHA_RE.test(t)) return null;
  return t.toLowerCase();
}

/** Deterministic JSON with sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = sortKeysDeep(obj[k]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Glob matcher aligned with design-gate (supports `**` and `*`). */
export function globToRegExp(pattern: string): RegExp {
  // Escape regex metacharacters with the matched character (callback form —
  // never a bare replacement that drops the token). Dot-paths like
  // `.github/pipeline.yml` and `package.json` must match literally.
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, (ch) => `\\${ch}`)
    .replace(/\*\*\//g, "§§§")
    .replace(/\*\*/g, "¶¶¶")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, "(?:.*/)?")
    .replace(/¶¶¶/g, ".*");
  return new RegExp(`^${regexStr}$`, "i");
}

export function pathMatchesAnyGlob(
  filePath: string,
  patterns: readonly string[],
): string | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const p of patterns) {
    try {
      if (globToRegExp(p).test(normalized)) return p;
    } catch {
      // malformed pattern never matches
    }
  }
  return null;
}

/** Effective globs for a class: built-in union optional additive extras. */
export function globsForClass(
  classId: TrustedSurfaceClassId,
  extraPaths: readonly TrustedSurfaceExtraPath[] = [],
): string[] {
  const extras = extraPaths
    .filter((e) => e.class === classId)
    .flatMap((e) => e.globs);
  return [...BUILTIN_CLASS_GLOBS[classId], ...extras];
}

export interface PathClassification {
  path: string;
  class_ids: TrustedSurfaceClassId[];
}

/**
 * Classify candidate changed paths into built-in (+ extra) sensitive classes.
 * Paths may match multiple classes.
 */
export function classifyPaths(
  candidatePaths: readonly string[],
  extraPaths: readonly TrustedSurfaceExtraPath[] = [],
): PathClassification[] {
  const out: PathClassification[] = [];
  for (const raw of candidatePaths) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const class_ids: TrustedSurfaceClassId[] = [];
    for (const id of TRUSTED_SURFACE_CLASS_IDS) {
      if (pathMatchesAnyGlob(path, globsForClass(id, extraPaths))) {
        class_ids.push(id);
      }
    }
    if (class_ids.length > 0) out.push({ path, class_ids });
  }
  return out;
}

/** Content hash of a set of path→content pairs (sorted by path). */
export function hashPathContents(
  entries: ReadonlyArray<{ path: string; content: string | null }>,
): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const payload = sorted.map((e) => ({
    path: e.path,
    content_sha256:
      e.content === null ? null : sha256Hex(e.content),
    absent: e.content === null,
  }));
  return sha256Hex(stableStringify(payload));
}

/** Trusted hash for installed_engine classes from the process pin. */
export function hashEnginePin(pin: TrustedEnginePin): string {
  const payload: Record<string, unknown> = {
    version: pin.version,
    templates_fingerprint: pin.templates_fingerprint,
  };
  if (pin.root) payload.root = pin.root;
  if (typeof pin.commit_sha === "string" && pin.commit_sha) {
    payload.commit_sha = pin.commit_sha.toLowerCase();
  }
  return sha256Hex(stableStringify({ source: "installed_engine", pin: payload }));
}

/**
 * Engine-default empty surface (path absent at base): documented default digest.
 * Used so rebound still has a pin when the candidate *adds* a new sensitive file.
 */
export function engineDefaultHash(classId: TrustedSurfaceClassId): string {
  return sha256Hex(
    stableStringify({
      source: "engine_default",
      class_id: classId,
      path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
    }),
  );
}

/**
 * Build effective_verifier_hash from resolved per-class trusted hashes.
 * Only includes classes with a non-null trusted_content_hash.
 */
export function buildEffectiveVerifierHash(
  classHashes: ReadonlyArray<{ class_id: string; trusted_content_hash: string }>,
): string {
  const map: Record<string, string> = {};
  for (const row of [...classHashes].sort((a, b) =>
    a.class_id.localeCompare(b.class_id),
  )) {
    map[row.class_id] = row.trusted_content_hash;
  }
  return sha256Hex(
    stableStringify({
      path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
      trusted: map,
    }),
  );
}

// ---------------------------------------------------------------------------
// Decision computation
// ---------------------------------------------------------------------------

/**
 * Pure trusted-surface decision for one candidate evaluation.
 *
 * Aggregate rules:
 * - blocked if any required touched class fails resolution
 * - else rebound if any sensitive path is touched and trust resolves
 * - else passthrough
 *
 * Engine classes never take trusted bytes from the candidate tree.
 */
export function computeTrustedSurfaceDecision(
  input: ComputeTrustedSurfaceInput,
): TrustedSurfaceDecision {
  const candidateSha = normalizeFullSha(input.candidate_sha);
  if (!candidateSha) {
    return failClosedDecision(input, {
      code: "invalid_candidate_sha",
      summary:
        "candidate_sha must be a full 40-character hex SHA for trusted-surface evaluation",
    });
  }

  const baseSha = normalizeFullSha(input.base_sha);
  const extraPaths = input.extra_paths ?? [];
  const classifications = classifyPaths(input.candidate_paths, extraPaths);

  const pathsByClass = new Map<TrustedSurfaceClassId, string[]>();
  for (const id of TRUSTED_SURFACE_CLASS_IDS) pathsByClass.set(id, []);
  for (const c of classifications) {
    for (const id of c.class_ids) {
      pathsByClass.get(id)!.push(c.path);
    }
  }
  for (const id of TRUSTED_SURFACE_CLASS_IDS) {
    pathsByClass.set(
      id,
      [...new Set(pathsByClass.get(id)!)].sort((a, b) => a.localeCompare(b)),
    );
  }

  const triggeringPaths = [
    ...new Set(classifications.map((c) => c.path)),
  ].sort((a, b) => a.localeCompare(b));

  const baseReadable =
    input.base_readable !== undefined
      ? input.base_readable
      : baseSha !== null;

  const classRecords: ClassDecisionRecord[] = [];
  let anyFailed = false;
  let anyRebound = false;

  for (const classId of TRUSTED_SURFACE_CLASS_IDS) {
    const source = BUILTIN_CLASS_TRUSTED_SOURCE[classId];
    const touched = pathsByClass.get(classId)!;
    const isTouched = touched.length > 0;

    let trustedHash: string | null = null;
    let candidateHash: string | null = null;
    let status: ClassResolutionStatus = isTouched ? "rebound" : "untouched";
    let failureReason: string | undefined;

    if (isTouched && input.read_candidate_content) {
      const entries = touched.map((p) => ({
        path: p,
        content: safeReadCandidate(input.read_candidate_content!, p),
      }));
      candidateHash = hashPathContents(entries);
    }

    if (source === "installed_engine") {
      // Installed engine pin is required for readiness-relevant judging. Never
      // invent trusted bytes from the candidate worktree.
      if (!input.engine_pin?.version || !input.engine_pin?.templates_fingerprint) {
        status = "failed";
        failureReason = "missing_engine_pin";
        anyFailed = true;
      } else {
        trustedHash = hashEnginePin(input.engine_pin);
        status = isTouched ? "rebound" : "resolved";
        if (isTouched) anyRebound = true;
      }
    } else if (source === "base_ref" || source === "engine_default") {
      // base_ref classes fall back to engine_default when path is **confirmed
      // absent** at base. Unreadable base objects fail closed (do not treat as
      // absence).
      if (isTouched) {
        if (!baseSha || !baseReadable) {
          status = "failed";
          failureReason = !baseSha ? "missing_base_sha" : "base_unreadable";
          anyFailed = true;
        } else if (!input.read_base_content) {
          status = "failed";
          failureReason = "missing_base_reader";
          anyFailed = true;
        } else {
          const entries: Array<{ path: string; content: string | null }> = [];
          let readFailed: string | undefined;
          for (const p of touched) {
            try {
              entries.push({ path: p, content: input.read_base_content(p) });
            } catch (err) {
              readFailed =
                err instanceof Error ? err.message : "base_read_failed";
              break;
            }
          }
          if (readFailed) {
            status = "failed";
            failureReason = "base_unreadable";
            anyFailed = true;
          } else {
            // All confirmed absent at base → engine_default pin (judge under
            // absence, not candidate).
            const allAbsent = entries.every((e) => e.content === null);
            trustedHash = allAbsent
              ? engineDefaultHash(classId)
              : hashPathContents(entries);
            status = "rebound";
            anyRebound = true;
          }
        }
      } else {
        // Untouched: still resolve a default/base pin for effective hash when possible.
        if (baseSha && baseReadable && input.read_base_content) {
          // For effective hash on passthrough, hash class default globs' base content
          // is expensive; use a stable class-level pin from engine defaults when
          // no paths are under evaluation. This keeps passthrough deterministic
          // without reading the full tree.
          trustedHash = engineDefaultHash(classId);
          status = "resolved";
        } else if (input.engine_pin) {
          // No base available but engine exists — class remains resolved via engine_default.
          trustedHash = engineDefaultHash(classId);
          status = "resolved";
        } else {
          trustedHash = engineDefaultHash(classId);
          status = "resolved";
        }
      }
    }

    classRecords.push({
      class_id: classId,
      trusted_source: source,
      trusted_content_hash: trustedHash,
      candidate_content_hash: candidateHash,
      status,
      triggering_paths: touched,
      ...(failureReason ? { failure_reason: failureReason } : {}),
    });
  }

  // Effective hash from all classes that resolved a trusted hash.
  const resolvedHashes = classRecords
    .filter((c) => typeof c.trusted_content_hash === "string" && c.trusted_content_hash)
    .map((c) => ({
      class_id: c.class_id,
      trusted_content_hash: c.trusted_content_hash as string,
    }));

  let outcome: TrustedSurfaceOutcome;
  let reason: TrustedSurfaceReason;
  let effective: string | null = null;

  if (anyFailed) {
    outcome = "blocked";
    const failed = classRecords.filter((c) => c.status === "failed");
    reason = {
      code: "trusted_resolution_failed",
      summary:
        `Trusted surface blocked: ${failed.map((f) => `${f.class_id}(${f.failure_reason ?? "failed"})`).join(", ")}`,
    };
    // Do not invent a trustworthy pin from partial/failed resolution when
    // required classes failed.
    effective = null;
  } else if (anyRebound || triggeringPaths.length > 0) {
    outcome = "rebound";
    effective = buildEffectiveVerifierHash(resolvedHashes);
    reason = {
      code: "sensitive_paths_rebound",
      summary:
        `Candidate touches verifier-sensitive paths; judging rebound to trusted surface (${triggeringPaths.length} path(s))`,
    };
  } else {
    outcome = "passthrough";
    effective = buildEffectiveVerifierHash(resolvedHashes);
    reason = {
      code: "no_sensitive_paths",
      summary:
        "Candidate touches no verifier-sensitive paths; judging uses trusted surface without rebind",
    };
  }

  return {
    schema_version: TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
    path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
    outcome,
    candidate_sha: candidateSha,
    base_sha: baseSha,
    triggering_paths: triggeringPaths,
    classes: classRecords,
    effective_verifier_hash: effective,
    reason,
  };
}

/** Candidate reads are observational only — errors become null content. */
function safeReadCandidate(
  reader: (path: string) => string | null,
  path: string,
): string | null {
  try {
    return reader(path);
  } catch {
    return null;
  }
}

function failClosedDecision(
  input: ComputeTrustedSurfaceInput,
  reason: TrustedSurfaceReason,
): TrustedSurfaceDecision {
  return {
    schema_version: TRUSTED_SURFACE_DECISION_SCHEMA_VERSION,
    path_class_schema_version: PATH_CLASS_SCHEMA_VERSION,
    outcome: "blocked",
    candidate_sha: normalizeFullSha(input.candidate_sha) ?? "",
    base_sha: normalizeFullSha(input.base_sha),
    triggering_paths: [],
    classes: TRUSTED_SURFACE_CLASS_IDS.map((id) => ({
      class_id: id,
      trusted_source: BUILTIN_CLASS_TRUSTED_SOURCE[id],
      trusted_content_hash: null,
      candidate_content_hash: null,
      status: "failed" as const,
      triggering_paths: [],
      failure_reason: reason.code,
    })),
    effective_verifier_hash: null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Mid-run invalidation helpers
// ---------------------------------------------------------------------------

/**
 * Recompute engine-class contribution after an engine pin change.
 * Returns whether the overall effective_verifier_hash would change.
 */
export function effectiveVerifierHashChanged(
  previous: TrustedSurfaceDecision,
  nextEnginePin: TrustedEnginePin,
): { changed: boolean; previous_hash: string | null; next_hash: string | null } {
  const prevHash = previous.effective_verifier_hash;
  if (!prevHash) {
    return { changed: false, previous_hash: prevHash, next_hash: null };
  }
  const nextHashes = previous.classes.map((c) => {
    if (BUILTIN_CLASS_TRUSTED_SOURCE[c.class_id] === "installed_engine") {
      return {
        class_id: c.class_id,
        trusted_content_hash: hashEnginePin(nextEnginePin),
      };
    }
    if (c.trusted_content_hash) {
      return {
        class_id: c.class_id,
        trusted_content_hash: c.trusted_content_hash,
      };
    }
    return null;
  }).filter((x): x is { class_id: string; trusted_content_hash: string } => x !== null);

  const nextHash = buildEffectiveVerifierHash(nextHashes);
  return {
    changed: nextHash !== prevHash,
    previous_hash: prevHash,
    next_hash: nextHash,
  };
}

/**
 * Whether readiness may advance to ready-to-deploy under this decision.
 *
 * - `blocked` → no
 * - missing decision → no by default (current runs must compute a decision);
 *   pass `{ enforcement: "historical" }` only for demonstrably pre-feature
 *   consumers that opt into legacy omission
 * - passthrough/rebound with effective hash → yes (other gates still apply)
 */
export function allowsReadyToDeploy(
  decision: TrustedSurfaceDecision | null | undefined,
  opts?: { enforcement?: "current" | "historical" },
): boolean {
  if (!decision) {
    // Historical omission is explicit opt-in only. Current runs fail closed.
    return opts?.enforcement === "historical";
  }
  if (decision.outcome === "blocked") return false;
  return typeof decision.effective_verifier_hash === "string" &&
    decision.effective_verifier_hash.length > 0;
}

/**
 * Classify a `git show <sha>:<path>` result.
 * - code 0 → content present
 * - path confirmed missing at that tree → absent
 * - any other failure → unreadable (must not be treated as absence)
 */
export function classifyGitShowResult(result: {
  code: number;
  stdout?: string;
  stderr?: string;
}): "content" | "absent" | "unreadable" {
  if (result.code === 0) return "content";
  const err = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  // Common git messages for a path that is simply not in the tree.
  const absent =
    result.code === 128 &&
    (err.includes("does not exist in") ||
      err.includes("exists on disk, but not in") ||
      err.includes("did not match any") ||
      (err.includes("fatal: path") && err.includes("not in")));
  if (absent) return "absent";
  return "unreadable";
}

/**
 * When engine-class material drifts mid-run, produce the next decision's
 * effective hash inputs by replacing installed_engine class hashes.
 * Returns null next_hash only when previous had no pin.
 */
export function rebindDecisionAfterEngineDrift(
  previous: TrustedSurfaceDecision,
  nextEnginePin: TrustedEnginePin,
): TrustedSurfaceDecision {
  const nextClasses = previous.classes.map((c) => {
    if (BUILTIN_CLASS_TRUSTED_SOURCE[c.class_id] !== "installed_engine") {
      return { ...c };
    }
    if (!nextEnginePin.version || !nextEnginePin.templates_fingerprint) {
      return {
        ...c,
        trusted_content_hash: null,
        status: "failed" as const,
        failure_reason: "missing_engine_pin",
      };
    }
    return {
      ...c,
      trusted_content_hash: hashEnginePin(nextEnginePin),
      status: c.status === "failed" ? ("resolved" as const) : c.status,
      failure_reason: undefined,
    };
  });
  const anyFailed = nextClasses.some((c) => c.status === "failed");
  const resolvedHashes = nextClasses
    .filter((c) => typeof c.trusted_content_hash === "string" && c.trusted_content_hash)
    .map((c) => ({
      class_id: c.class_id,
      trusted_content_hash: c.trusted_content_hash as string,
    }));
  if (anyFailed) {
    return {
      ...previous,
      outcome: "blocked",
      classes: nextClasses,
      effective_verifier_hash: null,
      reason: {
        code: "engine_drift_resolution_failed",
        summary:
          "Mid-run engine drift left a required installed_engine class unresolved",
      },
    };
  }
  const nextHash = buildEffectiveVerifierHash(resolvedHashes);
  const anyRebound =
    previous.outcome === "rebound" ||
    nextClasses.some((c) => c.status === "rebound");
  return {
    ...previous,
    outcome: anyRebound || previous.triggering_paths.length > 0 ? "rebound" : "passthrough",
    classes: nextClasses,
    effective_verifier_hash: nextHash,
    reason: {
      code: "engine_drift_rebound",
      summary:
        "Mid-run engine identity changed; effective verifier hash recomputed under the new pin",
    },
  };
}

/**
 * Record shape written to summary.json / evidence.json (same as decision).
 * Historical bundles may omit this field — consumers must not invent passthrough.
 */
export type TrustedSurfaceBundleRecord = TrustedSurfaceDecision;

/** Parse a stored decision; returns null when absent/malformed (no invent). */
export function parseTrustedSurfaceDecision(value: unknown): TrustedSurfaceDecision | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.schema_version !== TRUSTED_SURFACE_DECISION_SCHEMA_VERSION) return null;
  if (o.path_class_schema_version !== PATH_CLASS_SCHEMA_VERSION) return null;
  if (o.outcome !== "passthrough" && o.outcome !== "rebound" && o.outcome !== "blocked") {
    return null;
  }
  if (typeof o.candidate_sha !== "string") return null;
  if (!Array.isArray(o.triggering_paths)) return null;
  if (!Array.isArray(o.classes)) return null;
  if (typeof o.reason !== "object" || o.reason === null) return null;
  return value as TrustedSurfaceDecision;
}

/**
 * Documented pure derivation: bind evidence_subject.verifier_fingerprint to the
 * trusted-surface effective verifier identity, optionally refined by a
 * family-local slice (e.g. tester toolchain).
 *
 * When decision is blocked / missing effective hash, returns null (fail closed).
 */
export function verifierFingerprintFromTrustedSurface(
  decision: TrustedSurfaceDecision,
  familyLocal?: Record<string, unknown> | null,
): string | null {
  if (decision.outcome === "blocked") return null;
  const h = decision.effective_verifier_hash;
  if (typeof h !== "string" || !h) return null;
  if (familyLocal && Object.keys(familyLocal).length > 0) {
    return sha256Hex(
      stableStringify({
        trusted_surface_effective_verifier_hash: h,
        family_local: familyLocal,
      }),
    );
  }
  // No family-local slice: fingerprint equals the effective verifier hash.
  return h;
}
