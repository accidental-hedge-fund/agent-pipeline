// CLI surfaces for the Liveness Provider (#1332).
//
// `pipeline liveness status` — discover/claim capability report for doctor.
// `pipeline liveness restore` — discover, claim, reattach. Not recovery, not merge.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  KEEP_ALIVE_ADAPTER_IDS,
  classifyWorkerFromSnapshot,
  defaultKeepAliveAdapters,
  livenessStatus,
  restoreEligibleRuns,
  type AttachResult,
  type ContinuousLivenessStatus,
  type DurableRunSnapshot,
  type FenceClaim,
  type KeepAliveAdapter,
  type LivenessProviderDeps,
  type RestoreResult,
} from "./liveness-provider.ts";
import { issueRunsDir, spawnDetached } from "./detach.ts";
import {
  eventsTextIsTerminal,
  findWrapperPidForIssue,
} from "./loop/live-advance.ts";
import {
  acquireLock,
  classifyStaleness,
  defaultLoopStoreDeps,
  readContract,
  readEvents,
  readLedger,
  readLock,
  readLoopRunHandoff,
  readSupervisorProcess,
  recoverLock,
  resolveStateHome,
  writeSupervisorProcess,
  type LoopStoreDeps,
} from "./loop/store.ts";
import { LoopError, type LoopEngineName, type LoopLedger } from "./loop/types.ts";
import { getProcessStartTime, issueRunLockPath } from "./lock.ts";
import type { WorkerIdentity } from "./worker-identity.ts";

/** Env set on a spawned `--resume` child so attach waits for this parent to exit. */
export const LIVENESS_PARENT_PID_ENV = "PIPELINE_LIVENESS_PARENT_PID";

const DONE_OR_ABANDONED = new Set([
  "ready",
  "merged",
  "released",
  "deployed",
  "abandoned",
  "skipped",
]);

export const LIVENESS_HELP = [
  "pipeline liveness: discover, claim, and reattach machine-local durable supervisors.",
  "  Usage: pipeline liveness status [--json]",
  "         pipeline liveness restore [--json] [--run-id <id>]",
  "  Status reports configured / available / active / degraded / unavailable.",
  "  Restore reattaches the same supervisor through a fenced same-host lease.",
  "  These surfaces do not classify faults, choose recipes, answer requests, or merge.",
].join("\n");

export interface LivenessCliInput {
  verb: "status" | "restore";
  json?: boolean;
  runId?: string;
}

export interface LivenessCliDeps {
  provider: LivenessProviderDeps;
}

export function adaptersFromEnv(env: NodeJS.ProcessEnv = process.env): KeepAliveAdapter[] {
  const named = (env.PIPELINE_LIVENESS_ADAPTER ?? "").trim().toLowerCase();
  return defaultKeepAliveAdapters({
    systemdConfigured: named === "systemd" || env.PIPELINE_LIVENESS_SYSTEMD === "1",
    launchdConfigured: named === "launchd" || env.PIPELINE_LIVENESS_LAUNCHD === "1",
    containerConfigured: named === "container" || env.PIPELINE_LIVENESS_CONTAINER === "1",
    harnessWorkerConfigured: named === "harness-worker" || env.PIPELINE_HARNESS_WORKER === "1",
  });
}

/** Project terminal / cancel / typed-request state from ledger + events. */
export function projectLoopRunTerminal(
  ledger: LoopLedger,
  events: ReadonlyArray<{ kind: string; data?: unknown }> = [],
): {
  verifiedComplete: boolean;
  cancelled: boolean;
  typedRequestForbidsResume: boolean;
  postconditionProven: boolean;
} {
  const items = Object.values(ledger.items ?? {});
  const allDone = items.length > 0 && items.every((item) => DONE_OR_ABANDONED.has(item.state));
  const completeEvent = events.some((event) => {
    if (event.kind !== "loop_run_complete") return false;
    const outcome =
      event.data && typeof event.data === "object"
        ? (event.data as { outcome?: unknown }).outcome
        : undefined;
    return (
      outcome === "all_done" ||
      outcome === "all_items_done" ||
      outcome === "all_items_done_or_excluded"
    );
  });
  const cancelled = events.some(
    (event) =>
      event.kind === "loop_run_cancelled" ||
      event.kind === "loop_cancelled" ||
      (event.data &&
        typeof event.data === "object" &&
        (event.data as { authenticated_cancellation?: unknown }).authenticated_cancellation === true),
  );
  const waitingTyped = items.some((item) => item.state === "waiting" && item.hold_request);
  const humanStop =
    ledger.stop?.reason === "human_authority" || ledger.stop?.reason === "needs_human_classification";
  return {
    verifiedComplete: allDone || completeEvent,
    cancelled,
    typedRequestForbidsResume: waitingTyped || humanStop || Boolean(ledger.stop),
    postconditionProven: allDone || completeEvent,
  };
}

