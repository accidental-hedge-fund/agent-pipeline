// The durable loop store (#508, capability `durable-loop-store`): state-home
// resolution, run directory layout, atomic document writes, append-only event
// and decision logs, exclusive locking with liveness-based staleness, and a
// read-only status projection.
//
// Every I/O op is behind LoopStoreDeps — mirrors the AdvanceReviewDeps /
// ShaGateDeps convention (see core/scripts/stages/*.ts): unit tests inject an
// in-memory fake and make no real filesystem, process, or network call.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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

export const PIPELINE_STATE_HOME_ENV = "AGENT_PIPELINE_STATE_HOME";

/** The variable's former name, honored as a migration fallback so runs stored
 *  under the previously documented override remain resumable (#508 delta
 *  finding 5668c55c). AGENT_PIPELINE_STATE_HOME always takes precedence. */
export const LEGACY_PIPELINE_STATE_HOME_ENV = "PIPELINE_STATE_HOME";

/** Injectable I/O seam for the durable loop store. All paths are absolute. */
export interface LoopStoreDeps {
  fsExists(p: string): Promise<boolean>;
  readTextFile(p: string): Promise<string | null>;
  /** Write `content` to `p` atomically: temp file in the same directory,
   *  flushed, then renamed into place. Implementations MUST NOT leave a
   *  partially-written `p` visible to a concurrent reader. */
  writeFileAtomic(p: string, content: string): Promise<void>;
  /** Creates `p` with `content` only if it does not already exist (e.g. `open`
   *  with `O_EXCL`). Returns `true` when this call created the file, `false`
   *  when `p` already existed (in which case `p` is left untouched). MUST be
   *  atomic against concurrent callers — this is the store's sole exclusivity
   *  primitive for lock acquisition and run initialization. */
  createFileExclusive(p: string, content: string): Promise<boolean>;
  /** Removes `p` if it exists. A no-op when `p` is absent. Lock release and
   *  recovery use {@link removeFileIfMatches} instead, so a stale-lock
   *  observation can never delete a record it did not itself last read. */
  removeFile(p: string): Promise<void>;
  /** Removes `p` only if its current content is byte-identical to
   *  `expectedContent`; otherwise leaves `p` untouched. Returns `true` when it
   *  removed the file, `false` when `p` was absent or had already changed.
   *  MUST be atomic against a concurrent write/remove of `p` — this is the
   *  store's compare-and-delete primitive for lock recovery/release, so a
   *  holder can never remove a lock record it did not itself last observe. */
  removeFileIfMatches(p: string, expectedContent: string): Promise<boolean>;
  /** Append `line` (without trailing newline) as a new line to `p`, creating
   *  the file if absent. MUST NOT rewrite existing bytes. */
  appendLine(p: string, line: string): Promise<void>;
  mkdirp(p: string): Promise<void>;
  /** Atomically move directory `from` to `to`. Returns `true` on success and
   *  `false` when `to` already exists — publication is exclusive: exactly one
   *  concurrent initializer's staged run directory can become the run
   *  directory (#508 delta finding 92d2ec8f). Callers never create `to`
   *  directly, so an existing `to` is always a previously published run. */
  renameDirExclusive(from: string, to: string): Promise<boolean>;
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
  if (env[LEGACY_PIPELINE_STATE_HOME_ENV]) return path.resolve(env[LEGACY_PIPELINE_STATE_HOME_ENV]!);
  if (env.XDG_STATE_HOME) return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "loop");
  return path.join(homedir(), ".local", "state", "agent-pipeline", "loop");
}

// Run ids are used as a bare path segment under `<state-home>/runs/`. Reject
// anything that could traverse out of that root (path separators, ".", "..")
// before it ever reaches a filesystem call.
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === ".." || runId.includes("..")) {
    throw new LoopError("validation", `invalid run id "${runId}": must be a bare name with no path separators or ".."`);
  }
}

export function runDir(deps: Pick<LoopStoreDeps, "env" | "hostname">, runId: string): string {
  assertSafeRunId(runId);
  const root = path.join(resolveStateHome(deps), "runs");
  const dir = path.join(root, runId);
  if (!(dir + path.sep).startsWith(root + path.sep)) {
    throw new LoopError("validation", `invalid run id "${runId}": resolves outside the runs root`);
  }
  return dir;
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
  return deps.fsExists(contractPath(runDir(deps, runId)));
}

