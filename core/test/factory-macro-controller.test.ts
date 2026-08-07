// Factory macro-controller tests (#890).
//
// Injected filesystem/lock/clock/child seams only — no real network, git, or
// subprocess. Covers hash stability, immutability, CAS races, claim idempotency,
// identity separation, crash matrix, replan, stale revision, duplicate tick,
// legacy run identity, concurrency non-widening, merge isolation, default-off.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeFactoryCanonicalHash,
  stableStringify,
} from "../scripts/factory/hash.ts";
import {
  validateFactoryIdentities,
  resolveFactoryOuterHost,
} from "../scripts/factory/identity.ts";
import {
  adoptOrReplan,
  claimAction,
  tryAcquireDispatchLease,
  tryAcquireOrRecoverDispatchLease,
  updateClaim,
  readCurrentRevision,
  readRevision,
  getFactoryStatus,
  acquireFactoryLock,
  releaseFactoryLock,
  resolveFactoryStateHome,
  factoryRunDir,
  readFactoryEvents,
  readPhaseEvidence,
  type FactoryStoreDeps,
} from "../scripts/factory/store.ts";
import {
  adoptFactoryContract,
  contractGithubIdentitySnapshot,
  derivePhaseAndNextAction,
  githubIdentityDriftReason,
  reconcileLiveIdentity,
  tickFactory,
  factoryStatus,
  FACTORY_CHILD_OPERATIONS,
  FACTORY_FORBIDDEN_MERGE_OPERATIONS,
  type FactoryMacroDeps,
  type ChildRunStatus,
} from "../scripts/factory/controller.ts";
import {
  FACTORY_CONTRACT_SCHEMA,
  FACTORY_SERVICE_CONTROLLER_ID,
  FactoryError,
  type FactoryControlIdentities,
  type FactoryExecutionContractBody,
  type FactoryGithubIdentitySnapshot,
} from "../scripts/factory/types.ts";
import { isFactoryMacroEnabled, isFactoryMacroEnabledFromEnv } from "../scripts/factory/enabled.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// In-memory fake store
// ---------------------------------------------------------------------------

let fakeCounter = 0;

function fakeStore(overrides: Partial<FactoryStoreDeps> = {}): {
  deps: FactoryStoreDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  let clock = new Date("2026-08-07T19:49:11.000Z").getTime();
  let uuidCounter = 0;
  const alivePids = new Set<number>([111]);
  const isolatedEnv = {
    AGENT_PIPELINE_FACTORY_STATE_HOME: `/factory-state-${fakeCounter++}`,
  };

  const deps: FactoryStoreDeps = {
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
    async removeFileIfMatches(p, expectedContent) {
      if (files.get(p) !== expectedContent) return false;
      files.delete(p);
      return true;
    },
    async appendLine(p, line) {
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
    async mkdirp() {},
    async listDir(p) {
      const prefix = p.endsWith("/") ? p : p + "/";
      const names = new Set<string>();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          names.add(k.slice(prefix.length).split("/")[0]!);
        }
      }
      return [...names];
    },
    async isPidAlive(pid) {
      return alivePids.has(pid);
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date(clock),
    uuid: () => `uuid-${uuidCounter++}`,
    env: isolatedEnv,
    ...overrides,
  };
  return { deps, files };
}

function baseIdentities(overrides: Partial<FactoryControlIdentities> = {}): FactoryControlIdentities {
  return {
    service_controller: FACTORY_SERVICE_CONTROLLER_ID,
    outer_host: "session-host-a",
    implementer_treatment: "my-ext",
    reviewer_treatment: "codex",
    privileged_mutation_actor: "operator-session-1",
    ...overrides,
  };
}

function bodyFields(overrides: Record<string, unknown> = {}) {
  return {
    factory_run_id: "frun-1",
    repo: {
      name: "acme/widgets",
      base_branch: "main",
      observed_base_sha: "abc123deadbeef",
    },
    selector: { type: "milestone" as const, value: "v2" },
    issue_ids: ["100", "101"],
    pr_ids: [] as string[],
    milestones: ["v2"],
    dependency_edges: [{ from: "100", to: "101" }],
    linked_runs: {
      loop_run_id: "loop-1",
      loop_contract_hash: "loophash",
      advance_run_id: null,
      legacy_run_identity: null,
    },
    identities: baseIdentities(),
    fingerprints: {
      authority_policy: "auth-fp",
      engine_pin: "pin-fp",
      configuration: "cfg-fp",
      treatment: "treat-fp",
    },
    coarse_phase: "adopted" as const,
    completion_policy: "all_items_ready_to_deploy" as const,
    next_action: "start_loop" as const,
    live_state_reason: null as string | null,
    ...overrides,
  };
}

async function adoptFresh(store: FactoryStoreDeps, overrides: Record<string, unknown> = {}) {
  const body = bodyFields(overrides);
  return adoptOrReplan(store, {
    factory_run_id: body.factory_run_id as string,
    expected_revision: null,
    live_repo: body.repo as { name: string; base_branch: string; observed_base_sha: string },
    factoryModeEnabled: true,
    body: body as never,
  });
}

const DEFAULT_FINGERPRINTS = {
  authority_policy: "auth-fp",
  engine_pin: "pin-fp",
  configuration: "cfg-fp",
  treatment: "treat-fp",
};

function makeMacroDeps(
  store: FactoryStoreDeps,
  opts: {
    loopStatus?: ChildRunStatus;
    advanceStatus?: ChildRunStatus;
    startCalls?: string[];
    fault?: FactoryMacroDeps["_fault"];
    baseSha?: string;
    repoIdentity?: { name: string; base_branch: string };
    /** When true, omit observeRepoIdentity (runtime fail-closed path). */
    omitRepoIdentity?: boolean;
    github?: {
      ok: boolean;
      detail?: string;
      observed?: FactoryGithubIdentitySnapshot;
    } | null;
    /**
     * When set, override the observed GitHub identity snapshot (for drift
     * tests). Defaults to echoing the contracted snapshot when ok.
     */
    githubObserved?: FactoryGithubIdentitySnapshot | "omit";
    /** When true, omit observeGithubSnapshot. */
    omitGithub?: boolean;
    configFingerprints?: {
      authority_policy: string;
      engine_pin: string;
      configuration: string;
      treatment: string;
    } | null;
    /** When true, omit readConfigFingerprints. */
    omitConfigFingerprints?: boolean;
    /** When true, provide advance start/status seams. */
    withAdvance?: boolean;
    /** When true, omit advance seams even if withAdvance would apply. */
    omitAdvance?: boolean;
    /** Shared map so idempotent start survives across makeMacroDeps instances. */
    startedByActionId?: Map<string, string>;
  } = {},
): FactoryMacroDeps {
  const startCalls = opts.startCalls ?? [];
  let loopStatus: ChildRunStatus = opts.loopStatus ?? { state: "not_found" };
  let advanceStatus: ChildRunStatus = opts.advanceStatus ?? { state: "not_found" };
  const startedByActionId = opts.startedByActionId ?? new Map<string, string>();
  const children = new Map<string, ChildRunStatus>();
  const deps: FactoryMacroDeps = {
    store,
    observeBaseSha: async () => opts.baseSha ?? "abc123deadbeef",
    observeRepoIdentity: async () =>
      opts.repoIdentity ?? { name: "acme/widgets", base_branch: "main" },
    observeGithubSnapshot: async ({ contracted }) => {
      if (opts.github) {
        if (opts.github.ok && opts.github.observed == null && opts.githubObserved !== "omit") {
          return {
            ...opts.github,
            observed: opts.githubObserved ?? contracted,
          };
        }
        return opts.github;
      }
      if (opts.githubObserved === "omit") {
        return { ok: true };
      }
      return {
        ok: true,
        observed: opts.githubObserved ?? contracted,
      };
    },
    readConfigFingerprints: async () => opts.configFingerprints ?? DEFAULT_FINGERPRINTS,
    now: () => store.now(),
    startOrResumeLoop: async ({ loop_run_id, factory_run_id, action_id }) => {
      startCalls.push(`loop:${loop_run_id ?? "new"}:${factory_run_id}:${action_id}`);
      // Durable-idempotent on action_id — start must not mint a second child.
      const existing = startedByActionId.get(action_id);
      const id = existing ?? loop_run_id ?? `loop-from-${factory_run_id}`;
      startedByActionId.set(action_id, id);
      loopStatus = { state: "running", run_id: id };
      children.set(id, loopStatus);
      return { loop_run_id: id };
    },
    lookupLoopByActionId: async (action_id) => {
      const id = startedByActionId.get(action_id);
      return id ? { loop_run_id: id } : null;
    },
    observeLoop: async (id) => {
      if (children.has(id)) return children.get(id)!;
      if (loopStatus.state === "not_found") return { state: "not_found" };
      return { ...loopStatus, run_id: "run_id" in loopStatus ? loopStatus.run_id : id } as ChildRunStatus;
    },
    _fault: opts.fault,
  };
  if (opts.omitRepoIdentity) {
    delete (deps as { observeRepoIdentity?: unknown }).observeRepoIdentity;
  }
  if (opts.omitGithub) {
    delete (deps as { observeGithubSnapshot?: unknown }).observeGithubSnapshot;
  }
  if (opts.omitConfigFingerprints) {
    delete (deps as { readConfigFingerprints?: unknown }).readConfigFingerprints;
  }
  if (opts.withAdvance && !opts.omitAdvance) {
    deps.startOrResumeAdvance = async ({ advance_run_id, factory_run_id, action_id }) => {
      startCalls.push(`advance:${advance_run_id ?? "new"}:${factory_run_id}:${action_id}`);
      const existing = startedByActionId.get(action_id);
      const id = existing ?? advance_run_id ?? `advance-from-${factory_run_id}`;
      startedByActionId.set(action_id, id);
      advanceStatus = { state: "running", run_id: id };
      children.set(id, advanceStatus);
      return { advance_run_id: id };
    };
    deps.lookupAdvanceByActionId = async (action_id) => {
      const id = startedByActionId.get(action_id);
      return id ? { advance_run_id: id } : null;
    };
    deps.observeAdvance = async (id) => {
      if (children.has(id)) return children.get(id)!;
      if (advanceStatus.state === "not_found") return { state: "not_found" };
      return {
        ...advanceStatus,
        run_id: "run_id" in advanceStatus ? advanceStatus.run_id : id,
      } as ChildRunStatus;
    };
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Enablement default-off
// ---------------------------------------------------------------------------

test("factory macro-controller is disabled by default in DEFAULT_CONFIG", () => {
  assert.equal(DEFAULT_CONFIG.factory.macro_controller.enabled, false);
  assert.equal(isFactoryMacroEnabled(DEFAULT_CONFIG), false);
  assert.equal(isFactoryMacroEnabled({ factory: { macro_controller: { enabled: false } } }), false);
  assert.equal(isFactoryMacroEnabled({ factory: { macro_controller: { enabled: true } } }), true);
  assert.equal(isFactoryMacroEnabledFromEnv({}), false);
  assert.equal(isFactoryMacroEnabledFromEnv({ PIPELINE_FACTORY_MACRO: "1" }), true);
});

test("config factory block has no auto_merge key", () => {
  const keys = Object.keys(DEFAULT_CONFIG.factory.macro_controller);
  assert.deepEqual(keys, ["enabled"]);
  assert.equal("auto_merge" in DEFAULT_CONFIG.factory, false);
  assert.equal("auto_merge" in DEFAULT_CONFIG.factory.macro_controller, false);
});

// ---------------------------------------------------------------------------
// Canonical hash
// ---------------------------------------------------------------------------

test("canonical hash is stable for equivalent bodies", () => {
  const a: FactoryExecutionContractBody = {
    schema: FACTORY_CONTRACT_SCHEMA,
    revision: 1,
    prior_revision: null,
    prior_canonical_hash: null,
    accepted_at: "2026-08-07T19:49:11.000Z",
    ...bodyFields(),
  } as FactoryExecutionContractBody;
  const b = JSON.parse(JSON.stringify(a)) as FactoryExecutionContractBody;
  // Shuffle key order by rebuild
  const h1 = computeFactoryCanonicalHash(a);
  const h2 = computeFactoryCanonicalHash(b);
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test("canonical hash differs when a minimum field changes", () => {
  const base: FactoryExecutionContractBody = {
    schema: FACTORY_CONTRACT_SCHEMA,
    revision: 1,
    prior_revision: null,
    prior_canonical_hash: null,
    accepted_at: "2026-08-07T19:49:11.000Z",
    ...bodyFields(),
  } as FactoryExecutionContractBody;
  const changed = {
    ...base,
    repo: { ...base.repo, observed_base_sha: "other-sha" },
  };
  assert.notEqual(computeFactoryCanonicalHash(base), computeFactoryCanonicalHash(changed));
});

test("stableStringify sorts object keys", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("five-way identity separation is preserved", () => {
  const ids = validateFactoryIdentities(baseIdentities(), { factoryModeEnabled: true });
  assert.equal(ids.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
  assert.equal(ids.outer_host, "session-host-a");
  assert.equal(ids.implementer_treatment, "my-ext");
  assert.equal(ids.reviewer_treatment, "codex");
  assert.equal(ids.privileged_mutation_actor, "operator-session-1");
});

test("missing identity slot fails closed when factory mode enabled", () => {
  assert.throws(
    () =>
      validateFactoryIdentities(
        { ...baseIdentities(), outer_host: "" },
        { factoryModeEnabled: true },
      ),
    (e: unknown) => e instanceof FactoryError && e.kind === "identity" && /outer_host/.test(e.message),
  );
});

test("non-Claude controller is not recorded as codex", () => {
  assert.throws(
    () =>
      validateFactoryIdentities(
        { ...baseIdentities(), service_controller: "codex" },
        { factoryModeEnabled: true },
      ),
    (e: unknown) => e instanceof FactoryError && e.kind === "identity",
  );
});

test("service_controller cannot collapse into outer_host", () => {
  assert.throws(
    () =>
      validateFactoryIdentities(
        {
          ...baseIdentities(),
          service_controller: FACTORY_SERVICE_CONTROLLER_ID,
          outer_host: FACTORY_SERVICE_CONTROLLER_ID,
        },
        { factoryModeEnabled: true },
      ),
    (e: unknown) => e instanceof FactoryError && /distinct from outer_host/.test((e as Error).message),
  );
});

test("resolveFactoryOuterHost never invents from controller id", () => {
  assert.equal(resolveFactoryOuterHost({}), "unknown");
  assert.equal(resolveFactoryOuterHost({ explicit: "grok" }), "grok");
  assert.equal(
    resolveFactoryOuterHost({ explicit: "not-registered", isRegistered: () => false }),
    "unknown",
  );
});

// ---------------------------------------------------------------------------
// Store: adopt, immutability, CAS, replan
// ---------------------------------------------------------------------------

test("adopt creates revision 1 and current pointer", async () => {
  const { deps } = fakeStore();
  const rev = await adoptFresh(deps);
  assert.equal(rev.revision, 1);
  assert.ok(rev.canonical_hash);
  const cur = await readCurrentRevision(deps, "frun-1");
  assert.equal(cur?.revision, 1);
  assert.equal(cur?.identities.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
});

test("accepted revision body cannot be overwritten", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  await assert.rejects(
    () =>
      adoptOrReplan(deps, {
        factory_run_id: "frun-1",
        expected_revision: null,
        live_repo: bodyFields().repo,
        body: bodyFields() as never,
      }),
    (e: unknown) => e instanceof FactoryError && e.kind === "conflict",
  );
});

test("replan retains prior revision and advances monotonic pointer", async () => {
  const { deps } = fakeStore();
  const r1 = await adoptFresh(deps);
  const r2 = await adoptOrReplan(deps, {
    factory_run_id: "frun-1",
    expected_revision: 1,
    live_repo: bodyFields().repo,
    body: {
      ...bodyFields(),
      coarse_phase: "executing",
      next_action: "observe_loop",
      live_state_reason: "base moved; restart execute",
    } as never,
  });
  assert.equal(r2.revision, 2);
  assert.equal(r2.prior_revision, 1);
  assert.equal(r2.prior_canonical_hash, r1.canonical_hash);
  assert.equal(r2.live_state_reason, "base moved; restart execute");
  const prior = await readRevision(deps, "frun-1", 1);
  assert.equal(prior.canonical_hash, r1.canonical_hash);
  const cur = await readCurrentRevision(deps, "frun-1");
  assert.equal(cur?.revision, 2);
});

test("stale expected revision fails without partial mutation", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  await adoptOrReplan(deps, {
    factory_run_id: "frun-1",
    expected_revision: 1,
    live_repo: bodyFields().repo,
    body: {
      ...bodyFields(),
      live_state_reason: "first replan",
      next_action: "observe_loop",
    } as never,
  });
  await assert.rejects(
    () =>
      adoptOrReplan(deps, {
        factory_run_id: "frun-1",
        expected_revision: 1, // stale
        live_repo: bodyFields().repo,
        body: {
          ...bodyFields(),
          live_state_reason: "stale replan",
          next_action: "start_loop",
        } as never,
      }),
    (e: unknown) => e instanceof FactoryError && /stale expected revision/.test((e as Error).message),
  );
  const cur = await readCurrentRevision(deps, "frun-1");
  assert.equal(cur?.revision, 2);
});

test("changed live identity refuses replan", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  await assert.rejects(
    () =>
      adoptOrReplan(deps, {
        factory_run_id: "frun-1",
        expected_revision: 1,
        live_repo: {
          name: "acme/widgets",
          base_branch: "main",
          observed_base_sha: "DIFFERENT",
        },
        body: {
          ...bodyFields(),
          live_state_reason: "should fail",
        } as never,
      }),
    (e: unknown) => e instanceof FactoryError && /live repository identity/.test((e as Error).message),
  );
  assert.equal((await readCurrentRevision(deps, "frun-1"))?.revision, 1);
});

// ---------------------------------------------------------------------------
// Claims + lock
// ---------------------------------------------------------------------------

test("claim is exclusive — second claim loses and does not overwrite", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const a = await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-start_loop-0",
    action: "start_loop",
    identities: baseIdentities(),
  });
  assert.equal(a.won, true);
  const b = await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-start_loop-0",
    action: "start_loop",
    identities: baseIdentities(),
  });
  assert.equal(b.won, false);
  assert.equal(b.claim.action_id, a.claim.action_id);
});

