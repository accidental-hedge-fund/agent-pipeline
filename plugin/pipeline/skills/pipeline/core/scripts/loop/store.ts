// The durable loop store (#508, capability `durable-loop-store`): state-home
// resolution, run directory layout, atomic document writes, append-only event
// and decision logs, exclusive locking with liveness-based staleness, and a
// read-only status projection.
//
// Every I/O op is behind LoopStoreDeps — mirrors the AdvanceReviewDeps /
// ShaGateDeps convention (see core/scripts/stages/*.ts): unit tests inject an
// in-memory fake and make no real filesystem, process, or network call.

import * as path from "node:path";
import { homedir } from "node:os";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopDecision,
  type LoopEvent,
  type LoopLedger,
  type LoopLockRecord,
} from "./types.ts";

export const PIPELINE_STATE_HOME_ENV = "PIPELINE_STATE_HOME";

/** Injectable I/O seam for the durable loop store. All paths are absolute. */
export interface LoopStoreDeps {
  fsExists(p: string): Promise<boolean>;
  readTextFile(p: string): Promise<string | null>;
  /** Write `content` to `p` atomically: temp file in the same directory,
   *  flushed, then renamed into place. Implementations MUST NOT leave a
   *  partially-written `p` visible to a concurrent reader. */
  writeFileAtomic(p: string, content: string): Promise<void>;
  /** Append `line` (without trailing newline) as a new line to `p`, creating
   *  the file if absent. MUST NOT rewrite existing bytes. */
  appendLine(p: string, line: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  listDir(p: string): Promise<string[]>;
  /** True when a process with this pid is alive on the current host. */
  isPidAlive(pid: number): Promise<boolean>;
  hostname(): string;
  pid(): number;
  now(): Date;
  uuid(): string;
  env: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// State home + run directory layout
// ---------------------------------------------------------------------------

/** Resolves the Pipeline loop state home: explicit override -> XDG state dir
 *  -> home-relative default. Never reads or writes a legacy goal-loop state
 *  home (that lives under GOAL_LOOP_STATE_HOME — see loop/import.ts). */
export function resolveStateHome(deps: Pick<LoopStoreDeps, "env" | "hostname">): string {
  const env = deps.env;
  if (env[PIPELINE_STATE_HOME_ENV]) return path.resolve(env[PIPELINE_STATE_HOME_ENV]!);
  if (env.XDG_STATE_HOME) return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "loop");
  return path.join(homedir(), ".local", "state", "agent-pipeline", "loop");
}

export function runDir(deps: Pick<LoopStoreDeps, "env" | "hostname">, runId: string): string {
  return path.join(resolveStateHome(deps), "runs", runId);
}

function contractPath(dir: string): string {
  return path.join(dir, "contract.json");
}
function ledgerPath(dir: string): string {
  return path.join(dir, "ledger.json");
}
function lockPath(dir: string): string {
  return path.join(dir, "lock.json");
}
function eventsPath(dir: string): string {
  return path.join(dir, "events.jsonl");
}
function decisionsPath(dir: string): string {
  return path.join(dir, "decisions.jsonl");
}

// ---------------------------------------------------------------------------
// Existence / conflict
// ---------------------------------------------------------------------------

export async function runExists(deps: LoopStoreDeps, runId: string): Promise<boolean> {
  return deps.fsExists(runDir(deps, runId));
}

/** Initializes a fresh run directory with the given contract + seeded ledger.
 *  Refuses (LoopError "conflict") when the run directory already exists —
 *  never overwrites. */
export async function initRun(deps: LoopStoreDeps, contract: LoopContract, ledger: LoopLedger): Promise<void> {
  const dir = runDir(deps, contract.run_id);
  if (await deps.fsExists(dir)) {
    throw new LoopError(
      "conflict",
      `loop run "${contract.run_id}" already exists — resume it instead of re-initializing`,
    );
  }
  await deps.mkdirp(dir);
  await deps.writeFileAtomic(contractPath(dir), JSON.stringify(contract, null, 2));
  await deps.writeFileAtomic(ledgerPath(dir), JSON.stringify(ledger, null, 2));
  await appendEvent(deps, contract.run_id, "run_initialized", { run_id: contract.run_id, engine: contract.engine });
}

export async function readContract(deps: LoopStoreDeps, runId: string): Promise<LoopContract> {
  const dir = runDir(deps, runId);
  const text = await deps.readTextFile(contractPath(dir));
  if (!text) {
    throw new LoopError("validation", `loop run "${runId}" not found under ${dir}`);
  }
  return JSON.parse(text) as LoopContract;
}

export async function readLedger(deps: LoopStoreDeps, runId: string): Promise<LoopLedger> {
  const dir = runDir(deps, runId);
  const text = await deps.readTextFile(ledgerPath(dir));
  if (!text) {
    throw new LoopError("validation", `loop run "${runId}" ledger not found under ${dir}`);
  }
  return JSON.parse(text) as LoopLedger;
}

export async function writeLedger(deps: LoopStoreDeps, ledger: LoopLedger): Promise<void> {
  const dir = runDir(deps, ledger.run_id);
  await deps.writeFileAtomic(ledgerPath(dir), JSON.stringify(ledger, null, 2));
}

// ---------------------------------------------------------------------------
// Append-only logs — dense, monotonic sequencing without a whole-file re-read.
// A run's next sequence number is tracked by counting existing lines once
// (on first append this process performs) and incrementing in memory after.
// ---------------------------------------------------------------------------

const nextSeqCache = new Map<string, number>();

async function nextSeq(deps: LoopStoreDeps, logPath: string): Promise<number> {
  const cached = nextSeqCache.get(logPath);
  if (cached !== undefined) return cached;
  const text = await deps.readTextFile(logPath);
  const lines = text ? text.split("\n").filter((l) => l.length > 0) : [];
  return lines.length;
}

async function appendLog(
  deps: LoopStoreDeps,
  logPath: string,
  kind: string,
  data: unknown,
): Promise<LoopEvent | LoopDecision> {
  const seq = await nextSeq(deps, logPath);
  const record = { seq, time: deps.now().toISOString(), kind, data };
  await deps.appendLine(logPath, JSON.stringify(record));
  nextSeqCache.set(logPath, seq + 1);
  return record;
}

export async function appendEvent(deps: LoopStoreDeps, runId: string, kind: string, data: unknown): Promise<LoopEvent> {
  return (await appendLog(deps, eventsPath(runDir(deps, runId)), kind, data)) as LoopEvent;
}

export async function appendDecision(
  deps: LoopStoreDeps,
  runId: string,
  kind: string,
  data: unknown,
): Promise<LoopDecision> {
  return (await appendLog(deps, decisionsPath(runDir(deps, runId)), kind, data)) as LoopDecision;
}

async function readLog(deps: LoopStoreDeps, p: string): Promise<Array<{ seq: number; time: string; kind: string; data: unknown }>> {
  const text = await deps.readTextFile(p);
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

export async function readEvents(deps: LoopStoreDeps, runId: string) {
  return readLog(deps, eventsPath(runDir(deps, runId)));
}

export async function readDecisions(deps: LoopStoreDeps, runId: string) {
  return readLog(deps, decisionsPath(runDir(deps, runId)));
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export interface LockAcquireResult {
  token: string;
  record: LoopLockRecord;
}

export type LockStaleness = "not_stale" | "stale_same_host_dead_pid" | "unverifiable_cross_host";

/** An empty lock file (written by release/recover) reads back as "no lock" —
 *  release and recovery overwrite with "" rather than deleting, so the same
 *  atomic-write primitive covers every lock state transition. */
export async function readLock(deps: LoopStoreDeps, runId: string): Promise<LoopLockRecord | null> {
  const text = await deps.readTextFile(lockPath(runDir(deps, runId)));
  return text ? (JSON.parse(text) as LoopLockRecord) : null;
}

export async function classifyStaleness(deps: LoopStoreDeps, lock: LoopLockRecord): Promise<LockStaleness> {
  if (lock.hostname !== deps.hostname()) return "unverifiable_cross_host";
  const alive = await deps.isPidAlive(lock.pid);
  return alive ? "not_stale" : "stale_same_host_dead_pid";
}

/** Acquires the run's exclusive lock. Refuses (LoopError "lock") when a
 *  non-stale lock is already held, naming the holder. Exclusive-create
 *  semantics: a caller MUST check {@link readLock} is empty (or stale +
 *  explicitly recovered) before calling this — see {@link recoverLock}. */
export async function acquireLock(deps: LoopStoreDeps, runId: string, engine: LoopLockRecord["engine"]): Promise<LockAcquireResult> {
  const existing = await readLock(deps, runId);
  if (existing) {
    throw new LoopError(
      "lock",
      `loop run "${runId}" is already locked by ${existing.engine} pid ${existing.pid} on ${existing.hostname} (acquired ${existing.acquired_at})`,
    );
  }
  const token = deps.uuid();
  const record: LoopLockRecord = {
    engine,
    pid: deps.pid(),
    hostname: deps.hostname(),
    acquired_at: deps.now().toISOString(),
    token,
    run_id: runId,
  };
  await deps.writeFileAtomic(lockPath(runDir(deps, runId)), JSON.stringify(record, null, 2));
  return { token, record };
}

export async function requireToken(deps: LoopStoreDeps, runId: string, token: string): Promise<LoopLockRecord> {
  const lock = await readLock(deps, runId);
  if (!lock || lock.token !== token) {
    const holder = lock ? `${lock.engine} pid ${lock.pid} on ${lock.hostname}` : "no holder";
    throw new LoopError("lock", `loop run "${runId}": mutating operation requires the current lock holder's token (${holder})`);
  }
  return lock;
}

export async function releaseLock(deps: LoopStoreDeps, runId: string, token: string): Promise<void> {
  await requireToken(deps, runId, token);
  await deps.writeFileAtomic(lockPath(runDir(deps, runId)), "");
  // An empty lock file reads back as null via JSON.parse guard in readLock.
}

/** Recovers (removes) a stale lock. Refuses without `force` unless staleness
 *  is `stale_same_host_dead_pid`. Never transfers the token — the recovering
 *  caller must acquire a fresh lock afterward. Records a recovery event. */
export async function recoverLock(
  deps: LoopStoreDeps,
  runId: string,
  reason: string,
  force = false,
): Promise<void> {
  const lock = await readLock(deps, runId);
  if (!lock) return;
  const staleness = await classifyStaleness(deps, lock);
  if (staleness !== "stale_same_host_dead_pid" && !force) {
    throw new LoopError(
      "lock",
      `loop run "${runId}": lock held by ${lock.engine} pid ${lock.pid} on ${lock.hostname} is not verifiably stale — refusing recovery without force`,
    );
  }
  await deps.writeFileAtomic(lockPath(runDir(deps, runId)), "");
  await appendEvent(deps, runId, "lock_recovered", {
    previous_holder: { engine: lock.engine, pid: lock.pid, hostname: lock.hostname },
    reason: force && staleness !== "stale_same_host_dead_pid" ? `${reason} (forced)` : reason,
  });
}

// ---------------------------------------------------------------------------
// Status projection — read-only, zero writes.
// ---------------------------------------------------------------------------

export interface LoopStatus {
  run_id: string;
  engine: string;
  repo: LoopContract["repo"];
  canonical_hash: string;
  items: Record<string, { state: string }>;
  active_items: string[];
  recovery_budgets_remaining: LoopLedger["items"][string]["recovery_budgets_remaining"] | null;
  consecutive_blocked: number;
  merge_barrier: LoopLedger["merge_barrier"];
  stop: LoopLedger["stop"];
  lock: { holder: LoopLockRecord | null; staleness: LockStaleness | null };
  last_reconciliation: LoopLedger["last_reconciliation"];
  event_count: number;
}

const ACTIVE_STATES = new Set(["in_progress"]);

export async function getStatus(deps: LoopStoreDeps, runId: string): Promise<LoopStatus> {
  const contract = await readContract(deps, runId);
  const ledger = await readLedger(deps, runId);
  const lock = await readLock(deps, runId);
  const staleness = lock ? await classifyStaleness(deps, lock) : null;
  const events = await readEvents(deps, runId);

  const items: Record<string, { state: string }> = {};
  const active: string[] = [];
  for (const [id, entry] of Object.entries(ledger.items)) {
    items[id] = { state: entry.state };
    if (ACTIVE_STATES.has(entry.state)) active.push(id);
  }

  return {
    run_id: runId,
    engine: contract.engine,
    repo: contract.repo,
    canonical_hash: contract.canonical_hash,
    items,
    active_items: active,
    recovery_budgets_remaining: active.length > 0 ? ledger.items[active[0]].recovery_budgets_remaining : null,
    consecutive_blocked: ledger.consecutive_blocked,
    merge_barrier: ledger.merge_barrier,
    stop: ledger.stop,
    lock: { holder: lock, staleness },
    last_reconciliation: ledger.last_reconciliation,
    event_count: events.length,
  };
}

export { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA };
