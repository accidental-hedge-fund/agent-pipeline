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
  assertNoRemainingOpenMilestoneIssues,
  listRemainingOpenMilestoneIssueNumbers,
  remainingOpenMilestoneIssuesError,
  emptyShipProgress,
  projectCandidateLineage,
  projectShipStatusView,
  shipPhaseInvariant,
  assertOperationBoundAuthority,
  type BuzzShipAuthorization,
  type RemainingOpenGhRunner,
  type ShipCoordinatorDeps,
  type ShipIntent,
  type ShipPhaseEvent,
  type ShipProgress,
  type ShipStateStore,
  type ShipStatus,
} from "../scripts/stages/ship.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import {
  listMilestoneOpenIssuesApiArgs,
  listMilestonesApiArgs,
} from "../scripts/stages/merge_queue.ts";
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

const emptyProgress = (): ShipProgress => emptyShipProgress();

const completeProgress = (): ShipProgress => {
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
      tag: `v${intent.version}`,
      published: true,
      artifact_digest: MERGE,
    },
    promotion: {
      version: intent.version,
      tag: `v${intent.version}`,
      verified: true,
      installed_version: intent.version,
      pin_digest: MERGE,
    },
    deployment: {
      version: intent.version,
      tag: `v${intent.version}`,
      environment: "all",
      authorized_digest: MERGE,
      live_digest: MERGE,
      verified: true,
    },
    lineage: emptyShipProgress().lineage,
  };
  progress.lineage = projectCandidateLineage(progress);
  return progress;
};

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
): ShipCoordinatorDeps & { calls: string[]; remainingOpenCalls: number; remainingOpenIssues: number[] } {
  const calls: string[] = [];
  const progress = completeProgress();
  const deps: ShipCoordinatorDeps & {
    calls: string[];
    remainingOpenCalls: number;
    remainingOpenIssues: number[];
  } = {
    calls,
    remainingOpenCalls: 0,
    remainingOpenIssues: [],
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
    async convergeDeployment(_intent, promotion) {
      calls.push("engine-deploy");
      assert.equal(promotion.pin_digest, MERGE);
      return structuredClone(progress.deployment!);
    },
    async observeRemainingOpenMilestoneIssues() {
      deps.remainingOpenCalls += 1;
      return [...deps.remainingOpenIssues];
    },
  };
  return deps;
}

