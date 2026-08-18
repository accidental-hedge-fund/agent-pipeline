// Pipeline-owned release shipment coordinator.
//
// This module is deliberately only a coordinator. It does not supervise a
// process, poll Buzz, schedule work, merge directly, or duplicate stage logic.
// Each injected `converge*` seam must reconcile and then drive its existing
// Pipeline capability to the typed terminal evidence it returns. The explicit
// `reconcile` pass makes a rerun safe after a crash between an external side
// effect and the local atomic status write.

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";

export const SHIP_SCHEMA_VERSION = 1;
export const SHIP_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** Stable identity for operator `pipeline ship --milestone` (no grant document). */
export const OPERATOR_SHIP_SENDER = "operator-cli";
export const OPERATOR_SHIP_FINGERPRINT = "operator-milestone";
export const OPERATOR_SHIP_EVENT_ID = "0".repeat(64);

export function operatorShipIntent(coordinates: ShipCoordinates): ShipIntent {
  return {
    repository: coordinates.repository,
    base_branch: coordinates.base_branch,
    milestone: coordinates.milestone,
    version: coordinates.version,
    event_id: OPERATOR_SHIP_EVENT_ID,
    sender_id: OPERATOR_SHIP_SENDER,
    channel_id: OPERATOR_SHIP_SENDER,
    thread_id: OPERATOR_SHIP_SENDER,
  };
}

export const SHIP_AUTHORIZED_ACTIONS = [
  "train_merge",
  "frg",
  "release_prepare",
  "release_finish",
  "engine_promote",
] as const;

export type ShipAuthorizedAction = (typeof SHIP_AUTHORIZED_ACTIONS)[number];

export interface ShipIntent {
  repository: string;
  base_branch: string;
  milestone: string;
  version: string;
  event_id: string;
  sender_id: string;
  channel_id: string;
  thread_id: string;
}

export type ShipCoordinates = Pick<
  ShipIntent,
  "repository" | "base_branch" | "milestone" | "version"
>;

/**
 * Immutable grant emitted only after the Buzz gateway authenticates the
 * operator event. `fingerprint` detects field mutation across the gateway and
 * host handoff; it is not a second signature or secret scheme.
 */
export interface BuzzShipAuthorization extends ShipIntent {
  schema_version: 1;
  kind: "ship_authorization";
  issued_at: string;
  expires_at: string;
  actions: ShipAuthorizedAction[];
  fingerprint: string;
  /** Ed25519 signature over the canonical authorization payload. */
  signature: string;
}

export type ShipNextAction =
  | "train_merge"
  | "frg_pack"
  | "frg_score"
  | "release_prepare"
  | "release_finish"
  | "release_wait"
  | "engine_promote"
  | "complete";

export interface ShipTrainPlan {
  ordered_issues: number[];
}

export interface ShipTrainEvidence {
  repository: string;
  base_branch: string;
  milestone: string;
  complete: true;
  ordered_issues: number[];
  run_id: string | null;
  integrated_head_oid: string;
  /** Time this ship observed the complete train at the exact integrated head. */
  completed_at: string;
}

export interface ShipFrgPackEvidence {
  version: string;
  complete: true;
  loop_run_id: string;
  pack_id: string;
  candidate_head_oid: string;
}

export interface ShipFrgEvidence {
  version: string;
  pass: true;
  loop_run_id: string;
  frg_run_id: string;
  candidate_head_oid: string;
}

export interface ShipReleaseEvidence {
  repository: string;
  base_branch: string;
  version: string;
  pr: number;
  head_oid: string;
  candidate_head_oid: string;
}

export interface ShipReleaseFinishEvidence extends ShipReleaseEvidence {
  merged: true;
  merge_commit_oid: string;
}

export interface ShipPublicationEvidence {
  version: string;
  tag: string;
  published: true;
}

export interface ShipPromotionEvidence {
  version: string;
  tag: string;
  verified: true;
  installed_version: string;
}