test("dispatch lease is exclusive", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  assert.equal(await tryAcquireDispatchLease(deps, "frun-1", "r1-start_loop-0"), true);
  assert.equal(await tryAcquireDispatchLease(deps, "frun-1", "r1-start_loop-0"), false);
});

test("unfinished dispatch lease is recoverable when claim has no child_run_id", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const { claim } = await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-start_loop-0",
    action: "start_loop",
    identities: baseIdentities(),
  });
  assert.equal(await tryAcquireDispatchLease(deps, "frun-1", "r1-start_loop-0"), true);
  const recovered = await tryAcquireOrRecoverDispatchLease(
    deps,
    "frun-1",
    "r1-start_loop-0",
    claim,
  );
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.recovered, true);
  // Once child is linked, recovery must not re-grant dispatch.
  await updateClaim(deps, "frun-1", "r1-start_loop-0", {
    state: "started",
    child_run_id: "loop-1",
  });
  const linked = await tryAcquireOrRecoverDispatchLease(
    deps,
    "frun-1",
    "r1-start_loop-0",
    (await claimAction(deps, {
      factory_run_id: "frun-1",
      revision: 1,
      action_id: "r1-start_loop-0",
      action: "start_loop",
      identities: baseIdentities(),
    })).claim,
  );
  assert.equal(linked.acquired, false);
});

