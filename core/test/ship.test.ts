import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  SHIP_AUTHORIZED_ACTIONS,
  OPERATOR_SHIP_FINGERPRINT,
  defaultShipStateStore,
  operatorShipIntent,
  resolveShipStateHome,
  runShipCoordinator,
  shipAuthorizationFingerprint,
  shipAuthorizationSigningPayload,
  shipBaseLockKey,
  shipKey,
  shipRunId,
  shipStatePaths,
  validateBuzzShipAuthorization,
  type BuzzShipAuthorization,
  type ShipCoordinatorDeps,
  type ShipIntent,
  type ShipPhaseEvent,
  type ShipProgress,
  type ShipStateStore,
  type ShipStatus,
} from "../scripts/stages/ship.ts";
import { ShipReleaseCheckWaitError } from "../scripts/stages/ship-release-check-wait.ts";

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
    schema_version: 1,
    kind: "ship_authorization",
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

const emptyProgress = (): ShipProgress => ({
  train: null,
  frg_pack: null,
  frg: null,
  release: null,
  release_finish: null,
  publication: null,
  promotion: null,
});

const completeProgress = (): ShipProgress => ({
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
    tag: `v${intent.version}`,
    published: true,
  },
  promotion: {
    version: intent.version,
    tag: `v${intent.version}`,
    verified: true,
    installed_version: intent.version,
  },
});

function memoryStore(): ShipStateStore & {
  status: ShipStatus | null;
  events: ShipPhaseEvent[];
  writes: ShipStatus[];
} {
  let status: ShipStatus | null = null;
  const events: ShipPhaseEvent[] = [];
  const writes: ShipStatus[] = [];
  return {
    get status() { return status; },
    set status(value) { status = value; },
    events,
    writes,
    statusFile: (key) => `/state/ships/${key}/status.json`,
    eventsFile: (key) => `/state/ships/${key}/events.jsonl`,
    async read() { return status ? structuredClone(status) : null; },
    async writeAtomic(_eventId, value) {
      status = structuredClone(value);
      writes.push(structuredClone(value));
    },
    async appendEvent(_eventId, event) { events.push(structuredClone(event)); },
  };
}

function makeDeps(
  store: ShipStateStore = memoryStore(),
  reconciliation: ShipProgress = emptyProgress(),
): ShipCoordinatorDeps & { calls: string[] } {
  const calls: string[] = [];
  const progress = completeProgress();
  return {
    calls,
    now: () => NOW,
    state: store,
    authorizationPublicKey: AUTH_PUBLIC_KEY,
    async withRunLock(_key, fn) { return fn(); },
    async reconcile(_intent, checkpoint) {
      calls.push("reconcile");
      assert.equal(checkpoint.ship_key, shipKey(intent));
      return structuredClone(reconciliation);
    },
    async planTrain() {
      calls.push("plan-train");
      return { ordered_issues: [901, 902] };
    },
    async convergeTrain(_intent, plannedIssues) {
      calls.push("train");
      assert.deepEqual(plannedIssues, [901, 902]);
      return structuredClone(progress.train!);
    },
    async convergeFrgPack(_intent, train) {
      calls.push("frg-pack");
      assert.equal(train.milestone, intent.milestone);
      return structuredClone(progress.frg_pack!);
    },
    async convergeFrgScore(_intent, pack) {
      calls.push("frg-score");
      assert.equal(pack.loop_run_id, "loop-1");
      return structuredClone(progress.frg!);
    },
    async convergeReleasePrepare(_intent, frg) {
      calls.push("release-prepare");
      assert.equal(frg.frg_run_id, "frg-1");
      return structuredClone(progress.release!);
    },
    async convergeReleaseFinish(_intent, release) {
      calls.push("release-finish");
      assert.equal(release.head_oid, HEAD);
      return structuredClone(progress.release_finish!);
    },
    async waitForRelease(_intent, release) {
      calls.push("release-wait");
      assert.equal(release.merge_commit_oid, MERGE);
      return structuredClone(progress.publication!);
    },
    async convergeEnginePromote(_intent, publication) {
      calls.push("engine-promote");
      assert.equal(publication.tag, "v1.34.0");
      return structuredClone(progress.promotion!);
    },
  };
}

async function seedFrozenTrainPlan(
  store: ReturnType<typeof memoryStore>,
): Promise<void> {
  const deps = makeDeps(store);
  deps.convergeTrain = async (_intent, plannedIssues) => {
    assert.deepEqual(plannedIssues, [901, 902]);
    throw new Error("simulated crash before train result");
  };
  await assert.rejects(
    runShipCoordinator(intent, authorization(), deps),
    /simulated crash/,
  );
  assert.deepEqual(store.status?.train_plan, { ordered_issues: [901, 902] });
  assert.equal(store.status?.train, null);
}

test("ship authorization validates the exact Buzz identity, coordinates, actions, time, and fingerprint", () => {
  const auth = authorization();
  assert.deepEqual(validateBuzzShipAuthorization(auth, intent, NOW, AUTH_PUBLIC_KEY), auth);

  const unknown = { ...auth, extra: true };
  assert.throws(() => validateBuzzShipAuthorization(unknown, intent, NOW, AUTH_PUBLIC_KEY), /missing or unknown/);

  const noncanonicalRepo = { ...auth, repository: "Accidental-Hedge-Fund/Agent-Pipeline" };
  assert.throws(() => validateBuzzShipAuthorization(noncanonicalRepo, intent, NOW, AUTH_PUBLIC_KEY), /canonical form/);

  const tampered = { ...auth, milestone: "v1.35.0" };
  assert.throws(() => validateBuzzShipAuthorization(tampered, { ...intent, milestone: "v1.35.0" }, NOW, AUTH_PUBLIC_KEY), /fingerprint/);

  assert.throws(
    () => validateBuzzShipAuthorization(auth, { ...intent, thread_id: "another-thread" }, NOW, AUTH_PUBLIC_KEY),
    /thread_id does not match/,
  );
  assert.throws(
    () => validateBuzzShipAuthorization({ ...auth, actions: [...auth.actions].reverse() }, intent, NOW, AUTH_PUBLIC_KEY),
    /exact ordered/,
  );

  const attackerKeys = crypto.generateKeyPairSync("ed25519");
  const forged = authorization();
  forged.signature = crypto.sign(
    null,
    shipAuthorizationSigningPayload(forged),
    attackerKeys.privateKey,
  ).toString("base64");
  assert.throws(
    () => validateBuzzShipAuthorization(forged, intent, NOW, AUTH_PUBLIC_KEY),
    /trusted gateway key/,
  );
});

test("ship authorization rejects noncanonical, future, expired, and overlong grants", () => {
  const noncanonical = authorization({ issued_at: "2026-08-10T11:55:00Z" });
  assert.throws(() => validateBuzzShipAuthorization(noncanonical, intent, NOW, AUTH_PUBLIC_KEY), /canonical UTC/);

  const future = authorization({
    issued_at: "2026-08-10T13:00:00.000Z",
    expires_at: "2026-08-11T13:00:00.000Z",
  });
  assert.throws(() => validateBuzzShipAuthorization(future, intent, NOW, AUTH_PUBLIC_KEY), /not active/);

  const expired = authorization({
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-08T00:00:00.000Z",
  });
  assert.throws(() => validateBuzzShipAuthorization(expired, intent, NOW, AUTH_PUBLIC_KEY), /expired/);

  const overlong = authorization({
    issued_at: "2026-08-10T00:00:00.000Z",
    expires_at: "2026-08-18T00:00:00.000Z",
  });
  assert.throws(() => validateBuzzShipAuthorization(overlong, intent, NOW, AUTH_PUBLIC_KEY), /within seven days/);
});

test("ship coordinator composes the existing capabilities in one fixed order", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  const result = await runShipCoordinator(intent, authorization(), deps);

  assert.deepEqual(deps.calls, [
    "reconcile",
    "plan-train",
    "train",
    "frg-pack",
    "frg-score",
    "release-prepare",
    "release-finish",
    "release-wait",
    "engine-promote",
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.next_action, "complete");
  assert.equal(result.ship_key, shipKey(intent));
  assert.equal(result.events_file, `/state/ships/${shipKey(intent)}/events.jsonl`);
  assert.equal(result.authorization_fingerprint, authorization().fingerprint);
  assert.equal(result.promotion?.installed_version, "1.34.0");
  assert.ok(store.writes.every((write) => write.kind === "ship_status"));
  assert.deepEqual(
    store.events.map((event) => `${event.phase}:${event.status}`),
    [
      "train_merge:reconciled",
      "train_merge:reconciled",
      "train_merge:started", "train_merge:completed",
      "frg_pack:started", "frg_pack:completed",
      "frg_score:started", "frg_score:completed",
      "release_prepare:started", "release_prepare:completed",
      "release_finish:started", "release_finish:completed",
      "release_wait:started", "release_wait:completed",
      "engine_promote:started", "engine_promote:completed",
      "complete:completed",
    ],
  );
});