export interface ShipProgress {
  train: ShipTrainEvidence | null;
  frg_pack: ShipFrgPackEvidence | null;
  frg: ShipFrgEvidence | null;
  release: ShipReleaseEvidence | null;
  release_finish: ShipReleaseFinishEvidence | null;
  publication: ShipPublicationEvidence | null;
  promotion: ShipPromotionEvidence | null;
}

export interface ShipStatus extends ShipProgress {
  schema_version: 1;
  kind: "ship_status";
  ship_key: string;
  run_id: string;
  intent: ShipIntent;
  authorization_fingerprint: string;
  authorized_at: string;
  authorization_expires_at: string;
  events_file: string;
  /** Frozen before the first train mutation; milestone reconciliation cannot expand it. */
  train_plan: ShipTrainPlan | null;
  revision: number;
  next_action: ShipNextAction;
  complete: boolean;
  updated_at: string;
  last_error: string | null;
  /** True when the current stop is human authority (hosts must not re-invoke). */
  human_authority?: boolean;
  current_item?: number | null;
  last_durable_stage?: string | null;
}

export interface ShipPhaseEvent {
  schema_version: 1;
  kind: "ship_phase";
  run_id: string;
  event_id: string;
  at: string;
  phase: ShipNextAction;
  status: "started" | "completed" | "failed" | "reconciled";
  detail: string | null;
}

/** A complete external-truth snapshot. Null means the stage is not complete. */
export type ShipReconciliation = ShipProgress;

export interface ShipStateStore {
  statusFile(shipKey: string): string;
  eventsFile(shipKey: string): string;
  read(shipKey: string): Promise<ShipStatus | null>;
  writeAtomic(shipKey: string, status: ShipStatus): Promise<void>;
  appendEvent(shipKey: string, event: ShipPhaseEvent): Promise<void>;
}

export interface ShipCoordinatorDeps {
  now(): Date;
  state: ShipStateStore;
  /** Trusted machine-local Ed25519 public key provisioned outside the repository. */
  authorizationPublicKey: string;
  /** Serialize one release coordinate across direct and systemd-managed callers. */
  withRunLock<T>(shipKey: string, fn: () => Promise<T>): Promise<T>;
  /** Observe GitHub/Pipeline truth before trusting restart progress. */
  reconcile(intent: ShipIntent, checkpoint: ShipStatus): Promise<ShipReconciliation>;
  /** Resolve milestone membership once, before the first train mutation. */
  planTrain(intent: ShipIntent): Promise<ShipTrainPlan>;
  /** Each converge seam must re-observe its relevant external identity before mutation. */
  convergeTrain(intent: ShipIntent, plannedIssues: readonly number[]): Promise<ShipTrainEvidence>;
  convergeFrgPack(intent: ShipIntent, train: ShipTrainEvidence): Promise<ShipFrgPackEvidence>;
  convergeFrgScore(intent: ShipIntent, pack: ShipFrgPackEvidence): Promise<ShipFrgEvidence>;
  convergeReleasePrepare(intent: ShipIntent, frg: ShipFrgEvidence): Promise<ShipReleaseEvidence>;
  convergeReleaseFinish(intent: ShipIntent, release: ShipReleaseEvidence): Promise<ShipReleaseFinishEvidence>;
  waitForRelease(intent: ShipIntent, release: ShipReleaseFinishEvidence): Promise<ShipPublicationEvidence>;
  convergeEnginePromote(intent: ShipIntent, publication: ShipPublicationEvidence): Promise<ShipPromotionEvidence>;
}

const AUTHORIZATION_KEYS = [
  "schema_version",
  "kind",
  "event_id",
  "sender_id",
  "channel_id",
  "thread_id",
  "repository",
  "base_branch",
  "milestone",
  "version",
  "issued_at",
  "expires_at",
  "actions",
  "fingerprint",
  "signature",
] as const;

const EMPTY_PROGRESS: ShipProgress = {
  train: null,
  frg_pack: null,
  frg: null,
  release: null,
  release_finish: null,
  publication: null,
  promotion: null,
};

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`ship authorization: ${field} must be a non-empty string without control characters`);
  }
  return value.trim();
}

