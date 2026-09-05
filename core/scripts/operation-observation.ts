// Typed operation observations for RecoverySupervisor adapters (#1329).
//
// Command, stage, and factory surfaces emit these records. They do not choose
// Cooling, wait, typed-request, or cancellation policy. RecoverySupervisor
// remains the sole lifecycle owner. This module is not a second supervisor,
// answer ledger, grant schema, or public CLI verb.
//
// Persistence is a claim adapter: one atomic record per (domain,
// logical_operation_id), stored under pipeline state-home (not anonymous
// /tmp files). Transitions are monotonic and compare-and-swap retried so
// a stale active admission cannot overwrite cooling/waiting/complete.
// Recovery consumes that claim by identity.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLogicalOperationId, mintLogicalOperationId } from "./logical-operation.ts";
import type { PublicAdmissionResult } from "./run-store.ts";

export const OPERATION_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type SideEffectCertainty = "known_complete" | "known_absent" | "uncertain";
export type ArtifactEvidenceRole = "planning" | "implementation";

/** Replay is allowed only when the observer has proven the side effect absent. */
export function mayReplaySideEffect(certainty: SideEffectCertainty): boolean {
  return certainty === "known_absent";
}

/**
 * Treatment of an observed side effect before retry. `known_complete` does not
 * replay. `known_absent` may replay under the same identity. `uncertain` stays
 * Cooling or an external-condition wait — never a guessed mutation.
 */
export function treatmentForSideEffectCertainty(
  certainty: SideEffectCertainty,
): "complete" | "replay" | "cooling" {
  if (certainty === "known_complete") return "complete";
  if (certainty === "known_absent") return "replay";
  return "cooling";
}

/** Linked-PR facts used to prove integration completeness (#1324). */
export interface LinkedPrIntegrationFact {
  number: number;
  state: "open" | "closed" | "merged";
  merge_commit_sha?: string | null;
  contained?: boolean | null;
  artifact_role?: ArtifactEvidenceRole | "unknown";
  artifact_identity?: string | null;
  candidate_sha?: string | null;
  candidate_epoch?: string | null;
  logical_operation_id?: string | null;
}

export interface ExpectedLinkedPrBinding {
  candidateSha?: string | null;
  logicalOperationId?: string | null;
}

function isExactLinkedImplementation(
  pr: LinkedPrIntegrationFact,
  expected?: ExpectedLinkedPrBinding,
): boolean {
  const sha = pr.candidate_sha?.trim().toLowerCase() ?? "";
  const epoch = pr.candidate_epoch?.trim().toLowerCase() ?? "";
  const expectedSha = expected?.candidateSha?.trim().toLowerCase() ?? "";
  const expectedOperation = expected?.logicalOperationId?.trim() ?? "";
  return pr.artifact_role === "implementation" &&
    Boolean(pr.artifact_identity?.trim()) &&
    Boolean(sha) &&
    sha === epoch &&
    (!expectedSha || sha === expectedSha) &&
    (!expectedOperation || pr.logical_operation_id?.trim() === expectedOperation);
}

/**
 * Integration side-effect certainty from every linked PR. A later open PR does
 * not hide a prior merged-and-contained PR. Issue closure is not consulted.
 * A truncated enumeration or a failed/missing detail read is not absence:
 * successor mutations stay disallowed until every enumerated linked PR has
 * been authoritatively inspected and no merged-and-contained PR exists.
 */
export function integrationSideEffectCertainty(
  linked: readonly LinkedPrIntegrationFact[],
  opts?: { truncated?: boolean; incompleteDetails?: boolean } & ExpectedLinkedPrBinding,
): SideEffectCertainty {
  if (linked.some((pr) =>
    pr.state === "merged" && pr.contained === true && isExactLinkedImplementation(pr, opts)
  )) {
    return "known_complete";
  }
  if (opts?.truncated || opts?.incompleteDetails) return "uncertain";
  if (linked.some((pr) => pr.state === "merged")) {
    return "uncertain";
  }
  return "known_absent";
}

/** Successor PR-open and rebase of squash-contained commits are forbidden unless the merge is proven absent. */
export function successorMutationsAllowed(certainty: SideEffectCertainty): {
  openSuccessorPr: boolean;
  rebaseContainedCommits: boolean;
} {
  const allowed = certainty === "known_absent";
  return { openSuccessorPr: allowed, rebaseContainedCommits: allowed };
}

/** Prefer a merged-and-contained PR as integration authority over a later open PR. */
export function selectAuthoritativeLinkedPr(
  linked: readonly LinkedPrIntegrationFact[],
  expected?: ExpectedLinkedPrBinding,
): LinkedPrIntegrationFact | null {
  const containedMerged = linked.find((pr) =>
    pr.state === "merged" && pr.contained === true && isExactLinkedImplementation(pr, expected)
  );
  if (containedMerged) return containedMerged;
  const open = linked.find((pr) => pr.state === "open" && pr.artifact_role === "implementation");
  if (open) return open;
  const ambiguousMerged = linked.find((pr) => pr.state === "merged");
  if (ambiguousMerged) return ambiguousMerged;
  return linked[0] ?? null;
}

const LOGICAL_OPERATION_BODY_MARKER_RE =
  /<!--\s*pipeline-logical-operation:\s*([A-Za-z0-9._:-]+)\s*-->/;

export function logicalOperationIdFromArtifactBody(body: string): string | null {
  return LOGICAL_OPERATION_BODY_MARKER_RE.exec(body)?.[1] ?? null;
}

export function bindArtifactBodyToLogicalOperation(
  body: string,
  logicalOperationId?: string | null,
): string {
  const id = logicalOperationId?.trim();
  if (!id || logicalOperationIdFromArtifactBody(body)) return body;
  return `${body.trimEnd()}\n\n<!-- pipeline-logical-operation: ${id} -->`;
}

/**
 * Partial multi-step mutation: a completed archive is not replayed; unfinished
 * rebase is observed; product dirt still fail-closes the archive.
 */
export function archiveReplayDecision(input: {
  archiveAlreadyDone: boolean;
  rebaseInProgress: boolean;
  productDirt: readonly string[];
}): {
  archive_certainty: SideEffectCertainty;
  replay_archive: boolean;
  dirty_fail_closed: boolean;
  rebase_in_progress: boolean;
} {
  const archive_certainty: SideEffectCertainty = input.archiveAlreadyDone
    ? "known_complete"
    : input.rebaseInProgress
      ? "uncertain"
      : "known_absent";
  return {
    archive_certainty,
    replay_archive: mayReplaySideEffect(archive_certainty),
    dirty_fail_closed: input.productDirt.length > 0,
    rebase_in_progress: input.rebaseInProgress,
  };
}

export type ObservationLifecycleState = "active" | "cooling" | "waiting" | "complete";

export interface CapabilityRequestObservation {
  kind: "capability";
  capability: string;
  detail: string;
}

export interface OperationIdentity {
  domain: string;
  logical_operation_id: string;
  repository: string | null;
  issue: number | null;
  run_id: string | null;
}

export interface OperationObservation extends OperationIdentity {
  schema_version: typeof OPERATION_OBSERVATION_SCHEMA_VERSION;
  operation: string;
  form_id: string;
  certainty: SideEffectCertainty;
  lifecycle: ObservationLifecycleState;
  human_owned: false;
  complete: boolean;
  cancelled: false;
  process_exit_is_completion: false;
  /** RecoverySupervisor retains ownership of the Logical Operation. */
  owned: true;
  fault: string | null;
  message: string;
  capability_request: CapabilityRequestObservation | null;
  /** Recovery Episode fields on the shared claim family (#1325). */
  invariant?: string;
  candidate_epoch?: string;
  /** Closed role and identity of the artifact proving this postcondition. */
  evidence_role?: ArtifactEvidenceRole;
  artifact_identity?: string;
  evidence_identity?: string;
  attempts_per_strategy?: Record<string, number>;
  strategy_cursor?: number;
  next_eligible_at?: string;
  episode_id?: string;
}

export type ReportOperationObservation = (obs: OperationObservation) => void;