async function listLoopRuns(store: LoopStoreDeps): Promise<DurableRunSnapshot[]> {
  const root = path.join(resolveStateHome(store), "runs");
  let ids: string[];
  try {
    ids = await store.listDir(root);
  } catch {
    return [];
  }
  const hostname = store.hostname();
  const now = store.now();
  const out: DurableRunSnapshot[] = [];
  for (const runId of [...new Set(ids)]) {
    if (!runId || runId.startsWith(".") || runId.includes(".init-")) continue;
    try {
      const ledger = await readLedger(store, runId);
      const lock = await readLock(store, runId);
      const handoff = await readLoopRunHandoff(store, runId);
      const supervisor = await readSupervisorProcess(store, runId);
      const events = await readEvents(store, runId);
      const sameHost = !lock || lock.hostname === hostname;
      const pidAlive = lock ? await store.isPidAlive(lock.pid) : supervisor ? await store.isPidAlive(supervisor.pid) : false;
      const staleness = lock ? await classifyStaleness(store, lock) : null;
      const worker = classifyWorkerFromSnapshot({
        now,
        recorded: supervisor
          ? { pid: supervisor.pid, boot_id: supervisor.boot_id, started_at: supervisor.started_at, heartbeat_at: supervisor.heartbeat_at }
          : lock
            ? { pid: lock.pid }
            : null,
        observed: supervisor
          ? { pid: supervisor.pid, boot_id: supervisor.boot_id, started_at: supervisor.started_at, heartbeat_at: supervisor.heartbeat_at }
          : null,
        pidAlive,
      });
      const contractText = await store.readTextFile(path.join(root, runId, "contract.json"));
      let logicalOperationId = runId;
      if (contractText) {
        const contract = JSON.parse(contractText) as { logical_operation_id?: string };
        if (typeof contract.logical_operation_id === "string" && contract.logical_operation_id.trim()) {
          logicalOperationId = contract.logical_operation_id;
        }
      }
      const terminal = projectLoopRunTerminal(ledger, events);
      out.push({
        kind: "loop",
        runId,
        logicalOperationId,
        hostname: lock?.hostname ?? hostname,
        hasResumeBinding: Boolean(handoff || ledger),
        verifiedComplete: terminal.verifiedComplete,
        cancelled: terminal.cancelled,
        typedRequestForbidsResume: terminal.typedRequestForbidsResume,
        sameHostDeadPid: sameHost && staleness === "stale_same_host_dead_pid",
        worker,
        postconditionProven: terminal.postconditionProven,
        lock: lock
          ? { pid: lock.pid, token: lock.token, hostname: lock.hostname }
          : undefined,
      });
    } catch {
      continue;
    }
  }
  return out;
}

function liveHolderFromLock(lock: { pid: number; hostname: string } | null, runId: string): FenceClaim {
  return {
    ok: false,
    runId,
    supervisorStarted: false,
    liveHolder: lock ? { pid: lock.pid, hostname: lock.hostname } : undefined,
  };
}

/** Recover a stale same-host lock and acquire a fresh fence token. */
export async function claimLoopFence(store: LoopStoreDeps, run: DurableRunSnapshot): Promise<FenceClaim> {
  const existing = await readLock(store, run.runId);
  if (existing) {
    const staleness = await classifyStaleness(store, existing);
    if (staleness !== "stale_same_host_dead_pid") {
      return liveHolderFromLock(existing, run.runId);
    }
    try {
      await recoverLock(store, run.runId, "liveness restore: prior holder provably dead");
    } catch (err) {
      if (err instanceof LoopError && err.loopFailureClass === "lock") {
        const latest = await readLock(store, run.runId);
        return liveHolderFromLock(latest, run.runId);
      }
      throw err;
    }
  }
  let engine: LoopEngineName = "codex";
  try {
    const contract = await readContract(store, run.runId);
    if (contract.engine === "claude" || contract.engine === "codex") engine = contract.engine;
  } catch {
    /* acquire still needs an engine tag */
  }
  try {
    const acquired = await acquireLock(store, run.runId, engine);
    return {
      ok: true,
      runId: run.runId,
      token: acquired.token,
      supervisorStarted: false,
    };
  } catch (err) {
    if (err instanceof LoopError && err.loopFailureClass === "lock") {
      const latest = await readLock(store, run.runId);
      return liveHolderFromLock(latest, run.runId);
    }
    throw err;
  }
}