test("ship coordinator rechecks authorization expiry before the next phase", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  let clock = NOW;
  deps.now = () => clock;
  deps.planTrain = async () => {
    clock = new Date("2026-08-10T12:02:00.000Z");
    return { ordered_issues: [901, 902] };
  };
  let trainEntered = false;
  deps.convergeTrain = async () => {
    trainEntered = true;
    return completeProgress().train!;
  };
  const shortGrant = authorization({ expires_at: "2026-08-10T12:01:00.000Z" });
  await assert.rejects(
    runShipCoordinator(intent, shortGrant, deps),
    /grant has expired/,
  );
  assert.equal(trainEntered, false);
  assert.equal(store.status?.last_error, "ship authorization: grant has expired");
});

test("ship coordinator uses external reconciliation to resume without repeating side effects", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  await runShipCoordinator(intent, authorization(), first);

  const rerun = makeDeps(store, completeProgress());
  const result = await runShipCoordinator(intent, authorization(), rerun);
  assert.equal(result.complete, true);
  assert.deepEqual(rerun.calls, ["reconcile"]);
  assert.equal(store.events.at(-1)?.status, "reconciled");
});

test("ship coordinator atomically persists the accepted train plan before train mutation", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  let trainEntered = false;
  deps.convergeTrain = async (_intent, plannedIssues) => {
    trainEntered = true;
    assert.deepEqual(plannedIssues, [901, 902]);
    assert.deepEqual(store.status?.train_plan, { ordered_issues: [901, 902] });
    assert.ok(store.writes.some((write) => write.train_plan?.ordered_issues.join(",") === "901,902"));
    throw new Error("simulated train crash");
  };

  await assert.rejects(runShipCoordinator(intent, authorization(), deps), /simulated train crash/);
  assert.equal(trainEntered, true);
  assert.deepEqual(store.status?.train_plan, { ordered_issues: [901, 902] });
});

test("ship coordinator rejects an empty, invalid, or duplicate train plan before mutation", async () => {
  for (const orderedIssues of [[], [901, 0], [901, 901]]) {
    const store = memoryStore();
    const deps = makeDeps(store);
    let trainEntered = false;
    deps.planTrain = async () => ({ ordered_issues: orderedIssues });
    deps.convergeTrain = async () => {
      trainEntered = true;
      return completeProgress().train!;
    };
    await assert.rejects(
      runShipCoordinator(intent, authorization(), deps),
      /train plan/,
    );
    assert.equal(trainEntered, false);
    assert.equal(store.status?.train_plan, null);
  }
});

test("ship coordinator reuses the frozen train plan after crash instead of replanning the milestone", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);

  const resumed = makeDeps(store);
  resumed.planTrain = async () => {
    throw new Error("must not replan a frozen train");
  };
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.equal(result.complete, true);
  assert.deepEqual(result.train_plan, { ordered_issues: [901, 902] });
  assert.deepEqual(resumed.calls, [
    "reconcile",
    "train",
    "frg-pack",
    "frg-score",
    "release-prepare",
    "release-finish",
    "release-wait",
    "engine-promote",
  ]);
});

test("ship reconciliation cannot expand or reorder the frozen train plan", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const expanded = emptyProgress();
  expanded.train = {
    ...completeProgress().train!,
    ordered_issues: [901, 902, 903],
  };
  const deps = makeDeps(store, expanded);
  await assert.rejects(
    runShipCoordinator(intent, authorization(), deps),
    /frozen train plan/,
  );
  assert.deepEqual(deps.calls, ["reconcile"]);
  assert.deepEqual(store.status?.train_plan, { ordered_issues: [901, 902] });
});

test("ship reconciliation rejects a noncanonical train completion checkpoint", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const invalid = emptyProgress();
  invalid.train = {
    ...completeProgress().train!,
    completed_at: "2026-08-10T12:00:00Z",
  };
  const deps = makeDeps(store, invalid);

  await assert.rejects(
    runShipCoordinator(intent, authorization(), deps),
    /completed_at must be a canonical UTC timestamp/,
  );
  assert.deepEqual(deps.calls, ["reconcile"]);
});

test("ship coordinator recovers a release side effect that overtook local status", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const progress = completeProgress();
  progress.release_finish = null;
  progress.publication = null;
  progress.promotion = null;
  const deps = makeDeps(store, progress);

  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.deepEqual(deps.calls, ["reconcile", "release-finish", "release-wait", "engine-promote"]);
  assert.equal(result.complete, true);
});

test("ship coordinator fails closed on an out-of-order or mismatched reconciliation", async () => {
  const store = memoryStore();
  const progress = emptyProgress();
  progress.release = completeProgress().release;
  const deps = makeDeps(store, progress);
  await assert.rejects(runShipCoordinator(intent, authorization(), deps), /release evidence/);
  assert.deepEqual(deps.calls, ["reconcile"]);
});

test("ship coordinator fails closed when the FRG candidate drifts from the integrated head", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const progress = completeProgress();
  progress.frg_pack!.candidate_head_oid = "e".repeat(40);
  progress.frg!.candidate_head_oid = "e".repeat(40);
  const deps = makeDeps(store, progress);
  await assert.rejects(runShipCoordinator(intent, authorization(), deps), /integrated train head/);
  assert.deepEqual(deps.calls, ["reconcile"]);
});

test("ship coordinator binds an existing status to its authorization and exact events path", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  await runShipCoordinator(intent, authorization(), first);

  store.status = { ...store.status!, events_file: "/different/events.jsonl" };
  const rerun = makeDeps(store, completeProgress());
  await assert.rejects(runShipCoordinator(intent, authorization(), rerun), /events_file/);
  assert.deepEqual(rerun.calls, []);
});

test("ship coordinator accepts a new signed grant only after the prior grant expires", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  first.convergeTrain = async () => { throw new Error("parked"); };
  const firstGrant = authorization({ expires_at: "2026-08-10T12:01:00.000Z" });
  await assert.rejects(runShipCoordinator(intent, firstGrant, first), /parked/);

  const replacementIntent = { ...intent, event_id: "e".repeat(64), thread_id: "replacement-thread" };
  const replacementGrant = authorization({
    ...replacementIntent,
    issued_at: "2026-08-10T12:01:00.000Z",
    expires_at: "2026-08-11T12:01:00.000Z",
  });
  const resumed = makeDeps(store);
  resumed.now = () => new Date("2026-08-10T12:02:00.000Z");
  const result = await runShipCoordinator(replacementIntent, replacementGrant, resumed);
  assert.equal(result.complete, true);
  assert.equal(result.intent.event_id, replacementIntent.event_id);
  assert.equal(result.authorization_fingerprint, replacementGrant.fingerprint);
  assert.deepEqual(result.train_plan?.ordered_issues, [901, 902]);
});

test("ship state paths use host state home and never the repository", () => {
  assert.equal(resolveShipStateHome({ AGENT_PIPELINE_STATE_HOME: "/custom/pipeline" }), "/custom/pipeline");
  assert.equal(resolveShipStateHome({ XDG_STATE_HOME: "/xdg/state" }), "/xdg/state/agent-pipeline");
  assert.deepEqual(
    shipStatePaths(shipKey(intent), { AGENT_PIPELINE_STATE_HOME: "/host/state" }),
    {
      status_file: `/host/state/ships/${shipKey(intent)}/status.json`,
      events_file: `/host/state/ships/${shipKey(intent)}/events.jsonl`,
    },
  );
  assert.equal(defaultShipStateStore({ AGENT_PIPELINE_STATE_HOME: "/host/state" }).eventsFile(shipKey(intent)),
    `/host/state/ships/${shipKey(intent)}/events.jsonl`);
});