test("factory lock acquire/release with token", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const lock = await acquireFactoryLock(deps, "frun-1");
  assert.ok(lock.token);
  await releaseFactoryLock(deps, "frun-1", lock.token);
  // second acquire succeeds after release
  const lock2 = await acquireFactoryLock(deps, "frun-1");
  assert.notEqual(lock2.token, lock.token);
});

test("status is non-mutating", async () => {
  const { deps, files } = fakeStore();
  await adoptFresh(deps);
  const before = [...files.entries()].map(([k, v]) => [k, v] as const);
  const status = await getFactoryStatus(deps, "frun-1");
  assert.equal(status?.revision, 1);
  assert.equal(status?.coarse_phase, "adopted");
  const after = [...files.entries()].map(([k, v]) => [k, v] as const);
  assert.deepEqual(after, before);
});

// ---------------------------------------------------------------------------
// Tick: crash matrix, duplicate, observe
// ---------------------------------------------------------------------------

test("duplicate tick dispatches child at most once", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const macro = makeMacroDeps(deps, { startCalls: starts, loopStatus: { state: "not_found" } });
  const t1 = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  const t2 = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t1.dispatched, true);
  assert.equal(t2.dispatched, false);
  assert.equal(starts.length, 1);
});

test("crash before claim: restart may claim cleanly once", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const faulting = makeMacroDeps(deps, {
    startCalls: starts,
    fault: { crashBeforeClaim: true },
  });
  await assert.rejects(() => tickFactory(faulting, "frun-1", { repoDir: "/repo" }));
  const clean = makeMacroDeps(deps, { startCalls: starts });
  const t = await tickFactory(clean, "frun-1", { repoDir: "/repo" });
  assert.equal(t.dispatched, true);
  assert.equal(starts.length, 1);
});

test("crash after claim: restart does not free second concurrent dispatch", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const faulting = makeMacroDeps(deps, {
    startCalls: starts,
    fault: { crashAfterClaim: true },
  });
  await assert.rejects(() => tickFactory(faulting, "frun-1", { repoDir: "/repo" }));
  // After claim crash: claim exists, lease may not. Restart acquires lease once.
  const clean = makeMacroDeps(deps, { startCalls: starts });
  const t = await tickFactory(clean, "frun-1", { repoDir: "/repo" });
  assert.equal(t.dispatched, true);
  assert.equal(starts.length, 1);
  // Second restart must not start again
  const t2 = await tickFactory(clean, "frun-1", { repoDir: "/repo" });
  assert.equal(t2.dispatched, false);
  assert.equal(starts.length, 1);
});

test("crash after child start (before claim update): restart reconciles via action_id lookup", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const startedByActionId = new Map<string, string>();
  const faulting = makeMacroDeps(deps, {
    startCalls: starts,
    fault: { crashAfterChildStart: true },
    loopStatus: { state: "not_found" },
    startedByActionId,
  });
  await assert.rejects(() => tickFactory(faulting, "frun-1", { repoDir: "/repo" }));
  assert.equal(starts.length, 1);
  // Child was created but claim has no child_run_id; dispatch lease is held.
  // Restart must lookup by action_id and link without a second start invocation.
  const resume = makeMacroDeps(deps, {
    startCalls: starts,
    loopStatus: { state: "not_found" },
    startedByActionId,
  });
  const t = await tickFactory(resume, "frun-1", { repoDir: "/repo" });
  assert.equal(t.dispatched, false); // lookup link, not a new start side-effect
  assert.equal(starts.length, 1); // no second start
  assert.ok(t.child_run_id);
  assert.equal(startedByActionId.get("r1-start_loop-0"), t.child_run_id);
  // Third tick must not start again once child is linked
  const t2 = await tickFactory(resume, "frun-1", { repoDir: "/repo" });
  assert.equal(t2.dispatched, false);
  assert.equal(starts.length, 1);
});

