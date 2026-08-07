// Factory run store (#890): state-home layout, immutable revisions, CAS
// adopt/replan, coarse-action claims, host-local lock, append-only events.
//
// Every I/O op is behind FactoryStoreDeps — unit tests inject an in-memory
// fake and make no real filesystem, process, or network call.
//
// Concurrency scope: host-local only (same single-host disposition as issue-run
// and loop locks). Possession of the factory-run lock does NOT authorize loop
// ledger mutations.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { homedir } from "node:os";
import { computeFactoryCanonicalHash } from "./hash.ts";
import { validateFactoryIdentities } from "./identity.ts";
import {
  FACTORY_CLAIM_SCHEMA,
  FACTORY_CONTRACT_SCHEMA,
  FACTORY_CURRENT_SCHEMA,
  FACTORY_LOCK_SCHEMA,
  FACTORY_PHASE_EVIDENCE_SCHEMA,
  FactoryError,
  type FactoryActionClaim,
  type FactoryClaimState,
  type FactoryControlIdentities,
  type FactoryCurrentPointer,
  type FactoryExecutionContractBody,
  type FactoryExecutionContractRevision,
  type FactoryLockRecord,
  type FactoryNextAction,
  type FactoryPhaseEvidence,
  type FactoryStatus,
} from "./types.ts";

export const PIPELINE_STATE_HOME_ENV = "AGENT_PIPELINE_STATE_HOME";
export const LEGACY_PIPELINE_STATE_HOME_ENV = "PIPELINE_STATE_HOME";
export const FACTORY_STATE_HOME_ENV = "AGENT_PIPELINE_FACTORY_STATE_HOME";

/** Injectable I/O seam for the factory store. */
export interface FactoryStoreDeps {
  fsExists(p: string): Promise<boolean>;
  readTextFile(p: string): Promise<string | null>;
  writeFileAtomic(p: string, content: string): Promise<void>;
  createFileExclusive(p: string, content: string): Promise<boolean>;
  removeFile(p: string): Promise<void>;
  removeFileIfMatches(p: string, expectedContent: string): Promise<boolean>;
  appendLine(p: string, line: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  listDir(p: string): Promise<string[]>;
  isPidAlive(pid: number): Promise<boolean>;
  hostname(): string;
  pid(): number;
  now(): Date;
  uuid(): string;
  env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// State home + layout
// ---------------------------------------------------------------------------

/**
 * Resolve factory state home (sibling of the loop store root when possible).
 * Never reads Hermes, goal-loop, or chat stores.
 */
export function resolveFactoryStateHome(
  deps: Pick<FactoryStoreDeps, "env" | "hostname">,
): string {
  const env = deps.env;
  if (env[FACTORY_STATE_HOME_ENV]) return path.resolve(env[FACTORY_STATE_HOME_ENV]!);
  const loopHome =
    env[PIPELINE_STATE_HOME_ENV] ?? env[LEGACY_PIPELINE_STATE_HOME_ENV] ?? null;
  if (loopHome) {
    const resolved = path.resolve(loopHome);
    if (path.basename(resolved) === "loop") {
      return path.join(path.dirname(resolved), "factory");
    }
    return path.join(resolved, "factory");
  }
  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "factory");
  }
  return path.join(homedir(), ".local", "state", "agent-pipeline", "factory");
}

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === ".." || runId.includes("..")) {
    throw new FactoryError(
      "validation",
      `invalid factory run id "${runId}": must be a bare name with no path separators or ".."`,
    );
  }
}

export function factoryRunDir(
  deps: Pick<FactoryStoreDeps, "env" | "hostname">,
  factoryRunId: string,
): string {
  assertSafeRunId(factoryRunId);
  const root = path.join(resolveFactoryStateHome(deps), "runs");
  const dir = path.join(root, factoryRunId);
  if (!(dir + path.sep).startsWith(root + path.sep)) {
    throw new FactoryError(
      "validation",
      `invalid factory run id "${factoryRunId}": resolves outside the factory runs root`,
    );
  }
  return dir;
}