async function seedFrozenTrainPlan(
  store: ReturnType<typeof memoryStore>,
): Promise<void> {
  const deps = makeDeps(store);
  deps.convergeTrain = async (_intent, plannedIssues) => {
    assert.deepEqual(plannedIssues, [901, 902]);
    throw new Error("simulated crash before train result");
  };
  const parked = await runShipCoordinator(intent, authorization(), deps);
  assert.equal(parked.complete, false);
  assert.match(parked.last_error ?? "", /simulated crash/);
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
    "engine-deploy",
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
      "deploy:started", "deploy:completed",
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

  const parked = await runShipCoordinator(intent, authorization(), deps);
  assert.match(parked.last_error ?? "", /simulated train crash/);
  assert.equal(parked.lifecycle, "cooling");
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
    "engine-deploy",
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
  progress.deployment = null;
  const deps = makeDeps(store, progress);

  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.deepEqual(deps.calls, ["reconcile", "release-finish", "release-wait", "engine-promote", "engine-deploy"]);
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
  const parked = await runShipCoordinator(intent, firstGrant, first);
  assert.match(parked.last_error ?? "", /parked/);
  assert.equal(parked.lifecycle, "cooling");

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
    assert.equal(eventLines.length, 19);
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

test("ship persist does not set human_authority from error-message regex (#1331)", async () => {
  const store = memoryStore();
  const parked = makeDeps(store);
  parked.convergeTrain = async () => {
    throw new Error("needs-human: missing-authority for milestone release");
  };
  const falseHuman = await runShipCoordinator(intent, authorization(), parked);
  assert.equal(falseHuman.human_authority, false);
  assert.equal(store.status?.human_authority, false);
  assert.match(store.status?.last_error ?? "", /missing-authority/);
  assert.equal(store.status?.lifecycle, "cooling");

  const nonHuman = makeDeps(store);
  nonHuman.convergeTrain = async () => {
    throw new Error("transient train crash");
  };
  const mechanical = await runShipCoordinator(intent, authorization(), nonHuman);
  assert.equal(mechanical.human_authority, false);
  assert.equal(store.status?.last_error, "transient train crash");
  assert.equal(store.status?.lifecycle, "cooling");

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
  observed.deployment = null;
  const resumed = makeDeps(store, observed);
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.equal(result.complete, true);
  assert.equal(result.next_action, "complete");
  assert.equal(result.last_error, null);
  assert.ok(resumed.calls.includes("release-finish"));
  assert.ok(!resumed.calls.includes("train"));
});

// ---------------------------------------------------------------------------
// Ship-end remaining-open gate (#1354)
// ---------------------------------------------------------------------------

test("assertNoRemainingOpenMilestoneIssues names every number and allows empty", () => {
  assert.doesNotThrow(() => assertNoRemainingOpenMilestoneIssues("v1.40.1", []));
  assert.throws(
    () => assertNoRemainingOpenMilestoneIssues("v1.40.1", [1344, 1348, 977]),
    (err: Error) => {
      assert.match(err.message, /ship-end-open-issue-gate/);
      assert.match(err.message, /v1\.40\.1/);
      assert.match(err.message, /#1344/);
      assert.match(err.message, /#1348/);
      assert.match(err.message, /#977/);
      assert.equal(err.message, remainingOpenMilestoneIssuesError("v1.40.1", [1344, 1348, 977]).message);
      return true;
    },
  );
});

function remainingOpenGhFake(opts: {
  milestones?: unknown;
  issues?: unknown;
  throwOn?: "milestones" | "issues";
  seen?: string[][];
}): RemainingOpenGhRunner {
  return async (args) => {
    opts.seen?.push([...args]);
    if (args[0] === "api" && String(args[1] ?? "").includes("/milestones")) {
      if (opts.throwOn === "milestones") throw new Error("gh auth failed: HTTP 401");
      return JSON.stringify(opts.milestones ?? [[{ number: 12, title: "v1.40.1" }]]);
    }
    if (args[0] === "api" && String(args[1] ?? "").includes("/issues")) {
      if (opts.throwOn === "issues") throw new Error("gh api paginate failed");
      return JSON.stringify(opts.issues ?? [[]]);
    }
    throw new Error(`unexpected gh args: ${args.join(" ")}`);
  };
}

test("listRemainingOpenMilestoneIssueNumbers fails closed on unresolved title, parse, and listing throw", async () => {
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      remainingOpenGhFake({ milestones: [[{ number: 1, title: "other" }]] }),
    ),
    /cannot resolve milestone v1\.40\.1/,
  );
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      remainingOpenGhFake({ milestones: "not-json" }),
    ),
    /cannot parse milestone listing/,
  );
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      async () => "{not json",
    ),
    /cannot parse milestone listing/,
  );
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      remainingOpenGhFake({ throwOn: "milestones" }),
    ),
    /cannot prove zero open issues on v1\.40\.1/,
  );
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      remainingOpenGhFake({ throwOn: "issues" }),
    ),
    /cannot prove zero open issues on v1\.40\.1/,
  );
  await assert.rejects(
    () => listRemainingOpenMilestoneIssueNumbers(
      "owner/repo",
      "v1.40.1",
      remainingOpenGhFake({ issues: { number: 1 } }),
    ),
    /cannot parse open-issue listing/,
  );
});

test("listRemainingOpenMilestoneIssueNumbers drops PRs, paginates, and uses milestone query", async () => {
  const seen: string[][] = [];
  const numbers = await listRemainingOpenMilestoneIssueNumbers(
    "owner/repo",
    "v1.40.1",
    remainingOpenGhFake({
      seen,
      issues: [
        [
          { number: 10, labels: [{ name: "pipeline:backlog" }] },
          { number: 11, pull_request: { url: "https://example/pr/11" }, labels: [] },
        ],
        [
          { number: 501, labels: [{ name: "factory-gate" }] },
        ],
      ],
    }),
  );
  assert.deepEqual(numbers, [10, 501]);
  const msArgs = listMilestonesApiArgs("owner/repo");
  const issueArgs = listMilestoneOpenIssuesApiArgs("owner/repo", 12);
  assert.deepEqual(seen[0], msArgs);
  assert.deepEqual(seen[1], issueArgs);
  assert.ok(issueArgs.some((a) => a.includes("milestone=12")));
  assert.ok(issueArgs.includes("--paginate"));
  assert.ok(!issueArgs.includes("--limit"));
});

