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
import { LIVENESS_HELP, runLivenessCli } from "../scripts/liveness-cli.ts";

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
