// Authoritative pack-loop liveness status (#1296).
//
// Live requires a valid durable loop_run_handoff plus the exact acknowledged
// PID, process-start identity, boot identity, and a fresh heartbeat. A
// non-terminal ledger is never liveness proof. Engine heartbeat constants
// are safety invariants — repository configuration cannot weaken them.

import * as path from "node:path";
import {
  LOOP_RUN_HANDOFF_KIND,
  LOOP_RUN_HANDOFF_SCHEMA_VERSION,
  type DurableLoopRunHandoff,
} from "./handoff.ts";
import {
  loopRunHandoffPath,
  readLoopRunHandoff,
  readSupervisorProcess,
  resolveStateHome,
  runDir,
  type LoopStoreDeps,
} from "./store.ts";
import type { LoopSupervisorProcess } from "./types.ts";

export const PACK_LOOP_HEARTBEAT_CADENCE_MS = 5_000;
export const PACK_LOOP_HEARTBEAT_STALE_MS = 30_000;
export const PACK_LOOP_STARTUP_OBSERVATION_MS = 30_000;
export const PACK_LOOP_HEARTBEAT_FUTURE_SLACK_MS = 1_000;
export const PACK_LOOP_STDERR_HEAD_BYTES = 16 * 1024;
export const PACK_LOOP_STDERR_TAIL_BYTES = 16 * 1024;

export const PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV = "PIPELINE_PACK_LOOP_CANDIDATE_SHA";

export const PACK_LOOP_LIVENESS_KIND = "pack_loop_liveness" as const;
export const PACK_LOOP_LIVENESS_SCHEMA_VERSION = 1 as const;

export type PackLoopLivenessState = "live" | "not-live" | "unknown" | "failed";

export type PackLoopLivenessReason =
  | "live"
  | "no_handoff"
  | "dead_pid"
  | "pid_reuse"
  | "stale_heartbeat"
  | "missing_heartbeat"
  | "unreadable_identity"
  | "unreadable_handoff"
  | "pre_handoff_exit"
  | "handoff_mismatch"
  | "observation_expired";

export interface PackLoopLivenessStatus {
  schema_version: typeof PACK_LOOP_LIVENESS_SCHEMA_VERSION;
  kind: typeof PACK_LOOP_LIVENESS_KIND;
  loop_run_id: string;
  status: PackLoopLivenessState;
  reason: PackLoopLivenessReason;
  observed_at: string;
  observation_deadline?: string;
  heartbeat_at?: string;
  stderr_evidence_path?: string;
}

export type ReadableOrUnreadable<T> = T | null | "unreadable";

export interface PackLoopLivenessEvidence {
  loopRunId: string;
  now: Date;
  observationDeadline?: string | null;
  handoff: ReadableOrUnreadable<DurableLoopRunHandoff>;
  supervisor: ReadableOrUnreadable<LoopSupervisorProcess>;
  lockPidAlive: boolean | "unreadable";
  stderrEvidencePath?: string | null;
  candidateSha?: string | null;
}

function iso(now: Date): string {
  return now.toISOString();
}

function statusOf(
  evidence: PackLoopLivenessEvidence,
  status: PackLoopLivenessState,
  reason: PackLoopLivenessReason,
  extra: Partial<PackLoopLivenessStatus> = {},
): PackLoopLivenessStatus {
  const out: PackLoopLivenessStatus = {
    schema_version: PACK_LOOP_LIVENESS_SCHEMA_VERSION,
    kind: PACK_LOOP_LIVENESS_KIND,
    loop_run_id: evidence.loopRunId,
    status,
    reason,
    observed_at: iso(evidence.now),
    ...extra,
  };
  if (evidence.observationDeadline) out.observation_deadline = evidence.observationDeadline;
  if (evidence.stderrEvidencePath) out.stderr_evidence_path = evidence.stderrEvidencePath;
  return out;
}

function observationExpired(evidence: PackLoopLivenessEvidence): boolean {
  const deadline = evidence.observationDeadline?.trim();
  if (!deadline) return false;
  const ms = Date.parse(deadline);
  if (!Number.isFinite(ms)) return true;
  return evidence.now.getTime() >= ms;
}

function unreadableIdentity(evidence: PackLoopLivenessEvidence, reason: PackLoopLivenessReason): PackLoopLivenessStatus {
  if (observationExpired(evidence)) {
    return statusOf(evidence, "failed", reason);
  }
  return statusOf(evidence, "unknown", reason);
}

export function parseHeartbeatAt(
  raw: unknown,
  now: Date,
): { kind: "fresh" | "stale" | "missing" } | { kind: "malformed" } {
  if (raw == null || raw === "") return { kind: "missing" };
  if (typeof raw !== "string") return { kind: "malformed" };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { kind: "malformed" };
  const skew = ms - now.getTime();
  if (skew > PACK_LOOP_HEARTBEAT_FUTURE_SLACK_MS) return { kind: "malformed" };
  const age = now.getTime() - ms;
  if (age > PACK_LOOP_HEARTBEAT_STALE_MS) return { kind: "stale" };
  return { kind: "fresh" };
}

/**
 * Clamp a requested heartbeat cadence. Repository config cannot lengthen
 * the engine invariant; a smaller (stricter) value is kept.
 */
export function packLoopHeartbeatCadenceMs(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return PACK_LOOP_HEARTBEAT_CADENCE_MS;
  }
  return Math.min(requested, PACK_LOOP_HEARTBEAT_CADENCE_MS);
}

/**
 * Clamp a requested heartbeat stale threshold. Repository config cannot
 * raise the engine invariant; a smaller (stricter) value is kept.
 */
export function packLoopHeartbeatStaleMs(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return PACK_LOOP_HEARTBEAT_STALE_MS;
  }
  return Math.min(requested, PACK_LOOP_HEARTBEAT_STALE_MS);
}

export function packLoopStartupObservationMs(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return PACK_LOOP_STARTUP_OBSERVATION_MS;
  }
  return Math.min(requested, PACK_LOOP_STARTUP_OBSERVATION_MS);
}

export function isDurableLoopRunHandoff(raw: unknown): raw is DurableLoopRunHandoff {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (o.kind !== LOOP_RUN_HANDOFF_KIND) return false;
  if (o.schema_version !== LOOP_RUN_HANDOFF_SCHEMA_VERSION) return false;
  if (typeof o.run_id !== "string" || !o.run_id.trim()) return false;
  if (typeof o.run_dir !== "string" || !path.isAbsolute(o.run_dir)) return false;
  if (typeof o.events !== "string" || !path.isAbsolute(o.events)) return false;
  if (typeof o.engine !== "string") return false;
  if (typeof o.resumed !== "boolean") return false;
  if (typeof o.candidate_sha !== "string") return false;
  const sup = o.supervisor;
  if (!sup || typeof sup !== "object" || Array.isArray(sup)) return false;
  const s = sup as Record<string, unknown>;
  if (typeof s.pid !== "number" || !Number.isInteger(s.pid) || s.pid <= 0) return false;
  if (typeof s.boot_id !== "string" || !s.boot_id.trim()) return false;
  if (typeof s.started_at !== "string" || !s.started_at.trim()) return false;
  if (typeof s.token !== "string" || !s.token.trim()) return false;
  return true;
}

export function pathContainedIn(
  child: string,
  parent: string,
  realpathImpl: (p: string) => string = path.resolve,
): boolean {
  let c: string;
  let p: string;
  try {
    c = realpathImpl(child);
    p = realpathImpl(parent);
  } catch {
    return false;
  }
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c === p || c.startsWith(prefix);
}

/** Authoritative classifier. Does not inspect the ledger. */
export function classifyPackLoopLiveness(evidence: PackLoopLivenessEvidence): PackLoopLivenessStatus {
  if (evidence.handoff === "unreadable" || evidence.supervisor === "unreadable" || evidence.lockPidAlive === "unreadable") {
    return unreadableIdentity(evidence, "unreadable_identity");
  }
  if (!evidence.handoff) {
    return statusOf(evidence, "not-live", "no_handoff");
  }
  if (!isDurableLoopRunHandoff(evidence.handoff)) {
    return unreadableIdentity(evidence, "unreadable_handoff");
  }
  if (evidence.handoff.run_id !== evidence.loopRunId) {
    return statusOf(evidence, "failed", "handoff_mismatch");
  }
  if (evidence.candidateSha && evidence.handoff.candidate_sha !== evidence.candidateSha) {
    return statusOf(evidence, "failed", "handoff_mismatch");
  }
  const supervisor = evidence.supervisor;
  if (!supervisor) {
    return unreadableIdentity(evidence, "unreadable_identity");
  }
  const snap = evidence.handoff.supervisor;
  if (
    supervisor.pid !== snap.pid ||
    supervisor.boot_id !== snap.boot_id ||
    supervisor.started_at !== snap.started_at ||
    supervisor.run_id !== evidence.loopRunId
  ) {
    return statusOf(evidence, "not-live", "pid_reuse");
  }
  if (evidence.lockPidAlive !== true) {
    return statusOf(evidence, "not-live", "dead_pid", {
      heartbeat_at: supervisor.heartbeat_at,
    });
  }
  const beat = parseHeartbeatAt(supervisor.heartbeat_at, evidence.now);
  if (beat.kind === "malformed") {
    return unreadableIdentity(evidence, "unreadable_identity");
  }
  if (beat.kind === "missing") {
    return statusOf(evidence, "not-live", "missing_heartbeat");
  }
  if (beat.kind === "stale") {
    return statusOf(evidence, "not-live", "stale_heartbeat", {
      heartbeat_at: supervisor.heartbeat_at,
    });
  }
  return statusOf(evidence, "live", "live", {
    heartbeat_at: supervisor.heartbeat_at,
  });
}

export function livenessStatusFromUnknown(raw: unknown): PackLoopLivenessStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== PACK_LOOP_LIVENESS_KIND) return null;
  if (o.schema_version !== PACK_LOOP_LIVENESS_SCHEMA_VERSION) return null;
  if (typeof o.loop_run_id !== "string" || !o.loop_run_id.trim()) return null;
  if (o.status !== "live" && o.status !== "not-live" && o.status !== "unknown" && o.status !== "failed") {
    return null;
  }
  const reasons: PackLoopLivenessReason[] = [
    "live",
    "no_handoff",
    "dead_pid",
    "pid_reuse",
    "stale_heartbeat",
    "missing_heartbeat",
    "unreadable_identity",
    "unreadable_handoff",
    "pre_handoff_exit",
    "handoff_mismatch",
    "observation_expired",
  ];
  if (typeof o.reason !== "string" || !reasons.includes(o.reason as PackLoopLivenessReason)) return null;
  if (typeof o.observed_at !== "string" || !o.observed_at.trim()) return null;
  const status: PackLoopLivenessStatus = {
    schema_version: PACK_LOOP_LIVENESS_SCHEMA_VERSION,
    kind: PACK_LOOP_LIVENESS_KIND,
    loop_run_id: o.loop_run_id,
    status: o.status,
    reason: o.reason as PackLoopLivenessReason,
    observed_at: o.observed_at,
  };
  if (typeof o.observation_deadline === "string") status.observation_deadline = o.observation_deadline;
  if (typeof o.heartbeat_at === "string") status.heartbeat_at = o.heartbeat_at;
  if (typeof o.stderr_evidence_path === "string") status.stderr_evidence_path = o.stderr_evidence_path;
  return status;
}

export interface ProbePackLoopLivenessDeps {
  store: LoopStoreDeps;
  now?: () => Date;
  isPidAlive?: (pid: number) => Promise<boolean> | boolean;
  observationDeadline?: string | null;
  candidateSha?: string | null;
  stderrEvidencePath?: string | null;
}

export async function probePackLoopLiveness(
  loopRunId: string,
  deps: ProbePackLoopLivenessDeps,
): Promise<PackLoopLivenessStatus> {
  const now = deps.now ?? (() => deps.store.now());
  const observedAt = now();
  const id = loopRunId.trim();
  const base: PackLoopLivenessEvidence = {
    loopRunId: id,
    now: observedAt,
    observationDeadline: deps.observationDeadline,
    handoff: null,
    supervisor: null,
    lockPidAlive: false,
    stderrEvidencePath: deps.stderrEvidencePath,
    candidateSha: deps.candidateSha,
  };
  let handoff: ReadableOrUnreadable<DurableLoopRunHandoff> = null;
  try {
    const parsed = await readLoopRunHandoff(deps.store, id);
    if (parsed === null) handoff = null;
    else if (!isDurableLoopRunHandoff(parsed)) handoff = "unreadable";
    else handoff = parsed;
  } catch {
    handoff = "unreadable";
  }
  let supervisor: ReadableOrUnreadable<LoopSupervisorProcess> = null;
  try {
    supervisor = await readSupervisorProcess(deps.store, id);
  } catch {
    supervisor = "unreadable";
  }
  let lockPidAlive: boolean | "unreadable" = false;
  try {
    const lockText = await deps.store.readTextFile(path.join(runDir(deps.store, id), "lock.json"));
    if (lockText) {
      const lock = JSON.parse(lockText) as { pid?: unknown };
      const pid = typeof lock.pid === "number" ? lock.pid : Number(lock.pid);
      if (!Number.isInteger(pid) || pid <= 0) {
        lockPidAlive = "unreadable";
      } else {
        const probe = deps.isPidAlive ?? ((p: number) => deps.store.isPidAlive(p));
        lockPidAlive = Boolean(await probe(pid));
      }
    }
  } catch {
    lockPidAlive = "unreadable";
  }
  return classifyPackLoopLiveness({
    ...base,
    handoff,
    supervisor,
    lockPidAlive,
  });
}

export function loopRunHandoffFile(store: Pick<LoopStoreDeps, "env" | "hostname">, runId: string): string {
  return loopRunHandoffPath(runDir(store, runId));
}

export function packLoopStateHome(store: Pick<LoopStoreDeps, "env" | "hostname">): string {
  return resolveStateHome(store);
}
