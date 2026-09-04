// Durable post-pilot FRG generation + prepare-only release handoff (#953 / #908 / #1037).
//
// CLI: pipeline factory-release prepare --request <absolute-off-repo-request.json> --json
//
// Idempotent multi-tick protocol:
//   1) No request-bound pack loop, or bound loop not terminal → start/resume
//      that factory-gate candidate pack loop and return status "in_progress"
//      (no pass, no complete, no release PR).
//   2) Bound loop terminal → score with factory-gate --from-run (no
//      --observations). If unsigned artifacts are structurally eligible
//      (HMAC omitted is eligible, not frg_not_eligible) and no verified
//      production-owned attestation exists → "awaiting_frg_attestation"
//      (no release PR). latest.json MAY stay pass:false until attested.
//   3) After the trusted attestor stores a valid attestation for those exact
//      artifacts → verify, invoke shared runRelease, return status "complete".
//
// Never merges, tags, publishes, promotes, or installs. Never places the FRG
// signing key or path in the candidate environment, request, or result.
// Never accepts caller-authored pass / status / metric / receipt claims.
// Never invents pass: true. Never adopts an unbound newest factory-gate loop.

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import { existsSync, realpathSync as fsRealpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  artifactSubdir,
  FACTORY_RELEASE_ARTIFACT,
} from "./artifact-ignore.ts";

const execFileAsync = promisify(execFile);
import {
  FRG_PACK_MANIFEST,
  isAllowedFrgPackSelector,
  isReleaseEligibleFrgPass,
  itemsFromLoopLedger,
  latestJsonForHonestPost133Persist,
  normalizeFrgVersion,
  parseFrgEvidenceJson,
  resolveFrgAttestationKey,
  runFactoryGate,
  validateFrgPackContract,
  validateReleaseEligibleFrgEvidence,
  type FactoryGateOpts,
  type FrgCompositionOverride,
  type FrgEvidence,
  type FrgScenarioOverride,
  type FrgValidateOpts,
  type ShipPathFromRunResolution,
} from "./factory-reliability-gate.ts";
import {
  uniqueOperationReleaseBindingFailure,
  uniqueOperationSloFailure,
} from "./operation-reliability.ts";
import {
  defaultFrgPackRoot,
  FRG_HYBRID_PILOT_VERSION,
  loadFrgPack,
  renderFrgPackIssues,
  type LoadedFrgPack,
  type RenderedFrgIssue,
} from "./frg-pack-observations.ts";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";
import {
  defaultLoopStoreDeps,
  loopRunHandoffPath,
  readActionEvidence,
  readContract,
  readEvents,
  readLedger,
  readLoopRunHandoff,
  readSupervisorProcess,
  resolveStateHome,
  runDir,
} from "./loop/store.ts";
import type { LoopContract } from "./loop/types.ts";
import {
  PACK_LOOP_STDERR_HEAD_BYTES,
  PACK_LOOP_STDERR_TAIL_BYTES,
  PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV,
  isDurableLoopRunHandoff,
  packLoopStartupObservationMs,
  pathContainedIn,
  probePackLoopLiveness,
  type PackLoopLivenessStatus,
} from "./loop/pack-loop-liveness.ts";
import { parseExactGitSha } from "./ship-end-identity.ts";
import type { FaultRecoveryMatrixRow } from "./fault-recovery-matrix.ts";
import {
  defaultResolveCandidateEngineDeps,
  resolveCandidateEngine,
} from "./ship-end-candidate.ts";
import {
  runRelease,
  type ReleaseOpts,
  type ReleasePrepareResult,
} from "./stages/release.ts";
import {
  assertNoRemainingOpenMilestoneIssues,
  listRemainingOpenMilestoneIssueNumbers,
  remainingOpenGh,
} from "./stages/ship.ts";

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

export const FACTORY_RELEASE_SCHEMA_VERSION = 1;
export const FACTORY_RELEASE_REQUEST_KIND = "factory_release_prepare_request";
export const FACTORY_RELEASE_CHECKPOINT_KIND = "factory_release_frg_checkpoint";
export const FACTORY_RELEASE_PREPARED_KIND = "factory_release_prepared";
export const FACTORY_RELEASE_FAILED_KIND = "factory_release_failed";
export const FACTORY_RELEASE_ROOT_REL = path.join(
  ".agent-pipeline",
  FACTORY_RELEASE_ARTIFACT.name,
);

/** Stable defect token when `--request` resolves inside a target checkout. */
export const REQUEST_INSIDE_CHECKOUT_TOKEN = "request_inside_checkout";

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Request fields required by the stable wrapper / ship handoff. */
const REQUEST_REQUIRED_KEYS = [
  "schema_version",
  "kind",
  "action_id",
  "repository",
  "base_branch",
  "target_version",
  "integrated_candidate",
  "frg_manifest",
] as const;

/** Forbidden request field names (credentials, executables, pass claims). */
const FORBIDDEN_REQUEST_KEYS = new Set([
  "pass",
  "status",
  "metrics",
  "metric",
  "receipt",
  "evidence_receipt",
  "attestation_key",
  "attestation_key_path",
  "PIPELINE_FRG_ATTESTATION_KEY",
  "credential",
  "credentials",
  "executable",
  "module",
  "command",
  "network_target",
  "signer_path",
  "private_key",
  "secret",
]);

export type FactoryReleasePhase =
  | "frg_running"
  | "awaiting_frg_attestation"
  | "release_preparing"
  | "complete"
  | "failed";

export interface FactoryReleaseArtifactRef {
  path: string;
  sha256: string;
}

export interface FactoryReleaseFrgPayload {
  pack_id: string;
  manifest_path: string;
  manifest_sha256: string;
  pack_run_id: string;
  loop_run_id: string;
  frg_run_id: string;
  evidence_created_at: string;
  observations: FactoryReleaseArtifactRef;
  evidence_bundle: FactoryReleaseArtifactRef;
  contract: FactoryReleaseArtifactRef;
  ledger: FactoryReleaseArtifactRef;
  events: FactoryReleaseArtifactRef;
  action_evidence: FactoryReleaseArtifactRef;
}

export interface FactoryReleasePrepareRequest {
  schema_version: 1;
  kind: typeof FACTORY_RELEASE_REQUEST_KIND;
  action_id: string;
  /** Optional grant fingerprint when driven by a factory grant. */
  grant_fingerprint?: string;
  repository: string;
  base_branch: string;
  target_version: string;
  milestone?: string;
  ordered_merges?: Array<{
    issue: number;
    pr: number;
    candidate_head: string;
    merge_oid: string;
    base_oid: string;
  }>;
  integrated_candidate: { git_sha: string; version?: string };
  production_pin?: { version: string; tag: string; git_sha: string };
  controller_revision?: string;
  engine_fingerprint?: string;
  policy_fingerprint?: string;
  frg_manifest: { pack_id: string; sha256: string };
}

export interface FactoryReleaseInProgressResult {
  schema_version: 1;
  kind: typeof FACTORY_RELEASE_CHECKPOINT_KIND;
  status: "in_progress";
  action_id: string;
  grant_fingerprint: string;
  repository: string;
  base_branch: string;
  target_version: string;
  candidate_git_sha: string;
  loop_run_id: string;
  checkpoint: string;
  liveness?: PackLoopLivenessStatus;
}

export interface FactoryReleaseAwaitingResult {
  schema_version: 1;
  kind: typeof FACTORY_RELEASE_CHECKPOINT_KIND;
  status: "awaiting_frg_attestation";
  action_id: string;
  grant_fingerprint: string;
  repository: string;
  base_branch: string;
  target_version: string;
  candidate_git_sha: string;
  checkpoint: string;
  frg: FactoryReleaseFrgPayload;
  /** Present when observation rejected the on-disk attestor result. */
  observe_miss?: FactoryReleaseObserveMiss;
}

export interface FactoryReleaseCompleteResult {
  schema_version: 1;
  kind: typeof FACTORY_RELEASE_PREPARED_KIND;
  status: "complete";
  action_id: string;
  grant_fingerprint: string;
  repository: string;
  base_branch: string;
  target_version: string;
  milestone: string;
  candidate_git_sha: string;
  frg: {
    pack_id: string;
    pack_run_id: string;
    loop_run_id: string;
    run_id: string;
    manifest_sha256: string;
    evidence_sha256: string;
  };
  release_pr: { number: number; head_oid: string; base_oid: string };
  checkpoint: string;
}

export interface FactoryReleaseFailedResult {
  schema_version: 1;
  kind: typeof FACTORY_RELEASE_FAILED_KIND;
  status: "failed";
  action_id: string;
  repository: string;
  base_branch: string;
  target_version: string;
  candidate_git_sha: string;
  defect_class: string;
  message: string;
  checkpoint: string;
  liveness?: PackLoopLivenessStatus;
}

export type FactoryReleaseResult =
  | FactoryReleaseInProgressResult
  | FactoryReleaseAwaitingResult
  | FactoryReleaseCompleteResult
  | FactoryReleaseFailedResult;

export interface FactoryReleaseCheckpointRecord {
  schema_version: 1;
  kind: "factory_release_checkpoint_store";
  request_fingerprint: string;
  phase: FactoryReleasePhase;
  request: FactoryReleasePrepareRequest;
  unsigned?: FactoryReleaseFrgPayload;
  awaiting_checkpoint_id?: string;
  attestation?: {
    frg_run_id: string;
    evidence_path: string;
    evidence_sha256: string;
    latest_path: string;
    latest_sha256: string;
  };
  release?: {
    pr: number;
    head_oid: string;
    base_oid: string;
    version: string;
  };
  complete_checkpoint_id?: string;
  failure?: { defect_class: string; message: string };
  updated_at: string;
}

export interface UnsignedFrgGenerationResult {
  frg: FactoryReleaseFrgPayload;
  /** Structural eligibility before production attestation (no MAC required). */
  structurally_eligible: boolean;
  defect_class?: string;
  message?: string;
  /**
   * Bound pack loop started or resumed and is not terminal.
   * Prepare MUST return status "in_progress" (exit 0) — not failed / complete.
   */
  in_progress?: boolean;
  /** Bound loop run id when started, resumed, or scored. */
  loop_run_id?: string;
  /** Authoritative pack-loop liveness on in_progress and pre-handoff fail. */
  liveness?: PackLoopLivenessStatus;
}

export interface ObservedAttestation {
  frg_run_id: string;
  evidence_path: string;
  evidence_sha256: string;
  latest_path: string;
  latest_sha256: string;
  evidence: FrgEvidence;
}

export interface FactoryReleasePrepareDeps {
  now(): Date;
  /** Candidate process env (defaults to process.env). Used only to refuse key leakage. */
  env?: NodeJS.ProcessEnv;
  /** Read request body (already validated absolute path). */
  readRequestText(absolutePath: string): Promise<string>;
  readFile(absolutePath: string): Promise<string>;
  writeFile(absolutePath: string, body: string, mode?: number): Promise<void>;
  mkdir(absolutePath: string, opts?: { recursive?: boolean; mode?: number }): Promise<void>;
  fileExists(absolutePath: string): Promise<boolean>;
  /**
   * Load the fixed pack. Injectable so unit tests never touch the real manifest
   * filesystem when only protocol state is under test.
   */
  loadPack?(): Promise<LoadedFrgPack>;
  /** Re-observe / create unsigned pack artifacts for this exact request. */
  generateUnsignedFrg(
    request: FactoryReleasePrepareRequest,
    ctx: { repoDir: string; workDir: string; pack: LoadedFrgPack; manifestPath: string },
  ): Promise<UnsignedFrgGenerationResult>;
  /** Look for a production-owned attested latest.json bound to the unsigned pack. */
  observeAttestation(
    request: FactoryReleasePrepareRequest,
    unsigned: FactoryReleaseFrgPayload,
    ctx: { repoDir: string; workDir: string },
  ): Promise<ObservedAttestation | AttestationObserveResult | null>;
  /**
   * Observe an already-opened or merged release/vX.Y.Z PR. When present,
   * prepare MUST NOT open a second PR (#1115).
   */
  observeExistingRelease?(
    request: FactoryReleasePrepareRequest,
  ): Promise<{ pr: number; head_oid: string; version: string } | null>;
  /** Shared prepare-only release entry (runRelease). */
  runRelease(
    version: string,
    opts: ReleaseOpts,
    cfg: { repo_dir: string; repo: string; base_branch?: string },
  ): Promise<ReleasePrepareResult | null | void>;
  /**
   * Start a request-bound factory-gate pack loop. Production default creates
   * or reuses pack issues and dispatches `pipeline loop --engine-track candidate`.
   * Unit tests inject this seam — no real subprocess.
   */
  startBoundPackLoop?: (
    ctx: DurableReconcilePackLoopCtx,
  ) => Promise<{ loop_run_id: string } | null>;
  /** Create or reuse factory-gate pack issues from rendered templates. */
  createOrReusePackIssues?: CreateOrReusePackIssues;
  /** Dispatch a candidate-track durable loop for the pack work-list. */
  dispatchPackLoop?: DispatchPackLoop;
  /**
   * Terminal score of a bound pack loop. Production default is
   * `runFactoryGate({ fromRun, writeEvidence })` with no observations.
   */
  scoreBoundPackLoop?: ScoreBoundPackLoop;
  /** Optional log sink. */
  log?(msg: string): void;
  /**
   * Canonicalize an existing path (follow symlinks). Defaults to
   * `fs.realpathSync`. Tests inject a map so symlink / missing-path cases
   * never touch the real filesystem.
   */
  realpathSync?(absolutePath: string): string;
  /**
   * Remaining-open GitHub observation for the ship milestone. Required before
   * pack-loop start. Tests inject leftover issues / empty sets / query failures.
   */
  listRemainingOpenMilestoneIssues?(args: {
    repository: string;
    milestone: string;
  }): Promise<readonly number[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canonical);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  };
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function requireString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`factory-release request: ${field} is required`);
  }
  const s = value.trim();
  if (pattern && !pattern.test(s)) {
    throw new Error(`factory-release request: ${field} is invalid`);
  }
  return s;
}

function requireSafeId(value: unknown, field: string): string {
  const id = requireString(value, field, SAFE_ID_RE);
  if (id.includes("..")) throw new Error(`factory-release request: ${field} is not safe`);
  return id;
}

function requireOid(value: unknown, field: string): string {
  return requireString(value, field, GIT_SHA_RE).toLowerCase();
}

function requireDigest(value: unknown, field: string): string {
  return requireString(value, field, DIGEST_RE);
}

/** Compare X.Y.Z; returns -1 / 0 / 1. */
export function compareSemver(left: string, right: string): number {
  const a = normalizeFrgVersion(left).split(".").map(Number);
  const b = normalizeFrgVersion(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when durable factory-release prepare applies (strictly after the hybrid pilot). */
export function isPostPilotReleaseVersion(version: string): boolean {
  return compareSemver(version, FRG_HYBRID_PILOT_VERSION) > 0;
}

/**
 * Recursively refuse forbidden keys and any caller-authored pass claim.
 * Used on the raw request object before structural parse.
 */
export function rejectForbiddenRequestFields(raw: unknown, field = "request"): void {
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => rejectForbiddenRequestFields(entry, `${field}[${i}]`));
    return;
  }
  if (raw === null || typeof raw !== "object") return;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key) || FORBIDDEN_REQUEST_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `factory-release request: forbidden field ${field}.${key} ` +
          `(credentials, executables, and caller-authored pass claims are refused)`,
      );
    }
    // Nested "pass: true" short-circuit attempts
    if (key === "pass" || key === "result") {
      throw new Error(`factory-release request: forbidden field ${field}.${key}`);
    }
    rejectForbiddenRequestFields(value, `${field}.${key}`);
  }
}

/**
 * Parse and validate a secret-free factory-release prepare request.
 * Fail closed on schema violations, hybrid target versions, and pass claims.
 */
export function parseFactoryReleasePrepareRequest(raw: unknown): FactoryReleasePrepareRequest {
  rejectForbiddenRequestFields(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("factory-release request: must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  for (const key of REQUEST_REQUIRED_KEYS) {
    if (!(key in o)) {
      throw new Error(`factory-release request: missing required field ${key}`);
    }
  }
  if (o.schema_version !== FACTORY_RELEASE_SCHEMA_VERSION) {
    throw new Error("factory-release request: schema_version must be 1");
  }
  if (o.kind !== FACTORY_RELEASE_REQUEST_KIND) {
    throw new Error(`factory-release request: kind must be ${FACTORY_RELEASE_REQUEST_KIND}`);
  }

  const actionId = requireSafeId(o.action_id, "action_id");
  const repository = requireString(o.repository, "repository", REPO_RE).toLowerCase();
  const baseBranch = requireString(o.base_branch, "base_branch");
  if (/\s/.test(baseBranch)) {
    throw new Error("factory-release request: base_branch must not contain whitespace");
  }
  const targetVersion = normalizeFrgVersion(requireString(o.target_version, "target_version", SEMVER_RE));

  if (!isPostPilotReleaseVersion(targetVersion)) {
    throw new Error(
      `factory-release request: durable prepare applies only after v${FRG_HYBRID_PILOT_VERSION}; ` +
        `got ${targetVersion}. The hybrid pilot remains valid only for exactly ${FRG_HYBRID_PILOT_VERSION}.`,
    );
  }

  if (o.integrated_candidate === null || typeof o.integrated_candidate !== "object" || Array.isArray(o.integrated_candidate)) {
    throw new Error("factory-release request: integrated_candidate must be an object");
  }
  const cand = o.integrated_candidate as Record<string, unknown>;
  const integrated = {
    git_sha: requireOid(cand.git_sha, "integrated_candidate.git_sha"),
    ...(cand.version !== undefined
      ? { version: requireString(cand.version, "integrated_candidate.version", SEMVER_RE) }
      : {}),
  };

  if (o.frg_manifest === null || typeof o.frg_manifest !== "object" || Array.isArray(o.frg_manifest)) {
    throw new Error("factory-release request: frg_manifest must be an object");
  }
  const man = o.frg_manifest as Record<string, unknown>;
  const frgManifest = {
    pack_id: requireSafeId(man.pack_id, "frg_manifest.pack_id"),
    sha256: requireDigest(man.sha256, "frg_manifest.sha256"),
  };
  if (frgManifest.pack_id !== FRG_PACK_MANIFEST.pack_id) {
    throw new Error(
      `factory-release request: frg_manifest.pack_id must be ${FRG_PACK_MANIFEST.pack_id}`,
    );
  }

  let grantFingerprint: string | undefined;
  if (o.grant_fingerprint !== undefined) {
    grantFingerprint = requireDigest(o.grant_fingerprint, "grant_fingerprint");
  }

  let milestone: string | undefined;
  if (o.milestone !== undefined) {
    milestone = requireString(o.milestone, "milestone");
  }

  let productionPin: FactoryReleasePrepareRequest["production_pin"];
  if (o.production_pin !== undefined) {
    if (o.production_pin === null || typeof o.production_pin !== "object" || Array.isArray(o.production_pin)) {
      throw new Error("factory-release request: production_pin must be an object");
    }
    const pin = o.production_pin as Record<string, unknown>;
    const version = requireString(pin.version, "production_pin.version", SEMVER_RE);
    const tag = requireString(pin.tag, "production_pin.tag");
    if (tag !== `v${version}`) {
      throw new Error("factory-release request: production_pin.tag must be v{version}");
    }
    productionPin = {
      version,
      tag,
      git_sha: requireOid(pin.git_sha, "production_pin.git_sha"),
    };
  }

  let orderedMerges: FactoryReleasePrepareRequest["ordered_merges"];
  if (o.ordered_merges !== undefined) {
    if (!Array.isArray(o.ordered_merges)) {
      throw new Error("factory-release request: ordered_merges must be an array");
    }
    orderedMerges = o.ordered_merges.map((entry, i) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`factory-release request: ordered_merges[${i}] must be an object`);
      }
      const m = entry as Record<string, unknown>;
      const issue = m.issue;
      const pr = m.pr;
      if (!Number.isSafeInteger(issue) || (issue as number) <= 0) {
        throw new Error(`factory-release request: ordered_merges[${i}].issue is invalid`);
      }
      if (!Number.isSafeInteger(pr) || (pr as number) <= 0) {
        throw new Error(`factory-release request: ordered_merges[${i}].pr is invalid`);
      }
      return {
        issue: issue as number,
        pr: pr as number,
        candidate_head: requireOid(m.candidate_head, `ordered_merges[${i}].candidate_head`),
        merge_oid: requireOid(m.merge_oid, `ordered_merges[${i}].merge_oid`),
        base_oid: requireOid(m.base_oid, `ordered_merges[${i}].base_oid`),
      };
    });
  }

  const request: FactoryReleasePrepareRequest = {
    schema_version: 1,
    kind: FACTORY_RELEASE_REQUEST_KIND,
    action_id: actionId,
    repository,
    base_branch: baseBranch,
    target_version: targetVersion,
    integrated_candidate: integrated,
    frg_manifest: frgManifest,
  };
  if (grantFingerprint) request.grant_fingerprint = grantFingerprint;
  if (milestone) request.milestone = milestone;
  if (productionPin) request.production_pin = productionPin;
  if (orderedMerges) request.ordered_merges = orderedMerges;
  if (o.controller_revision !== undefined) {
    request.controller_revision = requireOid(o.controller_revision, "controller_revision");
  }
  if (o.engine_fingerprint !== undefined) {
    request.engine_fingerprint = requireDigest(o.engine_fingerprint, "engine_fingerprint");
  }
  if (o.policy_fingerprint !== undefined) {
    request.policy_fingerprint = requireDigest(o.policy_fingerprint, "policy_fingerprint");
  }
  return request;
}