/** Initializes a fresh run directory with the given contract + seeded ledger.
 *  Refuses (LoopError "conflict") when the run already has a ledger — never
 *  overwrites a genuinely initialized run. The contract's exclusive creation
 *  is the concurrency gate: concurrent initRun calls both `mkdirp` (idempotent)
 *  but only one can win the exclusive create, so a crash between mkdirp and
 *  the exclusive create never permanently wedges the run id — a later caller
 *  still wins the gate cleanly.
 *
 *  A run id is canonical, so a caller cannot fall back to a different id if a
 *  prior attempt won the contract-creation gate but crashed before the
 *  ledger/event were written. initRun therefore treats "contract exists, no
 *  ledger yet" as a stranded partial init and completes it — rather than
 *  refusing that run id forever. */
export async function initRun(deps: LoopStoreDeps, contract: LoopContract, ledger: LoopLedger): Promise<void> {
  const dir = runDir(deps, contract.run_id);
  if (await deps.fsExists(contractPath(dir))) {
    throw new LoopError(
      "conflict",
      `loop run "${contract.run_id}" already exists — resume it instead of re-initializing`,
    );
  }
  // Atomic publication (#508 delta finding 92d2ec8f): the complete run —
  // contract, ledger, and initialization event — is staged in a sibling
  // directory and published with one exclusive directory rename. A run id
  // either appears fully initialized or not at all, so two concurrent
  // initializers can never interleave records from different requests: the
  // rename loser observes the winner's published run and reports conflict.
  const staging = `${dir}.init-${deps.uuid()}`;
  await deps.mkdirp(staging);
  await deps.writeFileAtomic(contractPath(staging), JSON.stringify(contract, null, 2));
  await deps.writeFileAtomic(ledgerPath(staging), JSON.stringify(ledger, null, 2));
  await appendLog(deps, eventsPath(staging), "run_initialized", { run_id: contract.run_id, engine: contract.engine });
  const published = await deps.renameDirExclusive(staging, dir);
  if (!published) {
    await deps.removeFile(contractPath(staging));
    await deps.removeFile(ledgerPath(staging));
    await deps.removeFile(eventsPath(staging));
    throw new LoopError(
      "conflict",
      `loop run "${contract.run_id}" was initialized concurrently — resume it instead of re-initializing`,
    );
  }
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

/** Overwrites the run's ledger. Requires the current lock holder's `token` —
 *  refuses (LoopError "lock") when it is absent or mismatched. */
export async function writeLedger(deps: LoopStoreDeps, ledger: LoopLedger, token: string): Promise<void> {
  await requireToken(deps, ledger.run_id, token);
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

// Reservation + write for a given log path must not interleave: two
// concurrent appendLog calls for the same path would otherwise both read the
// same nextSeq before either commits, producing duplicate sequence numbers.
// This chain serializes append calls per log path within this process (the
// single-engine-lock-holder invariant means only one process ever appends to
// a given run's logs at a time, so per-process serialization is sufficient).
const appendQueues = new Map<string, Promise<unknown>>();

async function appendLog(
  deps: LoopStoreDeps,
  logPath: string,
  kind: string,
  data: unknown,
): Promise<LoopEvent | LoopDecision> {
  const prior = appendQueues.get(logPath) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const seq = await nextSeq(deps, logPath);
    const record = { seq, time: deps.now().toISOString(), kind, data };
    await deps.appendLine(logPath, JSON.stringify(record));
    nextSeqCache.set(logPath, seq + 1);
    return record;
  });
  appendQueues.set(logPath, task);
  return task;
}

/** Appends an event without requiring a lock token. Reserved for the store's
 *  own narrowly-scoped lifecycle records (run init, lock recovery) that occur
 *  when no holder token exists yet. Every other caller MUST use
 *  {@link appendEvent}. */
async function appendEventUnchecked(deps: LoopStoreDeps, runId: string, kind: string, data: unknown): Promise<LoopEvent> {
  return (await appendLog(deps, eventsPath(runDir(deps, runId)), kind, data)) as LoopEvent;
}

/** Appends an event. Requires the current lock holder's `token` — refuses
 *  (LoopError "lock") when it is absent or mismatched. */
export async function appendEvent(deps: LoopStoreDeps, runId: string, token: string, kind: string, data: unknown): Promise<LoopEvent> {
  await requireToken(deps, runId, token);
  return appendEventUnchecked(deps, runId, kind, data);
}

/** Appends a decision. Requires the current lock holder's `token` — refuses
 *  (LoopError "lock") when it is absent or mismatched. */
