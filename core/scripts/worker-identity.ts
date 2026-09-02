// Shared worker-identity probe (#1332).
//
// Classifies pid liveness, starttime/boot identity (PID reuse), and heartbeat
// freshness. Pack-loop liveness and the Liveness Provider both call this
// module. Pack-loop-specific handoff kind and FRG prepare JSON stay in
// pack-loop-liveness.ts.

export const WORKER_HEARTBEAT_STALE_MS = 30_000;
export const WORKER_HEARTBEAT_FUTURE_SLACK_MS = 1_000;

export type WorkerLivenessState = "live" | "not-live" | "unknown";

export type WorkerLivenessReason =
  | "live"
  | "dead_pid"
  | "pid_reuse"
  | "stale_heartbeat"
  | "missing_heartbeat"
  | "unreadable_identity";

export interface WorkerIdentity {
  pid: number;
  boot_id?: string;
  started_at?: string;
  heartbeat_at?: string;
}

export type ReadableOrUnreadable<T> = T | null | "unreadable";

export interface WorkerIdentityEvidence {
  now: Date;
  recorded: ReadableOrUnreadable<WorkerIdentity>;
  observed: ReadableOrUnreadable<WorkerIdentity>;
  pidAlive: boolean | "unreadable";
}

export interface WorkerLivenessResult {
  status: WorkerLivenessState;
  reason: WorkerLivenessReason;
  heartbeat_at?: string;
}

export function parseHeartbeatAt(
  raw: unknown,
  now: Date,
  staleMs: number = WORKER_HEARTBEAT_STALE_MS,
  futureSlackMs: number = WORKER_HEARTBEAT_FUTURE_SLACK_MS,
): { kind: "fresh" | "stale" | "missing" } | { kind: "malformed" } {
  if (raw == null || raw === "") return { kind: "missing" };
  if (typeof raw !== "string") return { kind: "malformed" };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { kind: "malformed" };
  const skew = ms - now.getTime();
  if (skew > futureSlackMs) return { kind: "malformed" };
  const age = now.getTime() - ms;
  if (age > staleMs) return { kind: "stale" };
  return { kind: "fresh" };
}

/**
 * Parse a `pid` or `pid starttime` lock/handshake marker.
 * Bare pid is parseable but not verifiable against starttime.
 */
export function parseProcessIdentityMarker(
  text: string,
): { pid: number; starttime: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const pid = Number.parseInt(parts[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rest = parts.slice(1).join(" ").trim();
  return { pid, starttime: rest === "" ? null : rest };
}

/**
 * True when the live process is the same instance the marker recorded.
 * A pid whose starttime no longer matches is PID reuse, not the original worker.
 */
export function processIdentityMatches(
  recorded: { pid: number; starttime: string | null },
  live: { pid: number; starttime: string | null },
): boolean {
  if (recorded.pid !== live.pid) return false;
  if (recorded.starttime == null || live.starttime == null) return false;
  return recorded.starttime === live.starttime;
}

function identityFieldsMatch(recorded: WorkerIdentity, observed: WorkerIdentity): boolean {
  if (recorded.pid !== observed.pid) return false;
  if (recorded.boot_id !== undefined && observed.boot_id !== undefined && recorded.boot_id !== observed.boot_id) {
    return false;
  }
  if (
    recorded.started_at !== undefined &&
    observed.started_at !== undefined &&
    recorded.started_at !== observed.started_at
  ) {
    return false;
  }
  return true;
}

/**
 * Authoritative worker-identity classifier. Does not inspect a ledger and
 * does not project human authority.
 */
export function classifyWorkerLiveness(evidence: WorkerIdentityEvidence): WorkerLivenessResult {
  if (
    evidence.recorded === "unreadable" ||
    evidence.observed === "unreadable" ||
    evidence.pidAlive === "unreadable"
  ) {
    return { status: "unknown", reason: "unreadable_identity" };
  }
  if (!evidence.observed) {
    return { status: "unknown", reason: "unreadable_identity" };
  }
  if (evidence.recorded && !identityFieldsMatch(evidence.recorded, evidence.observed)) {
    return { status: "not-live", reason: "pid_reuse" };
  }
  if (evidence.pidAlive !== true) {
    return {
      status: "not-live",
      reason: "dead_pid",
      heartbeat_at: evidence.observed.heartbeat_at,
    };
  }
  const beat = parseHeartbeatAt(evidence.observed.heartbeat_at, evidence.now);
  if (beat.kind === "malformed") {
    return { status: "unknown", reason: "unreadable_identity" };
  }
  if (beat.kind === "missing") {
    return { status: "not-live", reason: "missing_heartbeat" };
  }
  if (beat.kind === "stale") {
    return {
      status: "not-live",
      reason: "stale_heartbeat",
      heartbeat_at: evidence.observed.heartbeat_at,
    };
  }
  return {
    status: "live",
    reason: "live",
    heartbeat_at: evidence.observed.heartbeat_at,
  };
}