function normalizeIntent(raw: ShipIntent): ShipIntent {
  const repository = requireNonEmpty(raw.repository, "repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("ship authorization: repository must be owner/name");
  }
  const baseBranch = requireNonEmpty(raw.base_branch, "base_branch");
  if (/\s/.test(baseBranch)) throw new Error("ship authorization: base_branch must not contain whitespace");
  const milestone = requireNonEmpty(raw.milestone, "milestone");
  const version = requireNonEmpty(raw.version, "version").replace(/^[vV]/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("ship authorization: version must be X.Y.Z");
  }
  const eventId = requireNonEmpty(raw.event_id, "event_id").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(eventId)) {
    throw new Error("ship authorization: event_id must be 64 lowercase hex characters");
  }
  const senderId = requireNonEmpty(raw.sender_id, "sender_id");
  const channelId = requireNonEmpty(raw.channel_id, "channel_id");
  const threadId = requireNonEmpty(raw.thread_id, "thread_id");
  return {
    repository,
    base_branch: baseBranch,
    milestone,
    version,
    event_id: eventId,
    sender_id: senderId,
    channel_id: channelId,
    thread_id: threadId,
  };
}

function canonicalTimestamp(value: unknown, field: string): string {
  const text = requireNonEmpty(value, field);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`ship authorization: ${field} must be a canonical UTC timestamp`);
  }
  return text;
}

export type UnsignedBuzzShipAuthorization = Omit<
  BuzzShipAuthorization,
  "fingerprint" | "signature"
>;

function canonicalAuthorizationPayload(auth: UnsignedBuzzShipAuthorization): string {
  return JSON.stringify({
    schema_version: auth.schema_version,
    kind: auth.kind,
    event_id: auth.event_id,
    sender_id: auth.sender_id,
    channel_id: auth.channel_id,
    thread_id: auth.thread_id,
    repository: auth.repository,
    base_branch: auth.base_branch,
    milestone: auth.milestone,
    version: auth.version,
    issued_at: auth.issued_at,
    expires_at: auth.expires_at,
    actions: auth.actions,
  });
}

export function shipAuthorizationFingerprint(
  auth: UnsignedBuzzShipAuthorization,
): string {
  return crypto.createHash("sha256").update(canonicalAuthorizationPayload(auth)).digest("hex");
}

export function shipAuthorizationSigningPayload(
  auth: UnsignedBuzzShipAuthorization,
): Buffer {
  return Buffer.from(canonicalAuthorizationPayload(auth), "utf8");
}

function verifyAuthorizationSignature(
  unsigned: UnsignedBuzzShipAuthorization,
  signatureText: unknown,
  trustedPublicKey: string,
): string {
  const signature = requireNonEmpty(signatureText, "signature");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature)) {
    throw new Error("ship authorization: signature must be canonical base64");
  }
  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== signature) {
    throw new Error("ship authorization: signature must be one canonical Ed25519 signature");
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(trustedPublicKey);
  } catch {
    throw new Error("ship authorization: trusted public key is invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("ship authorization: trusted public key must use Ed25519");
  }
  if (!crypto.verify(null, shipAuthorizationSigningPayload(unsigned), publicKey, decoded)) {
    throw new Error("ship authorization: signature does not match the trusted gateway key");
  }
  return signature;
}