/** Fingerprint keys the restart checkpoint (repo, version, candidate, action). */
export function factoryReleaseRequestFingerprint(request: FactoryReleasePrepareRequest): string {
  return sha256(
    canonicalJson({
      repository: request.repository,
      base_branch: request.base_branch,
      target_version: request.target_version,
      candidate_git_sha: request.integrated_candidate.git_sha,
      action_id: request.action_id,
      grant_fingerprint: request.grant_fingerprint ?? null,
      frg_manifest: request.frg_manifest,
    }),
  );
}

export function factoryReleaseWorkDir(repoDir: string, fingerprint: string): string {
  return path.join(artifactSubdir(repoDir, FACTORY_RELEASE_ARTIFACT), fingerprint);
}

export function factoryReleaseCheckpointPath(repoDir: string, fingerprint: string): string {
  return path.join(factoryReleaseWorkDir(repoDir, fingerprint), "checkpoint.json");
}

export function factoryReleaseVersionIndexPath(repoDir: string, version: string): string {
  return path.join(
    artifactSubdir(repoDir, FACTORY_RELEASE_ARTIFACT),
    "by-version",
    `${normalizeFrgVersion(version)}.json`,
  );
}

export type AttestationObserveReason =
  | "missing_file"
  | "unreadable"
  | "unparsable"
  | "hmac_invalid"
  | "missing_factory_release_binding"
  | "notes_only_binding"
  | "binding_mismatch"
  | "pack_provenance_invalid"
  | "identity_mismatch"
  | "not_release_eligible";

export type AttestationObserveResult =
  | { status: "accepted"; attestation: ObservedAttestation }
  | { status: "absent"; reason: AttestationObserveReason }
  | {
      status: "rejected";
      reason: AttestationObserveReason;
      expected_frg_run_id: string;
      observed_run_id: string | null;
      detail?: string;
    };

export interface FactoryReleaseObserveMiss {
  reason: AttestationObserveReason;
  expected_frg_run_id: string;
  observed_run_id: string | null;
  detail?: string;
}

async function tryReadJsonFile(
  readFile: (p: string) => Promise<string>,
  filePath: string,
): Promise<{ ok: true; value: unknown } | { ok: false; missing: boolean }> {
  let text: string;
  try {
    text = await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, missing: true };
    }
    return { ok: false, missing: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, missing: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Load the closed unsigned checkpoint for credentialed `--from-run`.
 * Ship-path (version index, checkpoint, or request SHA in hand) fails closed
 * when the unsigned payload is missing, malformed, or conflicts.
 * Standalone unbound `--from-run` (none of those) omits the binding.
 */
export async function defaultResolveShipPathFromRun(args: {
  version: string;
  fromRun: string;
  repoDir: string;
  requestCandidateGitSha?: string;
  readFile: (p: string) => Promise<string>;
}): Promise<ShipPathFromRunResolution> {
  const version = normalizeFrgVersion(args.version);
  const requestSha = args.requestCandidateGitSha?.trim() ?? "";
  const indexPath = factoryReleaseVersionIndexPath(args.repoDir, version);
  const indexRead = await tryReadJsonFile(args.readFile, indexPath);

  if (indexRead.missing && !requestSha) {
    return { kind: "standalone" };
  }
  if (!indexRead.ok) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} has a malformed ` +
        `factory-release version index for v${version}; refusing HMAC latest.json without factory_release_binding`,
    };
  }
  if (indexRead.missing) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} has no unsigned checkpoint ` +
        `for v${version}; refusing HMAC latest.json without factory_release_binding`,
    };
  }

  const index = indexRead.value;
  if (!isRecord(index)) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} version index is not an object`,
    };
  }
  const fingerprint = typeof index.request_fingerprint === "string" ? index.request_fingerprint : "";
  const indexFrg = typeof index.frg_run_id === "string" ? index.frg_run_id : "";
  const indexLoop = typeof index.loop_run_id === "string" ? index.loop_run_id : "";
  const indexPack = typeof index.pack_run_id === "string" ? index.pack_run_id : "";
  const indexCandidate = typeof index.candidate_git_sha === "string" ? index.candidate_git_sha : "";
  if (!fingerprint || !indexFrg || !indexLoop || !indexPack || !indexCandidate) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} version index is incomplete`,
    };
  }
  if (indexLoop !== args.fromRun) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} does not match version-index loop_run_id ${indexLoop}`,
    };
  }
  if (requestSha && requestSha.toLowerCase() !== indexCandidate.toLowerCase()) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run request candidate SHA does not match version index`,
    };
  }

  const checkpointPath = factoryReleaseCheckpointPath(args.repoDir, fingerprint);
  const ckptRead = await tryReadJsonFile(args.readFile, checkpointPath);
  if (!ckptRead.ok || ckptRead.missing) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} is missing a closed unsigned checkpoint ` +
        `for v${version}; refusing HMAC latest.json without factory_release_binding`,
    };
  }
  if (!isRecord(ckptRead.value)) {
    return {
      kind: "fail",
      message: `pipeline factory-gate: ship-path --from-run unsigned checkpoint is not an object`,
    };
  }
  const store = ckptRead.value;
  const request = store.request;
  const unsigned = store.unsigned;
  if (!isRecord(request) || !isRecord(unsigned)) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run unsigned checkpoint is missing request or unsigned payload`,
    };
  }
  let parsedRequest: FactoryReleasePrepareRequest;
  try {
    parsedRequest = parseFactoryReleasePrepareRequest(request);
  } catch (err) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run unsigned checkpoint request is malformed: ${(err as Error).message}`,
    };
  }
  const unsignedPayload = unsigned as unknown as FactoryReleaseFrgPayload;
  if (
    unsignedPayload.frg_run_id !== indexFrg ||
    unsignedPayload.loop_run_id !== indexLoop ||
    unsignedPayload.pack_run_id !== indexPack ||
    parsedRequest.integrated_candidate.git_sha.toLowerCase() !== indexCandidate.toLowerCase() ||
    factoryReleaseRequestFingerprint(parsedRequest) !== fingerprint
  ) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run unsigned checkpoint conflicts with the version index`,
    };
  }

  const loopBindingPath = factoryReleaseLoopBindingPath(args.fromRun);
  const loopRead = await tryReadJsonFile(args.readFile, loopBindingPath);
  if (!loopRead.ok || loopRead.missing || !isRecord(loopRead.value)) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run ${args.fromRun} is missing factory-release-binding.json`,
    };
  }
  const loopCandidate =
    typeof loopRead.value.candidate_git_sha === "string" ? loopRead.value.candidate_git_sha : "";
  if (loopCandidate.toLowerCase() !== parsedRequest.integrated_candidate.git_sha.toLowerCase()) {
    return {
      kind: "fail",
      message:
        `pipeline factory-gate: ship-path --from-run loop binding candidate SHA does not match the unsigned request`,
    };
  }

  const binding = buildFactoryReleaseUnsignedDigestBinding(parsedRequest, unsignedPayload);
  return {
    kind: "bound",
    binding,
    unsigned_frg_run_id: unsignedPayload.frg_run_id,
  };
}

function defaultRealpathSync(absolutePath: string): string {
  return fsRealpathSync(absolutePath);
}

/**
 * Resolve `--request` for containment: absolute path, then realpath of the
 * file when it exists, else realpath of its parent joined with the basename.
 * Missing file and missing parent fall back to `path.resolve`.
 */
export function resolveRequestPathForContainment(
  requestPath: string,
  realpathSync: (absolutePath: string) => string = defaultRealpathSync,
): string {
  const resolved = path.resolve(requestPath);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/** True when `candidate` is `checkoutRoot` or a descendant (after resolve). */
export function isPathInsideCheckout(candidate: string, checkoutRoot: string): boolean {
  const rel = path.relative(path.resolve(checkoutRoot), path.resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Checkouts prepare must keep clean of operator `--request` files: `repoDir`
 * plus a distinct factory control checkout from opts / env.
 */
export function targetCheckoutsForPrepare(opts: {
  repoDir: string;
  factoryControlDir?: string | null;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const roots: string[] = [path.resolve(opts.repoDir)];
  const env = opts.env ?? {};
  const extras = [opts.factoryControlDir, env.AGENT_PIPELINE_FACTORY_CONTROL, env.REPO_DIR];
  for (const extra of extras) {
    if (typeof extra !== "string" || extra.trim() === "") continue;
    const resolved = path.resolve(extra.trim());
    if (!roots.some((root) => root === resolved)) roots.push(resolved);
  }
  return roots;
}

export function requestInsideCheckoutMessage(requestPath: string, checkoutRoot: string): string {
  return (
    `factory-release prepare: ${REQUEST_INSIDE_CHECKOUT_TOKEN}: ` +
    `--request ${requestPath} resolves inside the target checkout ${checkoutRoot}. ` +
    `Place the request outside the checkout ($TMPDIR, AGENT_PIPELINE_STATE_HOME, or the Tugboat $RUN_DIR). ` +
    `Gitignoring request-*.json or skip-worktree is not the product fix.`
  );
}

/**
 * Refuse `--request` when it resolves inside any target checkout (root,
 * descendant, or symlink whose target is inside). Gitignored descendants
 * are still refused.
 */
export function assertRequestOutsideCheckouts(
  requestPath: string,
  checkouts: readonly string[],
  realpathSync: (absolutePath: string) => string = defaultRealpathSync,
): void {
  const resolvedRequest = resolveRequestPathForContainment(requestPath, realpathSync);
  for (const checkout of checkouts) {
    const resolvedCheckout = resolveRequestPathForContainment(checkout, realpathSync);
    if (isPathInsideCheckout(resolvedRequest, resolvedCheckout)) {
      throw new Error(requestInsideCheckoutMessage(resolvedRequest, resolvedCheckout));
    }
  }
}

function grantFingerprintOrAction(request: FactoryReleasePrepareRequest): string {
  return request.grant_fingerprint ?? sha256(`action:${request.action_id}`);
}

function isoNow(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function checkpointId(prefix: string, fingerprint: string): string {
  return `${prefix}-${fingerprint.slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Default I/O + generation seams
// ---------------------------------------------------------------------------

async function defaultFileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when latest.json is a production-attested hybrid-v2 score of this
 * request's exact candidate. Auto-tag and promote require that file; prepare
 * must reuse it instead of starting a second pack or overwriting it.
 */
export function honestLatestJsonBindsRequest(
  request: FactoryReleasePrepareRequest,
  evidence: {
    version?: string;
    pass?: boolean;
    pack_id?: string | null;
    loop_run_id?: string | null;
    run_id?: string;
    integrity?: { attestation?: unknown } | null;
    pack_provenance?: { candidate_git_sha?: string } | null;
    factory_release_binding?: { candidate_git_sha?: string } | null;
  },
): boolean {
  if (evidence.version !== request.target_version) return false;
  if (evidence.pass !== true) return false;
  if (evidence.pack_id !== request.frg_manifest.pack_id) return false;
  if (typeof evidence.loop_run_id !== "string" || evidence.loop_run_id.trim() === "") {
    return false;
  }
  if (typeof evidence.run_id !== "string" || evidence.run_id.trim() === "") return false;
  if (!evidence.integrity?.attestation) return false;
  const expected = request.integrated_candidate.git_sha.toLowerCase();
  const bindingSha = evidence.factory_release_binding?.candidate_git_sha?.toLowerCase() ?? "";
  const provenanceSha = evidence.pack_provenance?.candidate_git_sha?.toLowerCase() ?? "";
  // A present binding or provenance candidate must each equal the request
  // candidate. Do not prefer binding C over scored provenance D.
  if (bindingSha && bindingSha !== expected) return false;
  if (provenanceSha && provenanceSha !== expected) return false;
  const cand = bindingSha || provenanceSha;
  return cand === expected;
}

function notesCarryFactoryReleaseBinding(notes: readonly string[] | undefined): boolean {
  for (const note of notes ?? []) {
    if (typeof note === "string" && note.startsWith("factory_release_binding:")) return true;
  }
  return false;
}

function topLevelFactoryReleaseBinding(raw: Record<string, unknown>, evidence: FrgEvidence): unknown {
  if (Object.prototype.hasOwnProperty.call(raw, "factory_release_binding")) {
    return raw.factory_release_binding;
  }
  if (Object.prototype.hasOwnProperty.call(evidence, "factory_release_binding")) {
    return (evidence as FrgEvidence & { factory_release_binding?: unknown }).factory_release_binding;
  }
  return undefined;
}

export function normalizeObserveAttestation(
  raw: ObservedAttestation | AttestationObserveResult | null,
): AttestationObserveResult {
  if (raw == null) return { status: "absent", reason: "missing_file" };
  if ("status" in raw && (raw.status === "accepted" || raw.status === "absent" || raw.status === "rejected")) {
    return raw;
  }
  return { status: "accepted", attestation: raw };
}

/** Pick an already-open/merged PR whose head is the request candidate. */
export function selectExistingReleaseRow(
  request: FactoryReleasePrepareRequest,
  rows: ReadonlyArray<{
    number?: number;
    headRefOid?: string;
    baseRefName?: string;
    state?: string;
  }>,
): { pr: number; head_oid: string; version: string } | null {
  const candidate = request.integrated_candidate.git_sha.toLowerCase();
  for (const row of rows) {
    const pr = Number(row.number);
    const head = String(row.headRefOid ?? "").toLowerCase();
    if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}$/i.test(head)) continue;
    if (row.baseRefName !== request.base_branch) continue;
    const state = String(row.state ?? "OPEN").toUpperCase();
    if (state !== "OPEN" && state !== "MERGED") continue;
    if (head === candidate) {
      return { pr, head_oid: head, version: request.target_version };
    }
  }
  return null;
}

/** Placeholder FRG payload used only in hard-fail results (never release-eligible). */
function refusedFrgPayload(request: FactoryReleasePrepareRequest): FactoryReleaseFrgPayload {
  return {
    pack_id: request.frg_manifest.pack_id,
    manifest_path: "/dev/null",
    manifest_sha256: request.frg_manifest.sha256,
    pack_run_id: "refused",
    loop_run_id: "refused",
    frg_run_id: "refused",
    evidence_created_at: "1970-01-01T00:00:00Z",
    observations: { path: "/dev/null", sha256: "0".repeat(64) },
    evidence_bundle: { path: "/dev/null", sha256: "0".repeat(64) },
    contract: { path: "/dev/null", sha256: "0".repeat(64) },
    ledger: { path: "/dev/null", sha256: "0".repeat(64) },
    events: { path: "/dev/null", sha256: "0".repeat(64) },
    action_evidence: { path: "/dev/null", sha256: "0".repeat(64) },
  };
}

/**
 * Fail-closed result for synthetic trivial packs or incomplete durable generation.
 * Never unlocks release preparation.
 */
export async function refuseSyntheticTrivialPack(
  request: FactoryReleasePrepareRequest,
  detail?: { defect_class?: string; message?: string },
): Promise<UnsignedFrgGenerationResult> {
  return {
    frg: refusedFrgPayload(request),
    structurally_eligible: false,
    defect_class: detail?.defect_class ?? "missing_generator",
    message:
      detail?.message ??
      (`factory-release prepare: durable FRG generator did not produce release-eligible ` +
        `unsigned artifacts for ${request.target_version}. Synthetic trivial docs/fixture ` +
        `packs are not release-eligible after v${FRG_HYBRID_PILOT_VERSION}. ` +
        `Bind a fixed-pack factory-gate durable loop to the request fingerprint from the exact candidate.`),
  };
}

/** Runner-derived live/ledger/derived observations only — never Layer A for post-pilot. */
export type DurableAllowedProofSource = "live" | "ledger" | "derived" | "observation";

export interface DurablePackLoopArtifacts {
  loop_run_id: string;
  contract_text: string;
  ledger_text: string;
  events_text: string;
  action_evidence_text: string;
  /** Optional runner-owned observations JSON (sources live|ledger|derived|observation only). */
  runner_observations_text?: string;
}