function currentPath(dir: string): string {
  return path.join(dir, "current.json");
}
function revisionPath(dir: string, revision: number): string {
  return path.join(dir, "revisions", `${revision}.json`);
}
function claimPath(dir: string, actionId: string): string {
  // action ids are safe path segments (we validate below)
  return path.join(dir, "claims", `${actionId}.json`);
}
function eventsPath(dir: string): string {
  return path.join(dir, "events.jsonl");
}
function lockPath(dir: string): string {
  return path.join(dir, "lock.json");
}
function phaseEvidencePath(dir: string): string {
  return path.join(dir, "phase-evidence.json");
}

const SAFE_ACTION_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeActionId(actionId: string): void {
  if (!SAFE_ACTION_ID.test(actionId)) {
    throw new FactoryError(
      "validation",
      `invalid action id "${actionId}": must be a bare name with no path separators`,
    );
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const nextSeqCache = new Map<string, number>();
const appendQueues = new Map<string, Promise<unknown>>();

async function nextSeq(deps: FactoryStoreDeps, logPath: string): Promise<number> {
  const cached = nextSeqCache.get(logPath);
  if (cached !== undefined) return cached;
  const text = await deps.readTextFile(logPath);
  const lines = text ? text.split("\n").filter((l) => l.length > 0) : [];
  return lines.length;
}

async function appendEvent(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  kind: string,
  data: unknown,
): Promise<void> {
  const logPath = eventsPath(factoryRunDir(deps, factoryRunId));
  const prior = appendQueues.get(logPath) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const seq = await nextSeq(deps, logPath);
    const record = { seq, time: deps.now().toISOString(), kind, data };
    await deps.appendLine(logPath, JSON.stringify(record));
    nextSeqCache.set(logPath, seq + 1);
  });
  appendQueues.set(logPath, task);
  await task;
}