/** Validate the gateway-authenticated grant and bind it to this exact request. */
export function validateBuzzShipAuthorization(
  raw: unknown,
  expectedRaw: ShipIntent,
  now: Date,
  trustedPublicKey: string,
): BuzzShipAuthorization {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("ship authorization: expected an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...AUTHORIZATION_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
    throw new Error("ship authorization: document has missing or unknown fields");
  }
  if (record.schema_version !== SHIP_SCHEMA_VERSION || record.kind !== "ship_authorization") {
    throw new Error("ship authorization: unsupported schema_version or kind");
  }

  const intent = normalizeIntent(record as unknown as ShipIntent);
  const expected = normalizeIntent(expectedRaw);
  for (const key of [
    "repository", "base_branch", "milestone", "version", "event_id",
    "sender_id", "channel_id", "thread_id",
  ] as const) {
    if (record[key] !== intent[key]) {
      throw new Error(`ship authorization: ${key} must use its canonical form`);
    }
  }
  for (const key of [
    "repository", "base_branch", "milestone", "version", "event_id",
    "sender_id", "channel_id", "thread_id",
  ] as const) {
    if (intent[key] !== expected[key]) {
      throw new Error(`ship authorization: ${key} does not match the requested shipment`);
    }
  }

  if (!Array.isArray(record.actions) ||
      record.actions.length !== SHIP_AUTHORIZED_ACTIONS.length ||
      record.actions.some((action, i) => action !== SHIP_AUTHORIZED_ACTIONS[i])) {
    throw new Error("ship authorization: actions must match the exact ordered ship action list");
  }
  const issuedAt = canonicalTimestamp(record.issued_at, "issued_at");
  const expiresAt = canonicalTimestamp(record.expires_at, "expires_at");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = now.getTime();
  if (expiresMs <= issuedMs || expiresMs - issuedMs > SHIP_AUTHORIZATION_TTL_MS) {
    throw new Error("ship authorization: expiry must be after issue time and within seven days");
  }
  if (nowMs < issuedMs) throw new Error("ship authorization: grant is not active yet");
  if (nowMs >= expiresMs) throw new Error("ship authorization: grant has expired");

  const unsigned: UnsignedBuzzShipAuthorization = {
    schema_version: 1,
    kind: "ship_authorization",
    ...intent,
    issued_at: issuedAt,
    expires_at: expiresAt,
    actions: [...SHIP_AUTHORIZED_ACTIONS],
  };
  const fingerprint = requireNonEmpty(record.fingerprint, "fingerprint").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint) ||
      fingerprint !== shipAuthorizationFingerprint(unsigned)) {
    throw new Error("ship authorization: fingerprint does not match the immutable grant fields");
  }
  const signature = verifyAuthorizationSignature(unsigned, record.signature, trustedPublicKey);
  return { ...unsigned, fingerprint, signature };
}

export function shipRunId(intentRaw: ShipIntent): string {
  const intent = normalizeIntent(intentRaw);
  const coordinate = JSON.stringify([
    intent.event_id,
    intent.sender_id,
    intent.channel_id,
    intent.thread_id,
    intent.repository,
    intent.base_branch,
    intent.milestone,
    intent.version,
  ]);
  return `ship-${crypto.createHash("sha256").update(coordinate).digest("hex").slice(0, 24)}`;
}

/** Stable admission/status key: one ledger for one exact release coordinate. */
export function shipKey(coordinatesRaw: ShipCoordinates): string {
  const intent = normalizeIntent({
    ...coordinatesRaw,
    event_id: "0".repeat(64),
    sender_id: "coordinate-key",
    channel_id: "coordinate-key",
    thread_id: "coordinate-key",
  });
  const coordinate = JSON.stringify([
    intent.repository,
    intent.base_branch,
    intent.milestone,
    intent.version,
  ]);
  return `ship-${crypto.createHash("sha256").update(coordinate).digest("hex").slice(0, 24)}`;
}

/** One host-local writer for all shipments that target the same repository/base. */
export function shipBaseLockKey(coordinatesRaw: ShipCoordinates): string {
  const intent = normalizeIntent({
    ...coordinatesRaw,
    event_id: "0".repeat(64),
    sender_id: "base-lock",
    channel_id: "base-lock",
    thread_id: "base-lock",
  });
  const coordinate = JSON.stringify([intent.repository, intent.base_branch]);
  return `ship-base-${crypto.createHash("sha256").update(coordinate).digest("hex").slice(0, 24)}`;
}

function expectedTag(version: string): string {
  return `v${version}`;
}

function requireOid(value: string, field: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`ship reconciliation: ${field} must be a 40-character git OID`);
}

