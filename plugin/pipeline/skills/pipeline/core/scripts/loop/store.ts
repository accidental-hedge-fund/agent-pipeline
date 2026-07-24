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
  isDurableBlockerClass,
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type DurableBlockerClass,
  type LoopActionEvidence,
  type LoopAuthorityAmendment,
  type LoopContract,
  type LoopDecision,
  type LoopEvent,
  type LoopHumanInputRequest,
  type LoopLedger,
  type LoopLockRecord,
  type LoopStopRecord,
  type LoopSupervisorProcess,
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
function supervisorPath(dir: string): string {
  return path.join(dir, "supervisor.json");
}
function actionEvidencePath(dir: string): string {
  return path.join(dir, "action-evidence.jsonl");
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
// Durable-run-blocker evidence projection (#538) — read-only, zero writes,
// zero lock. A distinct evidence source from `runsDir()`/events.jsonl in
// `improve.ts`: this reads the durable-loop store's own ledgers under the
// loop state home, not `.agent-pipeline/runs/`.
// ---------------------------------------------------------------------------

/** One durable-run-blocker occurrence — an item's current typed blocker
 *  classification as recorded in a run's ledger, projected for the
 *  `durable-run-blocker` improve-cluster category (capability
 *  `durable-run-blocker-auto-file`). `terminal` is true when this run's
 *  {@link LoopStopRecord} is attributable to this exact item — a terminal
 *  stop with a different or absent `item_id` never marks an unrelated
 *  item's occurrence as terminal. */
export interface DurableBlockerOccurrence {
  runId: string;
  itemId: string;
  blockerClass: DurableBlockerClass;
  fingerprint: string;
  /** Raw (unsanitized) evidence excerpt from the item's most recent `blocked`
   *  history entry — callers MUST sanitize before rendering or filing. */
  evidenceExcerpt: string;
  /** ISO-8601 timestamp of the history entry the evidence excerpt was drawn
   *  from — used by callers for trailing-window filtering of non-terminal
   *  occurrences. */
  time: string;
  terminal: boolean;
  /** ISO-8601 timestamp of the {@link LoopStopRecord} when `terminal` is true
   *  (undefined otherwise) — callers MUST filter a terminal occurrence's
   *  trailing window against this timestamp, not `time`: `time` is the
   *  underlying `blocked` history entry, which can predate the window even
   *  when the terminal stop itself just happened (#538 review 2 finding
   *  c5457eee500bcb8d). */
  terminalTime?: string;
}

/** Enumerates every durable-run ledger under the loop state home and
 *  projects each item currently (or most recently) carrying a typed
 *  {@link DurableBlockerClass} into a {@link DurableBlockerOccurrence}.
 *  Read-only: acquires no lock, writes no ledger, appends no event. A single
 *  unreadable or malformed ledger is skipped rather than aborting the whole
 *  projection — one corrupt run must never hide every other run's evidence. */
export async function readDurableRunBlockerOccurrences(
  deps: Pick<LoopStoreDeps, "listDir" | "readTextFile" | "env" | "hostname">,
): Promise<DurableBlockerOccurrence[]> {
  const root = path.join(resolveStateHome(deps), "runs");
  let runIds: string[];
  try {
    runIds = [...new Set(await deps.listDir(root))];
  } catch {
    return []; // no runs root (e.g. pipeline:loop never ran on this host) — no durable evidence, not fatal
  }
  const out: DurableBlockerOccurrence[] = [];

  for (const runId of runIds) {
    try {
      const text = await deps.readTextFile(ledgerPath(path.join(root, runId)));
      if (!text) continue;
      const ledger = JSON.parse(text) as LoopLedger;
      const stop: LoopStopRecord | null = ledger.stop ?? null;

      for (const [itemId, item] of Object.entries(ledger.items ?? {})) {
        if (!item.blocked_theme || !isDurableBlockerClass(item.blocked_theme) || !item.evidence_fingerprint) continue;

        const historyEntry = [...(item.history ?? [])]
          .reverse()
          .find((h) => h.to === "blocked" && h.theme === item.blocked_theme);

        const terminal = !!stop && stop.item_id === itemId;
        out.push({
          runId,
          itemId,
          blockerClass: item.blocked_theme,
          fingerprint: item.evidence_fingerprint,
          evidenceExcerpt: historyEntry?.evidence ?? "",
          time: historyEntry?.time ?? "",
          terminal,
          terminalTime: terminal ? stop!.time : undefined,
        });
      }
    } catch {
      continue; // unreadable/malformed ledger — skip, never fatal
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Run supersession (#568, capability `loop-run-supersession`) — an audited,
// operator-invoked way to retire a terminally-stopped run and start a fresh
// run for the same selector, linked by supersedes/superseded_by pointers. See
// openspec/changes/loop-precondition-stage-gate/design.md decision 4.
// ---------------------------------------------------------------------------

/** Marks a terminally-stopped run as superseded by `newRunId` — a narrow, token-free
 *  administrative write mirroring {@link recoverLock}/{@link appendEventUnchecked}: a
 *  terminally-stopped run has released its lock (driveSupervisor's `finally`), so there is no
 *  holder token to check against. Refuses (LoopError "validation") when the named run is not
 *  terminally stopped — the caller MUST verify this itself before calling, since this function's
 *  own guard exists only to prevent a coding error from marking a live run superseded, not as the
 *  sole enforcement point. */
export async function markRunSuperseded(deps: LoopStoreDeps, runId: string, newRunId: string): Promise<void> {
  const ledger = await readLedger(deps, runId);
  if (!ledger.stop) {
    throw new LoopError("validation", `loop run "${runId}" is not terminally stopped — refusing to mark it superseded`);
  }
  const dir = runDir(deps, runId);
  const updated: LoopLedger = { ...ledger, superseded_by: newRunId };
  await deps.writeFileAtomic(ledgerPath(dir), JSON.stringify(updated, null, 2));
  await appendEventUnchecked(deps, runId, "loop_run_superseded", { superseded_by: newRunId });
}

/** Walks a run's supersession chain forward from `runId` via each ledger's `superseded_by`
 *  pointer, returning the chain's current head (the run nothing yet supersedes) and how many
 *  supersessions preceded it. `chainLength` is 0 when `runId` itself has never been superseded —
 *  the caller (the `--new-run` CLI path) uses it to mint the next deterministic superseding run
 *  id. Refuses (LoopError "validation") on a cyclic chain — a defensive guard against a corrupted
 *  ledger, since a well-formed chain is always acyclic by construction (each superseding run id
 *  is freshly minted). */
export async function resolveSupersessionChainHead(
  deps: LoopStoreDeps,
  runId: string,
): Promise<{ headRunId: string; chainLength: number }> {
  let current = runId;
  let chainLength = 0;
  const seen = new Set<string>([current]);
  for (;;) {
    const ledger = await readLedger(deps, current);
    if (!ledger.superseded_by) break;
    if (seen.has(ledger.superseded_by)) {
      throw new LoopError("validation", `loop run "${runId}": supersession chain contains a cycle at "${ledger.superseded_by}"`);
    }
    current = ledger.superseded_by;
    seen.add(current);
    chainLength++;
  }
  return { headRunId: current, chainLength };
}

// ---------------------------------------------------------------------------
// Supervisor process identity (#512, capability `durable-loop-supervisor`) —
// a distinct atomic-write document from lock.json (design.md decision 1).
// ---------------------------------------------------------------------------

/** Writes (or overwrites) the run's process-identity record. Requires the
 *  current lock holder's token, mirroring {@link writeLedger} — the record
 *  can only be written by whoever currently holds the run. */
export async function writeSupervisorProcess(
  deps: LoopStoreDeps,
  record: LoopSupervisorProcess,
  token: string,
): Promise<void> {
  await requireToken(deps, record.run_id, token);
  const dir = runDir(deps, record.run_id);
  await deps.writeFileAtomic(supervisorPath(dir), JSON.stringify(record, null, 2));
}

/** Reads the run's process-identity record. Returns null when absent — a
 *  pre-#512 run, or a run no supervisor has ever attached to. */
export async function readSupervisorProcess(deps: LoopStoreDeps, runId: string): Promise<LoopSupervisorProcess | null> {
  const text = await deps.readTextFile(supervisorPath(runDir(deps, runId)));
  return text ? (JSON.parse(text) as LoopSupervisorProcess) : null;
}

// ---------------------------------------------------------------------------
// Action-evidence trail (#512) — append-only, token-guarded, mirroring
// appendEvent/readLog. Entries carry their own seq/time (unlike LoopEvent),
// so this uses the same nextSeq/appendQueues serialization directly rather
// than wrapping appendLog's {seq,time,kind,data} envelope.
// ---------------------------------------------------------------------------

export async function appendActionEvidence(
  deps: LoopStoreDeps,
  runId: string,
  token: string,
  entry: Omit<LoopActionEvidence, "seq" | "time">,
): Promise<LoopActionEvidence> {
  await requireToken(deps, runId, token);
  const logPath = actionEvidencePath(runDir(deps, runId));
  const prior = appendQueues.get(logPath) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const seq = await nextSeq(deps, logPath);
    const record: LoopActionEvidence = { seq, time: deps.now().toISOString(), ...entry };
    await deps.appendLine(logPath, JSON.stringify(record));
    nextSeqCache.set(logPath, seq + 1);
    return record;
  });
  appendQueues.set(logPath, task);
  return task;
}

export async function readActionEvidence(deps: LoopStoreDeps, runId: string): Promise<LoopActionEvidence[]> {
  const text = await deps.readTextFile(actionEvidencePath(runDir(deps, runId)));
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LoopActionEvidence);
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
  /** Outstanding human-input requests, keyed by item id — capability `durable-pause-and-authority`. */
  outstanding_requests: Record<string, LoopHumanInputRequest>;
  /** Every audited scoped authority amendment recorded on this run. */
  authority_amendments: LoopAuthorityAmendment[];
  /** The supervisor's process identity, when one has ever attached — null for
   *  a pre-#512 run or one no supervisor has driven yet. */
  supervisor: LoopSupervisorProcess | null;
  /** The full append-only action-evidence timeline, in order. */
  action_evidence: LoopActionEvidence[];
  /** The watchdog's current consecutive-no-progress count — 0 when absent. */
  consecutive_no_progress: number;
  /** Present when this run was created via `pipeline loop --new-run` to supersede a
   *  terminally-stopped run — names the retired run id (#568, capability
   *  `loop-run-supersession`). */
  supersedes: string | null;
  /** Present once this terminally-stopped run has itself been superseded — names the fresh run
   *  that replaced it (#568, capability `loop-run-supersession`). */
  superseded_by: string | null;
}

const ACTIVE_STATES = new Set(["in_progress"]);

export async function getStatus(deps: LoopStoreDeps, runId: string): Promise<LoopStatus> {
  const contract = await readContract(deps, runId);
  const ledger = await readLedger(deps, runId);
  const lock = await readLock(deps, runId);
  const staleness = lock ? await classifyStaleness(deps, lock) : null;
  const events = await readEvents(deps, runId);
  const supervisor = await readSupervisorProcess(deps, runId);
  const action_evidence = await readActionEvidence(deps, runId);

  const items: Record<string, { state: string }> = {};
  const active: string[] = [];
  const outstanding_requests: Record<string, LoopHumanInputRequest> = {};
  for (const [id, entry] of Object.entries(ledger.items)) {
    items[id] = { state: entry.state };
    if (ACTIVE_STATES.has(entry.state)) active.push(id);
    if (entry.hold_request) outstanding_requests[id] = entry.hold_request;
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
    outstanding_requests,
    authority_amendments: ledger.authority_amendments ?? [],
    supervisor,
    action_evidence,
    consecutive_no_progress: supervisor?.consecutive_no_progress ?? 0,
    supersedes: contract.supersedes ?? null,
    superseded_by: ledger.superseded_by ?? null,
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