export interface ProductionProviderOver {
  store?: LoopStoreDeps;
  spawnSupervisor?: (input: {
    runId: string;
    engine: LoopEngineName;
    parentPid: number;
  }) => Promise<{ pid: number }>;
}

function defaultSpawnSupervisor(input: {
  runId: string;
  engine: LoopEngineName;
  parentPid: number;
}): Promise<{ pid: number }> {
  const pipelineTs = fileURLToPath(new URL("./pipeline.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      pipelineTs,
      "loop",
      "--resume",
      input.runId,
      "--profile",
      input.engine,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        [LIVENESS_PARENT_PID_ENV]: String(input.parentPid),
      },
    },
  );
  child.unref();
  if (child.pid === undefined) {
    return Promise.reject(new Error(`liveness restore: failed to spawn supervisor for ${input.runId}`));
  }
  return Promise.resolve({ pid: child.pid });
}

export function productionProviderDeps(
  env: NodeJS.ProcessEnv = process.env,
  over: ProductionProviderOver = {},
): LivenessProviderDeps {
  const store = over.store ?? defaultLoopStoreDeps(env);
  const spawnSupervisor = over.spawnSupervisor ?? defaultSpawnSupervisor;
  const claimedTokens = new Map<string, string>();
  return {
    hostname: () => store.hostname(),
    now: () => store.now(),
    adapters: adaptersFromEnv(env),
    listRuns: () => listLoopRuns(store),
    claimFence: async (run) => {
      if (run.kind !== "loop") {
        return { ok: true, runId: run.runId, supervisorStarted: false };
      }
      const claimed = await claimLoopFence(store, run);
      if (claimed.ok && claimed.token) claimedTokens.set(run.runId, claimed.token);
      return claimed;
    },
    attach: async (run, fence) => productionAttachLoop(store, spawnSupervisor, run, fence),
    refreshIdentity: async (run, identity) => {
      const token = claimedTokens.get(run.runId);
      if (!token) return;
      await persistWorkerIdentity(store, run, identity, token);
    },
  };
}

async function productionAttachLoop(
  store: LoopStoreDeps,
  spawnSupervisor: NonNullable<ProductionProviderOver["spawnSupervisor"]>,
  run: DurableRunSnapshot,
  fence: FenceClaim,
): Promise<AttachResult> {
  let engine: LoopEngineName = "codex";
  try {
    const contract = await readContract(store, run.runId);
    if (contract.engine === "claude" || contract.engine === "codex") engine = contract.engine;
  } catch {
    /* default engine */
  }
  const spawned = await spawnSupervisor({
    runId: run.runId,
    engine,
    parentPid: store.pid(),
  });
  const now = store.now().toISOString();
  const identity: WorkerIdentity = {
    pid: spawned.pid,
    boot_id: store.uuid(),
    started_at: now,
    heartbeat_at: now,
  };
  if (fence.token) {
    await persistWorkerIdentity(store, run, identity, fence.token);
  }
  return {
    runId: run.runId,
    logicalOperationId: run.logicalOperationId,
    identity,
  };
}

async function persistWorkerIdentity(
  store: LoopStoreDeps,
  run: DurableRunSnapshot,
  identity: WorkerIdentity,
  token: string,
): Promise<void> {
  let engine: LoopEngineName = "codex";
  try {
    const contract = await readContract(store, run.runId);
    if (contract.engine === "claude" || contract.engine === "codex") engine = contract.engine;
  } catch {
    /* default */
  }
  const prior = await readSupervisorProcess(store, run.runId);
  const now = store.now().toISOString();
  await writeSupervisorProcess(
    store,
    {
      run_id: run.runId,
      engine,
      pid: identity.pid,
      hostname: store.hostname(),
      boot_id: identity.boot_id ?? prior?.boot_id ?? store.uuid(),
      started_at: identity.started_at ?? prior?.started_at ?? now,
      heartbeat_at: identity.heartbeat_at ?? now,
      token,
      consecutive_no_progress: prior?.consecutive_no_progress ?? 0,
    },
    token,
  );
}

