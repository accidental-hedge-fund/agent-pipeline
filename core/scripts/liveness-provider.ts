// Host-neutral Liveness Provider (#1332).
//
// Discovers machine-local durable runs, claims a fenced same-host lease,
// starts or reattaches the existing supervisor, refreshes worker identity,
// follows events, and relinquishes on terminal evidence. Does not classify
// faults, choose recovery recipes, answer requests, merge, or create a ledger.

import {
  classifyWorkerLiveness,
  parseProcessIdentityMarker,
  processIdentityMatches,
  type WorkerIdentity,
  type WorkerLivenessResult,
} from "./worker-identity.ts";

export const LIVENESS_RESTORE_ARGV = ["liveness", "restore"] as const;
export const LIVENESS_STATUS_ARGV = ["liveness", "status"] as const;

export const KEEP_ALIVE_ADAPTER_IDS = ["systemd", "launchd", "container", "harness-worker"] as const;
export type KeepAliveAdapterId = (typeof KEEP_ALIVE_ADAPTER_IDS)[number];

export type ContinuousLivenessDiscriminant =
  | "configured"
  | "available"
  | "active"
  | "degraded"
  | "unavailable";

export type TypedCapabilityConditionReason =
  | "keep_alive_unconfigured"
  | "keep_alive_broken"
  | "keep_alive_unavailable";

export interface TypedCapabilityCondition {
  kind: "typed_capability_condition";
  reason: TypedCapabilityConditionReason;
  adapter?: string;
}

export interface KeepAliveAdapter {
  id: KeepAliveAdapterId;
  configured: boolean;
  /** Undefined means configured but not yet probed (projects `configured`). */
  probeOk?: boolean;
  brokenDetail?: string;
  restoreArgv: readonly string[];
  invokeRestore?: (argv: readonly string[]) => Promise<void>;
}

export type DurableRunKind = "loop" | "detach";

export interface DurableRunSnapshot {
  kind: DurableRunKind;
  runId: string;
  logicalOperationId: string;
  hostname: string;
  hasResumeBinding: boolean;
  verifiedComplete: boolean;
  cancelled: boolean;
  typedRequestForbidsResume: boolean;
  sameHostDeadPid: boolean;
  worker: WorkerLivenessResult;
  sentinelExitCode?: number | null;
  postconditionProven?: boolean;
  lock?: {
    pid: number;
    starttime?: string | null;
    token?: string;
    hostname: string;
  };
  issueNumber?: number;
  domain?: string;
}

export interface FenceClaim {
  ok: boolean;
  runId: string;
  token?: string;
  liveHolder?: { pid: number; hostname: string };
  supervisorStarted: false;
}

export interface AttachResult {
  runId: string;
  logicalOperationId: string;
  identity: WorkerIdentity;
}

export interface RestoreResult {
  ok: boolean;
  runId: string;
  logicalOperationId: string;
  supervisorStarted: boolean;
  reason?: "live_holder" | "not_eligible" | "attached" | "attach_failed";
  liveHolder?: { pid: number; hostname: string };
  identity?: WorkerIdentity;
  follow?: { eventsPath?: string; runId: string };
}

export interface TerminalEvidence {
  verifiedSuccess?: boolean;
  coolingNeedsNoWorker?: boolean;
  genuineTypedRequest?: boolean;
  authenticatedCancellation?: boolean;
}

export interface LivenessProviderDeps {
  hostname: () => string;
  now: () => Date;
  listRuns: () => Promise<DurableRunSnapshot[]>;
  claimFence: (run: DurableRunSnapshot) => Promise<FenceClaim>;
  attach: (run: DurableRunSnapshot, fence: FenceClaim) => Promise<AttachResult>;
  refreshIdentity: (run: DurableRunSnapshot, identity: WorkerIdentity) => Promise<void>;
  adapters: KeepAliveAdapter[];
}

export interface ContinuousLivenessStatus {
  discriminant: ContinuousLivenessDiscriminant;
  adapter: string | null;
  liveWorker: boolean;
  eligibleRuns: number;
  capabilityCondition: TypedCapabilityCondition | null;
}

const HUMAN_AUTHORITY_RE = /needs-human|needs_human|human authority|decision request/i;

export function isEligibleForRestore(
  run: DurableRunSnapshot,
  hostname: string,
): boolean {
  if (run.verifiedComplete) return false;
  if (run.cancelled) return false;
  if (run.typedRequestForbidsResume) return false;
  if (!run.hasResumeBinding) return false;
  if (run.hostname !== hostname) return false;
  if (run.worker.status === "live") return false;
  if (run.worker.status === "not-live") return true;
  return run.sameHostDeadPid;
}