test("timeout after child creation: marks ambiguous_reconcile and lookup prevents double start", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const startedByActionId = new Map<string, string>();
  let startCount = 0;
  // Non-idempotent starter: each call mints a new id unless we prevent re-entry.
  // Proves the controller must not re-invoke start after a lost response when
  // lookup can recover the first child.
  const timeouting: FactoryMacroDeps = {
    store: deps,
    observeBaseSha: async () => "abc123deadbeef",
    observeRepoIdentity: async () => ({ name: "acme/widgets", base_branch: "main" }),
    observeGithubSnapshot: async ({ contracted }) => ({ ok: true, observed: contracted }),
    readConfigFingerprints: async () => DEFAULT_FINGERPRINTS,
    now: () => deps.now(),
    startOrResumeLoop: async ({ action_id }) => {
      startCount += 1;
      starts.push(`start#${startCount}:${action_id}`);
      const id = `loop-created-${startCount}`;
      startedByActionId.set(action_id, id);
      // Child exists under action_id, but response is lost (timeout).
      throw new Error("timeout after child creation");
    },
    lookupLoopByActionId: async (action_id) => {
      const id = startedByActionId.get(action_id);
      return id ? { loop_run_id: id } : null;
    },
    observeLoop: async (id) => ({ state: "running", run_id: id }),
  };
  const t1 = await tickFactory(timeouting, "frun-1", { repoDir: "/repo" });
  assert.equal(startCount, 1);
  assert.equal(t1.dispatched, false);
  assert.equal(t1.claim?.state, "ambiguous_reconcile");
  assert.equal(t1.child_run_id, null);
  assert.match(t1.claim?.outcome_detail ?? "", /timeout after child creation/);

  // Restart: must reconcile via lookup, never mint loop-created-2.
  const t2 = await tickFactory(timeouting, "frun-1", { repoDir: "/repo" });
  assert.equal(startCount, 1, "must not re-invoke start after ambiguous timeout");
  assert.equal(t2.dispatched, false);
  assert.equal(t2.child_run_id, "loop-created-1");
  assert.equal(t2.claim?.state, "started");
  assert.equal(startedByActionId.size, 1);
});

test("crash after ambiguous child result: restart re-queries live truth", async () => {
  const { deps } = fakeStore();
  // Adopt with executing phase and linked loop already started claim path via observe
  await adoptFresh(deps, {
    coarse_phase: "executing",
    next_action: "observe_loop",
    linked_runs: {
      loop_run_id: "loop-1",
      loop_contract_hash: "h",
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  // Seed open claim
  await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-observe_loop-0",
    action: "observe_loop",
    identities: baseIdentities(),
  });
  await updateClaim(deps, "frun-1", "r1-observe_loop-0", {
    state: "ambiguous_reconcile",
    child_run_id: "loop-1",
    outcome_detail: "unknown",
  });

  const starts: string[] = [];
  const macro = makeMacroDeps(deps, {
    startCalls: starts,
    loopStatus: { state: "completed", run_id: "loop-1", all_items_terminal: true, all_ready_to_deploy: true },
  });
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(starts.length, 0);
  assert.ok(
    t.next_action === "operator_merge" || t.coarse_phase === "items_complete" || t.next_action === "observe_loop",
  );
});

test("restart reconstructs without conversation memory — status from durable store", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const s = await factoryStatus({ store: deps } as FactoryMacroDeps, "frun-1");
  assert.equal(s?.revision, 1);
  assert.equal(s?.next_action, "start_loop");
});

test("live base SHA drift fails closed with replan_required (no dispatch)", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const macro = makeMacroDeps(deps, {
    startCalls: starts,
    baseSha: "DIFFERENT-BASE-SHA",
  });
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t.next_action, "replan_required");
  assert.equal(t.dispatched, false);
  assert.equal(starts.length, 0);
  assert.match(t.derive_reason, /base SHA drift/);
  const evidence = await readPhaseEvidence(deps, "frun-1");
  assert.equal(evidence?.next_action, "replan_required");
  assert.ok(evidence?.replan_reason);
  // Read-only status reconstructs the same posture without another tick
  const s = await factoryStatus({ store: deps } as FactoryMacroDeps, "frun-1");
  assert.equal(s?.next_action, "replan_required");
  assert.equal(s?.phase_evidence?.next_action, "replan_required");
});

test("config fingerprint drift fails closed with replan_required", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const t = await tickFactory(
    makeMacroDeps(deps, {
      configFingerprints: {
        authority_policy: "auth-fp",
        engine_pin: "pin-fp",
        configuration: "CHANGED-CFG",
        treatment: "treat-fp",
      },
    }),
    "frun-1",
    { repoDir: "/repo" },
  );
  assert.equal(t.next_action, "replan_required");
  assert.match(t.derive_reason, /configuration fingerprint/);
});

test("GitHub snapshot mismatch fails closed with replan_required", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const t = await tickFactory(
    makeMacroDeps(deps, {
      github: { ok: false, detail: "selector issues changed" },
    }),
    "frun-1",
    { repoDir: "/repo" },
  );
  assert.equal(t.next_action, "replan_required");
  assert.match(t.derive_reason, /GitHub snapshot/);
});

function sampleGithubIdentity(
  overrides: Partial<FactoryGithubIdentitySnapshot> = {},
): FactoryGithubIdentitySnapshot {
  return {
    selector: { type: "milestone", value: "v2" },
    issue_ids: ["100", "101"],
    pr_ids: [],
    milestones: ["v2"],
    dependency_edges: [{ from: "100", to: "101" }],
    ...overrides,
  };
}

function sampleContractForReconcile(overrides: Record<string, unknown> = {}) {
  return {
    repo: { name: "acme/widgets", base_branch: "main", observed_base_sha: "abc" },
    selector: { type: "milestone", value: "v2" },
    issue_ids: ["100", "101"],
    pr_ids: [] as string[],
    milestones: ["v2"],
    dependency_edges: [{ from: "100", to: "101" }],
    fingerprints: DEFAULT_FINGERPRINTS,
    ...overrides,
  } as never;
}