export async function appendDecision(
  deps: LoopStoreDeps,
  runId: string,
  token: string,
  kind: string,
  data: unknown,
): Promise<LoopDecision> {
  await requireToken(deps, runId, token);
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

/** Release and recovery remove `lock.json` entirely (see {@link releaseLock},
 *  {@link recoverLock}), so a subsequent {@link acquireLock} can win the
 *  exclusive-create gate. An absent file reads back as "no lock". */
export async function readLock(deps: LoopStoreDeps, runId: string): Promise<LoopLockRecord | null> {
  const text = await deps.readTextFile(lockPath(runDir(deps, runId)));
  return text ? (JSON.parse(text) as LoopLockRecord) : null;
}

export async function classifyStaleness(deps: LoopStoreDeps, lock: LoopLockRecord): Promise<LockStaleness> {
  if (lock.hostname !== deps.hostname()) return "unverifiable_cross_host";
  const alive = await deps.isPidAlive(lock.pid);
  return alive ? "not_stale" : "stale_same_host_dead_pid";
}

/** Acquires the run's exclusive lock via {@link LoopStoreDeps.createFileExclusive}
 *  — of two concurrent acquisitions, exactly one wins the exclusive create and
 *  the other observes the file already exists and refuses (LoopError "lock"),
 *  naming the holder. A stale lock must be explicitly recovered first — see
 *  {@link recoverLock}. */
export async function acquireLock(deps: LoopStoreDeps, runId: string, engine: LoopLockRecord["engine"]): Promise<LockAcquireResult> {
  const token = deps.uuid();
  const record: LoopLockRecord = {
    engine,
    pid: deps.pid(),
    hostname: deps.hostname(),
    acquired_at: deps.now().toISOString(),
    token,
    run_id: runId,
  };
  const created = await deps.createFileExclusive(lockPath(runDir(deps, runId)), JSON.stringify(record, null, 2));
  if (!created) {
    const existing = await readLock(deps, runId);
    const holder = existing
      ? `${existing.engine} pid ${existing.pid} on ${existing.hostname} (acquired ${existing.acquired_at})`
      : "an existing holder";
    throw new LoopError("lock", `loop run "${runId}" is already locked by ${holder}`);
  }
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

/** Releases the lock. Uses compare-and-delete against the exact record this
 *  call observed, so a holder can never remove a lock that a concurrent
 *  recovery has already superseded (see {@link recoverLock}). */
export async function releaseLock(deps: LoopStoreDeps, runId: string, token: string): Promise<void> {
  const lock = await requireToken(deps, runId, token);
  const removed = await deps.removeFileIfMatches(lockPath(runDir(deps, runId)), JSON.stringify(lock, null, 2));
  if (!removed) {
    throw new LoopError("lock", `loop run "${runId}": lock was already superseded by another holder`);
  }
}

/** Recovers (removes) a stale lock. Refuses without `force` unless staleness
 *  is `stale_same_host_dead_pid`. Never transfers the token — the recovering
 *  caller must acquire a fresh lock afterward. Records a recovery event.
 *
 *  Uses compare-and-delete against the exact lock record this call classified
 *  as stale (see {@link LoopStoreDeps.removeFileIfMatches}): if a concurrent
 *  recovery already removed and a new holder already re-acquired the lock,
 *  this call's removal is a no-op instead of deleting the new holder's lock —
 *  closing the ABA race where two racing recoveries could otherwise strip a
 *  lock that a third engine had already legitimately acquired. */
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
  const removed = await deps.removeFileIfMatches(lockPath(runDir(deps, runId)), JSON.stringify(lock, null, 2));
  if (!removed) return; // superseded by a concurrent recovery — nothing left to recover
  await appendEventUnchecked(deps, runId, "lock_recovered", {
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

// ---------------------------------------------------------------------------
// Production dependencies (#508 delta finding bc212827): the single real-fs
// implementation of every LoopStoreDeps seam, so no caller can construct a
// partial object that misses a newer method under type stripping (there is no
// tsc gate — a missing method surfaces only at runtime).
// ---------------------------------------------------------------------------

/** Real-filesystem LoopStoreDeps. All mutating primitives match their seam
 *  contracts: exclusive create via O_EXCL, atomic whole-document writes via
 *  temp+fsync+rename, exclusive directory publication, and compare-and-delete
 *  via the exclusive rename-claim protocol established for the installer's
 *  update lock (#450): exactly one concurrent caller claims the file, the
 *  claimed bytes are verified before discard, and a non-matching claim is
 *  restored via link — atomic and EEXIST-failing, so a record written after
 *  the claim is never clobbered. */
export function defaultLoopStoreDeps(env: NodeJS.ProcessEnv = process.env): LoopStoreDeps {
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
        await fs.promises.link(claim, p); // EEXIST: a newer record landed; keep it
      } catch {
        // best-effort restore; the newer record (if any) is authoritative
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
    async renameDirExclusive(from, to) {
      try {
        await fs.promises.rename(from, to);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") return false;
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

export { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA };
