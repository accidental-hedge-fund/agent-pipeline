// Liveness Provider (#1332). Injected store/lock/identity deps only — no real
// network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyObservationalFailure,
  copyProjectsHumanAuthority,
  discoverEligibleRuns,
  evaluateLivenessRestoreFixture,
  fenceHolderIsOriginalWorker,
  invokeKeepAliveAdapter,
  isEligibleForRestore,
  LIVENESS_RESTORE_ARGV,
  livenessStatus,
  projectContinuousLiveness,
  projectWorkerDeath,
  restoreEligibleRuns,
  restoreRun,
  sentinelIsVerifiedCompletion,
  shouldRelinquish,
  type DurableRunSnapshot,
  type KeepAliveAdapter,
  type LivenessProviderDeps,
  type WorkerLivenessResult,
} from "../scripts/liveness-provider.ts";
import {
  LIVENESS_HELP,
  claimLoopFence,
  productionProviderDeps,
  productionRestoreDeadDetached,
  projectLoopRunTerminal,
  runLivenessCli,
} from "../scripts/liveness-cli.ts";
import {
  acquireLock,
  readLock,
  readSupervisorProcess,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PROVIDER_SRC = join(here, "../scripts/liveness-provider.ts");
const CLI_SRC = join(here, "../scripts/liveness-cli.ts");

const HOST = "host-a";

function worker(over: Partial<WorkerLivenessResult> = {}): WorkerLivenessResult {
  return { status: "not-live", reason: "dead_pid", ...over };
}

function run(over: Partial<DurableRunSnapshot> = {}): DurableRunSnapshot {
  return {
    kind: "loop",
    runId: "loop-1",
    logicalOperationId: "lop-abc",
    hostname: HOST,
    hasResumeBinding: true,
    verifiedComplete: false,
    cancelled: false,
    typedRequestForbidsResume: false,
    sameHostDeadPid: true,
    worker: worker(),
    ...over,
  };
}

function serialFence(): {
  claim: LivenessProviderDeps["claimFence"];
  attachCount: () => number;
  winners: () => string[];
} {
  let held = false;
  let attachCount = 0;
  const winners: string[] = [];
  return {
    winners: () => winners,
    attachCount: () => attachCount,
    claim: async (r) => {
      if (held) {
        return {
          ok: false,
          runId: r.runId,
          supervisorStarted: false,
          liveHolder: { pid: 99, hostname: HOST },
        };
      }
      held = true;
      winners.push(r.runId);
      attachCount += 0;
      return { ok: true, runId: r.runId, token: "tok-1", supervisorStarted: false };
    },
  };
}

function deps(over: Partial<LivenessProviderDeps> & { runs?: DurableRunSnapshot[] } = {}): LivenessProviderDeps {
  const fence = serialFence();
  const { runs, ...rest } = over;
  return {
    hostname: () => HOST,
    now: () => new Date("2026-09-02T00:00:00.000Z"),
    listRuns: async () => runs ?? [run()],
    claimFence: fence.claim,
    attach: async (r) => {
      (fence as { _attach?: number })._attach = ((fence as { _attach?: number })._attach ?? 0) + 1;
      return {
        runId: r.runId,
        logicalOperationId: r.logicalOperationId,
        identity: { pid: 1001, boot_id: "boot-new", started_at: "2026-09-02T00:00:01.000Z" },
      };
    },
    refreshIdentity: async () => {},
    adapters: [],
    ...rest,
  };
}

test("discover lists a same-host non-terminal not-live run", async () => {
  const listed = await discoverEligibleRuns(deps());
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.runId, "loop-1");
});

