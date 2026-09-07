import {
  adapterResponseFromFault,
  observationFromAdapterRaw,
  type AdapterObservation,
  type MatrixFaultState,
} from "./fault-recovery-matrix.ts";
import { DEFAULT_RECOVERY_POLICY } from "./loop/recovery.ts";
import { driveSupervisor, type SupervisorDeps } from "./loop/supervisor.ts";
import { initRun, type LoopStoreDeps } from "./loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "./loop/types.ts";

let observerSequence = 0;

function memoryStore(identity: string): LoopStoreDeps {
  const files = new Map<string, string>();
  let clock = Date.parse("2026-09-07T00:00:00.000Z");
  let uuid = 0;
  return {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((key) => key.startsWith(`${p}/`));
    },
    async readTextFile(p) { return files.get(p) ?? null; },
    async writeFileAtomic(p, content) { files.set(p, content); },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) { files.delete(p); },
    async removeFileIfMatches(p, expected) {
      if (files.get(p) !== expected) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) { files.set(p, `${files.get(p) ?? ""}${line}\n`); },
    async mkdirp() {},
    async renameDirExclusive(from, to) {
      const prefix = `${from}/`;
      if ([...files.keys()].some((key) => key === to || key.startsWith(`${to}/`))) return false;
      for (const key of [...files.keys()]) {
        if (!key.startsWith(prefix)) continue;
        files.set(`${to}/${key.slice(prefix.length)}`, files.get(key)!);
        files.delete(key);
      }
      return true;
    },
    async listDir(p) {
      const prefix = `${p}/`;
      return [...new Set(
        [...files.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => key.slice(prefix.length).split("/")[0]!)
          .filter(Boolean),
      )];
    },
    async isPidAlive() { return false; },
    hostname: () => "qualification-host",
    pid: () => 41000 + observerSequence,
    now: () => new Date((clock += 1000)),
    uuid: () => `${identity}-uuid-${uuid++}`,
    env: { AGENT_PIPELINE_STATE_HOME: `/qualification/${identity}` },
  };
}

/** Execute one injected adapter fault through the real RecoverySupervisor. */
export async function observeFaultThroughRecoverySupervisor(
  faultState: MatrixFaultState,
): Promise<AdapterObservation> {
  const identity = `qualification-${observerSequence++}`;
  const runId = `${identity}-run`;
  const itemId = "100";
  const { raw, response } = adapterResponseFromFault({
    fault_state: faultState,
    item_id: itemId,
    run_id: runId,
  });
  const store = memoryStore(identity);
  const contract: LoopContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
    engine: "codex",
    repo: { name: "qualification/closed", base_branch: "main" },
    selector: { type: "milestone", value: "qualification" },
    objective: "closed candidate fault qualification",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 3 },
    recovery_policy: Object.fromEntries(
      Object.entries(DEFAULT_RECOVERY_POLICY).map(([key, value]) => [
        key,
        { ...value, backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 } },
      ]),
    ) as typeof DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [{ id: itemId, depends_on: [] }],
    canonical_hash: "qualification",
  };
  const ledger: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: runId,
    items: {
      [itemId]: {
        id: itemId,
        state: "pending",
        history: [],
        recovery_budgets_remaining: { default: 3 },
      },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
  await initRun(store, contract, ledger);
  const dispatchItem: SupervisorDeps["dispatchItem"] = async () => response;
  const result = await driveSupervisor(
    {
      store,
      observe: {
        async getIssueStateAndLabels() { return { state: "open", labels: ["pipeline:ready"] }; },
        async findPrForIssue() { return null; },
        async getPrDetail() { return null; },
        async getPrChecks() { return []; },
        async getLocalHead() { return null; },
        async baseBranchContainsSha() { return null; },
        async getLabelEvents() { return []; },
        async getExternalDependencyIssueState() { return null; },
        now: () => new Date("2026-09-07T00:00:00.000Z"),
      },
      dispatchItem,
      executeRecovery: async () => ({
        succeeded: false,
        evidence: "qualification injected fault",
        error: "qualification injected",
      }),
      probeLiveAdvance: () => ({ live: false as const }),
      acquireItemAdvanceLock: async () => ({ release() {} }),
    },
    { runId, engine: "codex", maxCycles: 20 },
  );
  return observationFromAdapterRaw(raw, faultState, {
    stop: result.stop,
    cooling: result.cooling ?? null,
  });
}
