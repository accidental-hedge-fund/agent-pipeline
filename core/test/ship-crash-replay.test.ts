// Fresh-process crash fixtures for every external ship-path side effect (#1331).
// Injected observer/mutation deps only. Real network, git, and subprocess fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  SHIP_AUTHORIZED_ACTIONS,
  emptyShipProgress,
  operatorShipIntent,
  projectCandidateLineage,
  runShipCoordinator,
  shipAuthorizationFingerprint,
  shipAuthorizationSigningPayload,
  shipKey,
  type BuzzShipAuthorization,
  type ShipCoordinatorDeps,
  type ShipIntent,
  type ShipPhaseEvent,
  type ShipProgress,
  type ShipStateStore,
  type ShipStatus,
} from "../scripts/stages/ship.ts";
import { rollbackProductionPin } from "../scripts/production-engine-pin.ts";

const EVENT_ID = "a".repeat(64);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const CANDIDATE = "d".repeat(40);
const NOW = new Date("2026-08-10T12:00:00.000Z");
const AUTH_KEYS = crypto.generateKeyPairSync("ed25519");
const AUTH_PUBLIC_KEY = AUTH_KEYS.publicKey.export({ type: "spki", format: "pem" }).toString();

const intent: ShipIntent = {
  repository: "accidental-hedge-fund/agent-pipeline",
  base_branch: "main",
  milestone: "v1.34.0",
  version: "1.34.0",
  event_id: EVENT_ID,
  sender_id: "npub-operator",
  channel_id: "pipeline-factory",
  thread_id: "thread-945",
};

function authorization(overrides: Partial<BuzzShipAuthorization> = {}): BuzzShipAuthorization {
  const unsigned = {
    schema_version: 1 as const,
    kind: "ship_authorization" as const,
    ...intent,
    issued_at: "2026-08-10T11:55:00.000Z",
    expires_at: "2026-08-17T11:55:00.000Z",
    actions: [...SHIP_AUTHORIZED_ACTIONS],
    ...overrides,
  };
  delete (unsigned as Partial<BuzzShipAuthorization>).fingerprint;
  delete (unsigned as Partial<BuzzShipAuthorization>).signature;
  const signature = crypto.sign(null, shipAuthorizationSigningPayload(unsigned), AUTH_KEYS.privateKey)
    .toString("base64");
  return {
    ...unsigned,
    fingerprint: overrides.fingerprint ?? shipAuthorizationFingerprint(unsigned),
    signature: overrides.signature ?? signature,
  };
}

function completeProgress(): ShipProgress {
  const progress: ShipProgress = {
    train: {
      repository: intent.repository,
      base_branch: intent.base_branch,
      milestone: intent.milestone,
      complete: true,
      ordered_issues: [901, 902],
      run_id: "train-1",
      integrated_head_oid: CANDIDATE,
      completed_at: NOW.toISOString(),
    },
    frg_pack: {
      version: intent.version,
      complete: true,
      loop_run_id: "loop-1",
      pack_id: "factory-gate-v1",
      candidate_head_oid: CANDIDATE,
    },
    frg: {
      version: intent.version,
      pass: true,
      loop_run_id: "loop-1",
      frg_run_id: "frg-1",
      candidate_head_oid: CANDIDATE,
    },
    release: {
      repository: intent.repository,
      base_branch: intent.base_branch,
      version: intent.version,
      pr: 1001,
      head_oid: HEAD,
      candidate_head_oid: CANDIDATE,
    },
    release_finish: {
      repository: intent.repository,
      base_branch: intent.base_branch,
      version: intent.version,
      pr: 1001,
      head_oid: HEAD,
      candidate_head_oid: CANDIDATE,
      merged: true,
      merge_commit_oid: MERGE,
    },
    publication: {
      version: intent.version,
      tag: "v1.34.0",
      published: true,
      artifact_digest: MERGE,
    },
    promotion: {
      version: intent.version,
      tag: "v1.34.0",
      verified: true,
      installed_version: intent.version,
      pin_digest: MERGE,
    },
    deployment: {
      version: intent.version,
      tag: "v1.34.0",
      environment: "all",
      authorized_digest: MERGE,
      live_digest: MERGE,
      verified: true,
    },
    lineage: emptyShipProgress().lineage,
  };
  progress.lineage = projectCandidateLineage(progress);
  return progress;
}

function memoryStore(): ShipStateStore & { status: ShipStatus | null; events: ShipPhaseEvent[] } {
  let status: ShipStatus | null = null;
  const events: ShipPhaseEvent[] = [];
  return {
    get status() { return status; },
    events,
    statusFile: (key) => `/state/ships/${key}/status.json`,
    eventsFile: (key) => `/state/ships/${key}/events.jsonl`,
    async read() { return status ? structuredClone(status) : null; },
    async writeAtomic(_key, value) { status = structuredClone(value); },
    async appendEvent(_key, event) { events.push(structuredClone(event)); },
  };
}

const FORBIDDEN_IO = "crash tests must not perform real network, git, or subprocess";

function crashDeps(store: ReturnType<typeof memoryStore>, observed: ShipProgress = emptyShipProgress()): ShipCoordinatorDeps & {
  mutations: string[];
} {
  const mutations: string[] = [];
  const progress = completeProgress();
  const deps: ShipCoordinatorDeps & { mutations: string[] } = {
    mutations,
    now: () => NOW,
    state: store,
    authorizationPublicKey: AUTH_PUBLIC_KEY,
    async withRunLock(_key, fn) { return fn(); },
    async reconcile() { return structuredClone(observed); },
    async planTrain() { return { ordered_issues: [901, 902] }; },
    async convergeTrain() {
      mutations.push("train-merge");
      return structuredClone(progress.train!);
    },
    async convergeFrgPack() {
      mutations.push("frg-pack");
      return structuredClone(progress.frg_pack!);
    },
    async convergeFrgScore() {
      mutations.push("frg-attest");
      return structuredClone(progress.frg!);
    },
    async convergeReleasePrepare() {
      mutations.push("release-pr-create");
      return structuredClone(progress.release!);
    },
    async convergeReleaseFinish() {
      mutations.push("release-merge");
      return structuredClone(progress.release_finish!);
    },
    async waitForRelease() {
      mutations.push("tag-push");
      mutations.push("github-release");
      return structuredClone(progress.publication!);
    },
    async convergeEnginePromote() {
      mutations.push("pin-write");
      return structuredClone(progress.promotion!);
    },
    async convergeDeployment() {
      mutations.push("host-install");
      return structuredClone(progress.deployment!);
    },
    async observeRemainingOpenMilestoneIssues() { return []; },
  };
  return deps;
}

test("crash after train merge does not remarge (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeTrain = async () => {
    first.mutations.push("train-merge");
    throw new Error("died after train-merge");
  };
  const crashed = await runShipCoordinator(intent, authorization(), first);
  assert.equal(crashed.lifecycle, "cooling");
  const observed = emptyShipProgress();
  observed.train = completeProgress().train;
  const resumed = crashDeps(store, observed);
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("train-merge"));
  assert.equal(result.complete, true);
});

test("crash after FRG pack/attest does not repack (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeFrgPack = async () => {
    first.mutations.push("frg-pack");
    throw new Error("died after frg-pack");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  const resumed = crashDeps(store, observed);
  await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("frg-pack"));
  assert.ok(!resumed.mutations.includes("frg-attest"));
});

test("crash after release PR create does not open a second PR (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeReleasePrepare = async () => {
    first.mutations.push("release-pr-create");
    throw new Error("died after release-pr-create");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  observed.release = done.release;
  const resumed = crashDeps(store, observed);
  await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("release-pr-create"));
});

test("crash after release merge does not remarge (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeReleaseFinish = async () => {
    first.mutations.push("release-merge");
    throw new Error("died after release-merge");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  observed.release = done.release;
  observed.release_finish = done.release_finish;
  const resumed = crashDeps(store, observed);
  await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("release-merge"));
});

test("crash after tag push / GitHub Release does not retag (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.waitForRelease = async () => {
    first.mutations.push("tag-push");
    first.mutations.push("github-release");
    throw new Error("died after tag-push");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  observed.release = done.release;
  observed.release_finish = done.release_finish;
  observed.publication = done.publication;
  const resumed = crashDeps(store, observed);
  await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("tag-push"));
  assert.ok(!resumed.mutations.includes("github-release"));
});