export interface PersistedOperationObservation extends OperationObservation {
  observation_id: string;
  recorded_at: string;
  transitioned_at?: string;
  /** Monotonic CAS token. Absent on records written before claim CAS. */
  claim_revision?: number;
}

export function resolveOperationClaimDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_PIPELINE_STATE_HOME) {
    return path.join(path.resolve(env.AGENT_PIPELINE_STATE_HOME), "operation-claims");
  }
  if (env.PIPELINE_STATE_HOME) {
    return path.join(path.resolve(env.PIPELINE_STATE_HOME), "operation-claims");
  }
  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "operation-claims");
  }
  return path.join(os.homedir(), ".local", "state", "agent-pipeline", "operation-claims");
}

export const OPERATION_OBSERVATION_DIR_DEFAULT = resolveOperationClaimDir();

export function operationClaimKey(domain: string, logicalOperationId: string): string {
  return `${domain.trim().toLowerCase()}::${logicalOperationId}`;
}

function observationFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

export function mintObservationIdentity(input: {
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  mint?: () => string;
}): OperationIdentity {
  const domain = String(input.domain ?? "").trim();
  if (!domain) {
    throw new Error("operation observation: domain is required");
  }
  const logical_operation_id =
    (typeof input.logical_operation_id === "string" && input.logical_operation_id.trim()) ||
    (input.mint ?? mintLogicalOperationId)();
  if (!isLogicalOperationId(logical_operation_id)) {
    throw new Error("operation observation: logical_operation_id is required");
  }
  return {
    domain,
    logical_operation_id,
    repository: typeof input.repository === "string" && input.repository.trim() ? input.repository.trim() : null,
    issue: typeof input.issue === "number" && Number.isInteger(input.issue) ? input.issue : null,
    run_id: typeof input.run_id === "string" && input.run_id.trim() ? input.run_id.trim() : null,
  };
}

function stableObservationId(obs: OperationObservation): string {
  return `${obs.logical_operation_id}:${obs.form_id}:${obs.operation}`;
}

function sameClaimIdentity(a: OperationObservation, b: OperationObservation): boolean {
  return (
    a.domain === b.domain &&
    a.logical_operation_id === b.logical_operation_id &&
    a.form_id === b.form_id &&
    a.operation === b.operation
  );
}

function readClaimFile(file: string): PersistedOperationObservation | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedOperationObservation;
    if (!raw || raw.owned !== true || raw.schema_version !== OPERATION_OBSERVATION_SCHEMA_VERSION) {
      return null;
    }
    if (!raw.domain || !isLogicalOperationId(raw.logical_operation_id)) return null;
    return raw;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function writeClaimAtomic(file: string, record: PersistedOperationObservation): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  fs.renameSync(tmp, file);
}

const CLAIM_CAS_ATTEMPTS = 16;

const LIFECYCLE_RANK: Record<ObservationLifecycleState, number> = {
  active: 0,
  cooling: 1,
  waiting: 1,
  complete: 2,
};

function lifecycleMayAdvance(
  from: ObservationLifecycleState,
  to: ObservationLifecycleState,
): boolean {
  return LIFECYCLE_RANK[to] >= LIFECYCLE_RANK[from];
}

function claimRevisionOf(record: PersistedOperationObservation | null): number {
  return record?.claim_revision ?? 0;
}

function isDuplicateClaim(existing: PersistedOperationObservation, obs: OperationObservation): boolean {
  return (
    existing.lifecycle === obs.lifecycle &&
    existing.fault === obs.fault &&
    existing.complete === obs.complete &&
    existing.message === obs.message
  );
}

function decideNextClaim(
  existing: PersistedOperationObservation | null,
  obs: OperationObservation,
  recorded_at: string,
): PersistedOperationObservation {
  if (!existing) {
    return {
      ...obs,
      observation_id: stableObservationId(obs),
      recorded_at,
      claim_revision: 1,
    };
  }
  if (!lifecycleMayAdvance(existing.lifecycle, obs.lifecycle)) return existing;
  if (sameClaimIdentity(existing, obs) && isDuplicateClaim(existing, obs)) return existing;
  if (sameClaimIdentity(existing, obs)) {
    return {
      ...existing,
      ...obs,
      observation_id: existing.observation_id,
      recorded_at: existing.recorded_at,
      transitioned_at: recorded_at,
      claim_revision: claimRevisionOf(existing) + 1,
    };
  }
  return {
    ...obs,
    observation_id: stableObservationId(obs),
    recorded_at,
    claim_revision: claimRevisionOf(existing) + 1,
  };
}

