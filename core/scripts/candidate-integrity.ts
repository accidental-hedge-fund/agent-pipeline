// Candidate-integrity protocol (#857).
//
// Provider-neutral control-plane: snapshot approved candidate surface before
// pipeline-owned head-moving mutations, compare after, classify, invalidate
// stale review/readiness on expansion or unverified, and emit durable events.
// Disposition authority is the integrity store + classification return value;
// run-ledger events are observability (#763).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "./run-store.ts";

// ---------------------------------------------------------------------------
// Schema & taxonomies
// ---------------------------------------------------------------------------

export const CANDIDATE_INTEGRITY_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_INTEGRITY_EVENT_TYPE = "candidate_integrity" as const;
export const CANDIDATE_INTEGRITY_DIR = "candidate-integrity";
export const CANDIDATE_INTEGRITY_ACTIVE_FILE = "active.json";
/** Default extra mutations after first expansion/unverified in a surface generation. */
export const DEFAULT_INTEGRITY_RETRY_BUDGET = 2;

export type PatchStatus = "A" | "M" | "D" | "R" | "C";

export type IntegrityClassification =
  | "semantically_equivalent"
  | "expected_scoped_change"
  | "scope_expansion"
  | "unverified";

export type MutationMethod =
  | "restack"
  | "rebase"
  | "conflict_repair"
  | "pre_merge_autofix"
  | "recovery_repair";

export type LifecycleState =
  | "idle"
  | "pre_persisted"
  | "mutation_claimed"
  | "authoritative_post_read"
  | "classified"
  | "disposed";

/** Methods that MUST use empty declared scope (any delta is expansion). */
export const EMPTY_SCOPE_METHODS: ReadonlySet<MutationMethod> = new Set([
  "restack",
  "rebase",
]);

/** Closed set of Covered call-site module identifiers (contract test). */
export const COVERED_MUTATION_SITES = [
  "stages/merge-queue.ts:runDeterministicConflictRebase",
  "stages/merge-queue.ts:runSharedMechanicalRepair",
  "stages/pre-merge-conflict-rebase.ts:recoverFromMergeConflict",
  "stages/pre-merge-ci-gate.ts:handleDefinitiveCiFailure",
  "stages/pre-merge-autofix.ts:performPreMergeAutoFix",
  "loop/repair-pipeline-item.ts:createRepairPipelineItemExecutor",
] as const;

export type CoveredMutationSite = (typeof COVERED_MUTATION_SITES)[number];