export interface FactoryReleasePackInstance {
  schema_version: 1;
  kind: "factory_release_pack_instance";
  request_fingerprint: string;
  target_version: string;
  candidate_git_sha: string;
  pack_id: string;
  manifest_sha256: string;
  pack_run_id: string;
  frg_run_id: string;
  loop_run_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Closed binding the production attestor MUST copy into signed evidence. */
export interface FactoryReleaseUnsignedDigestBinding {
  schema_version: 1;
  kind: "factory_release_unsigned_digest_binding";
  request_fingerprint: string;
  target_version: string;
  candidate_git_sha: string;
  pack_id: string;
  pack_run_id: string;
  loop_run_id: string;
  frg_run_id: string;
  artifacts: {
    observations_sha256: string;
    evidence_bundle_sha256: string;
    contract_sha256: string;
    ledger_sha256: string;
    events_sha256: string;
    action_evidence_sha256: string;
  };
}

export interface CreateOrReusePackIssuesInput {
  repoDir: string;
  request: FactoryReleasePrepareRequest;
  pack: LoadedFrgPack;
  packRunId: string;
  rendered: RenderedFrgIssue[];
}

export type CreateOrReusePackIssues = (
  input: CreateOrReusePackIssuesInput,
) => Promise<{ issue_numbers: number[] }>;

export type FactoryReleaseLoopDispatchState = "bound" | "starting" | "dispatched" | "failed";

/** Frozen candidate-engine spawn object. Never re-derived from PATH or PIPELINE_BIN. */
export interface CandidateInvocation {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly candidateSha: string;
}

export interface FactoryReleaseSpawnAttempt {
  error_code?: string;
  pid?: number;
  at: string;
}

export interface FactoryReleaseFailedProcessIdentity {
  pid: number;
  boot_id: string;
  started_at: string;
}

export interface FactoryReleaseLoopBindingFields {
  observation_deadline?: string;
  spawn_attempt?: FactoryReleaseSpawnAttempt;
  candidate_invocation?: { executable: string; argv: readonly string[]; candidateSha: string };
  stderr_evidence_path?: string;
  resume_count?: number;
  failed_process_identity?: FactoryReleaseFailedProcessIdentity;
  last_error?: string;
}

export interface PackLoopSpawnResult {
  dispatch_state: FactoryReleaseLoopDispatchState;
  pid?: number;
  observation_deadline?: string;
  stderr_evidence_path?: string;
  last_error?: string;
  spawn_attempt?: FactoryReleaseSpawnAttempt;
}

export interface DispatchPackLoopInput {
  repoDir: string;
  request: FactoryReleasePrepareRequest;
  pack: LoadedFrgPack;
  packRunId: string;
  issue_numbers: number[];
  engineTrack: "candidate";
  label: string;
  /** When set, production dispatch persists the request binding before spawn. */
  persistCtx?: DurableReconcilePackLoopCtx;
  /** Typed candidate spawn. Missing or SHA-mismatched fails closed. */
  candidateInvocation?: CandidateInvocation;
}

export type DispatchPackLoop = (
  input: DispatchPackLoopInput,
) => Promise<{ loop_run_id: string }>;

export interface ScoreBoundPackLoopArgs {
  version: string;
  fromRun: string;
  repoDir: string;
  request: FactoryReleasePrepareRequest;
  loop: DurablePackLoopArtifacts;
  pack: LoadedFrgPack;
  now: () => Date;
  /** Tests inject collect; production `--from-run` uses the live hybrid-v2 fetch. */
  collectHybridV2?: FactoryGateOpts["collectHybridV2"];
  env?: NodeJS.ProcessEnv;
  factoryControlDir?: string | null;
  resolveUniqueOperationRunsRoots?: FactoryGateOpts["resolveUniqueOperationRunsRoots"];
  uniqueOperationRunsRoot?: string;
  loadCandidateFaultRecoveryInventory?: FactoryGateOpts["loadCandidateFaultRecoveryInventory"];
}

export interface ScoreBoundPackLoopResult {
  evidence: FrgEvidence;
  evidencePath: string | null;
  latestPath: string | null;
}

export type ScoreBoundPackLoop = (
  args: ScoreBoundPackLoopArgs,
) => Promise<ScoreBoundPackLoopResult>;

export interface DurableGenerateOptions {
  /**
   * Reconcile a pack loop bound to this exact request fingerprint / candidate /
   * version / manifest. Default never reuses an unbound newest factory-gate loop.
   */
  reconcilePackLoop?: (
    ctx: DurableReconcilePackLoopCtx,
  ) => Promise<DurablePackLoopArtifacts | null>;
  /**
   * Start of a fresh fixed-pack durable loop for this request.
   * Production default creates/reuses pack issues and dispatches a candidate
   * pack loop. When no bound loop exists, called once.
   */
  startBoundPackLoop?: (
    ctx: DurableReconcilePackLoopCtx,
  ) => Promise<{ loop_run_id: string } | null>;
  createOrReusePackIssues?: CreateOrReusePackIssues;
  dispatchPackLoop?: DispatchPackLoop;
  /**
   * Resume a request-bound run whose binding was persisted but whose spawn
   * never confirmed. Tests inject this seam — no real subprocess.
   */
  resumeBoundPackLoop?: (args: {
    repoDir: string;
    loop_run_id: string;
    candidateInvocation?: CandidateInvocation;
  }) => Promise<void | PackLoopSpawnResult>;
  /**
   * Spawn seams for the default resume dispatcher. Tests inject fake Spawn /
   * ChildProcess here; production omits and uses real `spawn`.
   */
  spawnDeps?: SpawnCandidateLoopDeps;
  /** Typed candidate invocation for pack-loop spawn. Tests inject; production resolves. */
  candidateInvocation?: CandidateInvocation;
  resolveCandidateEngine?: typeof resolveCandidateEngine;
  probePackLoopLiveness?: typeof probePackLoopLiveness;
  env?: NodeJS.ProcessEnv;
  factoryControlDir?: string | null;
  resolveUniqueOperationRunsRoots?: FactoryGateOpts["resolveUniqueOperationRunsRoots"];
  uniqueOperationRunsRoot?: string;
  loadCandidateFaultRecoveryInventory?: FactoryGateOpts["loadCandidateFaultRecoveryInventory"];
  /**
   * Terminal score through factory-gate --from-run (no --observations).
   * Tests inject this seam.
   */
  scoreBoundPackLoop?: ScoreBoundPackLoop;
  writeFile?: (path: string, body: string, mode?: number) => Promise<void>;
  mkdir?: (path: string, opts?: { recursive?: boolean; mode?: number }) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
  now?: () => Date;
}

export interface DurableReconcilePackLoopCtx {
  repoDir: string;
  workDir: string;
  request: FactoryReleasePrepareRequest;
  pack: LoadedFrgPack;
  packRunId: string;
  frgRunId: string;
  requestFingerprint: string;
  writeFile: (path: string, body: string, mode?: number) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  now: () => Date;
}

const POST_PILOT_ALLOWED_SOURCES = new Set<string>([
  "live",
  "ledger",
  "derived",
  "observation",
]);

export function factoryReleasePackInstancePath(workDir: string): string {
  return path.join(workDir, "pack-instance.json");
}

export function factoryReleaseLoopBindingPath(loopRunId: string): string {
  return path.join(runDir(defaultLoopStoreDeps(), loopRunId), "factory-release-binding.json");
}

/** True when the binding was persisted but the OS never started the child. */
export function isPendingLoopDispatch(binding: Record<string, unknown>): boolean {
  return binding.dispatch_state === "bound";
}

export function parseDispatchState(raw: unknown): FactoryReleaseLoopDispatchState | null {
  if (raw === "bound" || raw === "starting" || raw === "dispatched" || raw === "failed") return raw;
  return null;
}

function isPackLoopSpawnResult(value: unknown): value is PackLoopSpawnResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return parseDispatchState((value as { dispatch_state?: unknown }).dispatch_state) !== null;
}

function requirePackLoopSpawnResult(
  value: unknown,
  loopRunId: string,
  action: "spawn" | "resume",
): PackLoopSpawnResult {
  if (!isPackLoopSpawnResult(value)) {
    throw new Error(
      `pack-loop ${action} returned no durable handoff acknowledgement for ${loopRunId}`,
    );
  }
  return value;
}

/**
 * Persist pack-instance `loop_run_id` and the matching loop binding.
 * Callers write `bound` before spawn, `starting` after OS accept, and
 * `dispatched` only after a valid durable handoff.
 */
export async function persistFactoryReleaseLoopBinding(
  ctx: DurableReconcilePackLoopCtx,
  loopRunId: string,
  dispatchState: FactoryReleaseLoopDispatchState,
  extras: FactoryReleaseLoopBindingFields = {},
): Promise<void> {
  const loopBindingPath = factoryReleaseLoopBindingPath(loopRunId);
  let prior: Record<string, unknown> = {};
  if (await ctx.fileExists(loopBindingPath)) {
    try {
      prior = JSON.parse(await ctx.readFile(loopBindingPath)) as Record<string, unknown>;
    } catch {
      prior = {};
    }
  }
  const merged: Record<string, unknown> = {
    schema_version: 1,
    kind: "factory_release_loop_binding",
    request_fingerprint: ctx.requestFingerprint,
    target_version: ctx.request.target_version,
    candidate_git_sha: ctx.request.integrated_candidate.git_sha,
    pack_id: ctx.request.frg_manifest.pack_id,
    manifest_sha256: ctx.request.frg_manifest.sha256,
    pack_run_id: ctx.packRunId,
    frg_run_id: ctx.frgRunId,
    loop_run_id: loopRunId,
    dispatch_state: dispatchState,
  };
  const keep = [
    "observation_deadline",
    "spawn_attempt",
    "candidate_invocation",
    "stderr_evidence_path",
    "resume_count",
    "failed_process_identity",
    "last_error",
  ] as const;
  for (const key of keep) {
    if (prior[key] !== undefined) merged[key] = prior[key];
  }
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) merged[key] = value;
  }
  if (dispatchState !== "starting") delete merged.observation_deadline;
  await ctx.writeFile(loopBindingPath, canonicalJson(merged), 0o600);
  const instancePath = factoryReleasePackInstancePath(ctx.workDir);
  let createdAt = isoNow(ctx.now());
  if (await ctx.fileExists(instancePath)) {
    try {
      const raw = JSON.parse(await ctx.readFile(instancePath)) as FactoryReleasePackInstance;
      if (raw.kind === "factory_release_pack_instance" && typeof raw.created_at === "string") {
        createdAt = raw.created_at;
      }
    } catch {
      // Replace an unreadable instance with a fresh matching record.
    }
  }
  await ctx.writeFile(
    instancePath,
    canonicalJson({
      schema_version: 1,
      kind: "factory_release_pack_instance",
      request_fingerprint: ctx.requestFingerprint,
      target_version: ctx.request.target_version,
      candidate_git_sha: ctx.request.integrated_candidate.git_sha,
      pack_id: ctx.request.frg_manifest.pack_id,
      manifest_sha256: ctx.request.frg_manifest.sha256,
      pack_run_id: ctx.packRunId,
      frg_run_id: ctx.frgRunId,
      loop_run_id: loopRunId,
      created_at: createdAt,
      updated_at: isoNow(ctx.now()),
    } satisfies FactoryReleasePackInstance),
    0o600,
  );
}

/** Persist `starting` after OS accept, before the parent awaits handoff. */
async function persistPackLoopOsAccepted(
  ctx: DurableReconcilePackLoopCtx | undefined,
  loopRunId: string,
  info: { pid?: number; observation_deadline: string },
  invocation?: CandidateInvocation,
): Promise<void> {
  if (!ctx) return;
  const extras: FactoryReleaseLoopBindingFields = {
    observation_deadline: info.observation_deadline,
    spawn_attempt: { pid: info.pid, at: isoNow(ctx.now()) },
  };
  if (invocation) {
    extras.candidate_invocation = {
      executable: invocation.executable,
      argv: [...invocation.argv],
      candidateSha: invocation.candidateSha,
    };
  }
  await persistFactoryReleaseLoopBinding(ctx, loopRunId, "starting", extras);
}

async function boundLoopNeedsDispatchRetry(
  loopRunId: string,
  request: FactoryReleasePrepareRequest,
  fingerprint: string,
  readFile: (p: string) => Promise<string>,
  fileExists: (p: string) => Promise<boolean>,
): Promise<boolean> {
  const bindingPath = factoryReleaseLoopBindingPath(loopRunId);
  if (!(await fileExists(bindingPath))) return false;
  try {
    const binding = JSON.parse(await readFile(bindingPath)) as Record<string, unknown>;
    return loopBindingMatchesRequest(binding, request, fingerprint) && isPendingLoopDispatch(binding);
  } catch {
    return false;
  }
}

const TERMINAL_PACK_ITEM_STATES = new Set([
  "ready",
  "merged",
  "released",
  "deployed",
  "abandoned",
  "skipped",
]);

/**
 * True when the bound pack loop has finished driving: ledger.stop is set, or
 * every item is in a terminal item state. An empty / unparsable ledger is
 * not terminal (in-progress / still starting).
 */
export function isBoundPackLoopTerminal(loop: DurablePackLoopArtifacts): boolean {
  let ledger: { stop?: unknown; items?: Record<string, { state?: string }> };
  try {
    ledger = JSON.parse(loop.ledger_text) as {
      stop?: unknown;
      items?: Record<string, { state?: string }>;
    };
  } catch {
    return false;
  }
  if (ledger.stop) return true;
  const items = Object.values(ledger.items ?? {});
  if (items.length === 0) return false;
  return items.every(
    (item) => typeof item?.state === "string" && TERMINAL_PACK_ITEM_STATES.has(item.state),
  );
}

function loopBindingMatchesRequest(
  binding: Record<string, unknown>,
  request: FactoryReleasePrepareRequest,
  fingerprint: string,
): boolean {
  return (
    binding.request_fingerprint === fingerprint &&
    binding.target_version === request.target_version &&
    binding.candidate_git_sha === request.integrated_candidate.git_sha &&
    binding.manifest_sha256 === request.frg_manifest.sha256 &&
    binding.pack_id === request.frg_manifest.pack_id
  );
}

function nonTerminalBoundStub(loopRunId: string): DurablePackLoopArtifacts {
  return {
    loop_run_id: loopRunId,
    contract_text: "",
    ledger_text: "{}",
    events_text: "",
    action_evidence_text: "{}\n",
  };
}

/**
 * Production start: render factory-gate-v1 templates, create or reuse pack
 * issues to the manifest minimum, dispatch the candidate-engine pack loop
 * (`--engine-track candidate` is intent metadata, not the binary selector).
 */
export async function defaultStartBoundPackLoop(
  ctx: DurableReconcilePackLoopCtx,
  opts: Pick<DurableGenerateOptions, "createOrReusePackIssues" | "dispatchPackLoop" | "candidateInvocation"> = {},
): Promise<{ loop_run_id: string } | null> {
  const create = opts.createOrReusePackIssues;
  const dispatch = opts.dispatchPackLoop;
  if (!create || !dispatch) {
    throw new Error(
      "factory-release prepare: startBoundPackLoop requires createOrReusePackIssues " +
        "and dispatchPackLoop seams (inject in tests; production defaultFactoryReleasePrepareDeps wires them)",
    );
  }
  const rendered = renderFrgPackIssues(ctx.pack, {
    release_version: ctx.request.target_version,
    pack_run_id: ctx.packRunId,
  });
  const minimum = ctx.pack.manifest.minimum_fresh_issues;
  if (rendered.length < minimum) {
    throw new Error(
      `factory-release prepare: factory-gate-v1 templates produced ${rendered.length} ` +
        `issues; manifest minimum_fresh_issues is ${minimum}`,
    );
  }
  const created = await create({
    repoDir: ctx.repoDir,
    request: ctx.request,
    pack: ctx.pack,
    packRunId: ctx.packRunId,
    rendered,
  });
  if (created.issue_numbers.length < minimum) {
    throw new Error(
      `factory-release prepare: create/reuse returned ${created.issue_numbers.length} ` +
        `issues; manifest minimum_fresh_issues is ${minimum}`,
    );
  }
  const selector = ctx.pack.manifest.selector;
  const label = selector.type === "label" ? selector.value : "factory-gate";
  return dispatch({
    repoDir: ctx.repoDir,
    request: ctx.request,
    pack: ctx.pack,
    packRunId: ctx.packRunId,
    issue_numbers: created.issue_numbers,
    engineTrack: "candidate",
    label,
    persistCtx: ctx,
    candidateInvocation: opts.candidateInvocation,
  });
}

export interface LoadCandidateFaultRecoveryInventoryDeps {
  /**
   * Resolve `git rev-parse HEAD` for the scored checkout. Tests inject this
   * so unit tests never spawn git.
   */
  resolveCheckoutSha?: (repoDir: string) => string | null | Promise<string | null>;
  /**
   * Load `FAULT_RECOVERY_MATRIX` from the scored checkout. Tests inject this
   * so unit tests never import the control-checkout module as candidate rows.
   */
  loadMatrixRows?: (
    repoDir: string,
  ) => Promise<readonly FaultRecoveryMatrixRow[] | null>;
}

async function defaultResolveCandidateCheckoutSha(
  repoDir: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 5_000 },
    );
    return parseExactGitSha(String(stdout).trim());
  } catch {
    return null;
  }
}

async function defaultLoadCandidateMatrixRows(
  repoDir: string,
): Promise<readonly FaultRecoveryMatrixRow[] | null> {
  try {
    const matrixPath = path.resolve(repoDir, "core/scripts/fault-recovery-matrix.ts");
    const mod = (await import(pathToFileURL(matrixPath).href)) as {
      FAULT_RECOVERY_MATRIX?: unknown;
    };
    return Array.isArray(mod.FAULT_RECOVERY_MATRIX)
      ? (mod.FAULT_RECOVERY_MATRIX as FaultRecoveryMatrixRow[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Production in-flight inventory loader. Reads the candidate checkout at
 * `repoDir`, verifies that checkout's HEAD equals `candidateSha`, and only
 * then returns that tree's matrix rows. A control-checkout matrix is never
 * labeled with the request SHA. SHA mismatch, unreadable HEAD, or a missing
 * matrix yields no inventory rows.
 */
export async function defaultLoadCandidateFaultRecoveryInventory(
  args: { candidateSha: string; repoDir: string },
  deps: LoadCandidateFaultRecoveryInventoryDeps = {},
): Promise<{ rows: readonly FaultRecoveryMatrixRow[]; sourceSha?: string | null }> {
  const candidateSha = parseExactGitSha(args.candidateSha);
  const repoDir = typeof args.repoDir === "string" ? args.repoDir.trim() : "";
  if (!candidateSha || !repoDir) return { rows: [], sourceSha: null };

  const resolveSha = deps.resolveCheckoutSha ?? defaultResolveCandidateCheckoutSha;
  const checkoutSha = parseExactGitSha(await resolveSha(repoDir));
  if (!checkoutSha || checkoutSha !== candidateSha) {
    return { rows: [], sourceSha: checkoutSha };
  }

  const loadRows = deps.loadMatrixRows ?? defaultLoadCandidateMatrixRows;
  const rows = await loadRows(repoDir);
  if (!rows) return { rows: [], sourceSha: null };
  return { rows, sourceSha: checkoutSha };
}

/**
 * In-process equivalent of `pipeline factory-gate --for <ver> --from-run <id>`.
 * Never accepts --observations / scenarioOverrides / a work-directory file.
 */
export async function defaultScoreBoundPackLoop(
  args: ScoreBoundPackLoopArgs,
): Promise<ScoreBoundPackLoopResult> {
  let contract: LoopContract;
  try {
    contract = JSON.parse(args.loop.contract_text) as LoopContract;
  } catch (err) {
    throw new Error(
      `factory-release prepare: terminal score requires a loadable loop contract: ${(err as Error).message}`,
    );
  }
  let ledger;
  try {
    ledger = JSON.parse(args.loop.ledger_text);
  } catch (err) {
    throw new Error(
      `factory-release prepare: terminal score requires a loadable loop ledger: ${(err as Error).message}`,
    );
  }
  const result = await runFactoryGate({
    version: args.version,
    repoDir: args.repoDir,
    fromRun: args.fromRun,
    writeEvidence: false,
    loadLedger: async () => ledger,
    loadContract: async () => contract,
    // Explicit: no --observations, no scenario/composition overrides, no
    // caller-authored pack provenance. Hybrid v2 inside the scorer applies.
    requestCandidateGitSha: args.request.integrated_candidate.git_sha,
    attestationKey: null,
    inFlightShip: true,
    env: args.env,
    factoryControlDir: args.factoryControlDir,
    resolveUniqueOperationRunsRoots: args.resolveUniqueOperationRunsRoots,
    uniqueOperationRunsRoot: args.uniqueOperationRunsRoot,
    loadCandidateFaultRecoveryInventory:
      args.loadCandidateFaultRecoveryInventory ??
      defaultLoadCandidateFaultRecoveryInventory,
    stdout: () => {},
    stderr: () => {},
    now: args.now,
    collectHybridV2: args.collectHybridV2,
  });
  return {
    evidence: result.evidence,
    evidencePath: result.evidencePath,
    latestPath: result.latestPath,
  };
}

/**
 * Production create/reuse: reuse open factory-gate issues that already carry
 * this pack_run_id + template_id; create the rest via gh.
 */
export async function productionCreateOrReusePackIssues(
  input: CreateOrReusePackIssuesInput,
  deps: {
    listOpenPackIssues?: (repo: string, labels: string[]) => Promise<
      Array<{ number: number; title: string; body: string }>
    >;
    createIssue?: (title: string, body: string, labels: string[]) => Promise<number>;
  } = {},
): Promise<{ issue_numbers: number[] }> {
  const list =
    deps.listOpenPackIssues ??
    (async (repo, labels) => {
      const { getOpenIssues } = await import("./gh.ts");
      const open = await getOpenIssues(repo, { labels });
      return open.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
      }));
    });
  const create =
    deps.createIssue ??
    (async (title, body, labels) => {
      const { createIssue } = await import("./gh.ts");
      const { resolveConfig } = await import("./config.ts");
      const cfg = resolveConfig({ repoPath: input.repoDir });
      return createIssue(cfg, title, body, labels);
    });
  const open = await list(input.request.repository, input.pack.manifest.issue_labels);
  const numbers: number[] = [];
  for (const rendered of input.rendered) {
    const existing = open.find(
      (issue) =>
        issue.body.includes(input.packRunId) &&
        issue.body.includes(rendered.provenance.template_id),
    );
    if (existing) {
      numbers.push(existing.number);
      continue;
    }
    numbers.push(await create(rendered.title, rendered.body, rendered.labels));
  }
  return { issue_numbers: numbers };
}

export type SpawnCandidateLoop = (args: {
  repoDir: string;
  loop_run_id: string;
  issue_numbers: number[];
  engineTrack: "candidate";
  label: string;
  candidateInvocation?: CandidateInvocation;
}) => Promise<void | PackLoopSpawnResult>;

/**
 * Wait for detached `spawn` or `error` before treating launch as confirmed.
 * Do not unref until spawn succeeds — otherwise startup ENOENT is lost.
 */
export function observeDetachedChildStart(child: {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref?: () => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

/**
 * FRG signing credential and credential-path vars. Candidate-track children
 * must not inherit these from a prepare wrapper that holds the attestor secret.
 */
export const CANDIDATE_LOOP_DENIED_FRG_ENV = [
  "PIPELINE_FRG_ATTESTATION_KEY",
  "PIPELINE_FRG_ATTESTATION_KEY_FILE",
] as const;

export type CandidateLoopChild = {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  once?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  stdout?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    destroy?: () => void;
  } | null;
  stderr?: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    destroy?: () => void;
  } | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean | void;
  unref?: () => void;
  pid?: number;
};

export type CandidateLoopSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    detached?: boolean;
    stdio?: "ignore" | Array<"ignore" | "pipe">;
    env?: NodeJS.ProcessEnv;
  },
) => CandidateLoopChild;