export async function readFactoryEvents(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<Array<{ seq: number; time: string; kind: string; data: unknown }>> {
  const text = await deps.readTextFile(eventsPath(factoryRunDir(deps, factoryRunId)));
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Current pointer + revisions
// ---------------------------------------------------------------------------

export async function factoryRunExists(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<boolean> {
  return deps.fsExists(currentPath(factoryRunDir(deps, factoryRunId)));
}

export async function readCurrentPointer(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryCurrentPointer | null> {
  const text = await deps.readTextFile(currentPath(factoryRunDir(deps, factoryRunId)));
  if (!text) return null;
  return JSON.parse(text) as FactoryCurrentPointer;
}

export async function readRevision(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  revision: number,
): Promise<FactoryExecutionContractRevision> {
  const text = await deps.readTextFile(revisionPath(factoryRunDir(deps, factoryRunId), revision));
  if (!text) {
    throw new FactoryError(
      "not_found",
      `factory run "${factoryRunId}" revision ${revision} not found`,
    );
  }
  return JSON.parse(text) as FactoryExecutionContractRevision;
}

export async function readCurrentRevision(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryExecutionContractRevision | null> {
  const cur = await readCurrentPointer(deps, factoryRunId);
  if (!cur) return null;
  return readRevision(deps, factoryRunId, cur.revision);
}

/**
 * Refuse in-place mutation of an accepted revision body. Callers that need a
 * change must replan to a new revision.
 */
export async function refuseRevisionOverwrite(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  revision: number,
): Promise<void> {
  if (await deps.fsExists(revisionPath(factoryRunDir(deps, factoryRunId), revision))) {
    throw new FactoryError(
      "conflict",
      `factory run "${factoryRunId}" revision ${revision} is immutable — replan to a new revision`,
    );
  }
}

export interface AdoptRequest {
  factory_run_id: string;
  /** null for first adoption. */
  expected_revision: number | null;
  body: Omit<
    FactoryExecutionContractBody,
    "schema" | "revision" | "prior_revision" | "prior_canonical_hash" | "accepted_at" | "canonical_hash"
  > & {
    /** Body fields supplied by caller; identities validated here. */
    identities: FactoryExecutionContractBody["identities"];
  };
  /** Freshly observed live identity that must match body.repo. */
  live_repo: { name: string; base_branch: string; observed_base_sha: string };
  factoryModeEnabled?: boolean;
}

/**
 * CAS adopt (expected null) or replan (expected = current). Writes a new
 * immutable revision and advances the current pointer only when CAS succeeds.
 * Fails closed on stale expected revision or live-identity mismatch.
 */
export async function adoptOrReplan(
  deps: FactoryStoreDeps,
  request: AdoptRequest,
): Promise<FactoryExecutionContractRevision> {
  const factoryRunId = request.factory_run_id;
  assertSafeRunId(factoryRunId);

  // Live identity precondition
  if (
    request.live_repo.name !== request.body.repo.name ||
    request.live_repo.base_branch !== request.body.repo.base_branch ||
    request.live_repo.observed_base_sha !== request.body.repo.observed_base_sha
  ) {
    throw new FactoryError(
      "conflict",
      `live repository identity does not match replan/adopt body ` +
        `(live ${request.live_repo.name}@${request.live_repo.observed_base_sha}, ` +
        `body ${request.body.repo.name}@${request.body.repo.observed_base_sha})`,
    );
  }

  const identities = validateFactoryIdentities(request.body.identities, {
    factoryModeEnabled: request.factoryModeEnabled !== false,
  });

  const dir = factoryRunDir(deps, factoryRunId);
  await deps.mkdirp(path.join(dir, "revisions"));
  await deps.mkdirp(path.join(dir, "claims"));

  const current = await readCurrentPointer(deps, factoryRunId);
  const expected = request.expected_revision;

  if (expected === null) {
    if (current !== null) {
      throw new FactoryError(
        "conflict",
        `factory run "${factoryRunId}" already has current revision ${current.revision} — replan with expected_revision`,
      );
    }
  } else {
    if (!current || current.revision !== expected) {
      throw new FactoryError(
        "conflict",
        `stale expected revision ${expected}: current is ${current?.revision ?? "absent"}`,
      );
    }
  }

  const priorRevision = current?.revision ?? null;
  const priorHash = current?.canonical_hash ?? null;
  const newRevision = priorRevision === null ? 1 : priorRevision + 1;

  if (priorRevision !== null && !request.body.live_state_reason) {
    throw new FactoryError(
      "validation",
      "replan requires a live_state_reason",
    );
  }

  await refuseRevisionOverwrite(deps, factoryRunId, newRevision);

  const body: FactoryExecutionContractBody = {
    schema: FACTORY_CONTRACT_SCHEMA,
    factory_run_id: factoryRunId,
    revision: newRevision,
    repo: { ...request.body.repo },
    selector: { ...request.body.selector },
    issue_ids: [...request.body.issue_ids],
    pr_ids: [...request.body.pr_ids],
    milestones: [...request.body.milestones],
    dependency_edges: request.body.dependency_edges.map((e) => ({ ...e })),
    linked_runs: { ...request.body.linked_runs },
    identities,
    fingerprints: { ...request.body.fingerprints },
    coarse_phase: request.body.coarse_phase,
    completion_policy: request.body.completion_policy,
    next_action: request.body.next_action,
    prior_revision: priorRevision,
    prior_canonical_hash: priorHash,
    live_state_reason: request.body.live_state_reason,
    accepted_at: deps.now().toISOString(),
  };

  const canonical_hash = computeFactoryCanonicalHash(body);
  const revisionDoc: FactoryExecutionContractRevision = { ...body, canonical_hash };

  // Write revision first (immutable document). Exclusive create refuses overwrite.
  const revPath = revisionPath(dir, newRevision);
  const created = await deps.createFileExclusive(
    revPath,
    JSON.stringify(revisionDoc, null, 2),
  );
  if (!created) {
    throw new FactoryError(
      "conflict",
      `factory run "${factoryRunId}" revision ${newRevision} already exists`,
    );
  }

  // CAS current pointer: exclusive create for first adopt; for replan, verify
  // expected still matches then atomic write. Re-read before write for races.
  const pointer: FactoryCurrentPointer = {
    schema: FACTORY_CURRENT_SCHEMA,
    factory_run_id: factoryRunId,
    revision: newRevision,
    canonical_hash,
    updated_at: deps.now().toISOString(),
  };
  const curPath = currentPath(dir);

  if (expected === null) {
    const ok = await deps.createFileExclusive(curPath, JSON.stringify(pointer, null, 2));
    if (!ok) {
      // Concurrent first adopt won — leave revision file (retained history) but
      // do not leave a hybrid current. Reader of current sees the winner only.
      throw new FactoryError(
        "conflict",
        `factory run "${factoryRunId}" was adopted concurrently`,
      );
    }
  } else {
    const still = await readCurrentPointer(deps, factoryRunId);
    if (!still || still.revision !== expected) {
      throw new FactoryError(
        "conflict",
        `stale expected revision ${expected} at CAS write (current ${still?.revision ?? "absent"})`,
      );
    }
    await deps.writeFileAtomic(curPath, JSON.stringify(pointer, null, 2));
  }

  await appendEvent(deps, factoryRunId, expected === null ? "factory_adopted" : "factory_replanned", {
    revision: newRevision,
    canonical_hash,
    prior_revision: priorRevision,
    service_controller: identities.service_controller,
    live_state_reason: body.live_state_reason,
  });

  return revisionDoc;
}

// ---------------------------------------------------------------------------
// Claims (claim-before-side-effect, at-most-once)
// ---------------------------------------------------------------------------

export function actionIdFor(
  revision: number,
  action: FactoryNextAction,
  disambiguator = "0",
): string {
  return `r${revision}-${action}-${disambiguator}`;
}

export async function readClaim(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  actionId: string,
): Promise<FactoryActionClaim | null> {
  assertSafeActionId(actionId);
  const text = await deps.readTextFile(claimPath(factoryRunDir(deps, factoryRunId), actionId));
  if (!text) return null;
  return JSON.parse(text) as FactoryActionClaim;
}

export async function listClaims(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryActionClaim[]> {
  const dir = path.join(factoryRunDir(deps, factoryRunId), "claims");
  let names: string[];
  try {
    names = await deps.listDir(dir);
  } catch {
    return [];
  }
  const out: FactoryActionClaim[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = await deps.readTextFile(path.join(dir, name));
    if (!text) continue;
    try {
      out.push(JSON.parse(text) as FactoryActionClaim);
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => a.claimed_at.localeCompare(b.claimed_at));
}

/**
 * Create a claim exclusively. Returns the claim when this caller won; returns
 * the existing claim when another tick already claimed (no second dispatch).
 */
export async function claimAction(
  deps: FactoryStoreDeps,
  input: {
    factory_run_id: string;
    revision: number;
    action_id: string;
    action: FactoryNextAction;
    /** Five distinct control identities from the authorizing revision. */
    identities: FactoryControlIdentities;
  },
): Promise<{ claim: FactoryActionClaim; won: boolean }> {
  assertSafeActionId(input.action_id);
  const dir = factoryRunDir(deps, input.factory_run_id);
  await deps.mkdirp(path.join(dir, "claims"));

  const now = deps.now().toISOString();
  const ids = input.identities;
  const claim: FactoryActionClaim = {
    schema: FACTORY_CLAIM_SCHEMA,
    factory_run_id: input.factory_run_id,
    revision: input.revision,
    action_id: input.action_id,
    action: input.action,
    state: "claimed",
    service_controller: ids.service_controller,
    outer_host: ids.outer_host,
    implementer_treatment: ids.implementer_treatment,
    reviewer_treatment: ids.reviewer_treatment,
    privileged_mutation_actor: ids.privileged_mutation_actor,
    claimed_at: now,
    updated_at: now,
    child_run_id: null,
    outcome_detail: null,
  };

  const p = claimPath(dir, input.action_id);
  const created = await deps.createFileExclusive(p, JSON.stringify(claim, null, 2));
  if (!created) {
    const existing = await readClaim(deps, input.factory_run_id, input.action_id);
    if (!existing) {
      throw new FactoryError(
        "conflict",
        `claim "${input.action_id}" exists but could not be read`,
      );
    }
    return { claim: existing, won: false };
  }

  await appendEvent(deps, input.factory_run_id, "factory_action_claimed", {
    action_id: input.action_id,
    action: input.action,
    revision: input.revision,
    service_controller: ids.service_controller,
    outer_host: ids.outer_host,
    implementer_treatment: ids.implementer_treatment,
    reviewer_treatment: ids.reviewer_treatment,
    privileged_mutation_actor: ids.privileged_mutation_actor,
  });

  return { claim, won: true };
}

/**
 * Exclusive dispatch lease so concurrent ticks that lost the claim create (or
 * restarted after claim) dispatch a child at most once. Lease file:
 * `claims/<actionId>.dispatch`.
 */
export async function tryAcquireDispatchLease(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  actionId: string,
): Promise<boolean> {
  assertSafeActionId(actionId);
  const dir = factoryRunDir(deps, factoryRunId);
  await deps.mkdirp(path.join(dir, "claims"));
  const p = path.join(dir, "claims", `${actionId}.dispatch`);
  return deps.createFileExclusive(
    p,
    JSON.stringify({ action_id: actionId, at: deps.now().toISOString() }, null, 2),
  );
}

/**
 * Acquire a new dispatch lease, or recover an unfinished lease when the claim
 * has no durable child_run_id yet. Recovery re-dispatches with the same
 * action_id (idempotency key) so a crash between child creation and claim
 * update cannot permanently strand the action.
 */
export async function tryAcquireOrRecoverDispatchLease(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  actionId: string,
  claim: FactoryActionClaim,
): Promise<{ acquired: boolean; recovered: boolean }> {
  const won = await tryAcquireDispatchLease(deps, factoryRunId, actionId);
  if (won) return { acquired: true, recovered: false };
  // Unfinished lease: claim exists without a durable child link — safe to
  // re-enter start with the same action_id as the idempotency key.
  if (
    !claim.child_run_id &&
    (claim.state === "claimed" || claim.state === "started")
  ) {
    return { acquired: true, recovered: true };
  }
  return { acquired: false, recovered: false };
}

export async function updateClaim(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  actionId: string,
  patch: {
    state: FactoryClaimState;
    child_run_id?: string | null;
    outcome_detail?: string | null;
  },
): Promise<FactoryActionClaim> {
  const existing = await readClaim(deps, factoryRunId, actionId);
  if (!existing) {
    throw new FactoryError("not_found", `claim "${actionId}" not found for factory run "${factoryRunId}"`);
  }
  const now = deps.now().toISOString();
  const updated: FactoryActionClaim = {
    ...existing,
    state: patch.state,
    child_run_id: patch.child_run_id !== undefined ? patch.child_run_id : existing.child_run_id,
    outcome_detail:
      patch.outcome_detail !== undefined ? patch.outcome_detail : existing.outcome_detail,
    updated_at: now,
    completed_at:
      patch.state === "completed" || patch.state === "failed" ? now : existing.completed_at,
  };
  await deps.writeFileAtomic(
    claimPath(factoryRunDir(deps, factoryRunId), actionId),
    JSON.stringify(updated, null, 2),
  );
  await appendEvent(deps, factoryRunId, "factory_action_updated", {
    action_id: actionId,
    state: patch.state,
    revision: existing.revision,
    service_controller: existing.service_controller,
    child_run_id: updated.child_run_id ?? null,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Lock (host-local, single-host concurrency scope)
// ---------------------------------------------------------------------------

export async function readFactoryLock(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryLockRecord | null> {
  const text = await deps.readTextFile(lockPath(factoryRunDir(deps, factoryRunId)));
  if (!text) return null;
  return JSON.parse(text) as FactoryLockRecord;
}

export async function acquireFactoryLock(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryLockRecord> {
  const dir = factoryRunDir(deps, factoryRunId);
  await deps.mkdirp(dir);
  const existing = await readFactoryLock(deps, factoryRunId);
  if (existing) {
    if (await deps.isPidAlive(existing.holder_pid)) {
      throw new FactoryError(
        "lock",
        `factory run "${factoryRunId}" lock held by pid ${existing.holder_pid} on ${existing.hostname}`,
      );
    }
    // Stale: remove only if content matches what we observed.
    await deps.removeFileIfMatches(
      lockPath(dir),
      JSON.stringify(existing, null, 2),
    );
  }
  const record: FactoryLockRecord = {
    schema: FACTORY_LOCK_SCHEMA,
    factory_run_id: factoryRunId,
    token: deps.uuid(),
    holder_pid: deps.pid(),
    hostname: deps.hostname(),
    acquired_at: deps.now().toISOString(),
  };
  const ok = await deps.createFileExclusive(lockPath(dir), JSON.stringify(record, null, 2));
  if (!ok) {
    throw new FactoryError("lock", `factory run "${factoryRunId}" lock raced — try again`);
  }
  return record;
}

export async function releaseFactoryLock(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  token: string,
): Promise<void> {
  const existing = await readFactoryLock(deps, factoryRunId);
  if (!existing) return;
  if (existing.token !== token) {
    throw new FactoryError("lock", `factory lock token mismatch for "${factoryRunId}"`);
  }
  await deps.removeFileIfMatches(
    lockPath(factoryRunDir(deps, factoryRunId)),
    JSON.stringify(existing, null, 2),
  );
}

export async function requireFactoryLockToken(
  deps: FactoryStoreDeps,
  factoryRunId: string,
  token: string,
): Promise<void> {
  const existing = await readFactoryLock(deps, factoryRunId);
  if (!existing || existing.token !== token) {
    throw new FactoryError("lock", `factory lock token required for "${factoryRunId}"`);
  }
}

// ---------------------------------------------------------------------------
// Phase evidence (durable posture for read-only status)
// ---------------------------------------------------------------------------

export async function readPhaseEvidence(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryPhaseEvidence | null> {
  const text = await deps.readTextFile(phaseEvidencePath(factoryRunDir(deps, factoryRunId)));
  if (!text) return null;
  return JSON.parse(text) as FactoryPhaseEvidence;
}

/**
 * Persist the last reconciled coarse phase / next action. Overwrites prior
 * evidence for the run (reconstructible from the latest record + claims).
 * Does not mutate contract revisions.
 */
export async function writePhaseEvidence(
  deps: FactoryStoreDeps,
  evidence: Omit<FactoryPhaseEvidence, "schema" | "recorded_at"> & {
    recorded_at?: string;
  },
): Promise<FactoryPhaseEvidence> {
  const dir = factoryRunDir(deps, evidence.factory_run_id);
  await deps.mkdirp(dir);
  const doc: FactoryPhaseEvidence = {
    schema: FACTORY_PHASE_EVIDENCE_SCHEMA,
    factory_run_id: evidence.factory_run_id,
    revision: evidence.revision,
    coarse_phase: evidence.coarse_phase,
    next_action: evidence.next_action,
    reason: evidence.reason,
    service_controller: evidence.service_controller,
    outer_host: evidence.outer_host,
    implementer_treatment: evidence.implementer_treatment,
    reviewer_treatment: evidence.reviewer_treatment,
    privileged_mutation_actor: evidence.privileged_mutation_actor,
    recorded_at: evidence.recorded_at ?? deps.now().toISOString(),
    child_disposition: evidence.child_disposition ?? null,
    replan_reason: evidence.replan_reason ?? null,
  };
  await deps.writeFileAtomic(phaseEvidencePath(dir), JSON.stringify(doc, null, 2));
  await appendEvent(deps, evidence.factory_run_id, "factory_phase_evidence", {
    revision: doc.revision,
    coarse_phase: doc.coarse_phase,
    next_action: doc.next_action,
    reason: doc.reason,
    service_controller: doc.service_controller,
    outer_host: doc.outer_host,
    implementer_treatment: doc.implementer_treatment,
    reviewer_treatment: doc.reviewer_treatment,
    privileged_mutation_actor: doc.privileged_mutation_actor,
    replan_reason: doc.replan_reason ?? null,
    child_disposition: doc.child_disposition ?? null,
  });
  return doc;
}

// ---------------------------------------------------------------------------
// Read-only status (non-mutating)
// ---------------------------------------------------------------------------

export async function getFactoryStatus(
  deps: FactoryStoreDeps,
  factoryRunId: string,
): Promise<FactoryStatus | null> {
  const rev = await readCurrentRevision(deps, factoryRunId);
  if (!rev) return null;
  const claims = await listClaims(deps, factoryRunId);
  const lock = await readFactoryLock(deps, factoryRunId);
  const phase_evidence = await readPhaseEvidence(deps, factoryRunId);
  // Prefer durable phase evidence for the current revision when present so
  // read-only status reconstructs post-tick posture without live observation.
  const useEvidence =
    phase_evidence && phase_evidence.revision === rev.revision ? phase_evidence : null;
  return {
    factory_run_id: factoryRunId,
    revision: rev.revision,
    canonical_hash: rev.canonical_hash,
    coarse_phase: useEvidence?.coarse_phase ?? rev.coarse_phase,
    next_action: useEvidence?.next_action ?? rev.next_action,
    completion_policy: rev.completion_policy,
    identities: rev.identities,
    linked_runs: rev.linked_runs,
    claims,
    lock,
    phase_evidence: phase_evidence,
  };
}

// ---------------------------------------------------------------------------
// Production deps
// ---------------------------------------------------------------------------

export function defaultFactoryStoreDeps(env: NodeJS.ProcessEnv = process.env): FactoryStoreDeps {
  return {
    async fsExists(p) {
      return fs.existsSync(p);
    },
    async readTextFile(p) {
      try {
        return await fs.promises.readFile(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async writeFileAtomic(p, content) {
      const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${crypto.randomUUID()}.tmp`);
      const fh = await fs.promises.open(tmp, "wx");
      try {
        await fh.writeFile(content, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fs.promises.rename(tmp, p);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    },
    async createFileExclusive(p, content) {
      let fh;
      try {
        fh = await fs.promises.open(p, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
      try {
        await fh.writeFile(content, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      return true;
    },
    async removeFile(p) {
      await fs.promises.rm(p, { force: true });
    },
    async removeFileIfMatches(p, expectedContent) {
      const claim = `${p}.claim-${crypto.randomUUID()}`;
      try {
        await fs.promises.rename(p, claim);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
      let claimed: string | null;
      try {
        claimed = await fs.promises.readFile(claim, "utf8");
      } catch {
        claimed = null;
      }
      if (claimed === expectedContent) {
        await fs.promises.rm(claim, { force: true });
        return true;
      }
      try {
        await fs.promises.link(claim, p);
      } catch {
        /* best-effort restore */
      }
      await fs.promises.rm(claim, { force: true });
      return false;
    },
    async appendLine(p, line) {
      await fs.promises.appendFile(p, `${line}\n`, "utf8");
    },
    async mkdirp(p) {
      await fs.promises.mkdir(p, { recursive: true });
    },
    async listDir(p) {
      try {
        return await fs.promises.readdir(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
    async isPidAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    hostname: () => os.hostname(),
    pid: () => process.pid,
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    env,
  };
}