test("reconcileLiveIdentity accepts matching observations", () => {
  const contract = sampleContractForReconcile({
    fingerprints: {
      authority_policy: "a",
      engine_pin: "e",
      configuration: "c",
      treatment: "t",
    },
  });
  assert.equal(
    reconcileLiveIdentity({
      contract,
      base_sha: "abc",
      live_repo: { name: "acme/widgets", base_branch: "main" },
      github: { ok: true, observed: sampleGithubIdentity() },
      configFingerprints: {
        authority_policy: "a",
        engine_pin: "e",
        configuration: "c",
        treatment: "t",
      },
    }).ok,
    true,
  );
});

test("reconcileLiveIdentity fails closed when GitHub observation is absent", () => {
  const contract = sampleContractForReconcile();
  const r = reconcileLiveIdentity({
    contract,
    base_sha: "abc",
    live_repo: { name: "acme/widgets", base_branch: "main" },
    github: null,
    configFingerprints: DEFAULT_FINGERPRINTS,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /GitHub snapshot observation required/);
});

test("reconcileLiveIdentity fails closed when observed GitHub identity is missing", () => {
  const contract = sampleContractForReconcile();
  const r = reconcileLiveIdentity({
    contract,
    base_sha: "abc",
    live_repo: { name: "acme/widgets", base_branch: "main" },
    github: { ok: true },
    configFingerprints: DEFAULT_FINGERPRINTS,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /observed selector\/issue\/PR\/milestone\/dependency/);
});

test("reconcileLiveIdentity fails closed on selector / issue / milestone / dependency drift", () => {
  const contract = sampleContractForReconcile();
  const cases: Array<{ name: string; observed: FactoryGithubIdentitySnapshot; re: RegExp }> = [
    {
      name: "selector",
      observed: sampleGithubIdentity({ selector: { type: "label", value: "ship" } }),
      re: /selector drift/,
    },
    {
      name: "issue_ids",
      observed: sampleGithubIdentity({ issue_ids: ["100", "999"] }),
      re: /issue_ids drift/,
    },
    {
      name: "pr_ids",
      observed: sampleGithubIdentity({ pr_ids: ["55"] }),
      re: /pr_ids drift/,
    },
    {
      name: "milestones",
      observed: sampleGithubIdentity({ milestones: ["v3"] }),
      re: /milestones drift/,
    },
    {
      name: "dependency_edges",
      observed: sampleGithubIdentity({
        dependency_edges: [{ from: "101", to: "100" }],
      }),
      re: /dependency_edges drift/,
    },
  ];
  for (const c of cases) {
    const r = reconcileLiveIdentity({
      contract,
      base_sha: "abc",
      live_repo: { name: "acme/widgets", base_branch: "main" },
      github: { ok: true, observed: c.observed },
      configFingerprints: DEFAULT_FINGERPRINTS,
    });
    assert.equal(r.ok, false, c.name);
    if (!r.ok) assert.match(r.reason, c.re, c.name);
  }
});

test("githubIdentityDriftReason and contractGithubIdentitySnapshot round-trip", () => {
  const contract = sampleContractForReconcile();
  const snap = contractGithubIdentitySnapshot(contract);
  assert.equal(githubIdentityDriftReason(contract, snap), null);
  assert.match(
    githubIdentityDriftReason(contract, sampleGithubIdentity({ issue_ids: ["1"] })) ?? "",
    /issue_ids drift/,
  );
});

test("reconcileLiveIdentity fails closed when configuration observation is absent", () => {
  const contract = sampleContractForReconcile();
  const r = reconcileLiveIdentity({
    contract,
    base_sha: "abc",
    live_repo: { name: "acme/widgets", base_branch: "main" },
    github: { ok: true, observed: sampleGithubIdentity() },
    configFingerprints: null,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /configuration fingerprint observation required/);
});

test("reconcileLiveIdentity fails closed on repository identity drift", () => {
  const contract = sampleContractForReconcile();
  const r = reconcileLiveIdentity({
    contract,
    base_sha: "abc",
    live_repo: { name: "other/repo", base_branch: "main" },
    github: { ok: true, observed: sampleGithubIdentity() },
    configFingerprints: DEFAULT_FINGERPRINTS,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /repository identity drift/);
});

test("tick fails closed when required live-observation seams are omitted", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const t = await tickFactory(
    makeMacroDeps(deps, { omitGithub: true }),
    "frun-1",
    { repoDir: "/repo" },
  );
  assert.equal(t.next_action, "replan_required");
  assert.equal(t.dispatched, false);
  assert.match(t.derive_reason, /GitHub snapshot observation required/);
});

test("ambiguous open advance claim derives observe_advance — never start_loop", () => {
  const contract = {
    revision: 1,
    coarse_phase: "executing",
    next_action: "start_loop", // contract snapshot would choose loop if fallthrough
    completion_policy: "all_items_ready_to_deploy",
    issue_ids: ["42"],
    linked_runs: { loop_run_id: null, advance_run_id: "adv-1" },
  } as never;
  const d = derivePhaseAndNextAction({
    contract,
    claims: [
      {
        revision: 1,
        action: "start_advance",
        state: "ambiguous_reconcile",
        child_run_id: "adv-1",
      } as never,
    ],
    live: {
      base_sha: "x",
      loop: null,
      advance: { state: "ambiguous", run_id: "adv-1", detail: "unknown" },
      observed_at: "t",
    },
  });
  assert.equal(d.next_action, "observe_advance");
  assert.equal(d.coarse_phase, "executing");
  assert.match(d.reason, /ambiguous/);
});

test("single-item start_advance without advance seams fails closed (no silent strand)", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    issue_ids: ["42"],
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
    next_action: "start_advance",
    coarse_phase: "adopted",
  });
  const starts: string[] = [];
  // Loop seams present; advance seams intentionally omitted.
  const macro = makeMacroDeps(deps, { startCalls: starts, omitAdvance: true });
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t.next_action, "replan_required");
  assert.equal(t.dispatched, false);
  assert.equal(starts.length, 0);
  assert.match(t.derive_reason, /startOrResumeAdvance, observeAdvance, and lookupAdvanceByActionId/);
  // Second tick remains fail-closed (no permanent silent wedge with claimed action).
  const t2 = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t2.next_action, "replan_required");
  assert.equal(t2.dispatched, false);
  assert.equal(starts.length, 0);
});