test("discover hides verified-complete, cancelled, and cross-host records", async () => {
  const listed = await discoverEligibleRuns(deps({
    runs: [
      run({ runId: "done", verifiedComplete: true }),
      run({ runId: "cancel", cancelled: true }),
      run({ runId: "other-host", hostname: "host-b" }),
      run({ runId: "live", worker: worker({ status: "live", reason: "live" }), sameHostDeadPid: false }),
      run({ runId: "ok" }),
    ],
  }));
  assert.deepEqual(listed.map((r) => r.runId), ["ok"]);
});

test("two concurrent restore fixtures grant exactly one fence", async () => {
  let held = false;
  let attachCount = 0;
  const shared: LivenessProviderDeps = deps({
    claimFence: async (r) => {
      if (held) {
        return {
          ok: false,
          runId: r.runId,
          supervisorStarted: false,
          liveHolder: { pid: 7, hostname: HOST },
        };
      }
      held = true;
      return { ok: true, runId: r.runId, token: "tok", supervisorStarted: false };
    },
    attach: async (r) => {
      attachCount += 1;
      return {
        runId: r.runId,
        logicalOperationId: r.logicalOperationId,
        identity: { pid: 8, started_at: "t" },
      };
    },
  });
  const first = await restoreRun(run(), shared);
  const second = await restoreRun(run(), shared);
  assert.equal(first.ok, true);
  assert.equal(first.supervisorStarted, true);
  assert.equal(second.ok, false);
  assert.equal(second.supervisorStarted, false);
  assert.equal(second.reason, "live_holder");
  assert.equal(attachCount, 1);
});

test("restore keeps the original run identity and Logical Operation", async () => {
  const result = await restoreRun(run(), deps());
  assert.equal(result.ok, true);
  assert.equal(result.runId, "loop-1");
  assert.equal(result.logicalOperationId, "lop-abc");
});

test("non-zero sentinel plus unproven postcondition remains eligible", () => {
  const snapshot = run({
    sentinelExitCode: 1,
    postconditionProven: false,
    verifiedComplete: false,
  });
  assert.equal(sentinelIsVerifiedCompletion(snapshot), false);
  assert.equal(isEligibleForRestore(snapshot, HOST), true);
});

test("follow interruption leaves the ledger unchanged", () => {
  const ledger = { stop: null, run_id: "loop-1" };
  assert.equal(applyObservationalFailure(ledger), ledger);
  assert.equal(shouldRelinquish({}), false);
  assert.equal(shouldRelinquish({ verifiedSuccess: true }), true);
});

test("observational sink failure does not change lifecycle", () => {
  const ledger = { stop: null, items: { a: { state: "in_progress" } } };
  const after = applyObservationalFailure(ledger);
  assert.deepEqual(after, ledger);
});

test("worker death does not project human authority", () => {
  const projection = projectWorkerDeath({ genuineTypedRequest: false });
  assert.equal(projection.liveness, "not-live");
  assert.equal(projection.humanAuthority, false);
  assert.equal(projection.needsHuman, false);
  assert.equal(projection.decisionRequest, false);
  assert.equal(copyProjectsHumanAuthority("worker pid 12 is not-live"), false);
  assert.equal(copyProjectsHumanAuthority("needs-human because the worker died"), true);
  assert.equal(copyProjectsHumanAuthority("Decision Request: worker death"), true);
});

test("PID reuse cannot steal the fence", () => {
  assert.equal(
    fenceHolderIsOriginalWorker({
      lockMarker: "12 1000",
      livePid: 12,
      liveStarttime: "9999",
      pidAlive: true,
    }),
    false,
  );
  assert.equal(
    fenceHolderIsOriginalWorker({
      lockMarker: "12 1000",
      livePid: 12,
      liveStarttime: "1000",
      pidAlive: true,
    }),
    true,
  );
});