/** Copy `source` and drop every supported FRG signing credential / path var. */
export function sanitizeCandidateLoopEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of CANDIDATE_LOOP_DENIED_FRG_ENV) {
    delete env[name];
  }
  return env;
}

export function freezeCandidateInvocation(input: {
  executable: string;
  loopRunId: string;
  candidateSha: string;
}): CandidateInvocation {
  const sha = parseExactGitSha(input.candidateSha);
  if (!sha) {
    throw new Error("pack-loop candidate SHA is not an exact 40-hex git OID");
  }
  if (!path.isAbsolute(input.executable)) {
    throw new Error("pack-loop candidate executable must be an absolute launcher path");
  }
  return Object.freeze({
    executable: input.executable,
    argv: Object.freeze([
      "loop",
      "--resume",
      input.loopRunId,
      "--engine-track",
      "candidate",
      "--profile",
      "claude",
    ]),
    candidateSha: sha,
  });
}

export function assertCandidateInvocation(
  invocation: CandidateInvocation | null | undefined,
  requestSha: string,
  fileExists: (p: string) => boolean,
): CandidateInvocation {
  if (!invocation) {
    throw new Error("pack-loop dispatch missing typed candidate invocation");
  }
  const want = parseExactGitSha(requestSha);
  if (!want || invocation.candidateSha !== want) {
    throw new Error("pack-loop candidate invocation SHA does not match the request candidate SHA");
  }
  if (!path.isAbsolute(invocation.executable)) {
    throw new Error("pack-loop candidate executable must be an absolute launcher path");
  }
  if (!fileExists(invocation.executable)) {
    throw new Error(`pack-loop candidate launcher does not exist: ${invocation.executable}`);
  }
  return invocation;
}

export function formatPackLoopLastError(input: {
  exitCode?: number | null;
  errorCode?: string;
  excerpt: string;
  evidencePath?: string | null;
  writeError?: string;
}): string {
  const excerpt = input.excerpt.trim() || "(no stderr)";
  if (typeof input.exitCode === "number") {
    const code = input.errorCode ? ` (${input.errorCode})` : "";
    const evidence = input.writeError
      ? ` (evidence write failed: ${input.writeError})`
      : input.evidencePath
        ? ` (evidence: ${input.evidencePath})`
        : " (evidence: none)";
    return `pack-loop child exit ${input.exitCode}${code}: ${excerpt}${evidence}`;
  }
  const code = input.errorCode ?? "spawn_error";
  const evidence = input.writeError
    ? ` (evidence write failed: ${input.writeError})`
    : input.evidencePath
      ? ` (evidence: ${input.evidencePath})`
      : " (evidence: none)";
  return `pack-loop spawn error ${code}: ${excerpt}${evidence}`;
}

class BoundedStreamBuffer {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private overflow = false;

  push(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    let rest = buf;
    if (this.head.length < PACK_LOOP_STDERR_HEAD_BYTES) {
      const take = Math.min(PACK_LOOP_STDERR_HEAD_BYTES - this.head.length, rest.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    this.overflow = true;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > PACK_LOOP_STDERR_TAIL_BYTES && this.tail.length > 1) {
      const drop = this.tail.shift()!;
      this.tailBytes -= drop.length;
    }
    if (this.tailBytes > PACK_LOOP_STDERR_TAIL_BYTES) {
      const last = this.tail[this.tail.length - 1]!;
      this.tail = [last.subarray(Math.max(0, last.length - PACK_LOOP_STDERR_TAIL_BYTES))];
      this.tailBytes = this.tail[0]!.length;
    }
  }

  text(): string {
    if (!this.overflow) return this.head.toString("utf8");
    return `${this.head.toString("utf8")}\n...[truncated]...\n${Buffer.concat(this.tail).toString("utf8")}`;
  }
}

function drainChildPipes(child: CandidateLoopChild): { stdout: BoundedStreamBuffer; stderr: BoundedStreamBuffer } {
  const stdout = new BoundedStreamBuffer();
  const stderr = new BoundedStreamBuffer();
  child.stdout?.on("data", (chunk) => stdout.push(chunk));
  child.stderr?.on("data", (chunk) => stderr.push(chunk));
  return { stdout, stderr };
}

const PACK_LOOP_FAILED_CHILD_SETTLE_MS = 1_000;

/** Stop a still-running child whose dispatch already failed closed. */
async function stopFailedPackLoopChild(
  child: CandidateLoopChild,
  alreadyExited: boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (!alreadyExited) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once?.("exit", () => finish());
      child.kill?.("SIGTERM");
      void sleep(PACK_LOOP_FAILED_CHILD_SETTLE_MS).then(finish);
    });
  }
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
}

function redactPackLoopExcerpt(raw: string): string {
  return sanitize(redactSecrets(raw));
}

export async function persistPackLoopStderrEvidence(
  writeFile: (p: string, body: string, mode?: number) => Promise<void>,
  evidencePath: string,
  raw: string,
): Promise<{ path: string } | { writeError: string }> {
  const body = redactPackLoopExcerpt(raw);
  try {
    await writeFile(evidencePath, body, 0o600);
    return { path: evidencePath };
  } catch (err) {
    return { writeError: (err as Error).message };
  }
}

export function validateDurablePackLoopHandoff(input: {
  handoff: unknown;
  loopRunId: string;
  candidateSha: string;
  storeRunDir: string;
  supervisor: { pid?: unknown; boot_id?: unknown; started_at?: unknown } | null;
  realpath?: (p: string) => string;
}): { ok: true } | { ok: false; error: string } {
  if (!isDurableLoopRunHandoff(input.handoff)) {
    return { ok: false, error: "pack-loop handoff missing or malformed" };
  }
  if (input.handoff.run_id !== input.loopRunId) {
    return { ok: false, error: "pack-loop handoff run_id mismatch" };
  }
  if (input.handoff.candidate_sha !== input.candidateSha) {
    return { ok: false, error: "pack-loop handoff candidate_sha mismatch" };
  }
  const realpath = input.realpath ?? path.resolve;
  if (!pathContainedIn(input.handoff.run_dir, input.storeRunDir, realpath)) {
    return { ok: false, error: "pack-loop handoff run_dir is not contained in the store run directory" };
  }
  if (!pathContainedIn(input.handoff.events, input.handoff.run_dir, realpath)) {
    return { ok: false, error: "pack-loop handoff events path is not contained in run_dir" };
  }
  const sup = input.supervisor;
  if (
    !sup ||
    sup.pid !== input.handoff.supervisor.pid ||
    sup.boot_id !== input.handoff.supervisor.boot_id ||
    sup.started_at !== input.handoff.supervisor.started_at
  ) {
    return { ok: false, error: "pack-loop handoff supervisor identity mismatch" };
  }
  return { ok: true };
}

export interface SpawnCandidateLoopDeps {
  spawn?: CandidateLoopSpawn;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  readHandoff?: (loopRunId: string) => Promise<unknown | null>;
  readSupervisor?: (loopRunId: string) => Promise<{ pid?: unknown; boot_id?: unknown; started_at?: unknown } | null>;
  realpath?: (p: string) => string;
  writeFile?: (p: string, body: string, mode?: number) => Promise<void>;
  evidencePath?: string;
  observationMs?: number;
  onAccepted?: (info: { pid?: number; observation_deadline: string }) => Promise<void>;
  storeRunDir?: string;
}