test("default ship store atomically publishes typed status and appends exact-run events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-ship-state-"));
  try {
    const store = defaultShipStateStore({ AGENT_PIPELINE_STATE_HOME: root });
    const deps = makeDeps(store);
    const result = await runShipCoordinator(intent, authorization(), deps);
    const loaded = await store.read(shipKey(intent));
    assert.deepEqual(loaded, result);
    assert.equal(store.statusFile(shipKey(intent)), path.join(root, "ships", shipKey(intent), "status.json"));
    assert.equal(result.events_file, store.eventsFile(shipKey(intent)));
    const eventLines = (await fs.readFile(result.events_file, "utf8")).trim().split("\n");
    assert.equal(eventLines.length, 17);
    assert.equal((JSON.parse(eventLines.at(-1)!) as ShipPhaseEvent).phase, "complete");
    assert.deepEqual(
      (await fs.readdir(path.dirname(store.statusFile(shipKey(intent))))).sort(),
      ["events.jsonl", "status.json"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ship key is stable across Buzz events and unique across release coordinates", () => {
  assert.equal(shipKey(intent), shipKey({ ...intent, event_id: "f".repeat(64), thread_id: "other" }));
  assert.notEqual(shipKey(intent), shipKey({ ...intent, version: "1.34.1" }));
});

test("ship base lock serializes different milestones on one repository base", () => {
  assert.equal(
    shipBaseLockKey(intent),
    shipBaseLockKey({ ...intent, milestone: "v1.35.0", version: "1.35.0" }),
  );
  assert.notEqual(shipBaseLockKey(intent), shipBaseLockKey({ ...intent, base_branch: "staging" }));
});

test("ship run identity is deterministic and changes with Buzz thread identity", () => {
  assert.equal(shipRunId(intent), shipRunId(intent));
  assert.notEqual(shipRunId(intent), shipRunId({ ...intent, thread_id: "another-thread" }));
});

test("operator milestone ship admits without a grant and resumes the same ledger (#1096)", async () => {
  const store = memoryStore();
  const operator = operatorShipIntent(intent);
  const deps = makeDeps(store);
  const first = await runShipCoordinator(operator, null, deps);
  assert.equal(first.complete, true);
  assert.equal(first.authorization_fingerprint, OPERATOR_SHIP_FINGERPRINT);
  assert.deepEqual(deps.calls.filter((c) => c === "train"), ["train"]);
  const secondDeps = makeDeps(store, completeProgress());
  const second = await runShipCoordinator(operator, null, secondDeps);
  assert.equal(second.ship_key, first.ship_key);
  assert.ok(!secondDeps.calls.includes("train"), "second invoke must not start a sibling train");
  assert.ok(!secondDeps.calls.includes("plan-train"));
});

test("ship persist writes the current human_authority bit so recovery is not stranded (#1096)", async () => {
  const store = memoryStore();
  const parked = makeDeps(store);
  parked.convergeTrain = async () => {
    throw new Error("needs-human: missing-authority for milestone release");
  };
  await assert.rejects(
    runShipCoordinator(intent, authorization(), parked),
    /needs-human/,
  );
  assert.equal(store.status?.human_authority, true);
  assert.match(store.status?.last_error ?? "", /missing-authority/);

  const nonHuman = makeDeps(store);
  nonHuman.convergeTrain = async () => {
    throw new Error("transient train crash");
  };
  await assert.rejects(
    runShipCoordinator(intent, authorization(), nonHuman),
    /transient train crash/,
  );
  assert.equal(store.status?.human_authority, false);
  assert.equal(store.status?.last_error, "transient train crash");

  const recovered = makeDeps(store);
  const result = await runShipCoordinator(intent, authorization(), recovered);
  assert.equal(result.complete, true);
  assert.equal(result.human_authority, false);
  assert.equal(result.last_error, null);
});

test("ship coordinator pending wait-cap expiry stays resumable (#1205)", async () => {
  const store = memoryStore();
  const waiting = makeDeps(store);
  waiting.convergeReleaseFinish = async () => {
    throw new ShipReleaseCheckWaitError(
      "pending",
      "ship release: PR #1001 checks still pending after 2 polls; retry the same ship command to resume",
    );
  };
  const checkpoint = await runShipCoordinator(intent, authorization(), waiting);
  assert.equal(checkpoint.complete, false);
  assert.equal(checkpoint.next_action, "release_finish");
  assert.equal(checkpoint.last_error, null);
  assert.equal(checkpoint.human_authority, false);
  assert.equal(checkpoint.release_finish, null);
  assert.equal(checkpoint.release?.pr, 1001);
  assert.ok(!store.events.some((event) => event.status === "failed"));
  assert.ok(store.events.some((event) =>
    event.phase === "release_finish" &&
    event.status === "started" &&
    /still pending/.test(event.detail ?? ""),
  ));

  const observed = completeProgress();
  observed.release_finish = null;
  observed.publication = null;
  observed.promotion = null;
  const resumed = makeDeps(store, observed);
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.equal(result.complete, true);
  assert.equal(result.next_action, "complete");
  assert.equal(result.last_error, null);
  assert.ok(resumed.calls.includes("release-finish"));
  assert.ok(!resumed.calls.includes("train"));
});