test("status covers configured, available, active, and degraded/unavailable", () => {
  const systemd: KeepAliveAdapter = {
    id: "systemd",
    configured: true,
    restoreArgv: LIVENESS_RESTORE_ARGV,
  };
  assert.equal(projectContinuousLiveness({ adapters: [], liveWorker: false }).discriminant, "unavailable");
  assert.equal(
    projectContinuousLiveness({ adapters: [systemd], liveWorker: false }).discriminant,
    "configured",
  );
  assert.equal(
    projectContinuousLiveness({
      adapters: [{ ...systemd, probeOk: true }],
      liveWorker: false,
    }).discriminant,
    "available",
  );
  assert.equal(
    projectContinuousLiveness({
      adapters: [{ ...systemd, probeOk: true }],
      liveWorker: true,
    }).discriminant,
    "active",
  );
  const degraded = projectContinuousLiveness({
    adapters: [{ ...systemd, probeOk: false }],
    liveWorker: false,
  });
  assert.equal(degraded.discriminant, "degraded");
  assert.equal(degraded.capabilityCondition?.adapter, "systemd");
});

test("restore does not import recovery-recipe selection", () => {
  const provider = readFileSync(PROVIDER_SRC, "utf8");
  const cli = readFileSync(CLI_SRC, "utf8");
  for (const src of [provider, cli]) {
    assert.doesNotMatch(src, /repair-pipeline-item/);
    assert.doesNotMatch(src, /fault-recovery-matrix/);
    assert.doesNotMatch(src, /recover-parked/);
    assert.doesNotMatch(src, /chooseRecipe/);
    assert.doesNotMatch(src, /run_fatal/);
  }
});

test("command-registry help names discover/claim/reattach only", () => {
  assert.match(LIVENESS_HELP, /discover, claim, and reattach/);
  assert.doesNotMatch(LIVENESS_HELP, /pipeline recover/);
  assert.doesNotMatch(LIVENESS_HELP, /pipeline merge/);
  assert.doesNotMatch(LIVENESS_HELP, /pipeline repair/);
});

test("liveness CLI restore walks eligible runs without minting a new identity", async () => {
  const provider = deps();
  const out = await runLivenessCli({ verb: "restore" }, { provider });
  assert.equal(out.restores?.length, 1);
  assert.equal(out.restores?.[0]?.runId, "loop-1");
  assert.equal(out.restores?.[0]?.logicalOperationId, "lop-abc");
});

test("injected adapter invokeRestore calls restore argv, not a host recipe", async () => {
  const called: string[][] = [];
  const adapter: KeepAliveAdapter = {
    id: "systemd",
    configured: true,
    restoreArgv: LIVENESS_RESTORE_ARGV,
    invokeRestore: async (argv) => {
      called.push([...argv]);
    },
  };
  const argv = await invokeKeepAliveAdapter(adapter);
  assert.deepEqual([...argv], ["liveness", "restore"]);
  assert.deepEqual(called, [["liveness", "restore"]]);
});

test("host restore fixture compares typed outcomes, not prompt text", () => {
  const direct = evaluateLivenessRestoreFixture({
    restoreSupport: "supported",
    workerDead: true,
    ledgerTerminal: false,
    directCliOutcome: "cooling",
    hostOutcome: "cooling",
  });
  assert.equal(direct.matchesDirectCli, true);
  assert.equal(direct.cell.kind, "typed_outcome");
  assert.equal(direct.falseHuman, false);

  const unsupported = evaluateLivenessRestoreFixture({
    restoreSupport: "unsupported",
    workerDead: true,
    ledgerTerminal: false,
    directCliOutcome: "verified_success",
  });
  assert.equal(unsupported.cell.kind, "not_applicable");
  assert.equal(unsupported.falseHuman, false);
});

test("livenessStatus uses injected adapters and runs", async () => {
  const status = await livenessStatus(deps({
    adapters: [{ id: "launchd", configured: true, probeOk: true, restoreArgv: LIVENESS_RESTORE_ARGV }],
    runs: [run({ worker: worker({ status: "live", reason: "live" }), sameHostDeadPid: false })],
  }));
  assert.equal(status.discriminant, "active");
  assert.equal(status.adapter, "launchd");
});

test("dead-pid restore does not record run_fatal or a terminal stop", async () => {
  const ledger = { run_id: "loop-1", stop: null as null | { reason: string } };
  const provider = deps({
    attach: async (r) => {
      assert.equal(ledger.stop, null);
      return {
        runId: r.runId,
        logicalOperationId: r.logicalOperationId,
        identity: { pid: 3 },
      };
    },
  });
  const result = await restoreRun(run(), provider);
  assert.equal(result.ok, true);
  assert.equal(ledger.stop, null);
});

test("projectLoopRunTerminal reads completion and cancellation from ledger/events", () => {
  const pending: LoopLedger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "loop-1",
    items: { "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } } },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  };
  assert.equal(projectLoopRunTerminal(pending).verifiedComplete, false);
  assert.equal(projectLoopRunTerminal(pending).cancelled, false);

  const done: LoopLedger = {
    ...pending,
    items: { "100": { id: "100", state: "ready", history: [], recovery_budgets_remaining: { default: 3 } } },
  };
  assert.equal(projectLoopRunTerminal(done).verifiedComplete, true);
  assert.equal(projectLoopRunTerminal(done).postconditionProven, true);

  const cancelled = projectLoopRunTerminal(pending, [{ kind: "loop_run_cancelled" }]);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.verifiedComplete, false);
});

function memStore(over: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  const alive = new Set<number>([111]);
  let uuid = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: "/state-liveness" };
  const deps: LoopStoreDeps = {
    async fsExists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/"));
    },
    async readTextFile(p) {
      return files.has(p) ? files.get(p)! : null;
    },
    async writeFileAtomic(p, content) {
      files.set(p, content);
    },
    async createFileExclusive(p, content) {
      if (files.has(p)) return false;
      files.set(p, content);
      return true;
    },
    async removeFile(p) {
      files.delete(p);
    },
    async removeFileIfMatches(p, expected) {
      if (files.get(p) !== expected) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      files.set(p, (files.get(p) ?? "") + line + "\n");
    },
    async mkdirp() {},
    async renameDirExclusive() {
      return true;
    },
    async listDir(p) {
      const prefix = p.endsWith("/") ? p : p + "/";
      return [...new Set(
        [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]!),
      )];
    },
    async isPidAlive(pid) {
      return alive.has(pid);
    },
    hostname: () => HOST,
    pid: () => 111,
    now: () => new Date("2026-09-02T00:00:00.000Z"),
    uuid: () => `uuid-${uuid++}`,
    env,
    ...over,
  };
  return { deps, files };
}

function seedLoopRun(
  files: Map<string, string>,
  over: { runId?: string; itemState?: string; logicalOperationId?: string; eventKind?: string } = {},
): void {
  const runId = over.runId ?? "loop-1";
  const dir = `/state-liveness/runs/${runId}`;
  const contract: Partial<LoopContract> = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: runId,
    logical_operation_id: over.logicalOperationId ?? "lop-abc",
    engine: "codex",
    repo: { name: "acme/widgets", base_branch: "main" },
    items: [{ id: "100", depends_on: [] }],
  };
  const ledger: Partial<LoopLedger> = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: runId,
    items: {
      "100": {
        id: "100",
        state: (over.itemState ?? "in_progress") as LoopLedger["items"][string]["state"],
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
  };
  files.set(`${dir}/contract.json`, JSON.stringify(contract));
  files.set(`${dir}/ledger.json`, JSON.stringify(ledger));
  if (over.eventKind) {
    files.set(`${dir}/events.jsonl`, JSON.stringify({ seq: 0, time: "t", kind: over.eventKind, data: {} }) + "\n");
  }
}