function defaultFileExistsSync(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export async function defaultSpawnCandidateLoop(
  args: {
    repoDir: string;
    loop_run_id: string;
    candidateInvocation?: CandidateInvocation;
    requestCandidateSha?: string;
  },
  deps: SpawnCandidateLoopDeps = {},
): Promise<PackLoopSpawnResult> {
  const sourceEnv = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const fileExists = deps.fileExists ?? defaultFileExistsSync;
  const requestSha = args.requestCandidateSha ?? args.candidateInvocation?.candidateSha ?? "";
  const invocation = assertCandidateInvocation(args.candidateInvocation, requestSha, fileExists);
  const spawnImpl = deps.spawn ?? ((await import("node:child_process")).spawn as unknown as CandidateLoopSpawn);
  const childEnv = sanitizeCandidateLoopEnv(sourceEnv);
  childEnv[PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV] = invocation.candidateSha;
  let child: CandidateLoopChild;
  try {
    child = spawnImpl(invocation.executable, invocation.argv, {
      cwd: args.repoDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "spawn_throw";
    return {
      dispatch_state: "bound",
      last_error: formatPackLoopLastError({
        errorCode: String(code),
        excerpt: (err as Error).message,
      }),
      spawn_attempt: { error_code: String(code), at: isoNow(now()) },
    };
  }
  const pipes = drainChildPipes(child);
  let exitCode: number | null | undefined;
  child.once?.("exit", (code) => {
    exitCode = code;
  });
  const started = observeDetachedChildStart({
    once: (event, listener) => child.once(event as "error", listener as (err: Error) => void),
    unref: undefined,
  });
  try {
    await started;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "spawn_error";
    return {
      dispatch_state: "bound",
      last_error: formatPackLoopLastError({
        errorCode: String(code),
        excerpt: redactPackLoopExcerpt(`${(err as Error).message}\n${pipes.stderr.text()}`),
      }),
      spawn_attempt: { error_code: String(code), at: isoNow(now()) },
    };
  }
  const deadlineMs = packLoopStartupObservationMs(deps.observationMs);
  const deadline = new Date(now().getTime() + deadlineMs).toISOString();
  if (deps.onAccepted) {
    await deps.onAccepted({ pid: child.pid, observation_deadline: deadline });
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const store = defaultLoopStoreDeps(sourceEnv);
  const storeRunDir = deps.storeRunDir ?? runDir(store, args.loop_run_id);
  const evidencePath =
    deps.evidencePath ?? path.join(storeRunDir, "pack-loop-stderr.txt");
  const readHandoff =
    deps.readHandoff ??
    (async (id: string) => readLoopRunHandoff(store, id));
  const readSupervisor =
    deps.readSupervisor ??
    (async (id: string) => readSupervisorProcess(store, id));
  const startedAt = now().getTime();
  while (now().getTime() - startedAt < deadlineMs) {
    if (exitCode !== undefined) break;
    let handoff: unknown = null;
    try {
      handoff = await readHandoff(args.loop_run_id);
    } catch {
      handoff = null;
    }
    if (handoff) {
      let supervisor: { pid?: unknown; boot_id?: unknown; started_at?: unknown } | null = null;
      try {
        supervisor = await readSupervisor(args.loop_run_id);
      } catch {
        supervisor = null;
      }
      const valid = validateDurablePackLoopHandoff({
        handoff,
        loopRunId: args.loop_run_id,
        candidateSha: invocation.candidateSha,
        storeRunDir,
        supervisor,
        realpath: deps.realpath,
      });
      if (valid.ok) {
        child.unref?.();
        return {
          dispatch_state: "dispatched",
          pid: child.pid,
          observation_deadline: deadline,
          spawn_attempt: { pid: child.pid, at: isoNow(now()) },
        };
      }
      await stopFailedPackLoopChild(child, exitCode !== undefined, sleep);
      const excerpt = await finishStderrEvidence(deps, evidencePath, pipes);
      return {
        dispatch_state: "failed",
        pid: child.pid,
        observation_deadline: deadline,
        last_error: formatPackLoopLastError({
          errorCode: "handoff_mismatch",
          excerpt: excerpt.excerpt,
          evidencePath: excerpt.path,
          writeError: excerpt.writeError,
        }),
        stderr_evidence_path: excerpt.path,
        spawn_attempt: { pid: child.pid, error_code: "handoff_mismatch", at: isoNow(now()) },
      };
    }
    await sleep(50);
  }
  const excerpt = await finishStderrEvidence(deps, evidencePath, pipes);
  child.unref?.();
  if (exitCode !== undefined) {
    return {
      dispatch_state: "failed",
      pid: child.pid,
      last_error: formatPackLoopLastError({
        exitCode: exitCode ?? 0,
        excerpt: excerpt.excerpt,
        evidencePath: excerpt.path,
        writeError: excerpt.writeError,
      }),
      stderr_evidence_path: excerpt.path,
      spawn_attempt: { pid: child.pid, error_code: "pre_handoff_exit", at: isoNow(now()) },
    };
  }
  return {
    dispatch_state: "failed",
    pid: child.pid,
    last_error: formatPackLoopLastError({
      errorCode: "observation_expired",
      excerpt: excerpt.excerpt,
      evidencePath: excerpt.path,
      writeError: excerpt.writeError,
    }),
    stderr_evidence_path: excerpt.path,
    observation_deadline: deadline,
    spawn_attempt: { pid: child.pid, error_code: "observation_expired", at: isoNow(now()) },
  };
}

async function finishStderrEvidence(
  deps: SpawnCandidateLoopDeps,
  evidencePath: string,
  pipes: { stdout: BoundedStreamBuffer; stderr: BoundedStreamBuffer },
): Promise<{ excerpt: string; path?: string; writeError?: string }> {
  const raw = pipes.stderr.text() || pipes.stdout.text();
  const excerpt = redactPackLoopExcerpt(raw);
  if (!deps.writeFile) return { excerpt };
  const written = await persistPackLoopStderrEvidence(deps.writeFile, evidencePath, raw);
  if ("writeError" in written) return { excerpt, writeError: written.writeError };
  return { excerpt, path: written.path };
}

export async function defaultResumeBoundPackLoop(
  args: {
    repoDir: string;
    loop_run_id: string;
    candidateInvocation?: CandidateInvocation;
    requestCandidateSha?: string;
  },
  deps: SpawnCandidateLoopDeps = {},
): Promise<PackLoopSpawnResult> {
  return defaultSpawnCandidateLoop(args, deps);
}

async function persistSpawnResult(
  ctx: DurableReconcilePackLoopCtx | undefined,
  loopRunId: string,
  result: PackLoopSpawnResult,
  invocation?: CandidateInvocation,
): Promise<void> {
  if (!ctx) return;
  const extras: FactoryReleaseLoopBindingFields = {
    spawn_attempt: result.spawn_attempt,
    stderr_evidence_path: result.stderr_evidence_path,
    last_error: result.last_error,
    observation_deadline: result.observation_deadline,
  };
  if (invocation) {
    extras.candidate_invocation = {
      executable: invocation.executable,
      argv: [...invocation.argv],
      candidateSha: invocation.candidateSha,
    };
  }
  await persistFactoryReleaseLoopBinding(ctx, loopRunId, result.dispatch_state, extras);
}

function restoreInvocation(
  binding: Record<string, unknown> | null,
  loopRunId: string,
  _request: FactoryReleasePrepareRequest,
): CandidateInvocation | undefined {
  const snap = binding?.candidate_invocation;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return undefined;
  const o = snap as { executable?: unknown; argv?: unknown; candidateSha?: unknown };
  if (typeof o.executable !== "string" || typeof o.candidateSha !== "string") return undefined;
  if (!Array.isArray(o.argv) || !o.argv.every((a) => typeof a === "string")) {
    return freezeCandidateInvocation({
      executable: o.executable,
      loopRunId,
      candidateSha: o.candidateSha,
    });
  }
  return Object.freeze({
    executable: o.executable,
    argv: Object.freeze([...o.argv] as string[]),
    candidateSha: o.candidateSha,
  });
}

function failedIdentityFromBinding(
  binding: Record<string, unknown> | null,
): FactoryReleaseFailedProcessIdentity | undefined {
  const snap = binding?.failed_process_identity;
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    const o = snap as { pid?: unknown; boot_id?: unknown; started_at?: unknown };
    if (typeof o.pid === "number" && typeof o.boot_id === "string" && typeof o.started_at === "string") {
      return { pid: o.pid, boot_id: o.boot_id, started_at: o.started_at };
    }
  }
  return undefined;
}

async function probePrepareLiveness(
  loopRunId: string,
  opts: DurableGenerateOptions,
  request: FactoryReleasePrepareRequest,
  binding: Record<string, unknown> | null,
): Promise<PackLoopLivenessStatus> {
  const probe = opts.probePackLoopLiveness ?? probePackLoopLiveness;
  const store = defaultLoopStoreDeps();
  const deadline = typeof binding?.observation_deadline === "string" ? binding.observation_deadline : null;
  const stderr = typeof binding?.stderr_evidence_path === "string" ? binding.stderr_evidence_path : null;
  return probe(loopRunId, {
    store,
    now: opts.now,
    observationDeadline: deadline,
    candidateSha: request.integrated_candidate.git_sha,
    stderrEvidencePath: stderr,
  });
}

async function readStartingHandoffArtifact(
  loopRunId: string,
  ctx: DurableReconcilePackLoopCtx,
  opts: DurableGenerateOptions,
  storeRunDir: string,
): Promise<{ handoff: unknown | null; supervisor: { pid?: unknown; boot_id?: unknown; started_at?: unknown } | null }> {
  let handoff: unknown | null = null;
  if (opts.spawnDeps?.readHandoff) {
    handoff = await opts.spawnDeps.readHandoff(loopRunId);
  } else {
    const p = loopRunHandoffPath(storeRunDir);
    if (await ctx.fileExists(p)) {
      handoff = JSON.parse(await ctx.readFile(p));
    }
  }
  let supervisor: { pid?: unknown; boot_id?: unknown; started_at?: unknown } | null = null;
  if (opts.spawnDeps?.readSupervisor) {
    supervisor = await opts.spawnDeps.readSupervisor(loopRunId);
  } else {
    const p = path.join(storeRunDir, "supervisor.json");
    if (await ctx.fileExists(p)) {
      supervisor = JSON.parse(await ctx.readFile(p)) as {
        pid?: unknown;
        boot_id?: unknown;
        started_at?: unknown;
      };
    }
  }
  return { handoff, supervisor };
}

/**
 * Later prepare ticks must adopt a valid durable handoff written after OS
 * accept, even when the original parent has already detached. Malformed
 * evidence fails closed. Missing evidence stays `starting` until the deadline.
 */
async function reconcileStartingDurableHandoff(input: {
  ctx: DurableReconcilePackLoopCtx;
  loopRunId: string;
  request: FactoryReleasePrepareRequest;
  binding: Record<string, unknown> | null;
  opts: DurableGenerateOptions;
}): Promise<{ kind: "adopted" } | { kind: "absent" } | { kind: "failed"; error: string }> {
  const invocation = restoreInvocation(input.binding, input.loopRunId, input.request);
  const candidateSha = invocation?.candidateSha ?? input.request.integrated_candidate.git_sha;
  const storeRunDir = input.opts.spawnDeps?.storeRunDir ?? runDir(defaultLoopStoreDeps(), input.loopRunId);
  let evidence: { handoff: unknown | null; supervisor: { pid?: unknown; boot_id?: unknown; started_at?: unknown } | null };
  try {
    evidence = await readStartingHandoffArtifact(input.loopRunId, input.ctx, input.opts, storeRunDir);
  } catch (err) {
    return {
      kind: "failed",
      error: `pack-loop handoff unreadable: ${(err as Error).message}`,
    };
  }
  if (!evidence.handoff) return { kind: "absent" };
  const valid = validateDurablePackLoopHandoff({
    handoff: evidence.handoff,
    loopRunId: input.loopRunId,
    candidateSha,
    storeRunDir,
    supervisor: evidence.supervisor,
    realpath: input.opts.spawnDeps?.realpath,
  });
  if (!valid.ok) return { kind: "failed", error: valid.error };
  const extras: FactoryReleaseLoopBindingFields = {};
  if (invocation) {
    extras.candidate_invocation = {
      executable: invocation.executable,
      argv: [...invocation.argv],
      candidateSha: invocation.candidateSha,
    };
  }
  await persistFactoryReleaseLoopBinding(input.ctx, input.loopRunId, "dispatched", extras);
  return { kind: "adopted" };
}

/**
 * Production dispatch: allocate/init the work-list run, persist `bound`, then
 * spawn the resolved candidate launcher. OS accept is `starting`. Valid
 * durable `loop_run_handoff` is `dispatched`. `--engine-track candidate` on
 * argv is intent metadata, not the binary selector.
 */
export async function productionDispatchPackLoop(
  input: DispatchPackLoopInput,
  deps: {
    spawnCandidateLoop?: SpawnCandidateLoop;
    initBoundLoop?: (args: {
      repoDir: string;
      issue_numbers: number[];
      label: string;
    }) => Promise<{ loop_run_id: string }>;
    persistBinding?: (loop_run_id: string, state?: FactoryReleaseLoopDispatchState) => Promise<void>;
    markDispatched?: (loop_run_id: string) => Promise<void>;
    fileExists?: (p: string) => boolean;
    resolveCandidate?: typeof resolveCandidateEngine;
    env?: NodeJS.ProcessEnv;
    spawnDeps?: SpawnCandidateLoopDeps;
  } = {},
): Promise<{ loop_run_id: string }> {
  const init =
    deps.initBoundLoop ??
    (async ({ repoDir, issue_numbers, label }) => {
      const { compileWorkListRunFresh, workListRunId } = await import("./pipeline.ts");
      const { resolveConfig } = await import("./config.ts");
      const { initRecoverableRun } = await import("./loop/recovery.ts");
      const { defaultLoopStoreDeps, runExists } = await import("./loop/store.ts");
      const { realWorkListDependencyDiscoverDeps } = await import("./loop/work-list-deps.ts");
      const cfg = resolveConfig({ repoPath: repoDir });
      const issues = issue_numbers.map(String);
      const loop_run_id = workListRunId(cfg.repo, "codex", issues);
      const store = defaultLoopStoreDeps();
      if (!(await runExists(store, loop_run_id))) {
        const compiled = await compileWorkListRunFresh(
          cfg,
          "codex",
          issues,
          loop_run_id,
          realWorkListDependencyDiscoverDeps(cfg),
          { type: "label", value: label },
        );
        await initRecoverableRun(store, compiled.contract, compiled.ledger);
      }
      return { loop_run_id };
    });
  const { loop_run_id } = await init({
    repoDir: input.repoDir,
    issue_numbers: input.issue_numbers,
    label: input.label,
  });
  const fileExists = deps.fileExists ?? defaultFileExistsSync;
  let invocation = input.candidateInvocation;
  if (!invocation) {
    const resolved = (deps.resolveCandidate ?? resolveCandidateEngine)(
      {
        repoDir: input.repoDir,
        candidateSha: input.request.integrated_candidate.git_sha,
        candidateEngineRootEnv: (deps.env ?? process.env).PIPELINE_CANDIDATE_ENGINE_ROOT,
      },
      defaultResolveCandidateEngineDeps(),
    );
    if (!resolved.ok) {
      throw new Error(`pack-loop dispatch: ${resolved.error}`);
    }
    invocation = freezeCandidateInvocation({
      executable: resolved.engine.launcherPath,
      loopRunId: loop_run_id,
      candidateSha: resolved.engine.commitSha,
    });
  }
  invocation = assertCandidateInvocation(
    invocation,
    input.request.integrated_candidate.git_sha,
    fileExists,
  );
  const persistBound =
    deps.persistBinding ??
    (input.persistCtx
      ? (id: string, state: FactoryReleaseLoopDispatchState = "bound") =>
          persistFactoryReleaseLoopBinding(input.persistCtx!, id, state, {
            candidate_invocation: {
              executable: invocation!.executable,
              argv: [...invocation!.argv],
              candidateSha: invocation!.candidateSha,
            },
          })
      : null);
  if (persistBound) await persistBound(loop_run_id, "bound");
  const spawn =
    deps.spawnCandidateLoop ??
    ((spawnArgs) =>
      defaultSpawnCandidateLoop(
        {
          repoDir: spawnArgs.repoDir,
          loop_run_id: spawnArgs.loop_run_id,
          candidateInvocation: spawnArgs.candidateInvocation ?? invocation,
          requestCandidateSha: input.request.integrated_candidate.git_sha,
        },
        {
          ...deps.spawnDeps,
          env: deps.env ?? deps.spawnDeps?.env,
          fileExists: deps.fileExists ?? deps.spawnDeps?.fileExists,
          writeFile: input.persistCtx?.writeFile ?? deps.spawnDeps?.writeFile,
          now: input.persistCtx?.now ?? deps.spawnDeps?.now,
          onAccepted: async (info) => {
            await persistPackLoopOsAccepted(input.persistCtx, spawnArgs.loop_run_id, info, invocation);
            if (deps.spawnDeps?.onAccepted) await deps.spawnDeps.onAccepted(info);
          },
        },
      ));
  let spawnResult: void | PackLoopSpawnResult;
  try {
    spawnResult = await spawn({
      repoDir: input.repoDir,
      loop_run_id,
      issue_numbers: input.issue_numbers,
      engineTrack: "candidate",
      label: input.label,
      candidateInvocation: invocation,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "spawn_throw";
    const last_error = formatPackLoopLastError({
      errorCode: String(code),
      excerpt: (err as Error).message,
    });
    if (input.persistCtx) {
      await persistFactoryReleaseLoopBinding(input.persistCtx, loop_run_id, "bound", {
        last_error,
        spawn_attempt: { error_code: String(code), at: isoNow(input.persistCtx.now()) },
        candidate_invocation: {
          executable: invocation.executable,
          argv: [...invocation.argv],
          candidateSha: invocation.candidateSha,
        },
      });
    }
    throw err;
  }
  const result = requirePackLoopSpawnResult(spawnResult, loop_run_id, "spawn");
  await persistSpawnResult(input.persistCtx, loop_run_id, result, invocation);
  if (result.dispatch_state === "failed") {
    throw new Error(result.last_error ?? "pack-loop dispatch failed before handoff");
  }
  if (result.dispatch_state === "bound") {
    throw new Error(result.last_error ?? "pack-loop spawn did not start");
  }
  return { loop_run_id };
}

export function buildFactoryReleaseUnsignedDigestBinding(
  request: FactoryReleasePrepareRequest,
  unsigned: FactoryReleaseFrgPayload,
): FactoryReleaseUnsignedDigestBinding {
  return {
    schema_version: 1,
    kind: "factory_release_unsigned_digest_binding",
    request_fingerprint: factoryReleaseRequestFingerprint(request),
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    pack_id: unsigned.pack_id,
    pack_run_id: unsigned.pack_run_id,
    loop_run_id: unsigned.loop_run_id,
    frg_run_id: unsigned.frg_run_id,
    artifacts: {
      observations_sha256: unsigned.observations.sha256,
      evidence_bundle_sha256: unsigned.evidence_bundle.sha256,
      contract_sha256: unsigned.contract.sha256,
      ledger_sha256: unsigned.ledger.sha256,
      events_sha256: unsigned.events.sha256,
      action_evidence_sha256: unsigned.action_evidence.sha256,
    },
  };
}

/**
 * Compare production attestation binding against closed unsigned digests.
 * Returns null when matched; otherwise a defect class detail.
 */
export function unsignedDigestBindingMismatch(
  expected: FactoryReleaseUnsignedDigestBinding,
  observed: unknown,
): string | null {
  if (observed === null || typeof observed !== "object" || Array.isArray(observed)) {
    return "factory_release_binding missing or not an object";
  }
  const o = observed as Record<string, unknown>;
  if (o.kind !== "factory_release_unsigned_digest_binding") {
    return "factory_release_binding.kind mismatch";
  }
  if (o.request_fingerprint !== expected.request_fingerprint) {
    return "factory_release_binding.request_fingerprint mismatch";
  }
  if (o.target_version !== expected.target_version) {
    return "factory_release_binding.target_version mismatch";
  }
  if (o.candidate_git_sha !== expected.candidate_git_sha) {
    return "factory_release_binding.candidate_git_sha mismatch";
  }
  if (o.pack_id !== expected.pack_id) return "factory_release_binding.pack_id mismatch";
  if (o.pack_run_id !== expected.pack_run_id) {
    return "factory_release_binding.pack_run_id mismatch";
  }
  if (o.loop_run_id !== expected.loop_run_id) {
    return "factory_release_binding.loop_run_id mismatch";
  }
  if (o.frg_run_id !== expected.frg_run_id) {
    return "factory_release_binding.frg_run_id mismatch";
  }
  const arts = o.artifacts;
  if (arts === null || typeof arts !== "object" || Array.isArray(arts)) {
    return "factory_release_binding.artifacts missing";
  }
  const a = arts as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected.artifacts)) {
    if (a[key] !== value) return `factory_release_binding.artifacts.${key} mismatch`;
  }
  return null;
}

function refuseLayerASource(source: unknown, field: string): void {
  if (source === "layer_a") {
    throw new Error(
      `factory-release prepare: ${field} uses forbidden source layer_a after v${FRG_HYBRID_PILOT_VERSION}; ` +
        `durable full-current FRG policy requires live|ledger|derived|observation only`,
    );
  }
  if (source !== undefined && typeof source === "string" && !POST_PILOT_ALLOWED_SOURCES.has(source)) {
    throw new Error(
      `factory-release prepare: ${field} has unsupported source ${source} (allowed: live|ledger|derived|observation)`,
    );
  }
}

function packInstanceMatchesRequest(
  instance: FactoryReleasePackInstance,
  request: FactoryReleasePrepareRequest,
  fingerprint: string,
  packRunId: string,
): boolean {
  return (
    instance.request_fingerprint === fingerprint &&
    instance.target_version === request.target_version &&
    instance.candidate_git_sha === request.integrated_candidate.git_sha &&
    instance.pack_id === request.frg_manifest.pack_id &&
    instance.manifest_sha256 === request.frg_manifest.sha256 &&
    instance.pack_run_id === packRunId
  );
}

async function loadBoundLoopArtifacts(
  loopRunId: string,
  request: FactoryReleasePrepareRequest,
  fingerprint: string,
  readFile: (p: string) => Promise<string>,
  fileExists: (p: string) => Promise<boolean>,
): Promise<DurablePackLoopArtifacts | null> {
  const storeDeps = defaultLoopStoreDeps();
  try {
    void runDir(storeDeps, loopRunId);
    const bindingPath = path.join(runDir(storeDeps, loopRunId), "factory-release-binding.json");
    if (!(await fileExists(bindingPath))) {
      // Also accept binding written into the factory-release work tree only when
      // the pack-instance already names this exact loop (checked by caller).
      // Without a loop-side binding, refuse unless pack-instance already bound it.
    } else {
      const bindingText = await readFile(bindingPath);
      let binding: Record<string, unknown>;
      try {
        binding = JSON.parse(bindingText) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (!loopBindingMatchesRequest(binding, request, fingerprint)) {
        return null;
      }
    }

    const contract = await readContract(storeDeps, loopRunId);
    if (!isAllowedFrgPackSelector(contract.selector)) return null;
    const packCheck = validateFrgPackContract(contract);
    if (!packCheck.ok) return null;
    const ledger = await readLedger(storeDeps, loopRunId);
    let eventsText = "";
    try {
      const events = await readEvents(storeDeps, loopRunId);
      eventsText = events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
    } catch {
      eventsText = "";
    }
    let actionEvidenceText = "{}\n";
    try {
      const actions = await readActionEvidence(storeDeps, loopRunId);
      actionEvidenceText = `${JSON.stringify(actions, null, 2)}\n`;
    } catch {
      actionEvidenceText = "{}\n";
    }

    // Optional runner observations colocated with the loop run.
    let runnerObs: string | undefined;
    const runnerObsPath = path.join(runDir(storeDeps, loopRunId), "runner-observations.json");
    if (await fileExists(runnerObsPath)) {
      runnerObs = await readFile(runnerObsPath);
    }

    return {
      loop_run_id: loopRunId,
      contract_text: `${JSON.stringify(contract, null, 2)}\n`,
      ledger_text: `${JSON.stringify(ledger, null, 2)}\n`,
      events_text: eventsText,
      action_evidence_text: actionEvidenceText,
      runner_observations_text: runnerObs,
    };
  } catch {
    return null;
  }
}

/**
 * Instantiate or reconcile a pack instance keyed by request fingerprint.
 * Never discovers an unbound newest factory-gate loop as evidence.
 */
export async function defaultReconcileBoundPackLoop(
  ctx: DurableReconcilePackLoopCtx,
): Promise<DurablePackLoopArtifacts | null> {
  const instancePath = factoryReleasePackInstancePath(ctx.workDir);
  let instance: FactoryReleasePackInstance | null = null;
  if (await ctx.fileExists(instancePath)) {
    try {
      const raw = JSON.parse(await ctx.readFile(instancePath)) as FactoryReleasePackInstance;
      if (
        raw.kind === "factory_release_pack_instance" &&
        packInstanceMatchesRequest(raw, ctx.request, ctx.requestFingerprint, ctx.packRunId)
      ) {
        instance = raw;
      } else {
        throw new Error(
          "factory-release prepare: pack-instance.json does not match the active request binding",
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("does not match")) throw err;
      instance = null;
    }
  }

  if (!instance) {
    // Instantiate a fresh pack instance bound to this exact request.
    instance = {
      schema_version: 1,
      kind: "factory_release_pack_instance",
      request_fingerprint: ctx.requestFingerprint,
      target_version: ctx.request.target_version,
      candidate_git_sha: ctx.request.integrated_candidate.git_sha,
      pack_id: ctx.request.frg_manifest.pack_id,
      manifest_sha256: ctx.request.frg_manifest.sha256,
      pack_run_id: ctx.packRunId,
      frg_run_id: ctx.frgRunId,
      loop_run_id: null,
      created_at: isoNow(ctx.now()),
      updated_at: isoNow(ctx.now()),
    };
    await ctx.writeFile(instancePath, canonicalJson(instance), 0o600);
  }

  if (instance.loop_run_id) {
    const loaded = await loadBoundLoopArtifacts(
      instance.loop_run_id,
      ctx.request,
      ctx.requestFingerprint,
      ctx.readFile,
      ctx.fileExists,
    );
    if (loaded) return loaded;
    // Binding matches but artifacts are not loadable yet (loop still starting).
    // Keep the bound id — do not adopt an unbound newest factory-gate loop.
    const bindingPath = factoryReleaseLoopBindingPath(instance.loop_run_id);
    if (await ctx.fileExists(bindingPath)) {
      try {
        const binding = JSON.parse(await ctx.readFile(bindingPath)) as Record<string, unknown>;
        if (loopBindingMatchesRequest(binding, ctx.request, ctx.requestFingerprint)) {
          return nonTerminalBoundStub(instance.loop_run_id);
        }
      } catch {
        // Fall through to stale-clear only when the binding is unusable.
      }
    }
    // Stale loop id with no matching binding — clear and fall through.
    instance = {
      ...instance,
      loop_run_id: null,
      updated_at: isoNow(ctx.now()),
    };
    await ctx.writeFile(instancePath, canonicalJson(instance), 0o600);
  }

  // Scan only runs that carry an explicit factory-release-binding for this fingerprint.
  const storeDeps = defaultLoopStoreDeps();
  const home = resolveStateHome(storeDeps);
  const runsRoot = path.join(home, "runs");
  let entries: string[] = [];
  try {
    entries = await storeDeps.listDir(runsRoot);
  } catch {
    entries = [];
  }
  const runIds = entries
    .filter((name) => name.startsWith("loop-") && !name.startsWith("archived-"))
    .sort()
    .reverse();
  for (const runId of runIds) {
    const bindingPath = path.join(runDir(storeDeps, runId), "factory-release-binding.json");
    if (!(await ctx.fileExists(bindingPath))) continue; // unbound — refuse
    const loaded = await loadBoundLoopArtifacts(
      runId,
      ctx.request,
      ctx.requestFingerprint,
      ctx.readFile,
      ctx.fileExists,
    );
    if (loaded) {
      instance = {
        ...instance,
        loop_run_id: runId,
        updated_at: isoNow(ctx.now()),
      };
      await ctx.writeFile(instancePath, canonicalJson(instance), 0o600);
      return loaded;
    }
    // Binding persisted before spawn/artifacts — adopt the same run, do not start another.
    try {
      const binding = JSON.parse(await ctx.readFile(bindingPath)) as Record<string, unknown>;
      if (
        loopBindingMatchesRequest(binding, ctx.request, ctx.requestFingerprint) &&
        isPendingLoopDispatch(binding)
      ) {
        instance = {
          ...instance,
          loop_run_id: runId,
          updated_at: isoNow(ctx.now()),
        };
        await ctx.writeFile(instancePath, canonicalJson(instance), 0o600);
        return nonTerminalBoundStub(runId);
      }
    } catch {
      // Unreadable binding — keep scanning.
    }
  }

  return null;
}

/**
 * Durable post-pilot unsigned FRG generator.
 *
 * Instantiates a request-bound pack instance, starts or resumes a bound
 * factory-gate candidate pack loop when none exists, scores a terminal loop
 * with factory-gate --from-run (no --observations), and writes closed
 * artifact digests under workDir. Synthetic trivial docs packs are never
 * accepted as release-eligible.
 */
export async function generateDurableUnsignedFrg(
  request: FactoryReleasePrepareRequest,
  ctx: { repoDir: string; workDir: string; pack: LoadedFrgPack; manifestPath: string },
  opts: DurableGenerateOptions = {},
): Promise<UnsignedFrgGenerationResult> {
  const now = opts.now ?? (() => new Date());
  const writeFile =
    opts.writeFile ??
    (async (p, body, mode) => {
      await fs.writeFile(p, body, { encoding: "utf8", mode: mode ?? 0o600 });
    });
  const mkdir =
    opts.mkdir ??
    (async (p, o) => {
      await fs.mkdir(p, { recursive: o?.recursive ?? true, mode: o?.mode ?? 0o700 });
    });
  const readFile =
    opts.readFile ?? ((p: string) => fs.readFile(p, "utf8"));
  const fileExists = opts.fileExists ?? defaultFileExists;
  const reconcilePackLoop = opts.reconcilePackLoop ?? defaultReconcileBoundPackLoop;
  const startBoundPackLoop =
    opts.startBoundPackLoop ??
    ((startCtx: DurableReconcilePackLoopCtx) =>
      defaultStartBoundPackLoop(startCtx, {
        createOrReusePackIssues: opts.createOrReusePackIssues,
        dispatchPackLoop: opts.dispatchPackLoop,
        candidateInvocation: opts.candidateInvocation,
      }));
  const injectedResumeBoundPackLoop = opts.resumeBoundPackLoop;
  const scoreBoundPackLoop = opts.scoreBoundPackLoop ?? defaultScoreBoundPackLoop;

  const requestFingerprint = factoryReleaseRequestFingerprint(request);
  const packRunId = `pack-${request.target_version.replace(/\./g, "")}-${request.action_id}`.slice(
    0,
    200,
  );
  const frgRunId = `frg-${sha256(`${request.action_id}:${request.integrated_candidate.git_sha}:${request.target_version}`).slice(0, 24)}`;
  const artDir = path.join(ctx.workDir, "unsigned");
  await mkdir(artDir, { recursive: true, mode: 0o700 });
  await mkdir(ctx.workDir, { recursive: true, mode: 0o700 });

  const existingLatestPath = path.join(
    ctx.repoDir,
    ".agent-pipeline",
    "frg",
    request.target_version,
    "latest.json",
  );
  if (await fileExists(existingLatestPath)) {
    try {
      const latestText = await readFile(existingLatestPath);
      const latestRaw = JSON.parse(latestText) as {
        version?: string;
        pass?: boolean;
        pack_id?: string | null;
        loop_run_id?: string | null;
        run_id?: string;
        created_at?: string;
        integrity?: { attestation?: unknown } | null;
        pack_provenance?: { candidate_git_sha?: string; pack_run_id?: string } | null;
      };
      if (honestLatestJsonBindsRequest(request, latestRaw) && latestRaw.run_id && latestRaw.loop_run_id) {
        const digest = sha256(latestText);
        const ref = { path: existingLatestPath, sha256: digest };
        return {
          frg: {
            pack_id: latestRaw.pack_id ?? request.frg_manifest.pack_id,
            manifest_path: ctx.manifestPath,
            manifest_sha256: request.frg_manifest.sha256,
            pack_run_id: latestRaw.pack_provenance?.pack_run_id ?? packRunId,
            loop_run_id: latestRaw.loop_run_id,
            frg_run_id: latestRaw.run_id,
            evidence_created_at: latestRaw.created_at ?? isoNow(now()),
            observations: ref,
            evidence_bundle: ref,
            contract: ref,
            ledger: ref,
            events: ref,
            action_evidence: ref,
          },
          structurally_eligible: true,
        };
      }
    } catch {
      // Unreadable or unbound latest.json — fall through to pack start/score.
    }
  }

  // Fresh pack binding record (version + candidate + action) — refuse reuse of
  // earlier-version evidence by never reading foreign frg/<old-version> trees here.
  const binding = {
    schema_version: 1,
    kind: "factory_release_pack_binding",
    request_fingerprint: requestFingerprint,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    action_id: request.action_id,
    pack_id: request.frg_manifest.pack_id,
    manifest_sha256: request.frg_manifest.sha256,
    pack_run_id: packRunId,
    frg_run_id: frgRunId,
    created_at: isoNow(now()),
  };
  await writeFile(path.join(artDir, "pack-binding.json"), canonicalJson(binding), 0o600);

  const reconcileCtx: DurableReconcilePackLoopCtx = {
    repoDir: ctx.repoDir,
    workDir: ctx.workDir,
    request,
    pack: ctx.pack,
    packRunId,
    frgRunId,
    requestFingerprint,
    writeFile,
    readFile,
    fileExists,
    now,
  };

  const resumeBoundPackLoop =
    injectedResumeBoundPackLoop ??
    ((args: {
      repoDir: string;
      loop_run_id: string;
      candidateInvocation?: CandidateInvocation;
    }) =>
      defaultResumeBoundPackLoop(
        {
          repoDir: args.repoDir,
          loop_run_id: args.loop_run_id,
          candidateInvocation: args.candidateInvocation,
          requestCandidateSha: request.integrated_candidate.git_sha,
        },
        {
          ...opts.spawnDeps,
          now: opts.spawnDeps?.now ?? now,
          writeFile: opts.spawnDeps?.writeFile ?? writeFile,
          onAccepted: async (info) => {
            await persistPackLoopOsAccepted(
              reconcileCtx,
              args.loop_run_id,
              info,
              args.candidateInvocation,
            );
            if (opts.spawnDeps?.onAccepted) await opts.spawnDeps.onAccepted(info);
          },
        },
      ));

  let loop = await reconcilePackLoop(reconcileCtx);
  if (!loop) {
    let started: { loop_run_id: string } | null = null;
    try {
      started = await startBoundPackLoop(reconcileCtx);
    } catch (err) {
      return refuseSyntheticTrivialPack(request, {
        defect_class: "pack_loop_start_failed",
        message:
          `factory-release prepare: failed to start a request-bound factory-gate pack loop ` +
          `for ${request.target_version}: ${(err as Error).message}`,
      });
    }
    if (started?.loop_run_id) {
      const bindingPath = factoryReleaseLoopBindingPath(started.loop_run_id);
      let existingState: FactoryReleaseLoopDispatchState | null = null;
      if (await fileExists(bindingPath)) {
        try {
          const raw = JSON.parse(await readFile(bindingPath)) as Record<string, unknown>;
          existingState = parseDispatchState(raw.dispatch_state);
        } catch {
          existingState = null;
        }
      }
      // Injected start seams persist no binding; record the run as dispatched
      // for that tick. Production dispatch already persisted starting/dispatched.
      const persistState = existingState ?? "dispatched";
      if (persistState !== "failed") {
        await persistFactoryReleaseLoopBinding(reconcileCtx, started.loop_run_id, persistState);
      }
      loop = await reconcilePackLoop(reconcileCtx);
      if (!loop) {
        loop = nonTerminalBoundStub(started.loop_run_id);
      }
    }
  } else {
    const bindingPath = factoryReleaseLoopBindingPath(loop.loop_run_id);
    let binding: Record<string, unknown> | null = null;
    if (await fileExists(bindingPath)) {
      try {
        binding = JSON.parse(await readFile(bindingPath)) as Record<string, unknown>;
      } catch {
        binding = null;
      }
    }
    const dispatchState = parseDispatchState(binding?.dispatch_state);
    if (dispatchState === "failed") {
      const msg =
        typeof binding?.last_error === "string" && binding.last_error
          ? binding.last_error
          : `factory-release prepare: bound pack loop ${loop.loop_run_id} failed before handoff`;
      return {
        ...refuseSyntheticTrivialPack(request, {
          defect_class: "pack_loop_start_failed",
          message: msg,
        }),
        loop_run_id: loop.loop_run_id,
        liveness: await probePrepareLiveness(loop.loop_run_id, opts, request, binding),
      };
    }
    if (dispatchState === "starting") {
      const adopted = await reconcileStartingDurableHandoff({
        ctx: reconcileCtx,
        loopRunId: loop.loop_run_id,
        request,
        binding,
        opts,
      });
      if (adopted.kind === "failed") {
        await persistFactoryReleaseLoopBinding(reconcileCtx, loop.loop_run_id, "failed", {
          last_error: adopted.error,
        });
        return {
          ...(await refuseSyntheticTrivialPack(request, {
            defect_class: "pack_loop_start_failed",
            message: adopted.error,
          })),
          loop_run_id: loop.loop_run_id,
        };
      }
      if (adopted.kind === "absent") {
        const deadline = typeof binding?.observation_deadline === "string" ? binding.observation_deadline : "";
        const expired = !deadline || now().getTime() >= Date.parse(deadline);
        if (expired) {
          const msg = `factory-release prepare: pack-loop observation window expired for ${loop.loop_run_id}`;
          await persistFactoryReleaseLoopBinding(reconcileCtx, loop.loop_run_id, "failed", {
            last_error: msg,
          });
          return {
            ...(await refuseSyntheticTrivialPack(request, {
              defect_class: "pack_loop_start_failed",
              message: msg,
            })),
            loop_run_id: loop.loop_run_id,
          };
        }
        // In-window starting with no handoff: observe, do not spawn a second child.
      }
      // Valid durable handoff: persist dispatched above and do not spawn.
    } else if (
      dispatchState === "dispatched" &&
      typeof binding?.resume_count === "number" &&
      binding.resume_count >= 1
    ) {
      const live = await probePrepareLiveness(loop.loop_run_id, opts, request, binding);
      if (live.status !== "live" && live.status !== "unknown") {
        const msg =
          `factory-release prepare: pack loop ${loop.loop_run_id} lost liveness after one resume`;
        await persistFactoryReleaseLoopBinding(reconcileCtx, loop.loop_run_id, "failed", {
          last_error: msg,
        });
        return {
          ...refuseSyntheticTrivialPack(request, {
            defect_class: "pack_loop_start_failed",
            message: msg,
          }),
          loop_run_id: loop.loop_run_id,
          liveness: live,
        };
      }
    } else if (dispatchState === "dispatched") {
      const live = await probePrepareLiveness(loop.loop_run_id, opts, request, binding);
      if (live.status === "not-live" && live.reason !== "unreadable_identity") {
        const resumeCount = typeof binding?.resume_count === "number" ? binding.resume_count : 0;
        if (resumeCount >= 1) {
          const msg =
            `factory-release prepare: pack loop ${loop.loop_run_id} lost liveness after one resume`;
          await persistFactoryReleaseLoopBinding(reconcileCtx, loop.loop_run_id, "failed", {
            last_error: msg,
          });
          return {
            ...refuseSyntheticTrivialPack(request, {
              defect_class: "pack_loop_start_failed",
              message: msg,
            }),
            loop_run_id: loop.loop_run_id,
            liveness: live,
          };
        }
        if (live.reason === "dead_pid") {
          try {
            const invocation = restoreInvocation(binding, loop.loop_run_id, request);
            await persistFactoryReleaseLoopBinding(reconcileCtx, loop.loop_run_id, "bound", {
              resume_count: 1,
              failed_process_identity: failedIdentityFromBinding(binding),
            });
            const resumed = requirePackLoopSpawnResult(
              await resumeBoundPackLoop({
                repoDir: ctx.repoDir,
                loop_run_id: loop.loop_run_id,
                candidateInvocation: invocation,
              }),
              loop.loop_run_id,
              "resume",
            );
            await persistSpawnResult(reconcileCtx, loop.loop_run_id, resumed, invocation);
            if (resumed.dispatch_state === "failed" || resumed.dispatch_state === "bound") {
              throw new Error(resumed.last_error ?? "pack-loop resume failed");
            }
          } catch (err) {
            return {
              ...(await refuseSyntheticTrivialPack(request, {
                defect_class: "pack_loop_start_failed",
                message:
                  `factory-release prepare: failed to resume request-bound factory-gate pack loop ` +
                  `${loop.loop_run_id} for ${request.target_version}: ${(err as Error).message}`,
              })),
              loop_run_id: loop.loop_run_id,
            };
          }
        }
      }
    } else if (
      await boundLoopNeedsDispatchRetry(
        loop.loop_run_id,
        request,
        requestFingerprint,
        readFile,
        fileExists,
      )
    ) {
      try {
        const invocation = restoreInvocation(binding, loop.loop_run_id, request) ?? opts.candidateInvocation;
        const resumed = requirePackLoopSpawnResult(
          await resumeBoundPackLoop({
            repoDir: ctx.repoDir,
            loop_run_id: loop.loop_run_id,
            candidateInvocation: invocation,
          }),
          loop.loop_run_id,
          "resume",
        );
        await persistSpawnResult(reconcileCtx, loop.loop_run_id, resumed, invocation);
        if (resumed.dispatch_state === "failed") {
          throw new Error(resumed.last_error ?? "pack-loop resume failed before handoff");
        }
        if (resumed.dispatch_state === "bound") {
          throw new Error(resumed.last_error ?? "pack-loop resume did not start");
        }
      } catch (err) {
        return refuseSyntheticTrivialPack(request, {
          defect_class: "pack_loop_start_failed",
          message:
            `factory-release prepare: failed to resume request-bound factory-gate pack loop ` +
            `${loop.loop_run_id} for ${request.target_version}: ${(err as Error).message}`,
        });
      }
    }
  }

  if (!loop) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "pack_loop_start_failed",
      message:
        `factory-release prepare: could not start a request-bound factory-gate pack loop for ` +
        `${request.target_version} (fingerprint=${requestFingerprint.slice(0, 12)}…, ` +
        `candidate=${request.integrated_candidate.git_sha}). Unbound prior factory-gate loops ` +
        `are not adopted. Synthetic trivial docs packs are not release-eligible after ` +
        `v${FRG_HYBRID_PILOT_VERSION}.`,
    });
  }

  if (!isBoundPackLoopTerminal(loop)) {
    const bindingPath = factoryReleaseLoopBindingPath(loop.loop_run_id);
    let binding: Record<string, unknown> | null = null;
    if (await fileExists(bindingPath)) {
      try {
        binding = JSON.parse(await readFile(bindingPath)) as Record<string, unknown>;
      } catch {
        binding = null;
      }
    }
    const liveness = await probePrepareLiveness(loop.loop_run_id, opts, request, binding);
    return {
      frg: {
        ...refusedFrgPayload(request),
        loop_run_id: loop.loop_run_id,
        pack_run_id: packRunId,
        frg_run_id: frgRunId,
      },
      structurally_eligible: false,
      in_progress: true,
      loop_run_id: loop.loop_run_id,
      defect_class: "frg_running",
      message:
        `factory-release prepare: bound pack loop ${loop.loop_run_id} is in progress for ` +
        `${request.target_version}; re-invoke the same request to resume.`,
      liveness,
    };
  }

  let contract: LoopContract;
  try {
    contract = JSON.parse(loop.contract_text) as LoopContract;
  } catch (err) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "contract_unparsable",
      message: `factory-release prepare: pack loop contract unparsable: ${(err as Error).message}`,
    });
  }
  const packCheck = validateFrgPackContract(contract);
  if (!packCheck.ok) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "pack_contract_invalid",
      message: `factory-release prepare: bound loop is not FRG fixed pack: ${packCheck.detail}`,
    });
  }

  let ledger;
  try {
    ledger = JSON.parse(loop.ledger_text);
    itemsFromLoopLedger(ledger);
  } catch (err) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "ledger_unparsable",
      message: `factory-release prepare: pack loop ledger unparsable: ${(err as Error).message}`,
    });
  }

  // Terminal score: factory-gate --from-run <id> (in-process). Never pass
  // --observations, scenarioOverrides from the request, or a work-directory
  // observations file. Hybrid v2 inside the scorer applies.
  let scoreResult: ScoreBoundPackLoopResult;
  try {
    scoreResult = await scoreBoundPackLoop({
      version: request.target_version,
      fromRun: loop.loop_run_id,
      repoDir: ctx.repoDir,
      request,
      loop,
      pack: ctx.pack,
      now,
      env: opts.env,
      factoryControlDir: opts.factoryControlDir,
      resolveUniqueOperationRunsRoots: opts.resolveUniqueOperationRunsRoots,
      uniqueOperationRunsRoot: opts.uniqueOperationRunsRoot,
      loadCandidateFaultRecoveryInventory: opts.loadCandidateFaultRecoveryInventory,
    });
  } catch (err) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "frg_not_eligible",
      message:
        `factory-release prepare: factory-gate --from-run ${loop.loop_run_id} failed for ` +
        `${request.target_version}: ${(err as Error).message}`,
    });
  }

  const scored = scoreResult.evidence;
  const eligible = isReleaseEligibleFrgPass(scored, { requireAttestation: false });
  const scenariosOk = scored.scenarios.every(
    (s) => s.status === "pass" || s.status === "warn",
  );
  const scenarioOverrides: FrgScenarioOverride[] = scored.scenarios.map((s) => ({
    id: s.id,
    status: s.status,
    detail: s.detail,
    observed: s.observed ?? null,
    threshold: s.threshold ?? null,
    source: s.source,
  }));
  const compositionOverrides: FrgCompositionOverride[] = scored.composition.dimensions.map((d) => ({
    id: d.id,
    status: d.status,
    detail: d.detail,
    source: d.source,
    observed: d.observed ?? null,
  }));

  // Honest-pass latest.json: persist pass:true only when the skip-frg
  // restore checker accepts a from-run candidate pack (full attestation
  // optional; score_receipt is a runner HMAC). Provenance must already
  // be on `scored`; persist does not stamp it. A structural fail MAY be
  // written with pass:false. Never flip fail to pass.
  const latestPath = path.join(
    ctx.repoDir,
    ".agent-pipeline",
    "frg",
    request.target_version,
    "latest.json",
  );
  const latestEvidence = latestJsonForHonestPost133Persist(scored);
  await mkdir(path.dirname(latestPath), { recursive: true, mode: 0o700 });
  await writeFile(latestPath, canonicalJson(latestEvidence), 0o600);

  const eventsBody = loop.events_text || "\n";
  const actionBody = loop.action_evidence_text || "{}\n";
  const contractBody = loop.contract_text;
  const ledgerBody = loop.ledger_text;

  const paths = {
    observations: path.join(artDir, "observations.json"),
    evidence_bundle: path.join(artDir, "evidence-bundle.json"),
    contract: path.join(artDir, "contract.json"),
    ledger: path.join(artDir, "ledger.json"),
    events: path.join(artDir, "events.jsonl"),
    action_evidence: path.join(artDir, "action-evidence.json"),
  };

  await writeFile(paths.contract, contractBody, 0o600);
  await writeFile(paths.ledger, ledgerBody, 0o600);
  await writeFile(paths.events, eventsBody, 0o600);
  await writeFile(paths.action_evidence, actionBody, 0o600);

  // Observations first (no self-digest). Evidence-bundle lists identity + score
  // summary; the closed six-digest binding is carried on signed evidence via
  // factory_release_binding and on the awaiting FRG payload digests.
  const observationsBody = canonicalJson({
    schema_version: 1,
    kind: "factory_release_unsigned_observations",
    request_fingerprint: requestFingerprint,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    pack_run_id: packRunId,
    loop_run_id: loop.loop_run_id,
    frg_run_id: frgRunId,
    scenarios: scenarioOverrides,
    composition: compositionOverrides,
    // Explicitly no pack_provenance / hybrid Layer A policy for post-pilot.
  });
  await writeFile(paths.observations, observationsBody, 0o600);

  const evidenceBundleBody = canonicalJson({
    schema_version: 1,
    kind: "factory_release_unsigned_evidence_bundle",
    request_fingerprint: requestFingerprint,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    structural_pass: eligible,
    scored_without_attestation: {
      run_id: scored.run_id,
      loop_run_id: scored.loop_run_id,
      pack_id: scored.pack_id,
      pass: scored.pass,
      composition_missing: scored.composition.missing,
    },
  });
  await writeFile(paths.evidence_bundle, evidenceBundleBody, 0o600);

  const frg: FactoryReleaseFrgPayload = {
    pack_id: request.frg_manifest.pack_id,
    manifest_path: path.resolve(ctx.manifestPath),
    manifest_sha256: request.frg_manifest.sha256,
    pack_run_id: packRunId,
    loop_run_id: loop.loop_run_id,
    frg_run_id: frgRunId,
    evidence_created_at: isoNow(now()),
    observations: { path: paths.observations, sha256: sha256(observationsBody) },
    evidence_bundle: { path: paths.evidence_bundle, sha256: sha256(evidenceBundleBody) },
    contract: { path: paths.contract, sha256: sha256(contractBody) },
    ledger: { path: paths.ledger, sha256: sha256(ledgerBody) },
    events: { path: paths.events, sha256: sha256(eventsBody) },
    action_evidence: { path: paths.action_evidence, sha256: sha256(actionBody) },
  };

  if (!eligible) {
    const slo = uniqueOperationSloFailure(scored.operation_reliability ?? null);
    const binding = uniqueOperationReleaseBindingFailure(scored.operation_reliability ?? null, {
      candidate_sha:
        scored.pack_provenance?.candidate_git_sha ?? request.integrated_candidate.git_sha,
      release_identity: request.target_version,
    });
    return {
      frg,
      structurally_eligible: false,
      defect_class: "frg_not_eligible",
      message:
        `factory-release prepare: FRG structural eligibility failed for ${request.target_version}` +
        (scored.composition.missing.length
          ? ` (composition missing: ${scored.composition.missing.join(", ")})`
          : "") +
        (scenariosOk
          ? ""
          : ` (scenarios not all pass/warn: ${scored.scenarios
              .filter((s) => s.status !== "pass" && s.status !== "warn")
              .map((s) => `${s.id}=${s.status}`)
              .join(", ")})`) +
        (slo ? ` (${slo})` : "") +
        (binding && binding !== slo ? ` (${binding})` : "") +
        `. Hard gate: release preparation blocked.`,
    };
  }

  return { frg, structurally_eligible: true };
}