test("single-item with advance seams dispatches start_advance once", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    issue_ids: ["42"],
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
    next_action: "start_advance",
    coarse_phase: "adopted",
  });
  const starts: string[] = [];
  const macro = makeMacroDeps(deps, { startCalls: starts, withAdvance: true });
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t.dispatched, true);
  assert.ok(t.child_run_id);
  assert.ok(starts.some((s) => s.startsWith("advance:")));
  assert.equal(starts.filter((s) => s.startsWith("loop:")).length, 0);
});

test("read-only status reconstructs phase after tick records completion disposition", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    coarse_phase: "executing",
    next_action: "observe_loop",
    linked_runs: {
      loop_run_id: "loop-1",
      loop_contract_hash: "h",
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-observe_loop-0",
    action: "observe_loop",
    identities: baseIdentities(),
  });
  await updateClaim(deps, "frun-1", "r1-observe_loop-0", {
    state: "started",
    child_run_id: "loop-1",
  });
  const macro = makeMacroDeps(deps, {
    loopStatus: {
      state: "completed",
      run_id: "loop-1",
      all_items_terminal: true,
      all_ready_to_deploy: true,
    },
  });
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(t.next_action, "operator_merge");
  assert.equal(t.coarse_phase, "merge_prepare");
  // Contract still has immutable executing snapshot; durable phase evidence
  // carries the reconciled posture so status needs no live observation.
  const s = await factoryStatus({ store: deps } as FactoryMacroDeps, "frun-1");
  assert.equal(s?.next_action, "operator_merge");
  assert.equal(s?.coarse_phase, "merge_prepare");
  assert.equal(s?.phase_evidence?.next_action, "operator_merge");
  assert.equal(s?.phase_evidence?.child_disposition?.all_ready_to_deploy, true);
  // Status remains non-mutating on a second call
  const before = JSON.stringify(await readPhaseEvidence(deps, "frun-1"));
  await factoryStatus({ store: deps } as FactoryMacroDeps, "frun-1");
  assert.equal(JSON.stringify(await readPhaseEvidence(deps, "frun-1")), before);
});

test("tickFactory acquires factory-run lock; concurrent holder blocks second tick", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const held = await acquireFactoryLock(deps, "frun-1");
  const macro = makeMacroDeps(deps);
  await assert.rejects(
    () => tickFactory(macro, "frun-1", { repoDir: "/repo", acquireLock: true }),
    (e: unknown) => e instanceof FactoryError && e.kind === "lock",
  );
  // Escape hatch: already-held lock skips acquire
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo", acquireLock: false });
  assert.equal(t.dispatched, true);
  await releaseFactoryLock(deps, "frun-1", held.token);
  // After release, default acquireLock succeeds
  const t2 = await tickFactory(makeMacroDeps(deps), "frun-1", { repoDir: "/repo" });
  assert.equal(t2.dispatched, false); // already started
});

// ---------------------------------------------------------------------------
// Phase derivation + merge isolation + no stage API
// ---------------------------------------------------------------------------

test("merge_prepare emits operator_merge only — never merge side effect", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    coarse_phase: "merge_prepare",
    next_action: "operator_merge",
  });
  const starts: string[] = [];
  const macro = makeMacroDeps(deps, { startCalls: starts });
  // Attach forbidden ops to prove tick never needs them
  const dirty = {
    ...macro,
    mergePr: async () => {
      throw new Error("must not call mergePr");
    },
    mergeQueueApply: async () => {
      throw new Error("must not call mergeQueueApply");
    },
    finalizeRelease: async () => {
      throw new Error("must not call finalizeRelease");
    },
  } as FactoryMacroDeps;
  const t = await tickFactory(dirty, "frun-1", { repoDir: "/repo" });
  assert.equal(t.next_action, "operator_merge");
  assert.equal(t.dispatched, false);
  assert.equal(starts.length, 0);
});

test("FACTORY_FORBIDDEN_MERGE_OPERATIONS documents isolation", () => {
  assert.ok(FACTORY_FORBIDDEN_MERGE_OPERATIONS.includes("mergePr"));
  assert.ok(FACTORY_FORBIDDEN_MERGE_OPERATIONS.includes("auto_merge"));
  assert.ok(FACTORY_CHILD_OPERATIONS.includes("startOrResumeLoop"));
  assert.ok(!FACTORY_CHILD_OPERATIONS.some((op) => /stage|label|merge/i.test(op)));
});

test("derivePhaseAndNextAction uses durable + live only", () => {
  const contract = {
    revision: 1,
    coarse_phase: "adopted",
    next_action: "start_loop",
    completion_policy: "all_items_ready_to_deploy",
    issue_ids: ["1", "2"],
    linked_runs: { loop_run_id: "loop-1" },
  } as never;
  const d = derivePhaseAndNextAction({
    contract,
    claims: [],
    live: {
      base_sha: "x",
      loop: { state: "running", run_id: "loop-1" },
      advance: null,
      observed_at: "t",
    },
  });
  assert.equal(d.coarse_phase, "executing");
  assert.equal(d.next_action, "observe_loop");
});

// ---------------------------------------------------------------------------
// Legacy run identity + evidence attribution
// ---------------------------------------------------------------------------

test("legacy run identity is recorded without second write authority", async () => {
  const { deps } = fakeStore();
  const rev = await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: "loop-1",
      loop_contract_hash: "h",
      advance_run_id: null,
      legacy_run_identity: "goal-loop-old-99",
    },
  });
  assert.equal(rev.linked_runs.legacy_run_identity, "goal-loop-old-99");
  // Macro never writes item ledger through legacy id — only stores the mapping.
  const events = await readFactoryEvents(deps, "frun-1");
  assert.ok(events.some((e) => e.kind === "factory_adopted"));
  assert.ok(!events.some((e) => e.kind === "item_transition"));
});