function validateTrainPlan(plan: ShipTrainPlan): ShipTrainPlan {
  if (!plan || !Array.isArray(plan.ordered_issues) || plan.ordered_issues.length === 0) {
    throw new Error("ship train plan: ordered_issues must be a non-empty array");
  }
  const seen = new Set<number>();
  for (const issue of plan.ordered_issues) {
    if (!Number.isSafeInteger(issue) || issue <= 0) {
      throw new Error("ship train plan: ordered_issues must contain only positive issue IDs");
    }
    if (seen.has(issue)) throw new Error(`ship train plan: duplicate issue #${issue}`);
    seen.add(issue);
  }
  return { ordered_issues: [...plan.ordered_issues] };
}

function sameIssueOrder(actual: readonly number[], planned: readonly number[]): boolean {
  return actual.length === planned.length && actual.every((issue, index) => issue === planned[index]);
}

function validateProgress(
  progress: ShipProgress,
  intent: ShipIntent,
  trainPlan: ShipTrainPlan | null,
): void {
  if (progress.train) {
    if (!progress.train.complete || progress.train.repository.toLowerCase() !== intent.repository ||
        progress.train.base_branch !== intent.base_branch || progress.train.milestone !== intent.milestone ||
        progress.train.ordered_issues.length === 0 ||
        progress.train.ordered_issues.some((issue) => !Number.isSafeInteger(issue) || issue <= 0)) {
      throw new Error("ship reconciliation: train evidence does not match the shipment");
    }
    if (!trainPlan || !sameIssueOrder(progress.train.ordered_issues, trainPlan.ordered_issues)) {
      throw new Error("ship reconciliation: train issue order does not match the frozen train plan");
    }
    requireOid(progress.train.integrated_head_oid, "train integrated_head_oid");
    const completedAt = new Date(progress.train.completed_at);
    if (!Number.isFinite(completedAt.getTime()) || completedAt.toISOString() !== progress.train.completed_at) {
      throw new Error("ship reconciliation: train completed_at must be a canonical UTC timestamp");
    }
  }
  if (progress.frg_pack) {
    if (!progress.train || !progress.frg_pack.complete || progress.frg_pack.version !== intent.version ||
        !progress.frg_pack.loop_run_id || !progress.frg_pack.pack_id) {
      throw new Error("ship reconciliation: FRG pack evidence is incomplete or out of order");
    }
    requireOid(progress.frg_pack.candidate_head_oid, "FRG pack candidate_head_oid");
    if (progress.frg_pack.candidate_head_oid !== progress.train.integrated_head_oid) {
      throw new Error("ship reconciliation: FRG pack candidate does not match the integrated train head");
    }
  }
  if (progress.frg) {
    if (!progress.frg_pack || !progress.frg.pass || progress.frg.version !== intent.version ||
        progress.frg.loop_run_id !== progress.frg_pack.loop_run_id || !progress.frg.frg_run_id) {
      throw new Error("ship reconciliation: FRG score evidence is incomplete or mismatched");
    }
    requireOid(progress.frg.candidate_head_oid, "FRG candidate_head_oid");
    if (progress.frg.candidate_head_oid !== progress.frg_pack.candidate_head_oid) {
      throw new Error("ship reconciliation: FRG score candidate does not match the fixed pack candidate");
    }
  }
  if (progress.release) {
    if (!progress.frg || progress.release.repository.toLowerCase() !== intent.repository ||
        progress.release.base_branch !== intent.base_branch || progress.release.version !== intent.version ||
        !Number.isSafeInteger(progress.release.pr) || progress.release.pr <= 0) {
      throw new Error("ship reconciliation: release evidence does not match the shipment");
    }
    requireOid(progress.release.head_oid, "release head_oid");
    requireOid(progress.release.candidate_head_oid, "release candidate_head_oid");
    if (progress.release.candidate_head_oid !== progress.frg.candidate_head_oid) {
      throw new Error("ship reconciliation: release candidate does not match the FRG candidate");
    }
  }
  if (progress.release_finish) {
    if (!progress.release || !progress.release_finish.merged ||
        progress.release_finish.pr !== progress.release.pr ||
        progress.release_finish.head_oid !== progress.release.head_oid ||
        progress.release_finish.candidate_head_oid !== progress.release.candidate_head_oid ||
        progress.release_finish.version !== intent.version ||
        progress.release_finish.base_branch !== intent.base_branch) {
      throw new Error("ship reconciliation: release finish evidence does not match the prepared release");
    }
    requireOid(progress.release_finish.merge_commit_oid, "release merge_commit_oid");
  }
  if (progress.publication) {
    if (!progress.release_finish || !progress.publication.published ||
        progress.publication.version !== intent.version || progress.publication.tag !== expectedTag(intent.version)) {
      throw new Error("ship reconciliation: publication evidence does not match the release");
    }
  }
  if (progress.promotion) {
    if (!progress.publication || !progress.promotion.verified ||
        progress.promotion.version !== intent.version || progress.promotion.tag !== expectedTag(intent.version) ||
        progress.promotion.installed_version !== intent.version) {
      throw new Error("ship reconciliation: engine promotion does not match the published release");
    }
  }
}

function nextAction(progress: ShipProgress): ShipNextAction {
  if (!progress.train) return "train_merge";
  if (!progress.frg_pack) return "frg_pack";
  if (!progress.frg) return "frg_score";
  if (!progress.release) return "release_prepare";
  if (!progress.release_finish) return "release_finish";
  if (!progress.publication) return "release_wait";
  if (!progress.promotion) return "engine_promote";
  return "complete";
}

function sameIntent(a: ShipIntent, b: ShipIntent): boolean {
  return a.repository === b.repository && a.base_branch === b.base_branch &&
    a.milestone === b.milestone && a.version === b.version && a.event_id === b.event_id &&
    a.sender_id === b.sender_id && a.channel_id === b.channel_id && a.thread_id === b.thread_id;
}

function parseStatus(raw: unknown): ShipStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ship status is not an object");
  const status = raw as ShipStatus;
  if (status.schema_version !== 1 || status.kind !== "ship_status" || !Number.isSafeInteger(status.revision)) {
    throw new Error("ship status has an unsupported schema or revision");
  }
  normalizeIntent(status.intent);
  if (status.train_plan !== null) validateTrainPlan(status.train_plan);
  return status;
}

async function recordEvent(
  deps: ShipCoordinatorDeps,
  status: ShipStatus,
  phase: ShipNextAction,
  eventStatus: ShipPhaseEvent["status"],
  detail: string | null = null,
): Promise<void> {
  await deps.state.appendEvent(status.ship_key, {
    schema_version: 1,
    kind: "ship_phase",
    run_id: status.run_id,
    event_id: status.intent.event_id,
    at: deps.now().toISOString(),
    phase,
    status: eventStatus,
    detail,
  });
}

async function persist(
  deps: ShipCoordinatorDeps,
  status: ShipStatus,
  progress: ShipProgress,
  lastError: string | null = null,
): Promise<ShipStatus> {
  validateProgress(progress, status.intent, status.train_plan);
  const action = nextAction(progress);
  const humanAuthority =
    typeof lastError === "string" &&
    /needs-human|missing-authority|human.authority|specification-decision/i.test(lastError);
  const updated: ShipStatus = {
    ...status,
    ...progress,
    revision: status.revision + 1,
    next_action: action,
    complete: action === "complete",
    updated_at: deps.now().toISOString(),
    last_error: lastError,
    ...(humanAuthority ? { human_authority: true as const } : {}),
  };
  await deps.state.writeAtomic(status.ship_key, updated);
  return updated;
}

