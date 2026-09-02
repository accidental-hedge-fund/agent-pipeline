// CLI surfaces for the Liveness Provider (#1332).
//
// `pipeline liveness status` — discover/claim capability report for doctor.
// `pipeline liveness restore` — discover, claim, reattach. Not recovery, not merge.

import * as path from "node:path";
import {
  KEEP_ALIVE_ADAPTER_IDS,
  classifyWorkerFromSnapshot,
  defaultKeepAliveAdapters,
  livenessStatus,
  restoreEligibleRuns,
  type ContinuousLivenessStatus,
  type DurableRunSnapshot,
  type KeepAliveAdapter,
  type LivenessProviderDeps,
  type RestoreResult,
} from "./liveness-provider.ts";
import {
  classifyStaleness,
  defaultLoopStoreDeps,
  readLedger,
  readLock,
  readLoopRunHandoff,
  readSupervisorProcess,
  resolveStateHome,
  type LoopStoreDeps,
} from "./loop/store.ts";

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
  for (const runId of ids) {
    try {
      const ledger = await readLedger(store, runId);
      const lock = await readLock(store, runId);
      const handoff = await readLoopRunHandoff(store, runId);
      const supervisor = await readSupervisorProcess(store, runId);
      const sameHost = !lock || lock.hostname === hostname;
      const pidAlive = lock ? await store.isPidAlive(lock.pid) : false;
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
      out.push({
        kind: "loop",
        runId,
        logicalOperationId,
        hostname: lock?.hostname ?? hostname,
        hasResumeBinding: Boolean(handoff || ledger),
        verifiedComplete: false,
        cancelled: false,
        typedRequestForbidsResume: Boolean(ledger.stop),
        sameHostDeadPid: sameHost && staleness === "stale_same_host_dead_pid",
        worker,
        postconditionProven: false,
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

export function productionProviderDeps(
  env: NodeJS.ProcessEnv = process.env,
): LivenessProviderDeps {
  const store = defaultLoopStoreDeps(env);
  return {
    hostname: () => store.hostname(),
    now: () => store.now(),
    adapters: adaptersFromEnv(env),
    listRuns: () => listLoopRuns(store),
    claimFence: async (run) => {
      const lock = await readLock(store, run.runId);
      if (!lock) return { ok: true, runId: run.runId, supervisorStarted: false };
      const staleness = await classifyStaleness(store, lock);
      if (staleness !== "stale_same_host_dead_pid") {
        return {
          ok: false,
          runId: run.runId,
          supervisorStarted: false,
          liveHolder: { pid: lock.pid, hostname: lock.hostname },
        };
      }
      return { ok: true, runId: run.runId, supervisorStarted: false, token: lock.token };
    },
    attach: async (run) => ({
      runId: run.runId,
      logicalOperationId: run.logicalOperationId,
      identity: {
        pid: store.pid(),
        started_at: store.now().toISOString(),
      },
    }),
    refreshIdentity: async () => {},
  };
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
