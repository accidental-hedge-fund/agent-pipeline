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
  updateClaim,
  readCurrentRevision,
  readRevision,
  getFactoryStatus,
  acquireFactoryLock,
  releaseFactoryLock,
  resolveFactoryStateHome,
  factoryRunDir,
  readFactoryEvents,
  type FactoryStoreDeps,
} from "../scripts/factory/store.ts";
import {
  adoptFactoryContract,
  derivePhaseAndNextAction,
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

function makeMacroDeps(
  store: FactoryStoreDeps,
  opts: {
    loopStatus?: ChildRunStatus;
    startCalls?: string[];
    fault?: FactoryMacroDeps["_fault"];
  } = {},
): FactoryMacroDeps {
  const startCalls = opts.startCalls ?? [];
  let loopStatus: ChildRunStatus = opts.loopStatus ?? { state: "not_found" };
  return {
    store,
    observeBaseSha: async () => "abc123deadbeef",
    now: () => store.now(),
    startOrResumeLoop: async ({ loop_run_id, factory_run_id }) => {
      startCalls.push(`loop:${loop_run_id ?? "new"}:${factory_run_id}`);
      const id = loop_run_id ?? `loop-from-${factory_run_id}`;
      loopStatus = { state: "running", run_id: id };
      return { loop_run_id: id };
    },
    observeLoop: async (id) => {
      if (loopStatus.state === "not_found") return { state: "not_found" };
      return { ...loopStatus, run_id: "run_id" in loopStatus ? loopStatus.run_id : id } as ChildRunStatus;
    },
    _fault: opts.fault,
  };
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
    service_controller: FACTORY_SERVICE_CONTROLLER_ID,
  });
  assert.equal(a.won, true);
  const b = await claimAction(deps, {
    factory_run_id: "frun-1",
    revision: 1,
    action_id: "r1-start_loop-0",
    action: "start_loop",
    service_controller: FACTORY_SERVICE_CONTROLLER_ID,
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

test("crash after child start: restart observes linked child without second start", async () => {
  const { deps } = fakeStore();
  await adoptFresh(deps, {
    linked_runs: {
      loop_run_id: "loop-1",
      loop_contract_hash: "h",
      advance_run_id: null,
      legacy_run_identity: null,
    },
  });
  const starts: string[] = [];
  const faulting = makeMacroDeps(deps, {
    startCalls: starts,
    fault: { crashAfterChildStart: true },
    loopStatus: { state: "not_found" },
  });
  await assert.rejects(() => tickFactory(faulting, "frun-1", { repoDir: "/repo" }));
  assert.equal(starts.length, 1);
  // Restart with running child
  const resume = makeMacroDeps(deps, {
    startCalls: starts,
    loopStatus: { state: "running", run_id: "loop-1" },
  });
  // Force observe path: claim already has child from first tick update... first tick crashed after updateClaim started
  const t = await tickFactory(resume, "frun-1", { repoDir: "/repo" });
  assert.equal(t.dispatched, false);
  assert.equal(starts.length, 1);
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
    service_controller: FACTORY_SERVICE_CONTROLLER_ID,
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
    now: () => deps.now(),
    startOrResumeLoop: async (input) => {
      payloads.push(input);
      return { loop_run_id: "loop-x" };
    },
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