function claimCasEqual(
  current: PersistedOperationObservation | null,
  expected: PersistedOperationObservation | null,
): boolean {
  if (current === null || expected === null) return current === expected;
  return (
    claimRevisionOf(current) === claimRevisionOf(expected) &&
    current.observation_id === expected.observation_id &&
    current.lifecycle === expected.lifecycle
  );
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimStaleClaimLock(lockPath: string): boolean {
  let holder = 0;
  try {
    holder = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(holder) || holder <= 0) return false;
  if (holder !== process.pid && isProcessAlive(holder)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function withClaimCasLock(lockPath: string, fn: () => boolean): boolean {
  const runLocked = (): boolean => {
    const fd = fs.openSync(lockPath, "wx");
    try {
      fs.writeSync(fd, String(process.pid));
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* lock already gone */
      }
    }
  };
  try {
    return runLocked();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") throw err;
    if (!reclaimStaleClaimLock(lockPath)) return false;
    try {
      return runLocked();
    } catch (retryErr) {
      const re = retryErr as NodeJS.ErrnoException;
      if (re.code === "EEXIST") return false;
      throw retryErr;
    }
  }
}

export type PersistOperationObservationDeps = {
  /** Exclusive create (`wx`). Tests inject EEXIST races. */
  exclusiveCreate?: (file: string, contents: string) => void;
  /** Test seam: runs after the claim is read and before CAS. */
  afterRead?: (existing: PersistedOperationObservation | null) => void;
};

function exclusiveCreateClaim(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
}

function compareAndSwapClaim(
  file: string,
  expected: PersistedOperationObservation | null,
  next: PersistedOperationObservation,
  deps: PersistOperationObservationDeps,
): boolean {
  if (expected === null) {
    try {
      (deps.exclusiveCreate ?? exclusiveCreateClaim)(file, JSON.stringify(next));
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") return false;
      throw err;
    }
  }
  return withClaimCasLock(`${file}.caslock`, () => {
    const current = readClaimFile(file);
    if (!claimCasEqual(current, expected)) return false;
    writeClaimAtomic(file, next);
    return true;
  });
}

/** Persist one observation as an atomic claim keyed by domain + logical operation. */
export function persistOperationObservation(
  obs: OperationObservation,
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
  deps: PersistOperationObservationDeps = {},
): PersistedOperationObservation {
  if (!obs.domain?.trim() || !isLogicalOperationId(obs.logical_operation_id)) {
    throw new Error("operation observation: domain and logical_operation_id are required");
  }
  fs.mkdirSync(dir, { recursive: true });
  const key = operationClaimKey(obs.domain, obs.logical_operation_id);
  const file = path.join(dir, observationFileName(key));
  const recorded_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (let attempt = 0; attempt < CLAIM_CAS_ATTEMPTS; attempt++) {
    const existing = readClaimFile(file);
    deps.afterRead?.(existing);
    const next = decideNextClaim(existing, obs, recorded_at);
    if (existing && next === existing) return existing;
    if (compareAndSwapClaim(file, existing, next, deps)) return next;
    sleepSync(1);
  }
  const existing = readClaimFile(file);
  const next = decideNextClaim(existing, obs, recorded_at);
  if (existing && next === existing) return existing;
  throw new Error("operation observation: claim CAS retries exhausted");
}

export function loadOwnedOperationClaim(
  domain: string,
  logicalOperationId: string,
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): PersistedOperationObservation | null {
  const file = path.join(dir, observationFileName(operationClaimKey(domain, logicalOperationId)));
  const rec = readClaimFile(file);
  if (!rec) return null;
  if (!rec.owned || rec.complete || rec.human_owned || rec.cancelled) return null;
  return rec;
}

export function listPersistedOperationObservations(
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): PersistedOperationObservation[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: PersistedOperationObservation[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = readClaimFile(path.join(dir, name));
    if (rec) out.push(rec);
  }
  return out;
}

/** RecoverySupervisor consumer: retain ownership from a durable claim. */
export function consumeOwnedOperation(claim: PersistedOperationObservation): {
  owned: true;
  lifecycle: ObservationLifecycleState;
  domain: string;
  logical_operation_id: string;
  issue: number | null;
  run_id: string | null;
} {
  if (!claim.owned || claim.complete || claim.human_owned || claim.cancelled) {
    throw new Error("recovery supervisor: claim is not an owned Logical Operation");
  }
  return {
    owned: true,
    lifecycle: claim.lifecycle,
    domain: claim.domain,
    logical_operation_id: claim.logical_operation_id,
    issue: claim.issue,
    run_id: claim.run_id,
  };
}

/** Production RecoverySupervisor adapter: persist claims durably by identity. */
export function recoverySupervisorObservationSink(
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): ReportOperationObservation {
  return (obs) => {
    persistOperationObservation(obs, dir);
  };
}

export const defaultRecoverySupervisorReport: ReportOperationObservation =
  recoverySupervisorObservationSink();

function observationBase(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  certainty?: SideEffectCertainty;
  lifecycle: ObservationLifecycleState;
  complete: boolean;
  fault: string | null;
  capability_request?: CapabilityRequestObservation | null;
}): OperationObservation {
  const identity = mintObservationIdentity(input);
  return {
    schema_version: OPERATION_OBSERVATION_SCHEMA_VERSION,
    operation: input.operation,
    form_id: input.form_id,
    ...identity,
    certainty: input.certainty ?? "uncertain",
    lifecycle: input.lifecycle,
    human_owned: false,
    complete: input.complete,
    cancelled: false,
    process_exit_is_completion: false,
    owned: true,
    fault: input.fault,
    message: input.message,
    capability_request: input.capability_request ?? null,
  };
}

export function ownedAdmissionObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "active",
    complete: false,
    fault: null,
    certainty: "uncertain",
  });
}