type LoadedAttestedEvidence =
  | { status: "accepted"; evidence: FrgEvidence; text: string; path: string }
  | { status: "absent"; reason: AttestationObserveReason }
  | {
      status: "rejected";
      reason: AttestationObserveReason;
      observed_run_id: string | null;
      detail?: string;
    };

/**
 * Try to load and validate release-eligible attested evidence from a path.
 * Accepts attested run_id B when HMAC-covered factory_release_binding names A.
 * pack_provenance presence is not a miss. Notes are not a binding carrier.
 */
async function tryLoadAttestedEvidence(
  evidencePath: string,
  request: FactoryReleasePrepareRequest,
  unsigned: FactoryReleaseFrgPayload,
  readFile: (p: string) => Promise<string>,
  fileExists: (p: string) => Promise<boolean>,
  validateOpts: FrgValidateOpts = {},
): Promise<LoadedAttestedEvidence> {
  if (!(await fileExists(evidencePath))) return { status: "absent", reason: "missing_file" };
  let text: string;
  try {
    text = await readFile(evidencePath);
  } catch {
    return { status: "absent", reason: "unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "absent", reason: "unparsable" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "absent", reason: "unparsable" };
  }
  const rawObj = raw as Record<string, unknown>;

  let evidence: FrgEvidence;
  try {
    evidence = parseFrgEvidenceJson(text);
  } catch {
    return { status: "absent", reason: "unparsable" };
  }
  const observedRunId = typeof evidence.run_id === "string" ? evidence.run_id : null;
  const reject = (
    reason: AttestationObserveReason,
    detail?: string,
  ): LoadedAttestedEvidence => ({
    status: "rejected",
    reason,
    observed_run_id: observedRunId,
    detail,
  });

  if (!evidence.integrity?.attestation) {
    return reject("hmac_invalid", "integrity.attestation missing");
  }
  if (evidence.version !== request.target_version) {
    return reject("identity_mismatch", "version mismatch");
  }
  if (evidence.loop_run_id !== unsigned.loop_run_id) {
    return reject("identity_mismatch", "loop_run_id mismatch");
  }
  if (evidence.pack_id !== unsigned.pack_id) {
    return reject("identity_mismatch", "pack_id mismatch");
  }

  const expected = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
  const topLevel = topLevelFactoryReleaseBinding(rawObj, evidence);
  if (topLevel === undefined) {
    if (notesCarryFactoryReleaseBinding(evidence.notes)) {
      return reject("notes_only_binding");
    }
    return reject("missing_factory_release_binding");
  }
  const mismatch = unsignedDigestBindingMismatch(expected, topLevel);
  if (mismatch) {
    return reject("binding_mismatch", mismatch);
  }

  if (!evidence.pass || !isReleaseEligibleFrgPass(evidence, { requireAttestation: true })) {
    return reject("not_release_eligible");
  }

  if (!honestLatestJsonBindsRequest(request, { ...evidence, factory_release_binding: topLevel })) {
    return reject("identity_mismatch", "candidate or honest-bind mismatch");
  }

  try {
    validateReleaseEligibleFrgEvidence(text, request.target_version, validateOpts);
  } catch (err) {
    const msg = (err as Error).message;
    if (
      /MAC|does not match|KEY is required|hand-authored|integrity\.attestation/i.test(msg)
    ) {
      return reject("hmac_invalid", msg);
    }
    return reject("not_release_eligible", msg);
  }

  return { status: "accepted", evidence, text, path: evidencePath };
}

function acceptedAttestation(
  loaded: Extract<LoadedAttestedEvidence, { status: "accepted" }>,
  latestPath: string,
  evidencePath: string,
  observedPath: string,
): ObservedAttestation {
  const digest = sha256(loaded.text);
  return {
    frg_run_id: loaded.evidence.run_id,
    evidence_path: observedPath === latestPath ? evidencePath : loaded.path,
    evidence_sha256: digest,
    latest_path: latestPath,
    latest_sha256: digest,
    evidence: loaded.evidence,
  };
}

/**
 * Observe release-eligible attested evidence under the version FRG tree.
 * Returns typed accepted / absent / rejected. Attested run_id MAY be B ≠ A
 * when HMAC factory_release_binding names unsigned A.
 */
export async function defaultObserveAttestation(
  request: FactoryReleasePrepareRequest,
  unsigned: FactoryReleaseFrgPayload,
  ctx: { repoDir: string; workDir: string },
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8"),
  fileExists: (p: string) => Promise<boolean> = defaultFileExists,
  validateOpts: FrgValidateOpts = {},
): Promise<AttestationObserveResult> {
  const version = request.target_version;
  const latestPath = path.join(ctx.repoDir, ".agent-pipeline", "frg", version, "latest.json");
  const evidencePath = path.join(
    ctx.repoDir,
    ".agent-pipeline",
    "frg",
    version,
    unsigned.frg_run_id,
    "evidence.json",
  );

  const tryPaths = [latestPath, evidencePath];
  let firstRejected: Extract<LoadedAttestedEvidence, { status: "rejected" }> | null = null;
  let sawPresent = false;
  for (const p of tryPaths) {
    const loaded = await tryLoadAttestedEvidence(
      p,
      request,
      unsigned,
      readFile,
      fileExists,
      validateOpts,
    );
    if (loaded.status === "accepted") {
      return {
        status: "accepted",
        attestation: acceptedAttestation(loaded, latestPath, evidencePath, p),
      };
    }
    if (loaded.status === "rejected") {
      sawPresent = true;
      if (!firstRejected) firstRejected = loaded;
      continue;
    }
    if (loaded.reason !== "missing_file") sawPresent = true;
  }

  // Optional handoff: single hint to re-observe referenced evidence paths once.
  const handoffPath = path.join(ctx.workDir, "attestation-handoff.json");
  if (await fileExists(handoffPath)) {
    let handoff: Record<string, unknown>;
    try {
      handoff = JSON.parse(await readFile(handoffPath)) as Record<string, unknown>;
    } catch {
      return { status: "absent", reason: "unparsable" };
    }
    if (
      handoff.kind === "frg_attestation_handoff" &&
      handoff.status === "complete" &&
      handoff.frg_run_id === unsigned.frg_run_id
    ) {
      const hintPaths: string[] = [];
      if (typeof handoff.frg_evidence_path === "string") {
        hintPaths.push(handoff.frg_evidence_path);
      }
      if (typeof handoff.frg_latest_path === "string") {
        hintPaths.push(handoff.frg_latest_path);
      }
      for (const p of hintPaths) {
        if (p === evidencePath || p === latestPath) continue;
        const loaded = await tryLoadAttestedEvidence(
          p,
          request,
          unsigned,
          readFile,
          fileExists,
          validateOpts,
        );
        if (loaded.status === "accepted") {
          const digest = sha256(loaded.text);
          return {
            status: "accepted",
            attestation: {
              frg_run_id: loaded.evidence.run_id,
              evidence_path: loaded.path,
              evidence_sha256: digest,
              latest_path:
                typeof handoff.frg_latest_path === "string" ? handoff.frg_latest_path : latestPath,
              latest_sha256: digest,
              evidence: loaded.evidence,
            },
          };
        }
        if (loaded.status === "rejected" && !firstRejected) firstRejected = loaded;
      }
    }
  }

  if (firstRejected) {
    return {
      status: "rejected",
      reason: firstRejected.reason,
      expected_frg_run_id: unsigned.frg_run_id,
      observed_run_id: firstRejected.observed_run_id,
      detail: firstRejected.detail,
    };
  }
  return {
    status: "absent",
    reason: sawPresent ? "unreadable" : "missing_file",
  };
}

export async function defaultObserveExistingRelease(
  request: FactoryReleasePrepareRequest,
): Promise<{ pr: number; head_oid: string; version: string } | null> {
  const branch = `release/v${request.target_version}`;
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr", "list", "-R", request.repository, "--state", "all", "--head", branch,
        "--limit", "5", "--json", "number,title,state,headRefOid,baseRefName",
      ],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const rows = JSON.parse(String(stdout)) as Array<{
      number?: number;
      title?: string;
      state?: string;
      headRefOid?: string;
      baseRefName?: string;
    }>;
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0]!;
      const pr = Number(row.number);
      const head = String(row.headRefOid ?? "");
      if (Number.isSafeInteger(pr) && pr > 0 && /^[0-9a-f]{40}$/i.test(head)) {
        if (row.baseRefName === request.base_branch) {
          return { pr, head_oid: head.toLowerCase(), version: request.target_version };
        }
      }
    }
  } catch {
    // Fall through to candidate-head lookup.
  }
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr", "list", "-R", request.repository, "--state", "open",
        "--limit", "50", "--json", "number,title,state,headRefOid,baseRefName",
      ],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const openRows = JSON.parse(String(stdout)) as Array<{
      number?: number;
      state?: string;
      headRefOid?: string;
      baseRefName?: string;
    }>;
    const fromOpen = selectExistingReleaseRow(request, Array.isArray(openRows) ? openRows : []);
    if (fromOpen) return fromOpen;
  } catch {
    // Fall through to commit-in-PR lookup.
  }
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${request.repository}/commits/${request.integrated_candidate.git_sha}/pulls`,
        "--jq",
        ".[] | {number,state,headRefOid:.head.sha,baseRefName:.base.ref}",
      ],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const lines = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        number?: number;
        state?: string;
        headRefOid?: string;
        baseRefName?: string;
      });
    return selectExistingReleaseFromContainingPrs(request, lines);
  } catch {
    return null;
  }
}

/** A PR that already contains the candidate may have a later HEAD. */
export function selectExistingReleaseFromContainingPrs(
  request: FactoryReleasePrepareRequest,
  rows: ReadonlyArray<{
    number?: number;
    headRefOid?: string;
    baseRefName?: string;
    state?: string;
  }>,
): { pr: number; head_oid: string; version: string } | null {
  for (const row of rows) {
    const pr = Number(row.number);
    const head = String(row.headRefOid ?? "").toLowerCase();
    if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[0-9a-f]{40}$/i.test(head)) continue;
    if (row.baseRefName !== request.base_branch) continue;
    const state = String(row.state ?? "open").toLowerCase();
    if (state !== "open" && state !== "merged") continue;
    return { pr, head_oid: head, version: request.target_version };
  }
  return null;
}

export function defaultFactoryReleasePrepareDeps(
  overrides: Partial<FactoryReleasePrepareDeps> = {},
): FactoryReleasePrepareDeps {
  const readFile = overrides.readFile ?? ((p: string) => fs.readFile(p, "utf8"));
  const fileExists = overrides.fileExists ?? defaultFileExists;
  return {
    now: overrides.now ?? (() => new Date()),
    env: overrides.env,
    readRequestText: overrides.readRequestText ?? ((p) => fs.readFile(p, "utf8")),
    readFile,
    writeFile:
      overrides.writeFile ??
      (async (p, body, mode) => {
        await fs.writeFile(p, body, { encoding: "utf8", mode: mode ?? 0o600 });
      }),
    mkdir:
      overrides.mkdir ??
      (async (p, opts) => {
        await fs.mkdir(p, { recursive: opts?.recursive ?? true, mode: opts?.mode ?? 0o700 });
      }),
    fileExists,
    loadPack: overrides.loadPack ?? (() => loadFrgPack(defaultFrgPackRoot())),
    generateUnsignedFrg:
      overrides.generateUnsignedFrg ??
      ((request, ctx) =>
        generateDurableUnsignedFrg(request, ctx, {
          writeFile: overrides.writeFile,
          mkdir: overrides.mkdir,
          now: overrides.now,
          readFile: overrides.readFile,
          fileExists: overrides.fileExists,
          startBoundPackLoop: overrides.startBoundPackLoop,
          createOrReusePackIssues:
            overrides.createOrReusePackIssues ?? productionCreateOrReusePackIssues,
          dispatchPackLoop: overrides.dispatchPackLoop ?? productionDispatchPackLoop,
          scoreBoundPackLoop: overrides.scoreBoundPackLoop,
        })),
    observeAttestation:
      overrides.observeAttestation ??
      ((request, unsigned, ctx) =>
        defaultObserveAttestation(request, unsigned, ctx, readFile, fileExists, {
          attestationKey: resolveFrgAttestationKey(overrides.env ?? process.env),
        })),
    observeExistingRelease:
      overrides.observeExistingRelease ??
      ((request) => defaultObserveExistingRelease(request)),
    runRelease:
      overrides.runRelease ??
      (async (version, opts, cfg) => {
        const result = await runRelease(version, opts, {
          repo_dir: cfg.repo_dir,
          repo: cfg.repo,
          base_branch: cfg.base_branch,
        } as Parameters<typeof runRelease>[2]);
        return result ?? null;
      }),
    startBoundPackLoop: overrides.startBoundPackLoop,
    createOrReusePackIssues:
      overrides.createOrReusePackIssues ?? productionCreateOrReusePackIssues,
    dispatchPackLoop: overrides.dispatchPackLoop ?? productionDispatchPackLoop,
    scoreBoundPackLoop: overrides.scoreBoundPackLoop,
    log: overrides.log,
    realpathSync: overrides.realpathSync,
    listRemainingOpenMilestoneIssues:
      overrides.listRemainingOpenMilestoneIssues ??
      ((args) => listRemainingOpenMilestoneIssueNumbers(args.repository, args.milestone, remainingOpenGh)),
  };
}

// ---------------------------------------------------------------------------
// Checkpoint store
// ---------------------------------------------------------------------------

async function loadCheckpoint(
  deps: FactoryReleasePrepareDeps,
  checkpointPath: string,
): Promise<FactoryReleaseCheckpointRecord | null> {
  if (!(await deps.fileExists(checkpointPath))) return null;
  const text = await deps.readFile(checkpointPath);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`factory-release prepare: checkpoint at ${checkpointPath} is not valid JSON`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("factory-release prepare: checkpoint is not an object");
  }
  const o = raw as FactoryReleaseCheckpointRecord;
  if (o.schema_version !== 1 || o.kind !== "factory_release_checkpoint_store") {
    throw new Error("factory-release prepare: unsupported checkpoint schema");
  }
  return o;
}

async function saveCheckpoint(
  deps: FactoryReleasePrepareDeps,
  checkpointPath: string,
  record: FactoryReleaseCheckpointRecord,
): Promise<void> {
  await deps.mkdir(path.dirname(checkpointPath), { recursive: true, mode: 0o700 });
  await deps.writeFile(checkpointPath, canonicalJson(record), 0o600);
}

function requestsMatch(
  a: FactoryReleasePrepareRequest,
  b: FactoryReleasePrepareRequest,
): boolean {
  return (
    a.action_id === b.action_id &&
    a.repository === b.repository &&
    a.base_branch === b.base_branch &&
    a.target_version === b.target_version &&
    a.integrated_candidate.git_sha === b.integrated_candidate.git_sha &&
    a.frg_manifest.pack_id === b.frg_manifest.pack_id &&
    a.frg_manifest.sha256 === b.frg_manifest.sha256 &&
    (a.grant_fingerprint ?? null) === (b.grant_fingerprint ?? null)
  );
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export interface RunFactoryReleasePrepareOpts {
  /** Absolute path to the request JSON. */
  requestPath: string;
  repoDir: string;
  /**
   * Factory control checkout when distinct from `repoDir`. Also read from
   * `AGENT_PIPELINE_FACTORY_CONTROL` / `REPO_DIR` on `deps.env`.
   */
  factoryControlDir?: string | null;
  /** When true (CLI default with --json), result is returned for stdout. */
  json?: boolean;
  baseBranch?: string;
}

export interface RunFactoryReleasePrepareOutcome {
  result: FactoryReleaseResult;
  exitCode: number;
}

function failedResult(
  request: FactoryReleasePrepareRequest,
  defectClass: string,
  message: string,
  checkpoint: string,
  liveness?: PackLoopLivenessStatus,
): FactoryReleaseFailedResult {
  return {
    schema_version: 1,
    kind: FACTORY_RELEASE_FAILED_KIND,
    status: "failed",
    action_id: request.action_id,
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    defect_class: defectClass,
    message,
    checkpoint,
    ...(liveness ? { liveness } : {}),
  };
}

function inProgressResult(
  request: FactoryReleasePrepareRequest,
  loopRunId: string,
  checkpoint: string,
  liveness?: PackLoopLivenessStatus,
): FactoryReleaseInProgressResult {
  return {
    schema_version: 1,
    kind: FACTORY_RELEASE_CHECKPOINT_KIND,
    status: "in_progress",
    action_id: request.action_id,
    grant_fingerprint: grantFingerprintOrAction(request),
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    loop_run_id: loopRunId,
    checkpoint,
    ...(liveness ? { liveness } : {}),
  };
}

function awaitingResult(
  request: FactoryReleasePrepareRequest,
  frg: FactoryReleaseFrgPayload,
  checkpoint: string,
  observeMiss?: FactoryReleaseObserveMiss,
): FactoryReleaseAwaitingResult {
  return {
    schema_version: 1,
    kind: FACTORY_RELEASE_CHECKPOINT_KIND,
    status: "awaiting_frg_attestation",
    action_id: request.action_id,
    grant_fingerprint: grantFingerprintOrAction(request),
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    checkpoint,
    frg,
    ...(observeMiss ? { observe_miss: observeMiss } : {}),
  };
}

function completeResult(
  request: FactoryReleasePrepareRequest,
  frg: FactoryReleaseFrgPayload,
  attestation: ObservedAttestation,
  release: { pr: number; head_oid: string; base_oid: string },
  checkpoint: string,
): FactoryReleaseCompleteResult {
  return {
    schema_version: 1,
    kind: FACTORY_RELEASE_PREPARED_KIND,
    status: "complete",
    action_id: request.action_id,
    grant_fingerprint: grantFingerprintOrAction(request),
    repository: request.repository,
    base_branch: request.base_branch,
    target_version: request.target_version,
    milestone: request.milestone ?? `v${request.target_version}`,
    candidate_git_sha: request.integrated_candidate.git_sha,
    frg: {
      pack_id: frg.pack_id,
      pack_run_id: frg.pack_run_id,
      loop_run_id: frg.loop_run_id,
      run_id: attestation.frg_run_id,
      manifest_sha256: frg.manifest_sha256,
      evidence_sha256: attestation.evidence_sha256,
    },
    release_pr: {
      number: release.pr,
      head_oid: release.head_oid,
      base_oid: release.base_oid,
    },
    checkpoint,
  };
}

/**
 * Idempotent two-call factory-release prepare.
 *
 * Re-observes checkpoint, pack, attestation, and release PR before any create.
 * Duplicate ticks return the same proved state without a second pack/PR.
 */
export async function runFactoryReleasePrepare(
  opts: RunFactoryReleasePrepareOpts,
  deps: FactoryReleasePrepareDeps = defaultFactoryReleasePrepareDeps(),
): Promise<RunFactoryReleasePrepareOutcome> {
  const requestPath = opts.requestPath;
  if (!path.isAbsolute(requestPath)) {
    throw new Error(
      "factory-release prepare: --request must be an absolute path to the request JSON",
    );
  }

  const env = deps.env ?? process.env;
  assertRequestOutsideCheckouts(
    requestPath,
    targetCheckoutsForPrepare({
      repoDir: opts.repoDir,
      factoryControlDir: opts.factoryControlDir,
      env,
    }),
    deps.realpathSync ?? defaultRealpathSync,
  );

  // Refuse FRG credential material in the candidate environment.
  for (const name of CANDIDATE_LOOP_DENIED_FRG_ENV) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") {
      throw new Error(
        `factory-release prepare: refuses to run with ${name} in the candidate environment ` +
          `(production-owned attestor must sign outside this process)`,
      );
    }
  }

  const text = await deps.readRequestText(requestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `factory-release prepare: request is not valid JSON: ${(err as Error).message}`,
    );
  }
  const request = parseFactoryReleasePrepareRequest(raw);
  const milestone = request.milestone ?? `v${request.target_version}`;
  const listRemaining = deps.listRemainingOpenMilestoneIssues;
  if (typeof listRemaining !== "function") {
    throw new Error("ship-end-open-issue-gate: remaining-open observation is required");
  }
  const remaining = await listRemaining({
    repository: request.repository,
    milestone,
  });
  assertNoRemainingOpenMilestoneIssues(milestone, remaining);
  const fingerprint = factoryReleaseRequestFingerprint(request);
  const workDir = factoryReleaseWorkDir(opts.repoDir, fingerprint);
  const checkpointPath = factoryReleaseCheckpointPath(opts.repoDir, fingerprint);
  const log = deps.log ?? (() => {});

  // Load pack + verify manifest digest matches the request binding.
  const loadPack = deps.loadPack ?? (() => loadFrgPack(defaultFrgPackRoot()));
  const pack = await loadPack();
  if (pack.manifest_sha256 !== request.frg_manifest.sha256) {
    return {
      exitCode: 1,
      result: failedResult(
        request,
        "manifest_mismatch",
        `factory-release prepare: request frg_manifest.sha256 does not match loaded pack ` +
          `(${pack.manifest_sha256})`,
        checkpointId("failed", fingerprint),
      ),
    };
  }
  const manifestPath = path.join(pack.root_dir, "manifest.json");

  let store = await loadCheckpoint(deps, checkpointPath);
  if (store && !requestsMatch(store.request, request)) {
    throw new Error(
      "factory-release prepare: checkpoint request binding changed; use a new action_id",
    );
  }

  // --- Complete: re-observe and return without mutation ---
  if (store?.phase === "complete" && store.unsigned && store.attestation && store.release) {
    const reobserved = normalizeObserveAttestation(
      await deps.observeAttestation(request, store.unsigned, {
        repoDir: opts.repoDir,
        workDir,
      }),
    );
    const attestation = reobserved.status === "accepted" ? reobserved.attestation : null;
    if (
      !attestation ||
      attestation.frg_run_id !== store.attestation.frg_run_id ||
      attestation.evidence_sha256 !== store.attestation.evidence_sha256
    ) {
      return {
        exitCode: 1,
        result: failedResult(
          request,
          "attestation_lost",
          "factory-release prepare: complete checkpoint attestation is no longer valid",
          store.complete_checkpoint_id ?? checkpointId("failed", fingerprint),
        ),
      };
    }
    log("[factory-release prepare] re-observed complete checkpoint; no mutation");
    return {
      exitCode: 0,
      result: completeResult(
        request,
        store.unsigned,
        attestation,
        store.release,
        store.complete_checkpoint_id ?? checkpointId("prepared", fingerprint),
      ),
    };
  }

  // --- Failed terminal ---
  // Omitted-HMAC `frg_not_eligible` is not a terminal pack-fail (#1147).
  // Re-observe so a prior unsigned-eligible score can become
  // awaiting_frg_attestation instead of replaying the stale checkpoint.
  // Real ineligible scores fail again when generate re-scores.
  if (
    store?.phase === "failed" &&
    store.failure &&
    store.failure.defect_class !== "frg_not_eligible"
  ) {
    return {
      exitCode: 1,
      result: failedResult(
        request,
        store.failure.defect_class,
        store.failure.message,
        checkpointId("failed", fingerprint),
      ),
    };
  }

  // --- Ensure unsigned artifacts (re-observe first) ---
  let unsigned = store?.unsigned;
  if (!unsigned) {
    log("[factory-release prepare] generating fresh unsigned FRG artifacts");
    store = {
      schema_version: 1,
      kind: "factory_release_checkpoint_store",
      request_fingerprint: fingerprint,
      phase: "frg_running",
      request,
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);

    const generated = await deps.generateUnsignedFrg(request, {
      repoDir: opts.repoDir,
      workDir,
      pack,
      manifestPath,
    });
    if (generated.in_progress && generated.loop_run_id) {
      const runningId = checkpointId("running", fingerprint);
      store = {
        ...store,
        phase: "frg_running",
        updated_at: isoNow(deps.now()),
      };
      await saveCheckpoint(deps, checkpointPath, store);
      log(
        `[factory-release prepare] bound pack loop ${generated.loop_run_id} in progress; re-invoke to resume`,
      );
      return {
        exitCode: 0,
        result: inProgressResult(request, generated.loop_run_id, runningId, generated.liveness),
      };
    }
    if (!generated.structurally_eligible) {
      const msg =
        generated.message ??
        `FRG structural eligibility failed for ${request.target_version}`;
      const defect = generated.defect_class ?? "frg_not_eligible";
      store = {
        ...store,
        phase: "failed",
        failure: { defect_class: defect, message: msg },
        updated_at: isoNow(deps.now()),
      };
      await saveCheckpoint(deps, checkpointPath, store);
      return {
        exitCode: 1,
        result: failedResult(request, defect, msg, checkpointId("failed", fingerprint), generated.liveness),
      };
    }
    unsigned = generated.frg;
    // Refuse foreign/stale binding
    if (
      unsigned.pack_id !== request.frg_manifest.pack_id ||
      unsigned.manifest_sha256 !== request.frg_manifest.sha256
    ) {
      const msg = "factory-release prepare: generated pack does not match request manifest binding";
      store = {
        ...store,
        phase: "failed",
        failure: { defect_class: "pack_mismatch", message: msg },
        updated_at: isoNow(deps.now()),
      };
      await saveCheckpoint(deps, checkpointPath, store);
      return {
        exitCode: 1,
        result: failedResult(request, "pack_mismatch", msg, checkpointId("failed", fingerprint)),
      };
    }
    const awaitingId = checkpointId("unsigned", fingerprint);
    store = {
      ...store,
      phase: "awaiting_frg_attestation",
      unsigned,
      awaiting_checkpoint_id: awaitingId,
      failure: undefined,
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);
    await deps.mkdir(path.dirname(factoryReleaseVersionIndexPath(opts.repoDir, request.target_version)), {
      recursive: true,
      mode: 0o700,
    });
    await deps.writeFile(
      factoryReleaseVersionIndexPath(opts.repoDir, request.target_version),
      canonicalJson({
        schema_version: 1,
        version: request.target_version,
        request_fingerprint: fingerprint,
        candidate_git_sha: request.integrated_candidate.git_sha,
        action_id: request.action_id,
        pack_run_id: unsigned.pack_run_id,
        loop_run_id: unsigned.loop_run_id,
        frg_run_id: unsigned.frg_run_id,
      }),
      0o600,
    );
  }

  // --- Attestation observation ---
  const observed = normalizeObserveAttestation(
    await deps.observeAttestation(request, unsigned, {
      repoDir: opts.repoDir,
      workDir,
    }),
  );
  if (observed.status !== "accepted") {
    const awaitingId = store?.awaiting_checkpoint_id ?? checkpointId("unsigned", fingerprint);
    if (!store || store.phase !== "awaiting_frg_attestation") {
      store = {
        schema_version: 1,
        kind: "factory_release_checkpoint_store",
        request_fingerprint: fingerprint,
        phase: "awaiting_frg_attestation",
        request,
        unsigned,
        awaiting_checkpoint_id: awaitingId,
        updated_at: isoNow(deps.now()),
      };
      await saveCheckpoint(deps, checkpointPath, store);
    }
    log("[factory-release prepare] awaiting production-owned FRG attestation");
    const observeMiss: FactoryReleaseObserveMiss | undefined =
      observed.status === "rejected"
        ? {
            reason: observed.reason,
            expected_frg_run_id: observed.expected_frg_run_id,
            observed_run_id: observed.observed_run_id,
            detail: observed.detail,
          }
        : undefined;
    return {
      exitCode: 0,
      result: awaitingResult(request, unsigned, awaitingId, observeMiss),
    };
  }
  const attestation = observed.attestation;

  // Join is HMAC factory_release_binding.frg_run_id === unsigned A, not run_id === A.
  if (
    attestation.evidence.loop_run_id !== unsigned.loop_run_id ||
    attestation.evidence.version !== request.target_version
  ) {
    const msg =
      `factory-release prepare: attested evidence does not match unsigned pack binding ` +
      `for ${request.target_version}`;
    return {
      exitCode: 1,
      result: failedResult(request, "attestation_mismatch", msg, checkpointId("failed", fingerprint)),
    };
  }
  {
    const expectedBinding = buildFactoryReleaseUnsignedDigestBinding(request, unsigned);
    const evidenceRec = attestation.evidence as FrgEvidence & {
      factory_release_binding?: unknown;
    };
    const observedBinding = evidenceRec.factory_release_binding;
    if (observedBinding === undefined && notesCarryFactoryReleaseBinding(attestation.evidence.notes)) {
      const awaitingId = store?.awaiting_checkpoint_id ?? checkpointId("unsigned", fingerprint);
      return {
        exitCode: 0,
        result: awaitingResult(request, unsigned, awaitingId, {
          reason: "notes_only_binding",
          expected_frg_run_id: unsigned.frg_run_id,
          observed_run_id: attestation.frg_run_id,
        }),
      };
    }
    const mismatch = unsignedDigestBindingMismatch(expectedBinding, observedBinding ?? null);
    if (mismatch) {
      const awaitingId = store?.awaiting_checkpoint_id ?? checkpointId("unsigned", fingerprint);
      return {
        exitCode: 0,
        result: awaitingResult(request, unsigned, awaitingId, {
          reason:
            mismatch === "factory_release_binding missing or not an object"
              ? "missing_factory_release_binding"
              : "binding_mismatch",
          expected_frg_run_id: unsigned.frg_run_id,
          observed_run_id: attestation.frg_run_id,
          detail: mismatch,
        }),
      };
    }
  }

  // --- Release prepare via shared runRelease (idempotent) ---
  if (store?.release) {
    const completeId = store.complete_checkpoint_id ?? checkpointId("prepared", fingerprint);
    store = {
      ...store,
      phase: "complete",
      attestation: {
        frg_run_id: attestation.frg_run_id,
        evidence_path: attestation.evidence_path,
        evidence_sha256: attestation.evidence_sha256,
        latest_path: attestation.latest_path,
        latest_sha256: attestation.latest_sha256,
      },
      complete_checkpoint_id: completeId,
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);
    return {
      exitCode: 0,
      result: completeResult(request, unsigned, attestation, store.release, completeId),
    };
  }

  const existingRelease = deps.observeExistingRelease
    ? await deps.observeExistingRelease(request)
    : null;
  if (existingRelease) {
    const release = {
      pr: existingRelease.pr,
      head_oid: existingRelease.head_oid,
      base_oid: request.integrated_candidate.git_sha,
      version: existingRelease.version,
    };
    const reusedId = checkpointId("prepared", fingerprint);
    store = {
      schema_version: 1,
      kind: "factory_release_checkpoint_store",
      request_fingerprint: fingerprint,
      phase: "complete",
      request,
      unsigned,
      awaiting_checkpoint_id: store?.awaiting_checkpoint_id,
      attestation: {
        frg_run_id: attestation.frg_run_id,
        evidence_path: attestation.evidence_path,
        evidence_sha256: attestation.evidence_sha256,
        latest_path: attestation.latest_path,
        latest_sha256: attestation.latest_sha256,
      },
      release,
      complete_checkpoint_id: reusedId,
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);
    log(
      `[factory-release prepare] reusing existing release PR #${release.pr}; not opening a second PR`,
    );
    return {
      exitCode: 0,
      result: completeResult(request, unsigned, attestation, release, reusedId),
    };
  }

  log("[factory-release prepare] invoking shared runRelease prepare-only path");
  store = {
    schema_version: 1,
    kind: "factory_release_checkpoint_store",
    request_fingerprint: fingerprint,
    phase: "release_preparing",
    request,
    unsigned,
    awaiting_checkpoint_id: store?.awaiting_checkpoint_id,
    attestation: {
      frg_run_id: attestation.frg_run_id,
      evidence_path: attestation.evidence_path,
      evidence_sha256: attestation.evidence_sha256,
      latest_path: attestation.latest_path,
      latest_sha256: attestation.latest_sha256,
    },
    updated_at: isoNow(deps.now()),
  };
  await saveCheckpoint(deps, checkpointPath, store);

  let releaseResult: ReleasePrepareResult | null | void;
  try {
    releaseResult = await deps.runRelease(
      request.target_version,
      { noEdit: true },
      {
        repo_dir: opts.repoDir,
        repo: request.repository,
        base_branch: request.base_branch,
      },
    );
  } catch (err) {
    const msg = `factory-release prepare: shared runRelease failed: ${(err as Error).message}`;
    store = {
      ...store,
      phase: "failed",
      failure: { defect_class: "release_prepare_failed", message: msg },
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);
    return {
      exitCode: 1,
      result: failedResult(
        request,
        "release_prepare_failed",
        msg,
        checkpointId("failed", fingerprint),
      ),
    };
  }

  if (!releaseResult || typeof releaseResult !== "object" || !("pr" in releaseResult)) {
    const msg = "factory-release prepare: shared runRelease returned no live PR identity";
    store = {
      ...store,
      phase: "failed",
      failure: { defect_class: "release_prepare_empty", message: msg },
      updated_at: isoNow(deps.now()),
    };
    await saveCheckpoint(deps, checkpointPath, store);
    return {
      exitCode: 1,
      result: failedResult(
        request,
        "release_prepare_empty",
        msg,
        checkpointId("failed", fingerprint),
      ),
    };
  }

  const release = {
    pr: releaseResult.pr,
    head_oid: releaseResult.head_oid,
    base_oid: request.integrated_candidate.git_sha,
    version: releaseResult.version,
  };
  const completeId = checkpointId("prepared", fingerprint);
  store = {
    ...store,
    phase: "complete",
    release,
    complete_checkpoint_id: completeId,
    updated_at: isoNow(deps.now()),
  };
  await saveCheckpoint(deps, checkpointPath, store);

  return {
    exitCode: 0,
    result: completeResult(request, unsigned, attestation, release, completeId),
  };
}