function seedDeadLock(files: Map<string, string>, runId: string, pid = 999): void {
  files.set(
    `/state-liveness/runs/${runId}/lock.json`,
    JSON.stringify({
      engine: "codex",
      pid,
      hostname: HOST,
      acquired_at: "2026-09-01T00:00:00.000Z",
      token: `old-${runId}`,
      run_id: runId,
    }),
  );
}

test("production listRuns projects verified-complete and cancelled loop runs", async () => {
  const { deps, files } = memStore();
  seedLoopRun(files, { runId: "done", itemState: "ready", logicalOperationId: "lop-done" });
  seedLoopRun(files, { runId: "cancel", eventKind: "loop_run_cancelled", logicalOperationId: "lop-cancel" });
  seedLoopRun(files, { runId: "live-work", logicalOperationId: "lop-live" });
  seedDeadLock(files, "done");
  seedDeadLock(files, "cancel");
  seedDeadLock(files, "live-work");
  const provider = productionProviderDeps({}, { store: deps, spawnSupervisor: async () => ({ pid: 2001 }) });
  const listed = await provider.listRuns();
  const byId = Object.fromEntries(listed.map((r) => [r.runId, r]));
  assert.equal(byId["done"]?.verifiedComplete, true);
  assert.equal(byId["cancel"]?.cancelled, true);
  assert.equal(byId["live-work"]?.verifiedComplete, false);
  assert.equal(byId["live-work"]?.cancelled, false);
  const eligible = await discoverEligibleRuns(provider);
  assert.deepEqual(eligible.map((r) => r.runId), ["live-work"]);
});

test("production claimFence acquires a fresh token; second claim sees the live holder", async () => {
  const { deps, files } = memStore();
  seedLoopRun(files);
  const snapshot = run({ runId: "loop-1", logicalOperationId: "lop-abc" });
  const first = await claimLoopFence(deps, snapshot);
  assert.equal(first.ok, true);
  assert.ok(first.token);
  const held = await readLock(deps, "loop-1");
  assert.equal(held?.pid, 111);
  const second = await claimLoopFence(deps, snapshot);
  assert.equal(second.ok, false);
  assert.equal(second.liveHolder?.pid, 111);
  assert.equal(second.supervisorStarted, false);
});

test("production claimFence recovers a stale same-host dead-pid lock before attach", async () => {
  const { deps, files } = memStore();
  seedLoopRun(files);
  const deadStore: LoopStoreDeps = { ...deps, pid: () => 999 };
  await acquireLock(deadStore, "loop-1", "codex");
  const snapshot = run({ runId: "loop-1" });
  const claimed = await claimLoopFence(deps, snapshot);
  assert.equal(claimed.ok, true);
  const held = await readLock(deps, "loop-1");
  assert.equal(held?.pid, 111);
  assert.notEqual(held?.token, undefined);
  const second = await claimLoopFence(deps, snapshot);
  assert.equal(second.ok, false);
  assert.equal(second.liveHolder?.pid, 111);
});

test("production attach spawns the supervisor and persists worker identity", async () => {
  const { deps, files } = memStore();
  seedLoopRun(files);
  const spawned: string[] = [];
  const provider = productionProviderDeps({}, {
    store: deps,
    spawnSupervisor: async (input) => {
      spawned.push(input.runId);
      return { pid: 2001 };
    },
  });
  const snapshot = run({ runId: "loop-1", logicalOperationId: "lop-abc" });
  const result = await restoreRun(snapshot, provider);
  assert.equal(result.ok, true);
  assert.equal(result.runId, "loop-1");
  assert.equal(result.logicalOperationId, "lop-abc");
  assert.equal(result.supervisorStarted, true);
  assert.deepEqual(spawned, ["loop-1"]);
  assert.equal(result.identity?.pid, 2001);
  const supervisor = await readSupervisorProcess(deps, "loop-1");
  assert.equal(supervisor?.pid, 2001);
  assert.equal(supervisor?.run_id, "loop-1");
});