async function seedCompletedTrain(
  store: ReturnType<typeof memoryStore>,
): Promise<void> {
  const deps = makeDeps(store);
  deps.convergeFrgPack = async () => {
    throw new Error("stop after train");
  };
  const parked = await runShipCoordinator(intent, authorization(), deps);
  assert.match(parked.last_error ?? "", /stop after train/);
  assert.ok(store.status?.train);
  assert.equal(store.status?.frg_pack, null);
}

test("ship remaining-open: leftover backlog after train does not start FRG (#1354)", async () => {
  const store = memoryStore();
  await seedCompletedTrain(store);
  const deps = makeDeps(store, { ...emptyProgress(), train: completeProgress().train });
  deps.remainingOpenIssues = [1344];
  const blocked = await runShipCoordinator(intent, authorization(), deps);
  assert.match(blocked.last_error ?? "", /milestone v1\.34\.0 still has open issues: #1344/);
  assert.equal(blocked.lifecycle, "waiting");
  assert.ok(deps.calls.includes("train") === false || store.status?.train);
  assert.ok(!deps.calls.includes("frg-pack"));
  assert.ok(!deps.calls.includes("frg-score"));
  assert.equal(store.status?.frg_pack, null);
  assert.equal(deps.remainingOpenCalls >= 1, true);
});

test("ship remaining-open: train is not gated by leftover open issues (#1354)", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  deps.remainingOpenIssues = [1344];
  const blocked = await runShipCoordinator(intent, authorization(), deps);
  assert.match(blocked.last_error ?? "", /#1344/);
  assert.equal(blocked.lifecycle, "waiting");
  assert.ok(deps.calls.includes("plan-train"));
  assert.ok(deps.calls.includes("train"));
  assert.ok(!deps.calls.includes("frg-pack"));
});

test("ship remaining-open: leftover issues block release prepare (#1354)", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  first.convergeReleasePrepare = async () => {
    throw new Error("stop after frg score");
  };
  const stopped = await runShipCoordinator(intent, authorization(), first);
  assert.match(stopped.last_error ?? "", /stop after frg score/);
  assert.ok(store.status?.frg);
  assert.equal(store.status?.release, null);

  const blocked = makeDeps(store, {
    ...emptyProgress(),
    train: completeProgress().train,
    frg_pack: completeProgress().frg_pack,
    frg: completeProgress().frg,
  });
  blocked.remainingOpenIssues = [1344];
  const held = await runShipCoordinator(intent, authorization(), blocked);
  assert.match(held.last_error ?? "", /#1344/);
  assert.ok(!blocked.calls.includes("release-prepare"));
  assert.ok(!blocked.calls.includes("release-finish"));
});

test("ship remaining-open: leftover issues block release finish (#1354)", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  first.convergeReleaseFinish = async () => {
    throw new Error("stop after release prepare");
  };
  const stopped = await runShipCoordinator(intent, authorization(), first);
  assert.match(stopped.last_error ?? "", /stop after release prepare/);
  assert.ok(store.status?.release);
  assert.equal(store.status?.release_finish, null);

  const blocked = makeDeps(store, {
    ...emptyProgress(),
    train: completeProgress().train,
    frg_pack: completeProgress().frg_pack,
    frg: completeProgress().frg,
    release: completeProgress().release,
  });
  blocked.remainingOpenIssues = [1348];
  const held = await runShipCoordinator(intent, authorization(), blocked);
  assert.match(held.last_error ?? "", /#1348/);
  assert.ok(!blocked.calls.includes("release-finish"));
});

test("ship remaining-open: leftover issues block engine-promote (#1354)", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  first.convergeEnginePromote = async () => {
    throw new Error("stop after publication");
  };
  const stopped = await runShipCoordinator(intent, authorization(), first);
  assert.match(stopped.last_error ?? "", /stop after publication/);
  assert.ok(store.status?.publication);
  assert.equal(store.status?.promotion, null);

  const blocked = makeDeps(store, {
    ...completeProgress(),
    promotion: null,
    deployment: null,
  });
  blocked.remainingOpenIssues = [977];
  const held = await runShipCoordinator(intent, authorization(), blocked);
  assert.match(held.last_error ?? "", /#977/);
  assert.ok(!blocked.calls.includes("engine-promote"));
});

test("ship remaining-open: resume re-observes after completed FRG pack (#1354)", async () => {
  const store = memoryStore();
  const first = makeDeps(store);
  first.convergeFrgScore = async () => {
    throw new Error("stop after frg pack");
  };
  const stopped = await runShipCoordinator(intent, authorization(), first);
  assert.match(stopped.last_error ?? "", /stop after frg pack/);
  assert.ok(store.status?.frg_pack);
  assert.equal(store.status?.frg, null);
  const firstObservations = first.remainingOpenCalls;
  assert.ok(firstObservations >= 1);

  const resumed = makeDeps(store, {
    ...emptyProgress(),
    train: completeProgress().train,
    frg_pack: completeProgress().frg_pack,
  });
  resumed.remainingOpenIssues = [1344];
  const held = await runShipCoordinator(intent, authorization(), resumed);
  assert.match(held.last_error ?? "", /#1344/);
  assert.ok(resumed.remainingOpenCalls >= 1, "resume must re-observe GitHub");
  assert.ok(!resumed.calls.includes("frg-score"));
  assert.ok(!resumed.calls.includes("frg-pack"));
});

test("ship remaining-open: zero open issues still reaches FRG pack (#1354)", async () => {
  const store = memoryStore();
  await seedCompletedTrain(store);
  const deps = makeDeps(store, { ...emptyProgress(), train: completeProgress().train });
  deps.remainingOpenIssues = [];
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.ok(deps.calls.includes("frg-pack"));
  assert.equal(result.frg_pack?.loop_run_id, "loop-1");
  assert.deepEqual(store.status?.train_plan, { ordered_issues: [901, 902] });
});

test("ship remaining-open: query failure fails closed before FRG (#1354)", async () => {
  const store = memoryStore();
  await seedCompletedTrain(store);
  const deps = makeDeps(store, { ...emptyProgress(), train: completeProgress().train });
  deps.observeRemainingOpenMilestoneIssues = async () => {
    throw new Error("ship-end-open-issue-gate: cannot prove zero open issues on v1.34.0: gh auth failed");
  };
  const held = await runShipCoordinator(intent, authorization(), deps);
  assert.match(held.last_error ?? "", /cannot prove zero open issues/);
  assert.equal(held.lifecycle, "waiting");
  assert.ok(!deps.calls.includes("frg-pack"));
});

test("candidate lineage round-trips distinct identities without collapsing to a version string (#1331)", () => {
  const lineage = projectCandidateLineage(completeProgress());
  assert.equal(lineage.integrated_candidate?.identity, CANDIDATE);
  assert.equal(lineage.frg_candidate?.identity, `${CANDIDATE}#frg-1`);
  assert.equal(lineage.release_pr_head?.identity, `pr#1001@${HEAD}`);
  assert.equal(lineage.release_merge_result?.identity, MERGE);
  assert.equal(lineage.tag?.identity, `v1.34.0@${MERGE}`);
  assert.equal(lineage.published_artifact?.identity, MERGE);
  assert.equal(lineage.promoted_pin?.identity, MERGE);
  assert.equal(lineage.deployed?.identity, `${MERGE}@all`);
  const identities = Object.values(lineage).map((node) => node?.identity);
  assert.ok(identities.every((id) => id && id !== intent.version && id !== "1.34.0"));
  assert.notEqual(lineage.integrated_candidate?.identity, lineage.release_pr_head?.identity);
  assert.notEqual(lineage.release_pr_head?.identity, lineage.release_merge_result?.identity);
});

test("missing observer proof cannot complete a post-ready phase (#1331)", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const deps = makeDeps(store);
  deps.waitForRelease = async () => ({
    version: intent.version,
    tag: "v1.34.0",
    published: true,
    artifact_digest: "",
  });
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.equal(result.complete, false);
  assert.equal(result.publication, null);
  assert.equal(result.lifecycle, "cooling");
  assert.match(result.last_error ?? "", /artifact_digest|reconciliation|OID|digest/i);
  const tag = shipPhaseInvariant("tag");
  assert.match(tag.observer, /origin annotated tag/);
  assert.match(shipPhaseInvariant("deployment").postcondition, /digest live/);
});

test("ship status view names phase, candidate, and next action without mutations (#1331)", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  const result = await runShipCoordinator(intent, authorization(), deps);
  const view = projectShipStatusView(result);
  assert.equal(view.phase, "complete");
  assert.equal(view.next_action, "complete");
  assert.equal(view.candidate, MERGE);
  assert.equal(view.human_authority, false);
  assert.equal(view.lifecycle, "complete");
  assert.equal(view.lineage.release_merge_result?.identity, MERGE);
});