export function completedOperationObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "complete",
    complete: true,
    fault: null,
    certainty: "known_complete",
  });
}

export function mechanicalFaultObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  fault?: string | null;
  certainty?: SideEffectCertainty;
  capability_request?: CapabilityRequestObservation | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "cooling",
    complete: false,
    fault: input.fault ?? "mechanical",
    certainty: input.certainty ?? "uncertain",
    capability_request: input.capability_request ?? null,
  });
}

export function reportOwnedOperation(
  report: ReportOperationObservation | undefined,
  obs: OperationObservation,
): OperationObservation {
  (report ?? defaultRecoverySupervisorReport)(obs);
  return obs;
}

export function reportMechanicalFault(
  report: ReportOperationObservation | undefined,
  input: Parameters<typeof mechanicalFaultObservation>[0],
): OperationObservation {
  return reportOwnedOperation(report, mechanicalFaultObservation(input));
}

/**
 * Admission-refusal adapter. It is deliberately unable to mint: the refusal
 * remains attached to the identity bound before persistence began.
 */
export function reportPublicEntrypointAdmissionFailure(
  report: ReportOperationObservation | undefined,
  result: Extract<PublicAdmissionResult, { acknowledged: false }>,
): OperationObservation {
  if (!isLogicalOperationId(result.logicalOperationId)) {
    throw new Error("public admission refusal is missing its pre-bound Logical Operation identity");
  }
  return reportMechanicalFault(report, {
    operation: result.kind,
    form_id: `public-admission:${result.kind}`,
    message: `${result.failure.step}: ${result.failure.diagnostic}`,
    domain: result.domain,
    logical_operation_id: result.logicalOperationId,
    repository: result.repository,
    issue: result.issue,
    run_id: result.runId,
    fault: `admission.${result.failure.kind}`,
    certainty: "known_absent",
  });
}

export function memoryObservationSink(): {
  observations: OperationObservation[];
  reportObservation: ReportOperationObservation;
} {
  const observations: OperationObservation[] = [];
  return {
    observations,
    reportObservation(obs) {
      observations.push(obs);
    },
  };
}