test("productionRestoreDeadDetached reattaches existing identity and refuses a live holder", async () => {
  const files = new Map<string, string>([
    ["/home/.pipeline/runs/repo/99/w1/run-store.json", JSON.stringify({ run_store_run_id: "99-existing" })],
    ["/repo/.agent-pipeline/runs/99-existing/events.jsonl", '{"type":"stage_start"}\n'],
  ]);
  const spawned: string[][] = [];
  const restored = await productionRestoreDeadDetached(
    { issueNumber: 99, domain: "repo", repoDir: "/repo" },
    {
      homedir: () => "/home",
      hostname: () => HOST,
      readText: (p) => files.get(p) ?? null,
      readdir: (p) => {
        const prefix = p.endsWith("/") ? p : p + "/";
        return [...new Set(
          [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]!),
        )];
      },
      isPidAlive: () => false,
      getStartTime: () => null,
      statMtimeMs: () => 1,
      spawnDetached: async (_issue, args) => {
        spawned.push([...args]);
        return { runDir: "/tmp/w", pid: 3001 };
      },
    },
  );
  assert.equal(restored?.ok, true);
  assert.equal(restored?.runId, "99-existing");
  assert.equal(restored?.logicalOperationId, "99-existing");
  assert.ok(spawned[0]?.includes("99-existing"));

  const live = await productionRestoreDeadDetached(
    { issueNumber: 99, domain: "repo", repoDir: "/repo" },
    {
      homedir: () => "/home",
      hostname: () => HOST,
      readText: (p) => (p.includes(".lock") ? "4242 1000" : files.get(p) ?? null),
      readdir: () => ["w1"],
      isPidAlive: (pid) => pid === 4242,
      getStartTime: () => "1000",
      statMtimeMs: () => 1,
      spawnDetached: async () => {
        throw new Error("must not spawn");
      },
    },
  );
  assert.equal(live?.ok, false);
  assert.equal(live?.reason, "live_holder");
  assert.equal(live?.liveHolder?.pid, 4242);
});

test("productionRestoreDeadDetached does not restore a verified-complete run", async () => {
  const files = new Map<string, string>([
    ["/home/.pipeline/runs/repo/99/w1/run-store.json", JSON.stringify({ run_store_run_id: "99-done" })],
    ["/repo/.agent-pipeline/runs/99-done/summary.json", "{}"],
    ["/repo/.agent-pipeline/runs/99-done/events.jsonl", '{"type":"run_complete"}\n'],
  ]);
  const restored = await productionRestoreDeadDetached(
    { issueNumber: 99, domain: "repo", repoDir: "/repo" },
    {
      homedir: () => "/home",
      hostname: () => HOST,
      readText: (p) => files.get(p) ?? null,
      readdir: (p) => {
        const prefix = p.endsWith("/") ? p : p + "/";
        return [...new Set(
          [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]!),
        )];
      },
      isPidAlive: () => false,
      statMtimeMs: () => 1,
      spawnDetached: async () => {
        throw new Error("must not spawn a completed run");
      },
    },
  );
  assert.equal(restored, null);
});

test("restoreEligibleRuns twice does not start a second supervisor", async () => {
  let held = false;
  let attachCount = 0;
  const provider = deps({
    claimFence: async (r) => {
      if (held) {
        return { ok: false, runId: r.runId, supervisorStarted: false, liveHolder: { pid: 1, hostname: HOST } };
      }
      held = true;
      return { ok: true, runId: r.runId, token: "t", supervisorStarted: false };
    },
    attach: async (r) => {
      attachCount += 1;
      return { runId: r.runId, logicalOperationId: r.logicalOperationId, identity: { pid: 2 } };
    },
  });
  const first = await restoreEligibleRuns(provider);
  const second = await restoreEligibleRuns(provider);
  assert.equal(first[0]?.supervisorStarted, true);
  assert.equal(second[0]?.supervisorStarted, false);
  assert.equal(attachCount, 1);
});