test("canonical human-authority diagnostic still projects the status bit (#1331)", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  deps.convergeReleasePrepare = async () => {
    const err = new Error("needs-human: missing-authority for milestone release") as Error & {
      diagnostic: ReturnType<typeof buildStageDiagnostic>;
    };
    err.diagnostic = buildStageDiagnostic({
      blockerKind: "human-decision-required",
      reason: "release authority required",
      authorityEvidence: [{
        category: "authority",
        finding_key: "deadbeef",
        finding_fingerprint: "0123456789abcdef",
        reviewed_sha: CANDIDATE,
      }],
    });
    throw err;
  };
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.equal(result.human_authority, true);
  assert.equal(result.lifecycle, "waiting");
  assert.equal(result.complete, false);
});

test("started claim plus process death does not uncharge a completed side effect (#1331)", async () => {
  const store = memoryStore();
  await seedFrozenTrainPlan(store);
  const observed = emptyProgress();
  observed.train = completeProgress().train;
  const first = makeDeps(store, emptyProgress());
  first.convergeTrain = async () => {
    throw new Error("died after train mutation started");
  };
  const crashed = await runShipCoordinator(intent, authorization(), first);
  assert.equal(crashed.active_claim?.outcome, "uncertain");
  assert.equal(crashed.lifecycle, "cooling");
  const resumed = makeDeps(store, observed);
  const result = await runShipCoordinator(intent, authorization(), resumed);
  assert.equal(result.complete, true);
  assert.ok(!resumed.calls.includes("train"));
});