export interface RestoreDeadDetachedInput {
  issueNumber: number;
  domain: string;
  repoDir?: string;
}

export interface RestoreDeadDetachedIo {
  homedir?: () => string;
  hostname?: () => string;
  readText?: (p: string) => string | null;
  readdir?: (p: string) => string[];
  isPidAlive?: (pid: number) => boolean;
  getStartTime?: (pid: number) => string | null;
  spawnDetached?: typeof spawnDetached;
  statMtimeMs?: (p: string) => number;
}

function readTextDefault(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function readdirDefault(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function statMtimeDefault(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function discoverExistingDetachRunId(
  input: RestoreDeadDetachedInput,
  io: Required<Pick<RestoreDeadDetachedIo, "homedir" | "readText" | "readdir" | "statMtimeMs">>,
): { runId: string; logicalOperationId: string; sentinelExitCode: number | null } | null {
  const wrapperRoot = issueRunsDir(io.homedir(), input.domain, input.issueNumber);
  const wrapperNames = io.readdir(wrapperRoot)
    .filter((n) => n !== "." && n !== ".." && !n.startsWith("."))
    .map((name) => ({ name, mtime: io.statMtimeMs(path.join(wrapperRoot, name)) }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { name } of wrapperNames) {
    const dir = path.join(wrapperRoot, name);
    const pointerRaw = io.readText(path.join(dir, "run-store.json"));
    let runId: string | null = null;
    if (pointerRaw) {
      try {
        const parsed = JSON.parse(pointerRaw) as { run_store_run_id?: string };
        if (typeof parsed.run_store_run_id === "string" && parsed.run_store_run_id.trim()) {
          runId = parsed.run_store_run_id.trim();
        }
      } catch {
        /* ignore malformed pointer */
      }
    }
    const sentinelRaw = io.readText(path.join(dir, "sentinel.json"));
    let sentinelExitCode: number | null = null;
    if (sentinelRaw) {
      try {
        const sentinel = JSON.parse(sentinelRaw) as { exitCode?: number };
        if (typeof sentinel.exitCode === "number") sentinelExitCode = sentinel.exitCode;
      } catch {
        sentinelExitCode = null;
      }
    }
    if (runId) {
      return { runId, logicalOperationId: runId, sentinelExitCode };
    }
  }
  if (input.repoDir) {
    const runsRoot = path.join(input.repoDir, ".agent-pipeline", "runs");
    const prefix = `${input.issueNumber}-`;
    const names = io.readdir(runsRoot)
      .filter((n) => n.startsWith(prefix) && !n.includes("/"))
      .map((name) => ({ name, mtime: io.statMtimeMs(path.join(runsRoot, name)) }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { name } of names) {
      return { runId: name, logicalOperationId: name, sentinelExitCode: null };
    }
  }
  return null;
}

function detachRunIsVerifiedComplete(
  input: RestoreDeadDetachedInput,
  runId: string,
  io: Required<Pick<RestoreDeadDetachedIo, "readText">>,
): boolean {
  if (!input.repoDir) return false;
  const runDir = path.join(input.repoDir, ".agent-pipeline", "runs", runId);
  if (io.readText(path.join(runDir, "summary.json")) !== null) return true;
  return eventsTextIsTerminal(io.readText(path.join(runDir, "events.jsonl")));
}

/**
 * Production dead-wrapper re-entry for `pipeline run <N> --detach`.
 * Discovers the matching domain/issue run, refuses a live holder, and
 * reattaches the existing run identity instead of minting a new one.
 */
export async function productionRestoreDeadDetached(
  input: RestoreDeadDetachedInput,
  io: RestoreDeadDetachedIo = {},
): Promise<{
  ok: boolean;
  runId: string;
  logicalOperationId: string;
  supervisorStarted: boolean;
  reason?: string;
  liveHolder?: { pid: number; hostname: string };
} | null> {
  const homedir = io.homedir ?? os.homedir;
  const hostname = io.hostname ?? os.hostname;
  const readText = io.readText ?? readTextDefault;
  const readdir = io.readdir ?? readdirDefault;
  const isPidAlive =
    io.isPidAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const getStartTime = io.getStartTime ?? getProcessStartTime;
  const spawnFn = io.spawnDetached ?? spawnDetached;
  const statMtimeMs = io.statMtimeMs ?? statMtimeDefault;

  const livePid = findWrapperPidForIssue(input.issueNumber, {
    domain: input.domain,
    homedir: homedir(),
    readdirSync: readdir,
    readText,
    isPidAlive,
    getStartTime,
    statMtimeMs,
    lockPath: issueRunLockPath(input.domain, input.issueNumber),
  });
  if (livePid != null) {
    return {
      ok: false,
      runId: String(input.issueNumber),
      logicalOperationId: String(input.issueNumber),
      supervisorStarted: false,
      reason: "live_holder",
      liveHolder: { pid: livePid, hostname: hostname() },
    };
  }

  const existing = discoverExistingDetachRunId(input, { homedir, readText, readdir, statMtimeMs });
  if (!existing) return null;
  if (detachRunIsVerifiedComplete(input, existing.runId, { readText })) return null;

  try {
    const spawned = await spawnFn(
      input.issueNumber,
      ["--domain", input.domain, "--run-id", existing.runId],
      { domain: input.domain },
    );
    return {
      ok: true,
      runId: existing.runId,
      logicalOperationId: existing.logicalOperationId,
      supervisorStarted: true,
      reason: "attached",
      liveHolder: { pid: spawned.pid, hostname: hostname() },
    };
  } catch (err) {
    const message = (err as Error).message ?? "";
    const holderMatch = message.match(/held by PID (\d+)/i);
    if (/already running/i.test(message)) {
      return {
        ok: false,
        runId: existing.runId,
        logicalOperationId: existing.logicalOperationId,
        supervisorStarted: false,
        reason: "live_holder",
        liveHolder: {
          pid: holderMatch ? Number(holderMatch[1]) : 0,
          hostname: hostname(),
        },
      };
    }
    throw err;
  }
}

export function emptyProviderDeps(
  over: Partial<LivenessProviderDeps> = {},
): LivenessProviderDeps {
  return {
    hostname: () => "localhost",
    now: () => new Date(),
    listRuns: async () => [],
    claimFence: async (run) => ({
      ok: false,
      runId: run.runId,
      supervisorStarted: false,
    }),
    attach: async (run) => ({
      runId: run.runId,
      logicalOperationId: run.logicalOperationId,
      identity: { pid: 0 },
    }),
    refreshIdentity: async () => {},
    adapters: adaptersFromEnv(),
    ...over,
  };
}

export async function runLivenessCli(
  input: LivenessCliInput,
  deps: LivenessCliDeps,
): Promise<{ status?: ContinuousLivenessStatus; restores?: RestoreResult[]; text: string }> {
  if (input.verb === "status") {
    const status = await livenessStatus(deps.provider);
    const text = input.json
      ? JSON.stringify(status)
      : formatLivenessStatus(status);
    return { status, text };
  }
  const restores = await restoreEligibleRuns(deps.provider, { runId: input.runId });
  const text = input.json
    ? JSON.stringify({ restores })
    : formatRestoreResults(restores);
  return { restores, text };
}

export function formatLivenessStatus(status: ContinuousLivenessStatus): string {
  const lines = [
    `liveness: ${status.discriminant}`,
    status.adapter ? `adapter: ${status.adapter}` : "adapter: none",
    `live_worker: ${status.liveWorker ? "yes" : "no"}`,
    `eligible_runs: ${status.eligibleRuns}`,
  ];
  if (status.capabilityCondition) {
    lines.push(
      `capability_condition: ${status.capabilityCondition.reason}` +
        (status.capabilityCondition.adapter ? ` (${status.capabilityCondition.adapter})` : ""),
    );
  }
  return lines.join("\n");
}

export function formatRestoreResults(results: RestoreResult[]): string {
  if (results.length === 0) {
    return "liveness restore: no eligible same-host durable runs";
  }
  return results
    .map((r) => {
      if (r.ok) return `reattached ${r.runId} (logical ${r.logicalOperationId})`;
      if (r.reason === "live_holder") {
        const holder = r.liveHolder
          ? ` pid ${r.liveHolder.pid} on ${r.liveHolder.hostname}`
          : "";
        return `skipped ${r.runId}: live holder${holder}`;
      }
      return `skipped ${r.runId}: ${r.reason ?? "not eligible"}`;
    })
    .join("\n");
}

export { KEEP_ALIVE_ADAPTER_IDS };