test("coarse-action evidence attributes controller and revision", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const macro = makeMacroDeps(deps);
  await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  const events = await readFactoryEvents(deps, "frun-1");
  const claimed = events.find((e) => e.kind === "factory_action_claimed");
  assert.ok(claimed);
  const data = claimed!.data as { service_controller: string; revision: number };
  assert.equal(data.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
  assert.equal(data.revision, 1);
});

test("coarse-action claim and phase evidence preserve all five control identities", async () => {
  const { deps } = fakeStore();
  const identities = baseIdentities({
    outer_host: "session-host-a",
    implementer_treatment: "my-ext",
    reviewer_treatment: "codex",
    privileged_mutation_actor: "operator-session-1",
  });
  await adoptFresh(deps, {
    identities,
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const macro = makeMacroDeps(deps);
  const t = await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.ok(t.claim);
  assert.equal(t.claim!.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
  assert.equal(t.claim!.outer_host, "session-host-a");
  assert.equal(t.claim!.implementer_treatment, "my-ext");
  assert.equal(t.claim!.reviewer_treatment, "codex");
  assert.equal(t.claim!.privileged_mutation_actor, "operator-session-1");
  // Distinct slots — none collapsed into a single host/engine string.
  const slots = [
    t.claim!.service_controller,
    t.claim!.outer_host,
    t.claim!.implementer_treatment,
    t.claim!.reviewer_treatment,
    t.claim!.privileged_mutation_actor,
  ];
  assert.equal(new Set(slots).size, 5);

  const evidence = await readPhaseEvidence(deps, "frun-1");
  assert.ok(evidence);
  assert.equal(evidence!.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
  assert.equal(evidence!.outer_host, "session-host-a");
  assert.equal(evidence!.implementer_treatment, "my-ext");
  assert.equal(evidence!.reviewer_treatment, "codex");
  assert.equal(evidence!.privileged_mutation_actor, "operator-session-1");

  // Restart reconciliation: re-read claim from durable store without re-dispatch.
  const restarted = await tickFactory(makeMacroDeps(deps), "frun-1", { repoDir: "/repo" });
  assert.equal(restarted.claim_won, false);
  assert.equal(restarted.claim?.outer_host, "session-host-a");
  assert.equal(restarted.claim?.implementer_treatment, "my-ext");
  assert.equal(restarted.claim?.reviewer_treatment, "codex");
  assert.equal(restarted.claim?.privileged_mutation_actor, "operator-session-1");
  assert.equal(restarted.claim?.service_controller, FACTORY_SERVICE_CONTROLLER_ID);
});

test("tick fails closed when live GitHub selector identity drifts from contract", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps);
  const t = await tickFactory(
    makeMacroDeps(deps, {
      githubObserved: sampleGithubIdentity({
        selector: { type: "label", value: "other" },
        issue_ids: ["100", "101"],
        milestones: ["v2"],
        dependency_edges: [{ from: "100", to: "101" }],
      }),
    }),
    "frun-1",
    { repoDir: "/repo" },
  );
  assert.equal(t.next_action, "replan_required");
  assert.equal(t.dispatched, false);
  assert.match(t.derive_reason, /selector drift/);
});

// ---------------------------------------------------------------------------
// Concurrency non-widening (controller does not set budget)
// ---------------------------------------------------------------------------

test("macro controller does not inject concurrency budget into start call", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: null,
      loop_contract_hash: null,
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const payloads: unknown[] = [];
  const macro: FactoryMacroDeps = {
    store: deps,
    observeBaseSha: async () => "abc123deadbeef",
    observeRepoIdentity: async () => ({ name: "acme/widgets", base_branch: "main" }),
    observeGithubSnapshot: async ({ contracted }) => ({ ok: true, observed: contracted }),
    readConfigFingerprints: async () => DEFAULT_FINGERPRINTS,
    now: () => deps.now(),
    startOrResumeLoop: async (input) => {
      payloads.push(input);
      return { loop_run_id: "loop-x" };
    },
    lookupLoopByActionId: async () => null,
    observeLoop: async () => ({ state: "not_found" }),
  };
  await tickFactory(macro, "frun-1", { repoDir: "/repo" });
  assert.equal(payloads.length, 1);
  const p = payloads[0] as Record<string, unknown>;
  assert.equal("concurrency_budget" in p, false);
  assert.equal("max_active_items" in p, false);
});

// ---------------------------------------------------------------------------
// State home resolution
// ---------------------------------------------------------------------------

test("resolveFactoryStateHome uses dedicated env and sibling of loop", () => {
  assert.equal(
    resolveFactoryStateHome({ env: { AGENT_PIPELINE_FACTORY_STATE_HOME: "/f" }, hostname: () => "h" }),
    "/f",
  );
  assert.equal(
    resolveFactoryStateHome({
      env: { AGENT_PIPELINE_STATE_HOME: "/state/agent-pipeline/loop" },
      hostname: () => "h",
    }),
    "/state/agent-pipeline/factory",
  );
  assert.equal(
    factoryRunDir(
      { env: { AGENT_PIPELINE_FACTORY_STATE_HOME: "/f" }, hostname: () => "h" },
      "run-a",
    ),
    "/f/runs/run-a",
  );
});

test("adoptFactoryContract wrapper works", async () => {
  const { deps } = fakeStore();
  const rev = await adoptFactoryContract(
    { store: deps } as FactoryMacroDeps,
    {
      factory_run_id: "frun-wrap",
      expected_revision: null,
      repo: bodyFields().repo,
      selector: { type: "label", value: "factory" },
      issue_ids: ["1"],
      identities: baseIdentities(),
      fingerprints: bodyFields().fingerprints,
      live_repo: bodyFields().repo,
      factoryModeEnabled: true,
    },
  );
  assert.equal(rev.revision, 1);
  assert.equal(rev.selector.value, "factory");
});