async function persistTrainPlan(
  deps: ShipCoordinatorDeps,
  status: ShipStatus,
  plan: ShipTrainPlan,
): Promise<ShipStatus> {
  if (status.train_plan) throw new Error("ship train plan is already frozen");
  const frozen = validateTrainPlan(plan);
  const updated: ShipStatus = {
    ...status,
    train_plan: frozen,
    revision: status.revision + 1,
    updated_at: deps.now().toISOString(),
    last_error: null,
  };
  await deps.state.writeAtomic(status.ship_key, updated);
  return updated;
}

export async function runShipCoordinator(
  expectedRaw: ShipIntent,
  authorizationRaw: unknown | null,
  deps: ShipCoordinatorDeps,
): Promise<ShipStatus> {
  const expected = normalizeIntent(expectedRaw);
  const operatorMode = authorizationRaw == null;
  const authorization = operatorMode
    ? null
    : validateBuzzShipAuthorization(
        authorizationRaw,
        expected,
        deps.now(),
        deps.authorizationPublicKey,
      );
  const coordinateKey = shipKey(expected);
  return deps.withRunLock(shipBaseLockKey(expected), async () => {
  // Recheck the signed grant after lock acquisition and before every phase.
  const requireActiveAuthorization = (): void => {
    if (operatorMode) return;
    validateBuzzShipAuthorization(
      authorizationRaw,
      expected,
      deps.now(),
      deps.authorizationPublicKey,
    );
  };
  requireActiveAuthorization();
  const eventsFile = deps.state.eventsFile(coordinateKey);
  if (!path.isAbsolute(eventsFile)) throw new Error("ship state: events_file must be an absolute path");

  const loaded = await deps.state.read(coordinateKey);
  let status: ShipStatus;
  if (loaded) {
    status = parseStatus(loaded);
    if (status.ship_key !== coordinateKey ||
        status.intent.repository !== expected.repository ||
        status.intent.base_branch !== expected.base_branch ||
        status.intent.milestone !== expected.milestone ||
        status.intent.version !== expected.version) {
      throw new Error("ship status belongs to a different shipment");
    }
    if (status.events_file !== eventsFile) {
      throw new Error("ship status events_file does not match the active host state adapter");
    }
    const fingerprint = operatorMode
      ? OPERATOR_SHIP_FINGERPRINT
      : authorization!.fingerprint;
    const sameCoordinates =
      status.intent.repository === expected.repository &&
      status.intent.base_branch === expected.base_branch &&
      status.intent.milestone === expected.milestone &&
      status.intent.version === expected.version;
    const sameAuthorization = operatorMode
      ? sameCoordinates
      : sameIntent(status.intent, expected) &&
        status.authorization_fingerprint === fingerprint;
    if (!sameAuthorization) {
      if (status.complete || deps.now().getTime() < Date.parse(status.authorization_expires_at)) {
        throw new Error("ship status belongs to a different active authorization");
      }
      const now = deps.now().toISOString();
      status = {
        ...status,
        run_id: shipRunId(expected),
        intent: expected,
        authorization_fingerprint: fingerprint,
        authorized_at: now,
        authorization_expires_at: operatorMode
          ? "9999-12-31T00:00:00.000Z"
          : authorization!.expires_at,
        revision: status.revision + 1,
        updated_at: now,
        last_error: null,
      };
      await deps.state.writeAtomic(coordinateKey, status);
    }
  } else {
    const now = deps.now().toISOString();
    status = {
      schema_version: 1,
      kind: "ship_status",
      ship_key: coordinateKey,
      run_id: shipRunId(expected),
      intent: expected,
      authorization_fingerprint: operatorMode
        ? OPERATOR_SHIP_FINGERPRINT
        : authorization!.fingerprint,
      authorized_at: now,
      authorization_expires_at: operatorMode
        ? "9999-12-31T00:00:00.000Z"
        : authorization!.expires_at,
      events_file: eventsFile,
      train_plan: null,
      revision: 0,
      next_action: "train_merge",
      complete: false,
      updated_at: now,
      last_error: null,
      ...EMPTY_PROGRESS,
    };
    await deps.state.writeAtomic(coordinateKey, status);
  }

  const reconciled = await deps.reconcile(expected, status);
  validateProgress(reconciled, expected, status.train_plan);
  status = await persist(deps, status, reconciled);
  await recordEvent(deps, status, status.next_action, "reconciled", "external truth applied");
  const wasComplete = status.complete;

  const run = async <T>(phase: ShipNextAction, operation: () => Promise<T>, apply: (value: T) => ShipProgress) => {
    await recordEvent(deps, status, phase, "started");
    try {
      requireActiveAuthorization();
      const value = await operation();
      status = await persist(deps, status, apply(value));
      await recordEvent(deps, status, phase, "completed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        status = await persist(deps, status, status, message);
        await recordEvent(deps, status, phase, "failed", message);
      } catch (stateErr) {
        throw new AggregateError([err, stateErr], `ship ${phase} failed and status persistence also failed`);
      }
      throw err;
    }
  };

  if (!status.train && !status.train_plan) {
    status = await persistTrainPlan(deps, status, await deps.planTrain(expected));
    await recordEvent(
      deps,
      status,
      "train_merge",
      "reconciled",
      `frozen train plan: ${status.train_plan.ordered_issues.map((issue) => `#${issue}`).join(", ")}`,
    );
  }
  if (!status.train) {
    await run(
      "train_merge",
      () => deps.convergeTrain(expected, status.train_plan!.ordered_issues),
      (train) => ({ ...status, train }),
    );
  }
  if (!status.frg_pack) {
    await run("frg_pack", () => deps.convergeFrgPack(expected, status.train!), (frg_pack) => ({ ...status, frg_pack }));
  }
  if (!status.frg) {
    await run("frg_score", () => deps.convergeFrgScore(expected, status.frg_pack!), (frg) => ({ ...status, frg }));
  }
  if (!status.release) {
    await run("release_prepare", () => deps.convergeReleasePrepare(expected, status.frg!), (release) => ({ ...status, release }));
  }
  if (!status.release_finish) {
    await run("release_finish", () => deps.convergeReleaseFinish(expected, status.release!), (release_finish) => ({ ...status, release_finish }));
  }
  if (!status.publication) {
    await run("release_wait", () => deps.waitForRelease(expected, status.release_finish!), (publication) => ({ ...status, publication }));
  }
  if (!status.promotion) {
    await run("engine_promote", () => deps.convergeEnginePromote(expected, status.publication!), (promotion) => ({ ...status, promotion }));
  }
  if (!status.complete) status = await persist(deps, status, status);
  if (status.complete && !wasComplete) {
    await recordEvent(deps, status, "complete", "completed");
  }
  return status;
  });
}