/** Documented out-of-scope head-moving paths (inventory D7). */
export const OUT_OF_SCOPE_MUTATION_SITES = [
  "stages/fix.ts — developer/fix commits already invalidate review-SHA",
  "stages/planning.ts — creates initial candidate; no pre-approved surface",
  "stages/pre-merge-openspec-archive.ts — pipeline-internal commit class",
  "stages/eval.ts / stages/visual.ts — explicit content change forces re-review",
  "stages/intake.ts / sweep / backfill — no approved PR candidate surface",
  "roadmap/writeback.ts — roadmap delivery, not PR candidate restack",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanonicalPatchRecord {
  path: string;
  status: PatchStatus;
  /** Source path when status is R/C; null otherwise. */
  old_path: string | null;
  /** Base/preimage blob digest; null for pure adds. */
  base_blob: string | null;
  /** Candidate/postimage blob digest; null for pure deletes. */
  candidate_blob: string | null;
  /** Optional rename similarity when status is R. */
  similarity?: number;
  /** True when digests could not be completed for this path. */
  incomplete?: boolean;
}

export interface DeclaredRepairScope {
  /** Exact repo-relative paths (posix, no leading ./). */
  paths: string[];
  /** Directory prefixes ending with `/` (e.g. `core/test/`). */
  directories?: string[];
  reason?: string;
}

export interface CandidateIntegrityManifest {
  schema_version: typeof CANDIDATE_INTEGRITY_SCHEMA_VERSION;
  run_id: string;
  issue: number;
  pr: number | null;
  domain?: string;
  base_ref: string;
  base_sha: string;
  candidate_sha: string;
  entries: CanonicalPatchRecord[];
  declared_scope?: DeclaredRepairScope;
  /** Diagnostic-only size enrichments. */
  diff_size?: { lines?: number; bytes?: number };
  producer: {
    component: "candidate-integrity";
    engine_version?: string;
  };
  captured_at: string;
}

export type CandidateSideValue = string | "__DELETE__";

export interface ClassificationResult {
  classification: IntegrityClassification;
  reason: string;
  /** Paths that differ between pre and post candidate-side maps. */
  differing_paths: string[];
  /** Bounded path list for events. */
  changed_path_summary: string[];
}

export interface IntegrityDisposition {
  classification: IntegrityClassification;
  invalidated_review: boolean;
  invalidated_readiness: boolean;
  requires_fresh_review: boolean;
  re_evaluate_gates: boolean;
  invalidation_reason: string | null;
  /** Not a human-authority hold solely for integrity. */
  human_authority_hold: false;
  merge_eligible: boolean;
}

export interface IntegrityInvalidationRecord {
  from_sha: string;
  to_sha: string;
  mutation_id: string;
  classification: IntegrityClassification;
  invalidated_review: boolean;
  invalidated_readiness: boolean;
  requires_fresh_review: boolean;
  reason: string;
  mutation_method: MutationMethod;
  at: string;
}

export interface MutationRecord {
  schema_version: typeof CANDIDATE_INTEGRITY_SCHEMA_VERSION;
  mutation_id: string;
  lifecycle: LifecycleState;
  mutation_method: MutationMethod;
  subject: {
    run_id: string;
    issue: number;
    pr: number | null;
    domain?: string;
  };
  declared_scope: DeclaredRepairScope;
  pre_manifest: CandidateIntegrityManifest | null;
  post_manifest: CandidateIntegrityManifest | null;
  classification: IntegrityClassification | null;
  disposition: IntegrityDisposition | null;
  before_sha: string | null;
  after_sha: string | null;
  base_sha_before: string | null;
  base_sha_after: string | null;
  mutation_error?: string;
  created_at: string;
  updated_at: string;
}

export interface CandidateIntegrityEventPayload {
  schema_version: number;
  type: typeof CANDIDATE_INTEGRITY_EVENT_TYPE;
  at: string;
  mutation_id: string;
  mutation_method: MutationMethod;
  classification: IntegrityClassification;
  before_sha: string | null;
  after_sha: string | null;
  base_sha_before: string | null;
  base_sha_after: string | null;
  changed_path_summary: string[];
  invalidated_review: boolean;
  invalidated_readiness: boolean;
  invalidation_reason: string | null;
  path_class?: string;
  engine_version?: string;
  issue?: number;
  pr?: number | null;
}

export interface IntegritySubject {
  run_id: string;
  issue: number;
  pr?: number | null;
  domain?: string;
}

export interface AuthoritativeRefs {
  base_ref: string;
  base_sha: string;
  candidate_sha: string;
}

// ---------------------------------------------------------------------------
// Injected deps
// ---------------------------------------------------------------------------

export interface IntegrityStoreDeps {
  mkdir?: (p: string) => Promise<void>;
  writeFileAtomic?: (p: string, content: string) => Promise<void>;
  readTextFile?: (p: string) => Promise<string | null>;
  readdir?: (p: string) => Promise<string[]>;
  now?: () => Date;
  randomId?: () => string;
}

export interface ManifestCaptureDeps {
  /**
   * List changed paths between base and candidate as name-status records.
   * Prefer `git diff --name-status -z` / equivalent via injected git.
   */
  listChangedPaths: (
    baseSha: string,
    candidateSha: string,
  ) => Promise<
    Array<{
      status: PatchStatus;
      path: string;
      old_path?: string | null;
      similarity?: number;
    }>
  >;
  /**
   * Resolve blob OID at treeish:path. Return null when path absent.
   * Prefer `git rev-parse <treeish>:<path>` / `ls-tree`.
   */
  blobOid: (treeish: string, filePath: string) => Promise<string | null>;
  /** When true, mark entry incomplete instead of throwing. */
  onUnreadable?: (filePath: string, err: unknown) => void;
}

export interface RunCandidateMovingMutationOpts<T> {
  storeRoot: string;
  subject: IntegritySubject;
  mutation_method: MutationMethod;
  declared_scope?: DeclaredRepairScope;
  mutation_id?: string;
  /** Capture pre/post manifests from authoritative SHAs. */
  captureManifest: (
    refs: AuthoritativeRefs,
    phase: "pre" | "post",
  ) => Promise<CandidateIntegrityManifest>;
  /** Re-read authoritative PR head + base (required after mutation, even on error). */
  reReadAuthoritative: () => Promise<AuthoritativeRefs | null>;
  /** Initial authoritative refs before mutation (avoids double pre-read). */
  preRefs?: AuthoritativeRefs;
  /** The head-moving side effect. Must not start before pre_persisted. */
  mutate: () => Promise<T>;
  /** Optional event append (non-fatal for disposition). */
  emitEvent?: (event: CandidateIntegrityEventPayload) => Promise<void>;
  path_class?: string;
  engine_version?: string;
  storeDeps?: IntegrityStoreDeps;
  /** Retry budget for expansion/unverified (default 2 extra). */
  retryBudget?: number;
}

export interface RunCandidateMovingMutationResult<T> {
  ok: boolean;
  aborted: boolean;
  abort_reason?: string;
  mutation_result?: T;
  mutation_error?: string;
  classification: IntegrityClassification;
  disposition: IntegrityDisposition;
  mutation_id: string;
  record: MutationRecord;
  event: CandidateIntegrityEventPayload | null;
  /** True when retry budget for expansion/unverified is exhausted. */
  budget_exhausted: boolean;
}

// ---------------------------------------------------------------------------
// Pure: path normalization & scope matching
// ---------------------------------------------------------------------------

/** Normalize to repo-relative posix path without leading ./ or /. */
export function normalizeRepoPath(p: string): string {
  let s = p.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

export function emptyDeclaredScope(reason?: string): DeclaredRepairScope {
  return { paths: [], directories: [], reason };
}

export function freezeDeclaredScope(scope: DeclaredRepairScope | undefined): DeclaredRepairScope {
  const paths = (scope?.paths ?? []).map(normalizeRepoPath).filter(Boolean);
  const directories = (scope?.directories ?? [])
    .map((d) => {
      let n = normalizeRepoPath(d);
      if (n && !n.endsWith("/")) n = `${n}/`;
      return n;
    })
    .filter(Boolean);
  return {
    paths: [...paths].sort(),
    directories: [...directories].sort(),
    reason: scope?.reason,
  };
}

/** True when path matches exact paths or a directory prefix. */
export function pathInScope(filePath: string, scope: DeclaredRepairScope): boolean {
  const p = normalizeRepoPath(filePath);
  if (!p) return false;
  for (const exact of scope.paths) {
    if (p === exact) return true;
  }
  for (const dir of scope.directories ?? []) {
    if (dir && p.startsWith(dir)) return true;
  }
  return false;
}

/**
 * Rename is in scope only when both old and new paths match.
 * One-sided rename is expansion.
 */
export function renameInScope(
  oldPath: string | null | undefined,
  newPath: string,
  scope: DeclaredRepairScope,
): boolean {
  if (!oldPath) return pathInScope(newPath, scope);
  return pathInScope(oldPath, scope) && pathInScope(newPath, scope);
}

// ---------------------------------------------------------------------------
// Pure: candidate-side map & classification
// ---------------------------------------------------------------------------

/**
 * Candidate-side content map: path → candidate blob or DELETE marker.
 * For renames, keys the destination path; old path gets DELETE if needed for
 * identity (we key only final path; old_path is in the record for scope checks).
 */
export function candidateSideMap(
  manifest: CandidateIntegrityManifest | null | undefined,
): Map<string, CandidateSideValue> | null {
  if (!manifest) return null;
  const map = new Map<string, CandidateSideValue>();
  for (const e of manifest.entries) {
    const p = normalizeRepoPath(e.path);
    if (e.status === "D") {
      map.set(p, "__DELETE__");
    } else if (e.candidate_blob == null || e.incomplete) {
      // Incomplete digests poison the map for fail-closed comparison.
      return null;
    } else {
      map.set(p, e.candidate_blob);
      // Track rename source as delete of that path's candidate content only when
      // the source is not also listed separately — comparison uses final map.
      if ((e.status === "R" || e.status === "C") && e.old_path) {
        const old = normalizeRepoPath(e.old_path);
        if (old && !map.has(old)) {
          // Rename moves content: source is absent on candidate relative to base
          // only if not still present. We record old as DELETE for surface identity
          // when status is R (content moved away).
          map.set(old, "__DELETE__");
        }
      }
    }
  }
  return map;
}

function mapsEqual(
  a: Map<string, CandidateSideValue>,
  b: Map<string, CandidateSideValue>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function mapDiffPaths(
  pre: Map<string, CandidateSideValue>,
  post: Map<string, CandidateSideValue>,
): string[] {
  const paths = new Set<string>([...pre.keys(), ...post.keys()]);
  const differing: string[] = [];
  for (const p of paths) {
    if (pre.get(p) !== post.get(p)) differing.push(p);
  }
  return differing.sort();
}

function entryIncomplete(entries: CanonicalPatchRecord[]): boolean {
  return entries.some((e) => {
    if (e.incomplete === true) return true;
    // Deletes have null candidate_blob; adds have null base_blob.
    if (e.status === "D") return e.base_blob == null;
    if (e.status === "A") return e.candidate_blob == null;
    // M / R / C need both sides when present as complete digests.
    return e.candidate_blob == null || e.base_blob == null;
  });
}

/**
 * Classify pre → post candidate transition.
 * Raw size is diagnostic-only and never sole accept/reject criterion.
 */
export function classifyTransition(
  pre: CandidateIntegrityManifest | null | undefined,
  post: CandidateIntegrityManifest | null | undefined,
  declaredScope: DeclaredRepairScope,
  mutationMethod: MutationMethod,
): ClassificationResult {
  if (!pre) {
    return {
      classification: "unverified",
      reason: "missing pre-mutation manifest",
      differing_paths: [],
      changed_path_summary: [],
    };
  }
  if (!post) {
    return {
      classification: "unverified",
      reason: "missing post-mutation manifest",
      differing_paths: [],
      changed_path_summary: summarizePaths(pre.entries.map((e) => e.path)),
    };
  }
  if (entryIncomplete(pre.entries) || entryIncomplete(post.entries)) {
    return {
      classification: "unverified",
      reason: "incomplete digests (binary/unreadable path or missing OID)",
      differing_paths: [],
      changed_path_summary: summarizePaths(post.entries.map((e) => e.path)),
    };
  }

  const preMap = candidateSideMap(pre);
  const postMap = candidateSideMap(post);
  if (!preMap || !postMap) {
    return {
      classification: "unverified",
      reason: "could not build candidate-side map",
      differing_paths: [],
      changed_path_summary: summarizePaths(post.entries.map((e) => e.path)),
    };
  }

  if (mapsEqual(preMap, postMap)) {
    return {
      classification: "semantically_equivalent",
      reason: "candidate-side path→blob map identical",
      differing_paths: [],
      changed_path_summary: summarizePaths([...postMap.keys()]),
    };
  }

  const differing = mapDiffPaths(preMap, postMap);
  const scope = freezeDeclaredScope(declaredScope);

  // restack/rebase cannot use non-empty scope to hide expansion
  if (EMPTY_SCOPE_METHODS.has(mutationMethod)) {
    return {
      classification: "scope_expansion",
      reason: `${mutationMethod}: candidate-side map changed with empty declared scope (${differing.join(", ")})`,
      differing_paths: differing,
      changed_path_summary: summarizePaths(differing),
    };
  }

  if (scope.paths.length === 0 && (scope.directories?.length ?? 0) === 0) {
    return {
      classification: "scope_expansion",
      reason: `undeclared candidate-side delta with empty scope: ${differing.join(", ")}`,
      differing_paths: differing,
      changed_path_summary: summarizePaths(differing),
    };
  }

  // Check each differing path (and rename pairs from post entries) against scope.
  const outOfScope: string[] = [];
  for (const p of differing) {
    // Find rename records involving this path
    const postEntry = post.entries.find(
      (e) => normalizeRepoPath(e.path) === p || normalizeRepoPath(e.old_path ?? "") === p,
    );
    if (postEntry && (postEntry.status === "R" || postEntry.status === "C")) {
      if (!renameInScope(postEntry.old_path, postEntry.path, scope)) {
        outOfScope.push(p);
        continue;
      }
    } else if (!pathInScope(p, scope)) {
      outOfScope.push(p);
    }
  }

  if (outOfScope.length > 0) {
    return {
      classification: "scope_expansion",
      reason: `undeclared path/content change outside scope: ${outOfScope.join(", ")}`,
      differing_paths: differing,
      changed_path_summary: summarizePaths(differing),
    };
  }

  return {
    classification: "expected_scoped_change",
    reason: `all differing paths within declared scope: ${differing.join(", ")}`,
    differing_paths: differing,
    changed_path_summary: summarizePaths(differing),
  };
}

const SUMMARY_PATH_LIMIT = 32;

export function summarizePaths(paths: string[]): string[] {
  const uniq = [...new Set(paths.map(normalizeRepoPath).filter(Boolean))].sort();
  if (uniq.length <= SUMMARY_PATH_LIMIT) return uniq;
  return [...uniq.slice(0, SUMMARY_PATH_LIMIT - 1), `…+${uniq.length - (SUMMARY_PATH_LIMIT - 1)} more`];
}

/**
 * Disposition matrix (design D5).
 * Semantic equivalence re-evaluates gates and does NOT preserve ready-to-deploy.
 * Expansion/unverified invalidate review+readiness; never human hold; not merge-eligible.
 * Expected scoped change requires fresh review.
 */
export function dispositionForClassification(
  classification: IntegrityClassification,
  opts: {
    shaChanged: boolean;
    classificationReason: string;
  },
): IntegrityDisposition {
  switch (classification) {
    case "semantically_equivalent":
      return {
        classification,
        invalidated_review: false,
        invalidated_readiness: opts.shaChanged, // prior ready-to-deploy claim must not carry
        requires_fresh_review: false,
        re_evaluate_gates: true,
        invalidation_reason: opts.shaChanged
          ? "semantically_equivalent: re-evaluate current-head gates; readiness not auto-preserved"
          : null,
        human_authority_hold: false,
        merge_eligible: true, // re-gate may still fail on CI/review
      };
    case "expected_scoped_change":
      return {
        classification,
        invalidated_review: true,
        invalidated_readiness: true,
        requires_fresh_review: true,
        re_evaluate_gates: true,
        invalidation_reason:
          opts.classificationReason ||
          "expected_scoped_change: fresh review required at new SHA",
        human_authority_hold: false,
        merge_eligible: false,
      };
    case "scope_expansion":
      return {
        classification,
        invalidated_review: true,
        invalidated_readiness: true,
        requires_fresh_review: true,
        re_evaluate_gates: true,
        invalidation_reason:
          opts.classificationReason || "scope_expansion: prior review not readiness authority",
        human_authority_hold: false,
        merge_eligible: false,
      };
    case "unverified":
      return {
        classification,
        invalidated_review: true,
        invalidated_readiness: true,
        requires_fresh_review: true,
        re_evaluate_gates: true,
        invalidation_reason:
          opts.classificationReason || "unverified: fail closed",
        human_authority_hold: false,
        merge_eligible: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

export async function buildManifestFromDeps(
  subject: IntegritySubject,
  refs: AuthoritativeRefs,
  capture: ManifestCaptureDeps,
  opts: {
    declared_scope?: DeclaredRepairScope;
    engine_version?: string;
    now?: () => Date;
  } = {},
): Promise<CandidateIntegrityManifest> {
  const now = opts.now ?? (() => new Date());
  let listed: Awaited<ReturnType<ManifestCaptureDeps["listChangedPaths"]>>;
  try {
    listed = await capture.listChangedPaths(refs.base_sha, refs.candidate_sha);
  } catch (err) {
    capture.onUnreadable?.("(list)", err);
    return {
      schema_version: CANDIDATE_INTEGRITY_SCHEMA_VERSION,
      run_id: subject.run_id,
      issue: subject.issue,
      pr: subject.pr ?? null,
      domain: subject.domain,
      base_ref: refs.base_ref,
      base_sha: refs.base_sha,
      candidate_sha: refs.candidate_sha,
      entries: [{ path: "__list_failed__", status: "M", old_path: null, base_blob: null, candidate_blob: null, incomplete: true }],
      declared_scope: opts.declared_scope ? freezeDeclaredScope(opts.declared_scope) : undefined,
      producer: { component: "candidate-integrity", engine_version: opts.engine_version },
      captured_at: now().toISOString(),
    };
  }

  const entries: CanonicalPatchRecord[] = [];
  for (const item of listed) {
    const filePath = normalizeRepoPath(item.path);
    const oldPath = item.old_path ? normalizeRepoPath(item.old_path) : null;
    let base_blob: string | null = null;
    let candidate_blob: string | null = null;
    let incomplete = false;

    try {
      if (item.status === "A") {
        base_blob = null;
        candidate_blob = await capture.blobOid(refs.candidate_sha, filePath);
        if (candidate_blob == null) incomplete = true;
      } else if (item.status === "D") {
        const basePath = oldPath ?? filePath;
        base_blob = await capture.blobOid(refs.base_sha, basePath);
        candidate_blob = null;
        if (base_blob == null) incomplete = true;
      } else if (item.status === "R" || item.status === "C") {
        base_blob = oldPath
          ? await capture.blobOid(refs.base_sha, oldPath)
          : await capture.blobOid(refs.base_sha, filePath);
        candidate_blob = await capture.blobOid(refs.candidate_sha, filePath);
        if (base_blob == null || candidate_blob == null) incomplete = true;
      } else {
        // M or other
        base_blob = await capture.blobOid(refs.base_sha, filePath);
        candidate_blob = await capture.blobOid(refs.candidate_sha, filePath);
        if (base_blob == null || candidate_blob == null) incomplete = true;
      }
    } catch (err) {
      capture.onUnreadable?.(filePath, err);
      incomplete = true;
    }

    entries.push({
      path: filePath,
      status: item.status,
      old_path: oldPath,
      base_blob,
      candidate_blob,
      similarity: item.similarity,
      incomplete: incomplete || undefined,
    });
  }

  return {
    schema_version: CANDIDATE_INTEGRITY_SCHEMA_VERSION,
    run_id: subject.run_id,
    issue: subject.issue,
    pr: subject.pr ?? null,
    domain: subject.domain,
    base_ref: refs.base_ref,
    base_sha: refs.base_sha,
    candidate_sha: refs.candidate_sha,
    entries,
    declared_scope: opts.declared_scope ? freezeDeclaredScope(opts.declared_scope) : undefined,
    producer: { component: "candidate-integrity", engine_version: opts.engine_version },
    captured_at: now().toISOString(),
  };
}

/**
 * Default git-backed capture deps (production). Unit tests inject fakes —
 * never call this from unit tests that ban real git.
 */
export function defaultManifestCaptureDeps(
  git: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): ManifestCaptureDeps {
  return {
    async listChangedPaths(baseSha, candidateSha) {
      const res = await git([
        "diff",
        "--name-status",
        "--find-renames",
        `${baseSha}...${candidateSha}`,
      ]);
      if (res.code !== 0) {
        throw new Error(`git diff name-status failed: ${res.stderr || res.stdout}`);
      }
      const out: Array<{
        status: PatchStatus;
        path: string;
        old_path?: string | null;
        similarity?: number;
      }> = [];
      for (const line of res.stdout.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const statusRaw = parts[0] ?? "";
        const statusChar = statusRaw.charAt(0);
        // Fail closed: unsupported (e.g. T type-change), empty, or malformed
        // name-status records must not be omitted — omission can yield a false
        // semantically_equivalent map when undeclared surface exists.
        if (!statusChar || !"AMDRC".includes(statusChar)) {
          throw new Error(
            `unsupported or malformed git name-status record: ${JSON.stringify(line)}`,
          );
        }
        if (statusChar === "R" || statusChar === "C") {
          const sim = parseInt(statusRaw.slice(1), 10);
          const oldPath = parts[1] ?? "";
          const newPath = parts[2] ?? "";
          if (!oldPath || !newPath) {
            throw new Error(
              `malformed rename/copy name-status (missing path): ${JSON.stringify(line)}`,
            );
          }
          out.push({
            status: statusChar as PatchStatus,
            old_path: oldPath,
            path: newPath,
            similarity: Number.isFinite(sim) ? sim : undefined,
          });
        } else {
          const filePath = parts[1] ?? "";
          if (!filePath) {
            throw new Error(
              `malformed name-status (missing path): ${JSON.stringify(line)}`,
            );
          }
          out.push({ status: statusChar as PatchStatus, path: filePath, old_path: null });
        }
      }
      return out;
    },
    async blobOid(treeish, filePath) {
      const res = await git(["rev-parse", "--verify", `${treeish}:${filePath}`]);
      if (res.code !== 0) return null;
      const oid = res.stdout.trim();
      return /^[0-9a-f]{40,64}$/i.test(oid) ? oid.toLowerCase() : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Durable store (atomic temp+fsync+rename)
// ---------------------------------------------------------------------------

export function integrityDir(storeRoot: string): string {
  return path.join(storeRoot, CANDIDATE_INTEGRITY_DIR);
}

export function mutationRecordPath(storeRoot: string, mutationId: string): string {
  const safe = mutationId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return path.join(integrityDir(storeRoot), `${safe}.json`);
}

export function activePointerPath(storeRoot: string): string {
  return path.join(integrityDir(storeRoot), CANDIDATE_INTEGRITY_ACTIVE_FILE);
}

export function invalidationsPath(storeRoot: string): string {
  return path.join(integrityDir(storeRoot), "invalidations.jsonl");
}

export function budgetStatePath(storeRoot: string, issue: number, pr: number | null): string {
  const key = pr != null ? `issue-${issue}-pr-${pr}` : `issue-${issue}`;
  return path.join(integrityDir(storeRoot), `budget-${key}.json`);
}

async function defaultWriteFileAtomic(p: string, content: string): Promise<void> {
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${crypto.randomUUID()}.tmp`);
  const fh = await fsp.open(tmp, "wx");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function defaultReadTextFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function resolveStoreDeps(deps: IntegrityStoreDeps = {}): Required<
  Pick<IntegrityStoreDeps, "mkdir" | "writeFileAtomic" | "readTextFile" | "readdir" | "now" | "randomId">
> {
  return {
    mkdir: deps.mkdir ?? (async (p) => {
      await fsp.mkdir(p, { recursive: true });
    }),
    writeFileAtomic: deps.writeFileAtomic ?? defaultWriteFileAtomic,
    readTextFile: deps.readTextFile ?? defaultReadTextFile,
    readdir: deps.readdir ?? (async (p) => {
      try {
        return await fsp.readdir(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    }),
    now: deps.now ?? (() => new Date()),
    randomId: deps.randomId ?? (() => crypto.randomUUID()),
  };
}

export async function persistMutationRecord(
  storeRoot: string,
  record: MutationRecord,
  deps: IntegrityStoreDeps = {},
): Promise<void> {
  const d = resolveStoreDeps(deps);
  await d.mkdir(integrityDir(storeRoot));
  const filePath = mutationRecordPath(storeRoot, record.mutation_id);
  await d.writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
  // Active pointer for in-flight mutations
  if (
    record.lifecycle === "pre_persisted" ||
    record.lifecycle === "mutation_claimed" ||
    record.lifecycle === "authoritative_post_read"
  ) {
    await d.writeFileAtomic(
      activePointerPath(storeRoot),
      `${JSON.stringify({ mutation_id: record.mutation_id, issue: record.subject.issue, pr: record.subject.pr, updated_at: record.updated_at })}\n`,
    );
  }
}

export async function loadMutationRecord(
  storeRoot: string,
  mutationId: string,
  deps: IntegrityStoreDeps = {},
): Promise<MutationRecord | null> {
  const d = resolveStoreDeps(deps);
  const raw = await d.readTextFile(mutationRecordPath(storeRoot, mutationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MutationRecord;
  } catch {
    return null;
  }
}

export async function loadActiveMutationId(
  storeRoot: string,
  deps: IntegrityStoreDeps = {},
): Promise<string | null> {
  const d = resolveStoreDeps(deps);
  const raw = await d.readTextFile(activePointerPath(storeRoot));
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { mutation_id?: string };
    return typeof obj.mutation_id === "string" ? obj.mutation_id : null;
  } catch {
    return null;
  }
}

export async function appendInvalidationRecord(
  storeRoot: string,
  inv: IntegrityInvalidationRecord,
  deps: IntegrityStoreDeps = {},
): Promise<void> {
  const d = resolveStoreDeps(deps);
  await d.mkdir(integrityDir(storeRoot));
  const p = invalidationsPath(storeRoot);
  // Atomic append via read-modify-write of full file for small invalidation logs.
  const existing = (await d.readTextFile(p)) ?? "";
  await d.writeFileAtomic(p, `${existing}${JSON.stringify(inv)}\n`);
}

export async function loadInvalidationRecords(
  storeRoot: string,
  deps: IntegrityStoreDeps = {},
): Promise<IntegrityInvalidationRecord[]> {
  const d = resolveStoreDeps(deps);
  const raw = await d.readTextFile(invalidationsPath(storeRoot));
  if (!raw) return [];
  const out: IntegrityInvalidationRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as IntegrityInvalidationRecord);
    } catch {
      // skip corrupt
    }
  }
  return out;
}

/**
 * Derive invalidation rows from durable mutation records (classified/disposed).
 * Mutation-record disposition is authoritative control-plane state; the JSONL
 * index is a convenience. Restart-time gates must still block when only the
 * mutation record was persisted.
 */
export async function invalidationsFromMutationRecords(
  storeRoot: string,
  deps: IntegrityStoreDeps = {},
): Promise<IntegrityInvalidationRecord[]> {
  const d = resolveStoreDeps(deps);
  const names = await d.readdir(integrityDir(storeRoot));
  const out: IntegrityInvalidationRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name === CANDIDATE_INTEGRITY_ACTIVE_FILE) continue;
    if (name.startsWith("budget-")) continue;
    const raw = await d.readTextFile(path.join(integrityDir(storeRoot), name));
    if (!raw) continue;
    let rec: MutationRecord;
    try {
      rec = JSON.parse(raw) as MutationRecord;
    } catch {
      continue;
    }
    if (!rec?.mutation_id || !rec.disposition) continue;
    if (rec.lifecycle !== "classified" && rec.lifecycle !== "disposed") continue;
    const disp = rec.disposition;
    if (
      !disp.invalidated_review &&
      !disp.invalidated_readiness &&
      !disp.requires_fresh_review
    ) {
      continue;
    }
    out.push({
      from_sha: rec.before_sha ?? "",
      to_sha: rec.after_sha ?? rec.before_sha ?? "",
      mutation_id: rec.mutation_id,
      classification: rec.classification ?? "unverified",
      invalidated_review: disp.invalidated_review,
      invalidated_readiness: disp.invalidated_readiness,
      requires_fresh_review: disp.requires_fresh_review,
      reason:
        disp.invalidation_reason ?? rec.classification ?? "integrity disposition",
      mutation_method: rec.mutation_method,
      at: rec.updated_at,
    });
  }
  return out;
}

/**
 * Authoritative invalidations: JSONL index unioned with mutation-record
 * dispositions so restart gates cannot miss a durable classified invalidation.
 */
export async function loadAuthoritativeInvalidationRecords(
  storeRoot: string,
  deps: IntegrityStoreDeps = {},
): Promise<IntegrityInvalidationRecord[]> {
  const fromJsonl = await loadInvalidationRecords(storeRoot, deps);
  const fromMut = await invalidationsFromMutationRecords(storeRoot, deps);
  const seen = new Set(fromJsonl.map((r) => `${r.mutation_id}|${r.to_sha}`));
  const merged = [...fromJsonl];
  for (const r of fromMut) {
    const k = `${r.mutation_id}|${r.to_sha}`;
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(r);
    }
  }
  return merged;
}

/**
 * Persist classified disposition and, when invalidating, the invalidation index.
 * Both writes are authoritative and required — callers must not continue as if
 * the control-plane disposition is durable when either fails.
 */
export async function persistClassifiedDisposition(
  storeRoot: string,
  record: MutationRecord,
  inv: IntegrityInvalidationRecord | null,
  deps: IntegrityStoreDeps = {},
): Promise<void> {
  await persistMutationRecord(storeRoot, record, deps);
  if (inv) {
    await appendInvalidationRecord(storeRoot, inv, deps);
  }
}

/**
 * Whether durable integrity invalidation blocks reuse of review evidence for
 * `candidateSha`. Invalidation rejects *pre-mutation* evidence only — not a
 * permanent ban on the post-mutation head.
 *
 * A post-mutation candidate SHA did not exist before the mutation that produced
 * it, so evidence bound to `reviewedSha === candidateSha === to_sha` postdates
 * the invalidating transition and satisfies the fresh-review path. Historical
 * invalidation records remain durable diagnostics.
 */
export function reviewBlockedByIntegrityInvalidation(
  records: IntegrityInvalidationRecord[],
  candidateSha: string,
  reviewedSha?: string | null,
): IntegrityInvalidationRecord | null {
  const head = candidateSha.toLowerCase();
  const reviewed = reviewedSha?.toLowerCase() ?? null;
  // Newest last wins
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (!r.invalidated_review && !r.requires_fresh_review) continue;
    const to = r.to_sha.toLowerCase();
    const from = r.from_sha.toLowerCase();

    // Fresh review bound to the post-mutation head supersedes this invalidation.
    if (reviewed && reviewed === head && to === head) {
      continue;
    }

    // Current head is the invalidated post-mutation SHA without B-bound review.
    if (to === head) return r;

    // Reviewed pre-mutation SHA while head moved away from that review.
    if (
      reviewed &&
      from === reviewed &&
      head !== reviewed &&
      (r.classification === "scope_expansion" ||
        r.classification === "unverified" ||
        r.classification === "expected_scoped_change")
    ) {
      return r;
    }
  }
  return null;
}

/**
 * Whether durable integrity invalidation blocks readiness for `candidateSha`.
 * Invalidation rejects pre-mutation readiness authority only — not a permanent
 * ban on the post-mutation head.
 *
 * When `reviewedSha` equals the current head and that head is the invalidation
 * `to_sha`, B-bound review evidence supersedes the historical invalidation for
 * readiness re-earn (normal current-head gates still apply separately).
 */
export function readinessBlockedByIntegrityInvalidation(
  records: IntegrityInvalidationRecord[],
  candidateSha: string,
  reviewedSha?: string | null,
): IntegrityInvalidationRecord | null {
  const head = candidateSha.toLowerCase();
  const reviewed = reviewedSha?.toLowerCase() ?? null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (!r.invalidated_readiness) continue;
    const to = r.to_sha.toLowerCase();
    if (to !== head) continue;
    // B-bound review postdates the mutation that created `to_sha`.
    if (reviewed && reviewed === head) continue;
    return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Retry budget
// ---------------------------------------------------------------------------

export interface IntegrityBudgetState {
  issue: number;
  pr: number | null;
  /** Failures (expansion/unverified) in the current surface generation. */
  failure_count: number;
  /** Max additional mutations after first failure (default 2). */
  max_extra: number;
  last_classification?: IntegrityClassification;
  updated_at: string;
}

export async function loadBudgetState(
  storeRoot: string,
  issue: number,
  pr: number | null,
  deps: IntegrityStoreDeps = {},
): Promise<IntegrityBudgetState> {
  const d = resolveStoreDeps(deps);
  const raw = await d.readTextFile(budgetStatePath(storeRoot, issue, pr));
  if (!raw) {
    return {
      issue,
      pr,
      failure_count: 0,
      max_extra: DEFAULT_INTEGRITY_RETRY_BUDGET,
      updated_at: d.now().toISOString(),
    };
  }
  try {
    return JSON.parse(raw) as IntegrityBudgetState;
  } catch {
    return {
      issue,
      pr,
      failure_count: 0,
      max_extra: DEFAULT_INTEGRITY_RETRY_BUDGET,
      updated_at: d.now().toISOString(),
    };
  }
}

export async function recordBudgetFailure(
  storeRoot: string,
  issue: number,
  pr: number | null,
  classification: IntegrityClassification,
  deps: IntegrityStoreDeps = {},
  maxExtra = DEFAULT_INTEGRITY_RETRY_BUDGET,
): Promise<{ state: IntegrityBudgetState; exhausted: boolean }> {
  const d = resolveStoreDeps(deps);
  const state = await loadBudgetState(storeRoot, issue, pr, deps);
  state.failure_count += 1;
  state.last_classification = classification;
  state.max_extra = maxExtra;
  state.updated_at = d.now().toISOString();
  await d.mkdir(integrityDir(storeRoot));
  await d.writeFileAtomic(budgetStatePath(storeRoot, issue, pr), `${JSON.stringify(state, null, 2)}\n`);
  // Exhausted after first failure + N extra mutations (default N=2 → stop at count >= 3)
  const exhausted = state.failure_count >= 1 + maxExtra;
  return { state, exhausted };
}

export function isBudgetExhausted(state: IntegrityBudgetState): boolean {
  return state.failure_count >= 1 + state.max_extra;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function buildCandidateIntegrityEvent(opts: {
  mutation_id: string;
  mutation_method: MutationMethod;
  classification: IntegrityClassification;
  before_sha: string | null;
  after_sha: string | null;
  base_sha_before: string | null;
  base_sha_after: string | null;
  changed_path_summary: string[];
  disposition: IntegrityDisposition;
  path_class?: string;
  engine_version?: string;
  issue?: number;
  pr?: number | null;
  at?: string;
}): CandidateIntegrityEventPayload {
  return {
    schema_version: RUN_SCHEMA_VERSION,
    type: CANDIDATE_INTEGRITY_EVENT_TYPE,
    at: opts.at ?? new Date().toISOString(),
    mutation_id: opts.mutation_id,
    mutation_method: opts.mutation_method,
    classification: opts.classification,
    before_sha: opts.before_sha,
    after_sha: opts.after_sha,
    base_sha_before: opts.base_sha_before,
    base_sha_after: opts.base_sha_after,
    changed_path_summary: opts.changed_path_summary,
    invalidated_review: opts.disposition.invalidated_review,
    invalidated_readiness: opts.disposition.invalidated_readiness,
    invalidation_reason: opts.disposition.invalidation_reason,
    path_class: opts.path_class,
    engine_version: opts.engine_version,
    issue: opts.issue,
    pr: opts.pr,
  };
}

/** Append candidate_integrity event to run ledger (non-fatal). */
export async function emitCandidateIntegrityEvent(
  runDir: string,
  event: CandidateIntegrityEventPayload,
  runStoreDeps?: RunStoreDeps,
): Promise<boolean> {
  try {
    return await appendEvent(runDir, event as unknown as Parameters<typeof appendEvent>[1], runStoreDeps);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle wrapper
// ---------------------------------------------------------------------------

/**
 * Mandatory lifecycle: pre_persisted → mutation_claimed → authoritative_post_read
 * → classified → disposed.
 *
 * Pre-persist failure aborts mutation (no head-moving side effect).
 * Mutation error still forces post-read + classify (or unverified).
 * Never reseeds pre-manifest from post head.
 */
export async function runCandidateMovingMutation<T>(
  opts: RunCandidateMovingMutationOpts<T>,
): Promise<RunCandidateMovingMutationResult<T>> {
  const d = resolveStoreDeps(opts.storeDeps);
  const mutationId = opts.mutation_id ?? d.randomId();
  const scope = freezeDeclaredScope(
    EMPTY_SCOPE_METHODS.has(opts.mutation_method)
      ? emptyDeclaredScope("restack/rebase must use empty scope")
      : opts.declared_scope,
  );
  const nowIso = () => d.now().toISOString();

  let record: MutationRecord = {
    schema_version: CANDIDATE_INTEGRITY_SCHEMA_VERSION,
    mutation_id: mutationId,
    lifecycle: "idle",
    mutation_method: opts.mutation_method,
    subject: {
      run_id: opts.subject.run_id,
      issue: opts.subject.issue,
      pr: opts.subject.pr ?? null,
      domain: opts.subject.domain,
    },
    declared_scope: scope,
    pre_manifest: null,
    post_manifest: null,
    classification: null,
    disposition: null,
    before_sha: null,
    after_sha: null,
    base_sha_before: null,
    base_sha_after: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  // --- pre_persisted ---
  let preRefs = opts.preRefs;
  try {
    if (!preRefs) {
      preRefs = (await opts.reReadAuthoritative()) ?? undefined;
    }
    if (!preRefs) {
      return abortResult(record, "could not read authoritative head/base before mutation", d, opts);
    }
    const preManifest = await opts.captureManifest(preRefs, "pre");
    // Freeze scope into pre-manifest
    preManifest.declared_scope = scope;
    record.pre_manifest = preManifest;
    record.before_sha = preRefs.candidate_sha;
    record.base_sha_before = preRefs.base_sha;
    record.lifecycle = "pre_persisted";
    record.updated_at = nowIso();
    await persistMutationRecord(opts.storeRoot, record, opts.storeDeps);
  } catch (err) {
    return abortResult(
      record,
      `pre-persist failed: ${(err as Error).message}`,
      d,
      opts,
    );
  }

  // Budget check before claiming mutation
  const budget = await loadBudgetState(
    opts.storeRoot,
    opts.subject.issue,
    opts.subject.pr ?? null,
    opts.storeDeps,
  );
  const maxExtra = opts.retryBudget ?? DEFAULT_INTEGRITY_RETRY_BUDGET;
  budget.max_extra = maxExtra;
  if (isBudgetExhausted(budget)) {
    const classification: IntegrityClassification = "unverified";
    const disposition = dispositionForClassification(classification, {
      shaChanged: false,
      classificationReason: "integrity retry budget exhausted; automatic mutation stopped",
    });
    record.classification = classification;
    record.disposition = disposition;
    record.lifecycle = "disposed";
    record.updated_at = nowIso();
    await persistMutationRecord(opts.storeRoot, record, opts.storeDeps).catch(() => {});
    return {
      ok: false,
      aborted: true,
      abort_reason: "integrity retry budget exhausted",
      classification,
      disposition,
      mutation_id: mutationId,
      record,
      event: null,
      budget_exhausted: true,
    };
  }

  // --- mutation_claimed ---
  record.lifecycle = "mutation_claimed";
  record.updated_at = nowIso();
  try {
    await persistMutationRecord(opts.storeRoot, record, opts.storeDeps);
  } catch (err) {
    // Claim persist failed — abort mutation (claim-before-side-effect)
    return abortResult(
      record,
      `mutation_claimed persist failed: ${(err as Error).message}`,
      d,
      opts,
    );
  }

  let mutationResult: T | undefined;
  let mutationError: string | undefined;
  try {
    mutationResult = await opts.mutate();
  } catch (err) {
    mutationError = (err as Error).message;
    record.mutation_error = mutationError;
  }

  // --- authoritative_post_read (even on mutation error) ---
  record.lifecycle = "authoritative_post_read";
  record.updated_at = nowIso();
  let postRefs: AuthoritativeRefs | null = null;
  try {
    postRefs = await opts.reReadAuthoritative();
    await persistMutationRecord(opts.storeRoot, record, opts.storeDeps);
  } catch {
    // continue to classify as unverified
  }

  // --- classified ---
  let classificationResult: ClassificationResult;
  let postManifest: CandidateIntegrityManifest | null = null;

  if (!postRefs) {
    classificationResult = {
      classification: "unverified",
      reason: mutationError
        ? `mutation error and unreadable post head: ${mutationError}`
        : "authoritative post head/base unreadable",
      differing_paths: [],
      changed_path_summary: [],
    };
  } else {
    record.after_sha = postRefs.candidate_sha;
    record.base_sha_after = postRefs.base_sha;
    try {
      postManifest = await opts.captureManifest(postRefs, "post");
      postManifest.declared_scope = scope;
      record.post_manifest = postManifest;
      classificationResult = classifyTransition(
        record.pre_manifest,
        postManifest,
        scope,
        opts.mutation_method,
      );
    } catch (err) {
      classificationResult = {
        classification: "unverified",
        reason: `post-manifest capture failed: ${(err as Error).message}`,
        differing_paths: [],
        changed_path_summary: [],
      };
    }
  }

  // No-op autofix: SHA unchanged and maps equal (or no post movement) — don't invent expansion
  if (
    !mutationError &&
    record.before_sha &&
    record.after_sha &&
    record.before_sha === record.after_sha &&
    classificationResult.classification === "scope_expansion" &&
    classificationResult.differing_paths.length === 0
  ) {
    classificationResult = {
      classification: "semantically_equivalent",
      reason: "no-op: candidate SHA and surface unchanged",
      differing_paths: [],
      changed_path_summary: classificationResult.changed_path_summary,
    };
  }

  const shaChanged =
    !!record.before_sha &&
    !!record.after_sha &&
    record.before_sha !== record.after_sha;

  const disposition = dispositionForClassification(classificationResult.classification, {
    shaChanged,
    classificationReason: classificationResult.reason,
  });

  record.classification = classificationResult.classification;
  record.disposition = disposition;
  record.lifecycle = "classified";
  record.updated_at = nowIso();

  // --- disposed: invalidation records + events + budget ---
  let budgetExhausted = false;
  if (
    classificationResult.classification === "scope_expansion" ||
    classificationResult.classification === "unverified"
  ) {
    const br = await recordBudgetFailure(
      opts.storeRoot,
      opts.subject.issue,
      opts.subject.pr ?? null,
      classificationResult.classification,
      opts.storeDeps,
      maxExtra,
    );
    budgetExhausted = br.exhausted;
  }

  const inv: IntegrityInvalidationRecord | null =
    disposition.invalidated_review || disposition.invalidated_readiness
      ? {
          from_sha: record.before_sha ?? "",
          to_sha: record.after_sha ?? record.before_sha ?? "",
          mutation_id: mutationId,
          classification: classificationResult.classification,
          invalidated_review: disposition.invalidated_review,
          invalidated_readiness: disposition.invalidated_readiness,
          requires_fresh_review: disposition.requires_fresh_review,
          reason: disposition.invalidation_reason ?? classificationResult.reason,
          mutation_method: opts.mutation_method,
          at: nowIso(),
        }
      : null;

  // Authoritative durable disposition — required before returning control.
  // Event emission remains non-fatal; store writes are not.
  try {
    await persistClassifiedDisposition(opts.storeRoot, record, inv, opts.storeDeps);
  } catch (err) {
    const persistErr = `authoritative disposition persist failed: ${(err as Error).message}`;
    record.mutation_error = record.mutation_error
      ? `${record.mutation_error}; ${persistErr}`
      : persistErr;
    // Fail closed: do not return a reusable success path without durable state.
    // Escalating classification to unverified ensures merge/readiness stay blocked
    // even if only in-memory disposition is available to the caller.
    const failDisposition = dispositionForClassification("unverified", {
      shaChanged,
      classificationReason: persistErr,
    });
    record.classification = "unverified";
    record.disposition = failDisposition;
    // Best-effort last attempt to leave *some* durable signal (may also fail).
    await persistMutationRecord(opts.storeRoot, record, opts.storeDeps).catch(() => {});
    if (failDisposition.invalidated_review || failDisposition.invalidated_readiness) {
      await appendInvalidationRecord(
        opts.storeRoot,
        {
          from_sha: record.before_sha ?? "",
          to_sha: record.after_sha ?? record.before_sha ?? "",
          mutation_id: mutationId,
          classification: "unverified",
          invalidated_review: failDisposition.invalidated_review,
          invalidated_readiness: failDisposition.invalidated_readiness,
          requires_fresh_review: failDisposition.requires_fresh_review,
          reason: persistErr,
          mutation_method: opts.mutation_method,
          at: nowIso(),
        },
        opts.storeDeps,
      ).catch(() => {});
    }
    return {
      ok: false,
      aborted: false,
      mutation_result: mutationResult,
      mutation_error: persistErr,
      classification: "unverified",
      disposition: failDisposition,
      mutation_id: mutationId,
      record,
      event: null,
      budget_exhausted: budgetExhausted,
    };
  }

  const event = buildCandidateIntegrityEvent({
    mutation_id: mutationId,
    mutation_method: opts.mutation_method,
    classification: classificationResult.classification,
    before_sha: record.before_sha,
    after_sha: record.after_sha,
    base_sha_before: record.base_sha_before,
    base_sha_after: record.base_sha_after,
    changed_path_summary: classificationResult.changed_path_summary,
    disposition,
    path_class: opts.path_class,
    engine_version: opts.engine_version,
    issue: opts.subject.issue,
    pr: opts.subject.pr ?? null,
    at: nowIso(),
  });

  if (opts.emitEvent) {
    try {
      await opts.emitEvent(event);
    } catch {
      // non-fatal — disposition already durable
    }
  }

  record.lifecycle = "disposed";
  record.updated_at = nowIso();
  // Dispose marker is secondary once classified disposition is durable; keep
  // best-effort so a dispose-only write failure cannot undo invalidation.
  await persistMutationRecord(opts.storeRoot, record, opts.storeDeps).catch(() => {});

  return {
    ok: !mutationError && classificationResult.classification !== "unverified",
    aborted: false,
    mutation_result: mutationResult,
    mutation_error: mutationError,
    classification: classificationResult.classification,
    disposition,
    mutation_id: mutationId,
    record,
    event,
    budget_exhausted: budgetExhausted,
  };
}

function abortResult<T>(
  record: MutationRecord,
  reason: string,
  d: ReturnType<typeof resolveStoreDeps>,
  opts: RunCandidateMovingMutationOpts<T>,
): RunCandidateMovingMutationResult<T> {
  const disposition = dispositionForClassification("unverified", {
    shaChanged: false,
    classificationReason: reason,
  });
  record.lifecycle = "disposed";
  record.classification = "unverified";
  record.disposition = disposition;
  record.mutation_error = reason;
  record.updated_at = d.now().toISOString();
  // Best-effort persist of abort — if pre-persist itself failed, this may also fail
  void persistMutationRecord(opts.storeRoot, record, opts.storeDeps).catch(() => {});
  return {
    ok: false,
    aborted: true,
    abort_reason: reason,
    classification: "unverified",
    disposition,
    mutation_id: record.mutation_id,
    record,
    event: null,
    budget_exhausted: false,
  };
}

// ---------------------------------------------------------------------------
// Restart hydration
// ---------------------------------------------------------------------------

/**
 * Resume incomplete lifecycle for an active mutation without reseeding pre-manifest
 * from post head. Completes authoritative_post_read → classified → disposed when possible.
 */
export async function hydrateAndCompleteIncompleteMutation(opts: {
  storeRoot: string;
  mutation_id?: string;
  reReadAuthoritative: () => Promise<AuthoritativeRefs | null>;
  captureManifest: (
    refs: AuthoritativeRefs,
    phase: "pre" | "post",
  ) => Promise<CandidateIntegrityManifest>;
  emitEvent?: (event: CandidateIntegrityEventPayload) => Promise<void>;
  storeDeps?: IntegrityStoreDeps;
  path_class?: string;
  engine_version?: string;
}): Promise<RunCandidateMovingMutationResult<null> | null> {
  const d = resolveStoreDeps(opts.storeDeps);
  const mutationId =
    opts.mutation_id ?? (await loadActiveMutationId(opts.storeRoot, opts.storeDeps));
  if (!mutationId) return null;

  const existing = await loadMutationRecord(opts.storeRoot, mutationId, opts.storeDeps);
  if (!existing) return null;
  if (existing.lifecycle === "disposed" || existing.lifecycle === "classified") {
    return {
      ok: existing.classification !== "unverified" && existing.classification !== "scope_expansion",
      aborted: false,
      classification: existing.classification ?? "unverified",
      disposition:
        existing.disposition ??
        dispositionForClassification(existing.classification ?? "unverified", {
          shaChanged: true,
          classificationReason: "hydrated terminal record",
        }),
      mutation_id: mutationId,
      record: existing,
      event: null,
      budget_exhausted: false,
    };
  }

  // Incomplete: pre_persisted | mutation_claimed | authoritative_post_read
  // NEVER rebuild pre-manifest from post head.
  if (!existing.pre_manifest) {
    const disposition = dispositionForClassification("unverified", {
      shaChanged: true,
      classificationReason: "incomplete lifecycle with missing pre-manifest",
    });
    existing.lifecycle = "disposed";
    existing.classification = "unverified";
    existing.disposition = disposition;
    existing.updated_at = d.now().toISOString();
    await persistMutationRecord(opts.storeRoot, existing, opts.storeDeps);
    return {
      ok: false,
      aborted: false,
      classification: "unverified",
      disposition,
      mutation_id: mutationId,
      record: existing,
      event: null,
      budget_exhausted: false,
    };
  }

  const postRefs = await opts.reReadAuthoritative();
  existing.lifecycle = "authoritative_post_read";
  existing.updated_at = d.now().toISOString();

  let classificationResult: ClassificationResult;
  if (!postRefs) {
    classificationResult = {
      classification: "unverified",
      reason: "restart: authoritative post head unreadable",
      differing_paths: [],
      changed_path_summary: [],
    };
  } else {
    existing.after_sha = postRefs.candidate_sha;
    existing.base_sha_after = postRefs.base_sha;
    // If head already differs from pre without completed classification, classify.
    try {
      const postManifest = await opts.captureManifest(postRefs, "post");
      postManifest.declared_scope = existing.declared_scope;
      existing.post_manifest = postManifest;
      classificationResult = classifyTransition(
        existing.pre_manifest,
        postManifest,
        existing.declared_scope,
        existing.mutation_method,
      );
    } catch (err) {
      classificationResult = {
        classification: "unverified",
        reason: `restart post-manifest failed: ${(err as Error).message}`,
        differing_paths: [],
        changed_path_summary: [],
      };
    }
  }

  const shaChanged =
    !!existing.before_sha &&
    !!existing.after_sha &&
    existing.before_sha !== existing.after_sha;

  const disposition = dispositionForClassification(classificationResult.classification, {
    shaChanged,
    classificationReason: classificationResult.reason,
  });
  existing.classification = classificationResult.classification;
  existing.disposition = disposition;
  existing.lifecycle = "classified";
  existing.updated_at = d.now().toISOString();

  const inv: IntegrityInvalidationRecord | null =
    disposition.invalidated_review || disposition.invalidated_readiness
      ? {
          from_sha: existing.before_sha ?? "",
          to_sha: existing.after_sha ?? existing.before_sha ?? "",
          mutation_id: mutationId,
          classification: classificationResult.classification,
          invalidated_review: disposition.invalidated_review,
          invalidated_readiness: disposition.invalidated_readiness,
          requires_fresh_review: disposition.requires_fresh_review,
          reason: disposition.invalidation_reason ?? classificationResult.reason,
          mutation_method: existing.mutation_method,
          at: d.now().toISOString(),
        }
      : null;

  try {
    await persistClassifiedDisposition(opts.storeRoot, existing, inv, opts.storeDeps);
  } catch (err) {
    const persistErr = `authoritative disposition persist failed: ${(err as Error).message}`;
    const failDisposition = dispositionForClassification("unverified", {
      shaChanged,
      classificationReason: persistErr,
    });
    existing.classification = "unverified";
    existing.disposition = failDisposition;
    existing.mutation_error = persistErr;
    await persistMutationRecord(opts.storeRoot, existing, opts.storeDeps).catch(() => {});
    return {
      ok: false,
      aborted: false,
      classification: "unverified",
      disposition: failDisposition,
      mutation_id: mutationId,
      record: existing,
      event: null,
      budget_exhausted: false,
    };
  }

  const event = buildCandidateIntegrityEvent({
    mutation_id: mutationId,
    mutation_method: existing.mutation_method,
    classification: classificationResult.classification,
    before_sha: existing.before_sha,
    after_sha: existing.after_sha,
    base_sha_before: existing.base_sha_before,
    base_sha_after: existing.base_sha_after,
    changed_path_summary: classificationResult.changed_path_summary,
    disposition,
    path_class: opts.path_class,
    engine_version: opts.engine_version,
    issue: existing.subject.issue,
    pr: existing.subject.pr,
    at: d.now().toISOString(),
  });
  if (opts.emitEvent) {
    try {
      await opts.emitEvent(event);
    } catch {
      /* non-fatal */
    }
  }

  existing.lifecycle = "disposed";
  existing.updated_at = d.now().toISOString();
  await persistMutationRecord(opts.storeRoot, existing, opts.storeDeps).catch(() => {});

  return {
    ok: classificationResult.classification === "semantically_equivalent",
    aborted: false,
    classification: classificationResult.classification,
    disposition,
    mutation_id: mutationId,
    record: existing,
    event,
    budget_exhausted: false,
  };
}

// ---------------------------------------------------------------------------
// Gate helpers for SHA-gate / readiness composition
// ---------------------------------------------------------------------------

/**
 * Check whether prior review may authorize readiness for candidateSha given
 * durable integrity invalidations under storeRoot (typically runDir).
 */
export async function integrityBlocksReviewReuse(
  storeRoot: string | undefined,
  candidateSha: string,
  reviewedSha?: string | null,
  deps: IntegrityStoreDeps = {},
): Promise<IntegrityInvalidationRecord | null> {
  if (!storeRoot) return null;
  // Mutation-record disposition is authoritative; JSONL alone is not sufficient
  // after a best-effort index write failure or partial restart recovery.
  const records = await loadAuthoritativeInvalidationRecords(storeRoot, deps);
  return reviewBlockedByIntegrityInvalidation(records, candidateSha, reviewedSha);
}

export async function integrityBlocksReadiness(
  storeRoot: string | undefined,
  candidateSha: string,
  deps: IntegrityStoreDeps = {},
  /** When equal to candidateSha, B-bound review supersedes historical invalidation. */
  reviewedSha?: string | null,
): Promise<IntegrityInvalidationRecord | null> {
  if (!storeRoot) return null;
  const records = await loadAuthoritativeInvalidationRecords(storeRoot, deps);
  return readinessBlockedByIntegrityInvalidation(records, candidateSha, reviewedSha);
}

/**
 * Derive declared repair scope from review finding file paths (pre-merge autofix).
 */
export function declaredScopeFromFindingPaths(
  paths: string[],
  reason?: string,
): DeclaredRepairScope {
  return freezeDeclaredScope({
    paths: paths.filter(Boolean),
    directories: [],
    reason: reason ?? "pre-merge autofix finding paths",
  });
}

/** In-memory store deps for unit tests (no real fs). */
export function memoryIntegrityStoreDeps(
  files: Map<string, string> = new Map(),
  opts: { now?: () => Date; randomId?: () => string; failWrite?: (p: string) => boolean } = {},
): IntegrityStoreDeps & { files: Map<string, string> } {
  const store: IntegrityStoreDeps & { files: Map<string, string> } = {
    files,
    now: opts.now ?? (() => new Date("2026-08-05T12:00:00.000Z")),
    randomId: opts.randomId ?? (() => "mut-test-1"),
    mkdir: async () => {},
    writeFileAtomic: async (p, content) => {
      if (opts.failWrite?.(p)) throw new Error(`write failed: ${p}`);
      files.set(p, content);
    },
    readTextFile: async (p) => files.get(p) ?? null,
    readdir: async (dir) => {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const name = rest.split(path.sep)[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
  };
  return store;
}

// Silence unused fs import when only fsp is used in production paths — keep for
// potential sync helpers; mark used via existsSync in store root checks.
export function integrityStoreExistsSync(storeRoot: string): boolean {
  try {
    return fs.existsSync(integrityDir(storeRoot));
  } catch {
    return false;
  }
}

/**
 * Durable store root for merge-queue mutations that lack an advance runDir.
 * Under `.agent-pipeline/runs/mq-<issue>-pr-<pr>/`.
 */
export function mergeQueueIntegrityStoreRoot(
  repoDir: string,
  issue: number,
  pr: number,
): string {
  return path.join(
    repoDir,
    ".agent-pipeline",
    "runs",
    `mq-${issue}-pr-${pr}`,
  );
}

/**
 * Capture helper that builds manifests via ManifestCaptureDeps + subject/refs.
 * Convenience for call sites that already hold capture deps.
 */
export function makeCaptureManifestFn(
  subject: IntegritySubject,
  capture: ManifestCaptureDeps,
  opts: { engine_version?: string; declared_scope?: DeclaredRepairScope } = {},
): (
  refs: AuthoritativeRefs,
  phase: "pre" | "post",
) => Promise<CandidateIntegrityManifest> {
  return async (refs) =>
    buildManifestFromDeps(subject, refs, capture, {
      engine_version: opts.engine_version,
      declared_scope: opts.declared_scope,
    });
}

/**
 * Production git capture from a worktree path (uses real git via injected runner).
 */
export function worktreeManifestCapture(
  worktreePath: string,
  gitInWorktreeFn: (
    wt: string,
    args: string[],
    opts?: { ignoreFailure?: boolean },
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): ManifestCaptureDeps {
  return defaultManifestCaptureDeps(async (args) => {
    const res = await gitInWorktreeFn(worktreePath, args, { ignoreFailure: true });
    return { code: res.code, stdout: res.stdout, stderr: res.stderr };
  });
}

/**
 * Optional integrity context passed into covered mutation functions.
 * When `storeRoot` is set, the function MUST route head movement through
 * {@link runCandidateMovingMutation}.
 */
export interface CandidateIntegrityContext {
  storeRoot: string;
  subject: IntegritySubject;
  mutation_method: MutationMethod;
  declared_scope?: DeclaredRepairScope;
  /** Authoritative base ref name (e.g. main). */
  base_ref: string;
  /** Resolve current base SHA (full 40-hex). */
  resolveBaseSha: () => Promise<string | null>;
  /** Resolve authoritative candidate (PR head) SHA. */
  resolveCandidateSha: () => Promise<string | null>;
  /** Worktree path for git-backed manifest capture. */
  worktreePath: string;
  gitInWorktree: (
    wt: string,
    args: string[],
    opts?: { ignoreFailure?: boolean },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  emitEvent?: (event: CandidateIntegrityEventPayload) => Promise<void>;
  path_class?: string;
  engine_version?: string;
  storeDeps?: IntegrityStoreDeps;
  mutation_id?: string;
}

/**
 * Run a covered head-moving side-effect under the mandatory integrity lifecycle.
 * Call sites pass their existing mutate body; pre-persist failure aborts it.
 */
export async function runCoveredCandidateMutation<T>(
  ctx: CandidateIntegrityContext,
  mutate: () => Promise<T>,
): Promise<RunCandidateMovingMutationResult<T>> {
  const capture = worktreeManifestCapture(ctx.worktreePath, ctx.gitInWorktree);
  const reRead = async (): Promise<AuthoritativeRefs | null> => {
    const base_sha = await ctx.resolveBaseSha();
    const candidate_sha = await ctx.resolveCandidateSha();
    // Candidate head is required to proceed; missing base uses a sentinel so
    // pre-persist can still succeed and comparison fails closed as unverified
    // (incomplete digests) rather than aborting the mutation entirely — abort
    // is reserved for store write failure.
    if (!candidate_sha || !/^[0-9a-f]{40}$/i.test(candidate_sha)) {
      return null;
    }
    const baseOk = !!base_sha && /^[0-9a-f]{40}$/i.test(base_sha);
    return {
      base_ref: ctx.base_ref,
      base_sha: baseOk ? base_sha!.toLowerCase() : UNKNOWN_BASE_SHA_SENTINEL,
      candidate_sha: candidate_sha.toLowerCase(),
    };
  };

  return runCandidateMovingMutation({
    storeRoot: ctx.storeRoot,
    subject: ctx.subject,
    mutation_method: ctx.mutation_method,
    declared_scope: ctx.declared_scope,
    mutation_id: ctx.mutation_id,
    captureManifest: makeCaptureManifestFn(ctx.subject, capture, {
      engine_version: ctx.engine_version,
      declared_scope: ctx.declared_scope,
    }),
    reReadAuthoritative: reRead,
    mutate,
    emitEvent: ctx.emitEvent,
    path_class: ctx.path_class,
    engine_version: ctx.engine_version,
    storeDeps: ctx.storeDeps,
  });
}

/** Full-zero SHA used when base is unreadable — forces incomplete digests → unverified. */
export const UNKNOWN_BASE_SHA_SENTINEL = "0".repeat(40);
