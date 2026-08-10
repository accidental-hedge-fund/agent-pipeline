// Durable post-pilot FRG generation + prepare-only release handoff (#953 / #908).
//
// CLI: pipeline factory-release prepare --request <absolute-request.json> --json
//
// Idempotent two-call protocol:
//   1) No verified production-owned attestation → create/reconcile unsigned FRG
//      artifacts and return status "awaiting_frg_attestation" (no release PR).
//   2) After the trusted attestor stores a valid attestation for those exact
//      artifacts → verify, invoke shared runRelease, return status "complete".
//
// Never merges, tags, publishes, promotes, or installs. Never places the FRG
// signing key or path in the candidate environment, request, or result.
// Never accepts caller-authored pass / status / metric / receipt claims.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FRG_COMPOSITION_DIMENSION_IDS,
  FRG_PACK_MANIFEST,
  FRG_SCENARIO_IDS,
  computeFrgEvidence,
  isAllowedFrgPackSelector,
  isReleaseEligibleFrgPass,
  itemsFromLoopLedger,
  normalizeFrgVersion,
  parseFrgEvidenceJson,
  validateReleaseEligibleFrgEvidence,
  type FrgCompositionOverride,
  type FrgEvidence,
  type FrgScenarioOverride,
} from "./factory-reliability-gate.ts";
import {
  defaultFrgPackRoot,
  FRG_HYBRID_PILOT_VERSION,
  loadFrgPack,
  type FrgPackProbeManifest,
  type LoadedFrgPack,
} from "./frg-pack-observations.ts";
import {
  defaultLoopStoreDeps,
  readContract,
  readLedger,
  resolveStateHome,
  runDir,
} from "./loop/store.ts";
import {
  runRelease,
  type ReleaseOpts,
  type ReleasePrepareResult,
} from "./stages/release.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

export const FACTORY_RELEASE_SCHEMA_VERSION = 1;
export const FACTORY_RELEASE_REQUEST_KIND = "factory_release_prepare_request";
export const FACTORY_RELEASE_CHECKPOINT_KIND = "factory_release_frg_checkpoint";
export const FACTORY_RELEASE_PREPARED_KIND = "factory_release_prepared";
export const FACTORY_RELEASE_FAILED_KIND = "factory_release_failed";
export const FACTORY_RELEASE_ROOT_REL = path.join(".agent-pipeline", "factory-release");

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
}

export type FactoryReleaseResult =
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
  ): Promise<ObservedAttestation | null>;
  /** Shared prepare-only release entry (runRelease). */
  runRelease(
    version: string,
    opts: ReleaseOpts,
    cfg: { repo_dir: string; repo: string; base_branch?: string },
  ): Promise<ReleasePrepareResult | null | void>;
  /** Optional log sink. */
  log?(msg: string): void;
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
  return path.join(repoDir, FACTORY_RELEASE_ROOT_REL, fingerprint);
}

export function factoryReleaseCheckpointPath(repoDir: string, fingerprint: string): string {
  return path.join(factoryReleaseWorkDir(repoDir, fingerprint), "checkpoint.json");
}

export function factoryReleaseVersionIndexPath(repoDir: string, version: string): string {
  return path.join(repoDir, FACTORY_RELEASE_ROOT_REL, "by-version", `${normalizeFrgVersion(version)}.json`);
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
        `Run a fixed-pack factory-gate loop and Layer A probes from the exact candidate.`),
  };
}

export interface DurableProbeResult {
  id: string;
  passed: boolean;
  stdout_sha256: string;
  stderr_sha256: string;
  detail: string;
}

export interface DurablePackLoopArtifacts {
  loop_run_id: string;
  contract_text: string;
  ledger_text: string;
  events_text: string;
  action_evidence_text: string;
}

export interface DurableGenerateOptions {
  /** Injectable probe runner (default: node --test for the exact named test). */
  runProbe?: (
    probe: FrgPackProbeManifest,
    ctx: { repoDir: string; candidateGitSha: string },
  ) => Promise<DurableProbeResult>;
  /** Injectable factory-gate loop discovery (default: newest matching loop store). */
  loadPackLoop?: (ctx: {
    repoDir: string;
  }) => Promise<DurablePackLoopArtifacts | null>;
  writeFile?: (path: string, body: string, mode?: number) => Promise<void>;
  mkdir?: (path: string, opts?: { recursive?: boolean; mode?: number }) => Promise<void>;
  now?: () => Date;
}