/**
 * Non-zero wrapper sentinel is attempt evidence. It is not verified completion
 * when the Logical Operation postcondition is unproven.
 */
export function sentinelIsVerifiedCompletion(run: Pick<DurableRunSnapshot, "sentinelExitCode" | "postconditionProven" | "verifiedComplete">): boolean {
  if (run.verifiedComplete) return true;
  if (run.postconditionProven) return true;
  if (typeof run.sentinelExitCode === "number" && run.sentinelExitCode !== 0) return false;
  return false;
}

export async function discoverEligibleRuns(
  deps: Pick<LivenessProviderDeps, "hostname" | "listRuns">,
): Promise<DurableRunSnapshot[]> {
  const hostname = deps.hostname();
  const runs = await deps.listRuns();
  return runs.filter((run) => {
    if (sentinelIsVerifiedCompletion(run)) return false;
    return isEligibleForRestore(run, hostname);
  });
}

export async function claimFence(
  run: DurableRunSnapshot,
  deps: Pick<LivenessProviderDeps, "claimFence">,
): Promise<FenceClaim> {
  return deps.claimFence(run);
}

/**
 * Treat a lock pid whose starttime no longer matches as not the original worker.
 * Do not follow the recycled process as the supervisor.
 */
export function fenceHolderIsOriginalWorker(input: {
  lockMarker: string;
  livePid: number;
  liveStarttime: string | null;
  pidAlive: boolean;
}): boolean {
  const recorded = parseProcessIdentityMarker(input.lockMarker);
  if (!recorded) return false;
  if (!input.pidAlive) return false;
  return processIdentityMatches(recorded, { pid: input.livePid, starttime: input.liveStarttime });
}

export async function restoreRun(
  run: DurableRunSnapshot,
  deps: LivenessProviderDeps,
): Promise<RestoreResult> {
  if (!isEligibleForRestore(run, deps.hostname())) {
    return {
      ok: false,
      runId: run.runId,
      logicalOperationId: run.logicalOperationId,
      supervisorStarted: false,
      reason: "not_eligible",
    };
  }
  const fence = await deps.claimFence(run);
  if (!fence.ok) {
    return {
      ok: false,
      runId: run.runId,
      logicalOperationId: run.logicalOperationId,
      supervisorStarted: false,
      reason: "live_holder",
      liveHolder: fence.liveHolder,
    };
  }
  let attached: AttachResult;
  try {
    attached = await deps.attach(run, fence);
  } catch {
    return {
      ok: false,
      runId: run.runId,
      logicalOperationId: run.logicalOperationId,
      supervisorStarted: false,
      reason: "attach_failed",
    };
  }
  await deps.refreshIdentity(run, attached.identity);
  return {
    ok: true,
    runId: attached.runId,
    logicalOperationId: attached.logicalOperationId,
    supervisorStarted: true,
    reason: "attached",
    identity: attached.identity,
    follow: { runId: attached.runId },
  };
}

export async function restoreEligibleRuns(
  deps: LivenessProviderDeps,
  opts: { runId?: string } = {},
): Promise<RestoreResult[]> {
  const eligible = await discoverEligibleRuns(deps);
  const selected = opts.runId ? eligible.filter((r) => r.runId === opts.runId) : eligible;
  const out: RestoreResult[] = [];
  for (const run of selected) {
    out.push(await restoreRun(run, deps));
  }
  return out;
}

export function shouldRelinquish(evidence: TerminalEvidence): boolean {
  return Boolean(
    evidence.verifiedSuccess ||
      evidence.coolingNeedsNoWorker ||
      evidence.genuineTypedRequest ||
      evidence.authenticatedCancellation,
  );
}

/** Follow interruption and observational sink failure leave the ledger unchanged. */
export function applyObservationalFailure<T>(ledger: T): T {
  return ledger;
}

/**
 * Worker death is lost physical liveness. It is never human authority,
 * a Decision Request, or a needs-human hold.
 */
export function projectWorkerDeath(input: {
  genuineTypedRequest: boolean;
}): {
  liveness: "not-live";
  humanAuthority: false;
  needsHuman: false;
  decisionRequest: false;
  typedRequest: boolean;
} {
  return {
    liveness: "not-live",
    humanAuthority: false,
    needsHuman: false,
    decisionRequest: false,
    typedRequest: input.genuineTypedRequest,
  };
}

export function copyProjectsHumanAuthority(text: string): boolean {
  return HUMAN_AUTHORITY_RE.test(text);
}