test("candidate movement refuses stale operation-bound authority (#1331)", () => {
  const presented = {
    operation: "release_prepare",
    repository: intent.repository,
    candidate: CANDIDATE,
    scope: "v1.34.0@1.34.0",
    actor: intent.sender_id,
    expires_at: "2026-08-17T11:55:00.000Z",
  };
  const moved = { ...presented, candidate: "e".repeat(40) };
  assert.throws(
    () => assertOperationBoundAuthority(presented, moved, NOW.getTime()),
    /candidate does not match/,
  );
});

test("roadmap.release_model is the single shipment-intent key (#1331)", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  deps.releaseModel = "continuous";
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.equal(result.release_model, "continuous");
  assert.equal(result.complete, true);
  assert.deepEqual(deps.calls, ["reconcile", "plan-train", "train"]);
  assert.ok(!deps.calls.includes("release-prepare"));
  assert.ok(!deps.calls.includes("engine-promote"));
  assert.ok(!deps.calls.includes("engine-deploy"));
});

test("semver remains the default when roadmap.release_model is absent (#1331)", async () => {
  const store = memoryStore();
  const deps = makeDeps(store);
  assert.equal(deps.releaseModel, undefined);
  const result = await runShipCoordinator(intent, authorization(), deps);
  assert.equal(result.release_model, "semver");
  assert.equal(result.complete, true);
  assert.ok(deps.calls.includes("frg-pack"));
  assert.ok(deps.calls.includes("engine-promote"));
  assert.ok(deps.calls.includes("engine-deploy"));
});