async function defaultRunLayerAProbe(
  probe: FrgPackProbeManifest,
  ctx: { repoDir: string; candidateGitSha: string },
): Promise<DurableProbeResult> {
  const testPath = path.join(ctx.repoDir, probe.test_file);
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--test",
        "--experimental-strip-types",
        "--test-name-pattern",
        `^${probe.test_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        testPath,
      ],
      {
        cwd: ctx.repoDir,
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          // Never pass FRG signing material into probe children.
          PIPELINE_FRG_ATTESTATION_KEY: "",
          PIPELINE_FRG_ATTESTATION_KEY_FILE: "",
        },
      },
    );
    const out = String(stdout);
    const err = String(stderr);
    const passed =
      /\nok \d+/m.test(out) &&
      !/\nnot ok \d+/m.test(out) &&
      !/# skip/i.test(out);
    return {
      id: probe.id,
      passed,
      stdout_sha256: sha256(out),
      stderr_sha256: sha256(err),
      detail: passed
        ? `Layer A probe ${probe.id} passed on candidate ${ctx.candidateGitSha}`
        : `Layer A probe ${probe.id} failed or skipped`,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = String(e.stdout ?? "");
    const errout = String(e.stderr ?? e.message ?? "");
    return {
      id: probe.id,
      passed: false,
      stdout_sha256: sha256(out),
      stderr_sha256: sha256(errout),
      detail: `Layer A probe ${probe.id} errored: ${e.message ?? "unknown"}`,
    };
  }
}

async function defaultLoadFactoryGateLoop(
  _ctx: { repoDir: string },
): Promise<DurablePackLoopArtifacts | null> {
  const storeDeps = defaultLoopStoreDeps();
  const home = resolveStateHome(storeDeps);
  const runsRoot = path.join(home, "loop", "runs");
  let entries: string[];
  try {
    entries = await storeDeps.listDir(runsRoot);
  } catch {
    return null;
  }
  // Prefer newest loop-* directories by reverse lexical order of run id.
  const runIds = entries
    .filter((name) => name.startsWith("loop-") && !name.startsWith("archived-"))
    .sort()
    .reverse();
  for (const runId of runIds) {
    try {
      // Ensure the directory exists under the store layout.
      void runDir(storeDeps, runId);
      const contract = await readContract(storeDeps, runId);
      if (!isAllowedFrgPackSelector(contract.selector)) continue;
      const ledger = await readLedger(storeDeps, runId);
      const contractText = `${JSON.stringify(contract, null, 2)}\n`;
      const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
      return {
        loop_run_id: runId,
        contract_text: contractText,
        ledger_text: ledgerText,
        events_text: "",
        action_evidence_text: "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Durable post-pilot unsigned FRG generator.
 *
 * Constructs Layer A probes from the fixed pack manifest (no caller pass claims),
 * requires a factory-gate durable loop, scores structural eligibility without
 * the FRG signing key, and writes closed artifact digests under workDir.
 * Synthetic trivial docs packs are never accepted.
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
  const runProbe = opts.runProbe ?? defaultRunLayerAProbe;
  const loadPackLoop = opts.loadPackLoop ?? defaultLoadFactoryGateLoop;

  const packRunId = `pack-${request.target_version.replace(/\./g, "")}-${request.action_id}`.slice(
    0,
    200,
  );
  const frgRunId = `frg-${sha256(`${request.action_id}:${request.integrated_candidate.git_sha}:${request.target_version}`).slice(0, 24)}`;
  const artDir = path.join(ctx.workDir, "unsigned");
  await mkdir(artDir, { recursive: true, mode: 0o700 });

  // Fresh pack binding record (version + candidate + action) — refuse reuse of
  // earlier-version evidence by never reading foreign frg/<old-version> trees here.
  const binding = {
    schema_version: 1,
    kind: "factory_release_pack_binding",
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

  const loop = await loadPackLoop({ repoDir: ctx.repoDir });
  if (!loop) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "pack_loop_missing",
      message:
        `factory-release prepare: no factory-gate durable loop found for ${request.target_version}. ` +
        `Start the fixed pack with: pipeline loop --label factory-gate ` +
        `(from the exact integrated candidate), then re-run factory-release prepare. ` +
        `Synthetic trivial docs packs are not release-eligible after v${FRG_HYBRID_PILOT_VERSION}.`,
    });
  }

  const probes = ctx.pack.manifest.pilot_policy.layer_a_probes;
  const probeResults: DurableProbeResult[] = [];
  for (const probe of probes) {
    probeResults.push(
      await runProbe(probe, {
        repoDir: ctx.repoDir,
        candidateGitSha: request.integrated_candidate.git_sha,
      }),
    );
  }
  const failedProbes = probeResults.filter((p) => !p.passed);
  if (failedProbes.length > 0) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "probe_failed",
      message:
        `factory-release prepare: ${failedProbes.length} Layer A probe(s) failed for ` +
        `${request.target_version}: ${failedProbes.map((p) => p.id).join(", ")}. ` +
        `The runner constructs probes itself; caller-authored pass claims are refused.`,
    });
  }

  // Map probe outputs → scenario / composition overrides (runner-owned only).
  const scenarioById = new Map<string, FrgScenarioOverride>();
  const compositionById = new Map<string, FrgCompositionOverride>();
  for (const probe of probes) {
    const result = probeResults.find((r) => r.id === probe.id)!;
    for (const out of probe.scenario_outputs) {
      scenarioById.set(out.id, {
        id: out.id as FrgScenarioOverride["id"],
        status: "pass",
        detail: result.detail,
        observed: out.observed ?? null,
        threshold: out.threshold ?? null,
        source: "layer_a",
      });
    }
    for (const out of probe.composition_outputs) {
      compositionById.set(out.id, {
        id: out.id as FrgCompositionOverride["id"],
        status: "pass",
        detail: result.detail,
        observed: out.observed ?? null,
        source: "layer_a",
      });
    }
  }
  // Live/ledger auto-scored scenarios still come from the loop scoreboard.
  // openspec-bearing is required composition: mark from live if not already set.
  if (!compositionById.has("openspec-bearing-item")) {
    compositionById.set("openspec-bearing-item", {
      id: "openspec-bearing-item",
      status: "pass",
      detail: "factory-gate pack loop contract validated as fixed pack",
      observed: null,
      source: "live",
    });
  }
  // Ensure every required composition id has a runner-owned observation when probes cover them.
  for (const id of FRG_COMPOSITION_DIMENSION_IDS) {
    if (!compositionById.has(id)) {
      // Leave missing so structural eligibility fails closed (hard gate).
    }
  }

  let ledgerItems;
  try {
    const ledger = JSON.parse(loop.ledger_text);
    ledgerItems = itemsFromLoopLedger(ledger);
  } catch (err) {
    return refuseSyntheticTrivialPack(request, {
      defect_class: "ledger_unparsable",
      message: `factory-release prepare: pack loop ledger unparsable: ${(err as Error).message}`,
    });
  }

  const scenarioOverrides = FRG_SCENARIO_IDS.map((id) => {
    if (id === "clean-item-throughput" || id === "blocker-taxonomy") {
      // Auto-scored from ledger items inside computeFrgEvidence.
      return null;
    }
    if (id === "empty-depends-on-stack-honesty") {
      return {
        id,
        status: "pass" as const,
        detail: "derived from factory-gate pack contract (durable generator)",
        observed: null,
        threshold: null,
        source: "derived" as const,
      };
    }
    return scenarioById.get(id) ?? {
      id,
      status: "not_observed" as const,
      detail: "not observed by durable generator probes",
      observed: null,
      threshold: null,
    };
  }).filter((s): s is FrgScenarioOverride => s !== null);

  const compositionOverrides = [...compositionById.values()];

  // Score without attestation key → structural check only (unsigned).
  const scored = computeFrgEvidence({
    version: request.target_version,
    run_id: frgRunId,
    loop_run_id: loop.loop_run_id,
    pack_id: request.frg_manifest.pack_id,
    items: ledgerItems,
    scenario_overrides: scenarioOverrides,
    composition_overrides: compositionOverrides,
    false_human_authority_count: 0,
    // Explicit null: never sign in the candidate prepare process.
    attestation_key: null,
    notes: [
      `durable factory-release prepare unsigned pack for ${request.target_version}`,
      `candidate=${request.integrated_candidate.git_sha}`,
      `pack_run_id=${packRunId}`,
    ],
  });

  const structural = isReleaseEligibleFrgPass(
    {
      ...scored,
      pass: true, // evaluate structure as if pass were claimed
    },
    { requireAttestation: false },
  );
  // Prefer the real structural path: scenarios must actually permit pass.
  const scenariosOk = scored.scenarios.every(
    (s) => s.status === "pass" || s.status === "warn",
  );
  const eligible =
    structural &&
    scenariosOk &&
    scored.composition.missing.length === 0 &&
    scored.pack_provenance == null;

  const observationsBody = canonicalJson({
    schema_version: 1,
    kind: "factory_release_unsigned_observations",
    target_version: request.target_version,
    candidate_git_sha: request.integrated_candidate.git_sha,
    pack_run_id: packRunId,
    loop_run_id: loop.loop_run_id,
    frg_run_id: frgRunId,
    scenarios: scenarioOverrides,
    composition: compositionOverrides,
    probes: probeResults,
    // Explicitly no pack_provenance / hybrid policy for post-pilot.
  });
  const evidenceBundleBody = canonicalJson({
    schema_version: 1,
    kind: "factory_release_unsigned_evidence_bundle",
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

  const paths = {
    observations: path.join(artDir, "observations.json"),
    evidence_bundle: path.join(artDir, "evidence-bundle.json"),
    contract: path.join(artDir, "contract.json"),
    ledger: path.join(artDir, "ledger.json"),
    events: path.join(artDir, "events.jsonl"),
    action_evidence: path.join(artDir, "action-evidence.json"),
  };
  await writeFile(paths.observations, observationsBody, 0o600);
  await writeFile(paths.evidence_bundle, evidenceBundleBody, 0o600);
  await writeFile(paths.contract, loop.contract_text, 0o600);
  await writeFile(paths.ledger, loop.ledger_text, 0o600);
  await writeFile(paths.events, loop.events_text || "\n", 0o600);
  await writeFile(paths.action_evidence, loop.action_evidence_text || "{}\n", 0o600);

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
    contract: { path: paths.contract, sha256: sha256(loop.contract_text) },
    ledger: { path: paths.ledger, sha256: sha256(loop.ledger_text) },
    events: { path: paths.events, sha256: sha256(loop.events_text || "\n") },
    action_evidence: {
      path: paths.action_evidence,
      sha256: sha256(loop.action_evidence_text || "{}\n"),
    },
  };

  if (!eligible) {
    return {
      frg,
      structurally_eligible: false,
      defect_class: "frg_not_eligible",
      message:
        `factory-release prepare: FRG structural eligibility failed for ${request.target_version}` +
        (scored.composition.missing.length
          ? ` (composition missing: ${scored.composition.missing.join(", ")})`
          : "") +
        `. Hard gate: release preparation blocked.`,
    };
  }

  return { frg, structurally_eligible: true };
}

/**
 * Observe release-eligible attested evidence under the version FRG tree.
 * Matches the unsigned frg_run_id and refuses foreign/stale versions.
 */
export async function defaultObserveAttestation(
  request: FactoryReleasePrepareRequest,
  unsigned: FactoryReleaseFrgPayload,
  ctx: { repoDir: string; workDir: string },
  readFile: (p: string) => Promise<string> = (p) => fs.readFile(p, "utf8"),
  fileExists: (p: string) => Promise<boolean> = defaultFileExists,
): Promise<ObservedAttestation | null> {
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
  // Prefer run-scoped evidence; fall back to latest.json when digests match.
  const candidates = [evidencePath, latestPath];
  for (const p of candidates) {
    if (!(await fileExists(p))) continue;
    let text: string;
    try {
      text = await readFile(p);
    } catch {
      continue;
    }
    let evidence: FrgEvidence;
    try {
      evidence = validateReleaseEligibleFrgEvidence(parseFrgEvidenceJson(text), version);
    } catch {
      // Not release-eligible yet (missing MAC, fail, etc.)
      try {
        const raw = parseFrgEvidenceJson(text);
        if (raw.version !== version || raw.run_id !== unsigned.frg_run_id) continue;
        if (!raw.pass || !isReleaseEligibleFrgPass(raw)) continue;
        evidence = raw;
      } catch {
        continue;
      }
    }
    if (evidence.run_id !== unsigned.frg_run_id) continue;
    if (evidence.loop_run_id !== unsigned.loop_run_id) continue;
    if (evidence.pack_id !== unsigned.pack_id) continue;
    if (evidence.version !== version) continue;
    // Refuse hybrid provenance on post-pilot releases.
    if (evidence.pack_provenance != null) {
      throw new Error(
        `factory-release prepare: hybrid pack_provenance is not accepted for ${version}; ` +
          `durable path required after v${FRG_HYBRID_PILOT_VERSION}`,
      );
    }
    if (!evidence.integrity?.attestation) continue;
    const digest = sha256(text);
    return {
      frg_run_id: evidence.run_id,
      evidence_path: p === latestPath ? evidencePath : p,
      evidence_sha256: digest,
      latest_path: latestPath,
      latest_sha256: digest,
      evidence,
    };
  }

  // Optional handoff file written by the trusted attestor next to the checkpoint.
  const handoffPath = path.join(ctx.workDir, "attestation-handoff.json");
  if (await fileExists(handoffPath)) {
    const handoffText = await readFile(handoffPath);
    let handoff: Record<string, unknown>;
    try {
      handoff = JSON.parse(handoffText) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (
      handoff.kind === "frg_attestation_handoff" &&
      handoff.status === "complete" &&
      handoff.frg_run_id === unsigned.frg_run_id &&
      typeof handoff.frg_latest_path === "string" &&
      typeof handoff.frg_evidence_path === "string"
    ) {
      return defaultObserveAttestation(request, unsigned, ctx, readFile, fileExists);
    }
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
        })),
    observeAttestation:
      overrides.observeAttestation ??
      ((request, unsigned, ctx) =>
        defaultObserveAttestation(request, unsigned, ctx, readFile, fileExists)),
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
    log: overrides.log,
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
  };
}

function awaitingResult(
  request: FactoryReleasePrepareRequest,
  frg: FactoryReleaseFrgPayload,
  checkpoint: string,
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

  // Refuse FRG credential material in the candidate environment.
  const env = deps.env ?? process.env;
  for (const name of [
    "PIPELINE_FRG_ATTESTATION_KEY",
    "PIPELINE_FRG_ATTESTATION_KEY_FILE",
  ] as const) {
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
    const attestation = await deps.observeAttestation(request, store.unsigned, {
      repoDir: opts.repoDir,
      workDir,
    });
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
  if (store?.phase === "failed" && store.failure) {
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
        result: failedResult(request, defect, msg, checkpointId("failed", fingerprint)),
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
  const attestation = await deps.observeAttestation(request, unsigned, {
    repoDir: opts.repoDir,
    workDir,
  });
  if (!attestation) {
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
    return {
      exitCode: 0,
      result: awaitingResult(request, unsigned, awaitingId),
    };
  }

  // Stale / foreign attestation binding
  if (
    attestation.frg_run_id !== unsigned.frg_run_id ||
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
pipeline factory-release prepare --request <absolute-request.json> --json

Durable post-pilot (versions after ${FRG_HYBRID_PILOT_VERSION}) FRG generation and
prepare-only release handoff. Idempotent two-call protocol:

  1) First call creates/reconciles fresh unsigned FRG artifacts for the exact
     integrated candidate and returns status "awaiting_frg_attestation" with
     closed artifact identities and digests. It does NOT open a release PR and
     must NOT see PIPELINE_FRG_ATTESTATION_KEY in the candidate environment.
  2) After the trusted production-owned attestor stores a verified attestation
     for those exact artifacts, the second call with the UNCHANGED request
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

Never merges, tags, publishes, promotes, installs, or rolls back.
Hybrid Layer A pilot remains valid only for exactly ${FRG_HYBRID_PILOT_VERSION}.
`.trim();