export function projectContinuousLiveness(input: {
  adapters: KeepAliveAdapter[];
  liveWorker: boolean;
  eligibleRuns?: number;
}): ContinuousLivenessStatus {
  const configured = input.adapters.filter((a) => a.configured);
  const eligibleRuns = input.eligibleRuns ?? 0;
  if (configured.length === 0) {
    return {
      discriminant: "unavailable",
      adapter: null,
      liveWorker: false,
      eligibleRuns,
      capabilityCondition: {
        kind: "typed_capability_condition",
        reason: "keep_alive_unconfigured",
      },
    };
  }
  const broken = configured.find((a) => a.probeOk === false);
  if (broken) {
    return {
      discriminant: "degraded",
      adapter: broken.id,
      liveWorker: false,
      eligibleRuns,
      capabilityCondition: {
        kind: "typed_capability_condition",
        reason: "keep_alive_broken",
        adapter: broken.id,
      },
    };
  }
  if (input.liveWorker) {
    return {
      discriminant: "active",
      adapter: configured[0]!.id,
      liveWorker: true,
      eligibleRuns,
      capabilityCondition: null,
    };
  }
  const unprobed = configured.every((a) => a.probeOk === undefined);
  if (unprobed) {
    return {
      discriminant: "configured",
      adapter: configured[0]!.id,
      liveWorker: false,
      eligibleRuns,
      capabilityCondition: null,
    };
  }
  return {
    discriminant: "available",
    adapter: configured[0]!.id,
    liveWorker: false,
    eligibleRuns,
    capabilityCondition: null,
  };
}

export async function livenessStatus(
  deps: Pick<LivenessProviderDeps, "adapters" | "listRuns" | "hostname">,
): Promise<ContinuousLivenessStatus> {
  const runs = await deps.listRuns();
  const hostname = deps.hostname();
  const liveWorker = runs.some((r) => r.hostname === hostname && r.worker.status === "live");
  const eligibleRuns = runs.filter((r) => isEligibleForRestore(r, hostname)).length;
  return projectContinuousLiveness({
    adapters: deps.adapters,
    liveWorker,
    eligibleRuns,
  });
}

export async function invokeKeepAliveAdapter(adapter: KeepAliveAdapter): Promise<readonly string[]> {
  const argv = adapter.restoreArgv.length > 0 ? adapter.restoreArgv : LIVENESS_RESTORE_ARGV;
  if (adapter.invokeRestore) {
    await adapter.invokeRestore(argv);
  }
  return argv;
}

export function defaultKeepAliveAdapters(input: {
  systemdConfigured?: boolean;
  launchdConfigured?: boolean;
  containerConfigured?: boolean;
  harnessWorkerConfigured?: boolean;
}): KeepAliveAdapter[] {
  return KEEP_ALIVE_ADAPTER_IDS.map((id) => {
    const configured =
      (id === "systemd" && !!input.systemdConfigured) ||
      (id === "launchd" && !!input.launchdConfigured) ||
      (id === "container" && !!input.containerConfigured) ||
      (id === "harness-worker" && !!input.harnessWorkerConfigured);
    return {
      id,
      configured,
      restoreArgv: LIVENESS_RESTORE_ARGV,
    };
  });
}

export function classifyWorkerFromSnapshot(input: {
  now: Date;
  recorded: WorkerIdentity | null;
  observed: WorkerIdentity | null;
  pidAlive: boolean | "unreadable";
}): WorkerLivenessResult {
  return classifyWorkerLiveness({
    now: input.now,
    recorded: input.recorded,
    observed: input.observed,
    pidAlive: input.pidAlive,
  });
}

export type TypedLifecycleOutcome =
  | "verified_success"
  | "cooling"
  | "external_condition_wait"
  | "typed_request"
  | "cancellation";

export type LivenessCapabilityCell =
  | { kind: "typed_outcome"; outcome: TypedLifecycleOutcome }
  | { kind: "capability_request"; reason: string }
  | { kind: "not_applicable"; reason: string };

export function evaluateLivenessRestoreFixture(input: {
  restoreSupport: "supported" | "limited" | "unsupported";
  workerDead: boolean;
  ledgerTerminal: boolean;
  directCliOutcome: TypedLifecycleOutcome;
  hostOutcome?: TypedLifecycleOutcome;
}): {
  cell: LivenessCapabilityCell;
  matchesDirectCli: boolean;
  falseHuman: false;
} {
  if (input.restoreSupport === "unsupported") {
    return {
      cell: { kind: "not_applicable", reason: "restore_unsupported" },
      matchesDirectCli: true,
      falseHuman: false,
    };
  }
  const outcome = input.hostOutcome ?? input.directCliOutcome;
  return {
    cell: { kind: "typed_outcome", outcome },
    matchesDirectCli: outcome === input.directCliOutcome,
    falseHuman: false,
  };
}