export function resolveShipStateHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_PIPELINE_STATE_HOME) return path.resolve(env.AGENT_PIPELINE_STATE_HOME);
  if (env.XDG_STATE_HOME) return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline");
  return path.join(homedir(), ".local", "state", "agent-pipeline");
}

function assertShipKey(key: string): void {
  if (!/^ship-[0-9a-f]{24}$/.test(key)) throw new Error("ship state: unsafe ship key");
}

export function shipStatePaths(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): { status_file: string; events_file: string } {
  assertShipKey(key);
  const dir = path.join(resolveShipStateHome(env), "ships", key);
  return {
    status_file: path.join(dir, "status.json"),
    events_file: path.join(dir, "events.jsonl"),
  };
}

/** Real host-local store. systemd remains responsible for single-instance admission. */
export function defaultShipStateStore(env: NodeJS.ProcessEnv = process.env): ShipStateStore {
  const paths = (key: string) => shipStatePaths(key, env);
  return {
    statusFile(key) {
      return paths(key).status_file;
    },
    eventsFile(key) {
      return paths(key).events_file;
    },
    async read(key) {
      try {
        return parseStatus(JSON.parse(await fs.readFile(paths(key).status_file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async writeAtomic(key, status) {
      const target = paths(key).status_file;
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temporary, target);
      } catch (err) {
        await fs.rm(temporary, { force: true });
        throw err;
      }
    },
    async appendEvent(key, event) {
      const target = paths(key).events_file;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}