/** Help text for `pipeline factory-release prepare --help` / command-docs. */
export const FACTORY_RELEASE_PREPARE_HELP = `
pipeline factory-release prepare --request <absolute-off-repo-request.json> --json

Durable post-pilot (versions after ${FRG_HYBRID_PILOT_VERSION}) FRG generation and
prepare-only release handoff. Idempotent multi-tick protocol:

--request MUST be an absolute path that resolves outside the target checkout
(repoDir and, when distinct, the factory control checkout). An in-checkout
path (for example $REPO_DIR/.agent-pipeline/request.json) is rejected with
defect token ${REQUEST_INSIDE_CHECKOUT_TOKEN} before pack-loop dispatch: it
dirties protected main and fails doctor worktree-clean on the pack loop.
Place the file under $TMPDIR, AGENT_PIPELINE_STATE_HOME, or the Tugboat
$RUN_DIR. Gitignoring request-*.json or skip-worktree is not the product fix.

  1) First call with no request-bound pack loop (or a bound loop that is not
     terminal) starts or resumes a factory-gate candidate pack loop
     (--engine-track candidate, work-list or --label factory-gate), persists
     loop_run_id, and returns status "in_progress" with that id and a restart
     checkpoint. It does NOT invent pass, does NOT return complete, and does
     NOT treat a missing pre-bound loop as missing_generator. Re-invoke the
     UNCHANGED request to resume the same loop_run_id. An unbound newest
     factory-gate loop is never adopted.
  2) When the bound loop is terminal, the command scores it with
     factory-gate --for <version> --from-run <loop_run_id> (no --observations).
     If unsigned artifacts are structurally eligible and no verified
     production-owned attestation exists, it returns status
     "awaiting_frg_attestation" with closed artifact identities and digests
     (HMAC omitted is awaiting, not failed / frg_not_eligible). latest.json
     MAY stay pass:false until attested. It does NOT open a release PR and
     must NOT see PIPELINE_FRG_ATTESTATION_KEY in the candidate environment.
  3) After the trusted production-owned attestor stores a verified attestation
     for those exact artifacts, a later call with the UNCHANGED request
     verifies the attestation, invokes shared runRelease (prepare-only), and
     returns status "complete" with FRG run id, release PR, head, base, and
     restart checkpoint.

Request JSON (schema_version: 1, kind: "${FACTORY_RELEASE_REQUEST_KIND}"):
  Required: action_id, repository, base_branch, target_version,
            integrated_candidate.git_sha, frg_manifest.{pack_id,sha256}
  Optional: grant_fingerprint, milestone, ordered_merges, production_pin,
            controller_revision, engine_fingerprint, policy_fingerprint
  Forbidden: credentials, executable paths, modules, network targets,
             caller-authored pass/status/metric/receipt claims.

Never merges, tags, publishes, promotes, installs, rolls back, or sets
Tugboat --skip-frg.
Hybrid Layer A pilot remains valid only for exactly ${FRG_HYBRID_PILOT_VERSION}.
`.trim();