test("crash after pin write does not rewrite the pin (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeEnginePromote = async () => {
    first.mutations.push("pin-write");
    throw new Error("died after pin-write");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  observed.release = done.release;
  observed.release_finish = done.release_finish;
  observed.publication = done.publication;
  observed.promotion = done.promotion;
  const resumed = crashDeps(store, observed);
  await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("pin-write"));
});

test("crash after host install with proven digest does not reinstall (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeDeployment = async () => {
    first.mutations.push("host-install");
    throw new Error("died after host-install");
  };
  await runShipCoordinator(intent, authorization(), first);
  const observed = completeProgress();
  const resumed = crashDeps(store, observed);
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.ok(!resumed.mutations.includes("host-install"));
  assert.equal(result.complete, true);
});

test("uncertain install stays owned and observes before replay (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  first.convergeDeployment = async () => {
    first.mutations.push("host-install");
    throw new Error("install timed out with unknown completeness");
  };
  const crashed = await runShipCoordinator(intent, authorization(), first);
  assert.equal(crashed.lifecycle, "cooling");
  assert.equal(crashed.complete, false);
  assert.equal(crashed.deployment, null);
  const observed = emptyShipProgress();
  const done = completeProgress();
  observed.train = done.train;
  observed.frg_pack = done.frg_pack;
  observed.frg = done.frg;
  observed.release = done.release;
  observed.release_finish = done.release_finish;
  observed.publication = done.publication;
  observed.promotion = done.promotion;
  const resumed = crashDeps(store, observed);
  let observedBeforeReplay = false;
  resumed.reconcile = async () => {
    observedBeforeReplay = true;
    return structuredClone(observed);
  };
  await runShipCoordinator(intent, authorization(), resumed);
  assert.equal(observedBeforeReplay, true);
  assert.equal(resumed.mutations.includes("host-install"), true);
});

test("crash tests fail if real I/O seams are used (#1331)", async () => {
  const store = memoryStore();
  const deps = crashDeps(store);
  const realIo = async () => {
    throw new Error(FORBIDDEN_IO);
  };
  deps.convergeTrain = realIo;
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.match(result.last_error ?? "", /must not perform real network, git, or subprocess/);
  assert.equal(result.lifecycle, "cooling");
});

test("rollback without an envelope does not mutate the pin (#1331)", async () => {
  const pinPath = "/repo/.agent-pipeline/production-engine-pin.json";
  const before = JSON.stringify({
    schema_version: 1,
    version: "1.30.0",
    tag: "v1.30.0",
    frg_run_id: "frg-new",
    promoted_at: "2026-08-01T00:00:00Z",
    previous: {
      schema_version: 1,
      version: "1.29.1",
      tag: "v1.29.1",
      frg_run_id: "frg-old",
      promoted_at: "2026-07-01T00:00:00Z",
    },
  });
  const files = new Map<string, string>([[pinPath, before]]);
  let writes = 0;
  const result = await rollbackProductionPin({
    repoDir: "/repo",
    env: {},
    now: () => NOW,
    automatic: true,
    fsDeps: {
      async readFile(p: string) {
        const text = files.get(p);
        if (text === undefined) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return text;
      },
      async writeFile() {
        writes += 1;
        throw new Error(FORBIDDEN_IO);
      },
      async mkdir() {},
      async rename() {
        writes += 1;
        throw new Error(FORBIDDEN_IO);
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
  assert.equal(files.get(pinPath), before);
});

test("operator ship status projection does not mutate (#1331)", async () => {
  const store = memoryStore();
  const first = crashDeps(store);
  const seeded = await runShipCoordinator(operatorShipIntent(intent), null, first);
  assert.equal(seeded.complete, true);
  const deps = crashDeps(store, completeProgress());
  deps.planTrain = async () => {
    throw new Error("status projection must not plan");
  };
  const result = await runShipCoordinator(operatorShipIntent(intent), null, deps);
  assert.equal(result.complete, true);
  assert.deepEqual(deps.mutations, []);
  assert.equal(result.ship_key, shipKey(intent));
});
