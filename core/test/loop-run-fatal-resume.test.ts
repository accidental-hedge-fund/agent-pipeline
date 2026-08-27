// Tests for operator `--resume` of a terminal `run_fatal` stop (#1258).
// Injected store/observe/dispatch seams only — no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  driveSupervisor as driveSupervisorRaw,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import {
  acquireLock,
  appendEvent,
  initRun,
  readEvents,
  readLedger,
  releaseLock,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { reconcile, transitionItem, type ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import {
  classifyOutstandingItem,
  classifyRunFatalResumeEligibility,
  formatRunFatalResumeRefusal,
  LOOP_RUN_FATAL_SUPERSEDED,
  supersedeRunFatalStop,
} from "../scripts/loop/run-fatal-resume.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopExternalIdentity,
  type LoopHumanInputRequest,
  type LoopLedger,
  type LoopStopRecord,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";

const PIPELINE_READY_LABEL = "pipeline:ready";
const READY_LABEL = "pipeline:ready-to-deploy";
const ORIGINAL_STOP_TIME = "2026-08-27T15:27:13.000Z";
const RUN_ID = "run-1";

function hermeticSupervisorDeps(deps: SupervisorDeps): SupervisorDeps {
  return {
    probeLiveAdvance: () => ({ live: false as const }),
    acquireItemAdvanceLock: () => ({ release() {} }),
    ...deps,
  };
}

const driveSupervisor: typeof driveSupervisorRaw = (deps, input) =>
  driveSupervisorRaw(hermeticSupervisorDeps(deps), input);

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-08-27T16:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-run-fatal-resume-${counter++}` };

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
    async renameDirExclusive(from, to) {
      const fromPrefix = from + "/";
      const published = [...files.keys()].some((k) => k === to || k.startsWith(to + "/"));
      if (published) return false;
      for (const k of [...files.keys()]) {
        if (k.startsWith(fromPrefix)) {
          files.set(to + "/" + k.slice(fromPrefix.length), files.get(k)!);
          files.delete(k);
        }
      }
      return true;
    },
    async listDir(p) {
      const prefix = p + "/";
      return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]);
    },
    async isPidAlive(pid) {
      return pid === 111;
    },
    hostname: () => "host-a",
    pid: () => 111,
    now: () => new Date((clock += 1000)),
    uuid: () => `uuid-${uuidCounter++}`,
    env,
  };
  return { deps, files };
}

function identity(overrides: Partial<LoopExternalIdentity> = {}): LoopExternalIdentity {
  return {
    issue_number: 1253,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: null,
    pr_state: null,
    head_branch: "pipeline/1253-fix",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "none",
    pipeline_stage: "ready",
    observed_at: "2026-08-27T16:00:00.000Z",
    ...overrides,
  };
}

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: RUN_ID,
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "milestone", value: "v2" },
    objective: "ship v2",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: ["push_pr", "merge", "release", "deploy"],
    recovery_budgets: { default: 3 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [
      { id: "1253", depends_on: [], external_depends_on: [] },
      { id: "1254", depends_on: [], external_depends_on: [] },
    ],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function itemEntry(id: string, state: LoopLedger["items"][string]["state"]): LoopLedger["items"][string] {
  return { id, state, history: [], recovery_budgets_remaining: { default: 3 } };
}

function runFatalStop(overrides: Partial<LoopStopRecord> = {}): LoopStopRecord {
  return {
    reason: "run_fatal",
    time: ORIGINAL_STOP_TIME,
    item_id: "1253",
    theme: "workflow-engine-defect",
    outstanding_ready: [],
    ...overrides,
  };
}

function testLedger(items: LoopLedger["items"], stop: LoopStopRecord | null = runFatalStop()): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: RUN_ID,
    items,
    consecutive_blocked: 0,
    merge_barrier: null,
    stop,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

function coordinatedFakes(outcomeFor: (itemId: string) => LoopExecutionResponse["outcome"] | string = () => "ready_to_deploy") {
  const dispatched = new Set<string>();
  const calls: LoopExecutionRequest[] = [];
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      return { state: "open", labels: dispatched.has(String(issueNumber)) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      return dispatched.has(String(issueNumber)) ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-08-27T16:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: outcomeFor(request.item_id) as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  return { observe, dispatchItem, calls };
}

function humanHoldRequest(itemId: string): LoopHumanInputRequest {
  return {
    request_id: "req-1",
    item_id: itemId,
    kind: "decision",
    prompt: "Need a product decision",
    requested_by_engine: "claude",
    requested_at: ORIGINAL_STOP_TIME,
  };
}

async function seedStoppedRun(
  contract: LoopContract,
  ledger: LoopLedger,
): Promise<{ deps: LoopStoreDeps; files: Map<string, string>; originalStopEventLine: string }> {
  const { deps, files } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, contract.run_id, "claude");
  await appendEvent(deps, contract.run_id, token, "loop_run_stopped", {
    reason: ledger.stop?.reason,
    item_id: ledger.stop?.item_id,
    theme: ledger.stop?.theme,
  });
  const eventsPath = [...files.keys()].find((k) => k.endsWith("/events.jsonl"));
  assert.ok(eventsPath);
  const originalStopEventLine = (files.get(eventsPath) ?? "")
    .split("\n")
    .find((line) => line.includes('"loop_run_stopped"'))!;
  assert.ok(originalStopEventLine);
  await releaseLock(deps, contract.run_id, token);
  return { deps, files, originalStopEventLine };
}

function publishedRunIds(files: Map<string, string>): string[] {
  const ids = new Set<string>();
  for (const key of files.keys()) {
    const match = key.match(/\/runs\/([^/]+)\//);
    if (match && !match[1].includes(".init-")) ids.add(match[1]);
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// 2.1 / 2.2 — pure classifier
// ---------------------------------------------------------------------------

test("classifier: admitted pending item is valid-outstanding", () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const result = classifyOutstandingItem("1253", contract, ledger, identity({ issue_number: 1253, pipeline_stage: "ready" }));
  assert.deepEqual(result, { valid: true, reason: "admitted" });
});

test("classifier: human-authority waiting hold is not valid-outstanding", () => {
  const contract = testContract();
  const held = { ...itemEntry("1253", "waiting"), hold_request: humanHoldRequest("1253") };
  const ledger = testLedger({
    "1253": held,
    "1254": itemEntry("1254", "ready"),
  });
  const result = classifyOutstandingItem("1253", contract, ledger, identity({ pipeline_stage: "ready" }));
  assert.deepEqual(result, { valid: false, reason: "human_authority_hold" });
});

test("classifier: backlog-excluded pending item is not valid-outstanding", () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const result = classifyOutstandingItem(
    "1253",
    contract,
    ledger,
    identity({ pipeline_stage: "backlog" }),
  );
  assert.deepEqual(result, { valid: false, reason: "precondition_excluded" });
});

test("classifier: done item is not valid-outstanding", () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "ready"),
    "1254": itemEntry("1254", "pending"),
  });
  const result = classifyOutstandingItem("1253", contract, ledger, identity({ pipeline_stage: "ready-to-deploy", ready_label_present: true }));
  assert.deepEqual(result, { valid: false, reason: "done" });
});

test("classifier: missing identity fail-closes (not eligible)", () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const result = classifyOutstandingItem("1253", contract, ledger, null);
  assert.deepEqual(result, { valid: false, reason: "unusable_identity" });
  const eligibility = classifyRunFatalResumeEligibility(contract, ledger, {});
  assert.equal(eligibility.eligible, false);
  assert.deepEqual(eligibility.validOutstandingItemIds, []);
});

test("classifier: blocked missing-authority is a human-authority hold", () => {
  const contract = testContract();
  const blocked = { ...itemEntry("1253", "blocked"), blocked_theme: "missing-authority" };
  const ledger = testLedger({
    "1253": blocked,
    "1254": itemEntry("1254", "ready"),
  });
  const result = classifyOutstandingItem("1253", contract, ledger, identity({ pipeline_stage: "ready" }));
  assert.deepEqual(result, { valid: false, reason: "human_authority_hold" });
});

// ---------------------------------------------------------------------------
// 1.1 — stale transient run_fatal with valid outstanding items re-drives
// ---------------------------------------------------------------------------

test("resume of stale run_fatal with valid outstanding items dispatches at the same run id", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const { deps, files, originalStopEventLine } = await seedStoppedRun(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();
  const readyCalls: string[] = [];

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
    },
    {
      runId: RUN_ID,
      engine: "claude",
      resume: true,
      onRunReady: async (ctx) => {
        readyCalls.push(ctx.runId);
        const current = await readLedger(deps, RUN_ID);
        assert.equal(current.stop, null, "loop_drive_started / onRunReady must run after supersede");
      },
    },
  );

  assert.ok(calls.length >= 1, "dispatchItem must be called for a valid-outstanding re-drive");
  assert.ok(calls.every((c) => c.run_id === RUN_ID));
  assert.deepEqual(publishedRunIds(files), [RUN_ID], "must not mint a second run directory");
  assert.equal(result.runId, RUN_ID);
  assert.equal(result.resumed, true);
  assert.ok(result.dispatched > 0, "re-drive must not echo dispatched: 0");
  assert.notEqual(result.stop?.time, ORIGINAL_STOP_TIME);
  const finalLedger = await readLedger(deps, RUN_ID);
  assert.equal(finalLedger.stop, null, "original run_fatal must be superseded");
  assert.equal(readyCalls.length, 1);

  const events = await readEvents(deps, RUN_ID);
  const stopEvents = events.filter((e) => e.kind === "loop_run_stopped");
  const supersede = events.find((e) => e.kind === LOOP_RUN_FATAL_SUPERSEDED);
  const driveStarted = events.find((e) => e.kind === "loop_drive_started");
  assert.equal(stopEvents.length, 1, "original stop event remains; no rewrite");
  assert.ok(supersede, "supersede event must be appended");
  assert.equal((supersede!.data as { time: string }).time, ORIGINAL_STOP_TIME);
  assert.ok(driveStarted);
  assert.ok(events.indexOf(supersede!) < events.indexOf(driveStarted!), "loop_drive_started only after supersede");

  const eventsPath = [...files.keys()].find((k) => k.endsWith("/events.jsonl"))!;
  assert.ok(files.get(eventsPath)!.includes(originalStopEventLine), "original loop_run_stopped bytes must be unchanged");
});

// ---------------------------------------------------------------------------
// 1.2 — ineligible resume refuses instead of zero-dispatch success
// ---------------------------------------------------------------------------

test("resume of run_fatal with no valid outstanding item refuses distinctly", async () => {
  const contract = testContract();
  const held = { ...itemEntry("1253", "waiting"), hold_request: humanHoldRequest("1253") };
  const ledger = testLedger({
    "1253": held,
    "1254": itemEntry("1254", "ready"),
  });
  const { deps, files } = await seedStoppedRun(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  let driveResult: unknown = null;
  await assert.rejects(
    async () => {
      driveResult = await driveSupervisor(
        { store: deps, observe, dispatchItem },
        { runId: RUN_ID, engine: "claude", resume: true },
      );
    },
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "stop");
      assert.match(err.message, new RegExp(ORIGINAL_STOP_TIME));
      assert.match(err.message, /workflow-engine-defect/);
      assert.match(err.message, /item_id=1253/);
      assert.match(err.message, /pipeline loop --resume run-1 --audit/);
      assert.match(err.message, /pipeline loop --new-run/);
      return true;
    },
  );
  assert.equal(driveResult, null, "must not return the terminal drive summary");
  assert.equal(calls.length, 0, "dispatchItem must not be called on ineligible resume");
  const finalLedger = await readLedger(deps, RUN_ID);
  assert.equal(finalLedger.stop?.reason, "run_fatal");
  assert.equal(finalLedger.stop?.time, ORIGINAL_STOP_TIME);
  const events = await readEvents(deps, RUN_ID);
  assert.equal(events.some((e) => e.kind === LOOP_RUN_FATAL_SUPERSEDED), false);
  assert.equal(events.some((e) => e.kind === "loop_drive_started"), false);
  assert.deepEqual(publishedRunIds(files), [RUN_ID]);
});

test("resume of run_fatal fail-closes when live observation throws", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const { deps } = await seedStoppedRun(contract, ledger);
  const { dispatchItem, calls } = coordinatedFakes();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      throw new Error("gh unavailable");
    },
    async findPrForIssue() {
      return null;
    },
    async getPrDetail() {
      return null;
    },
    async getPrChecks() {
      return [];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-08-27T16:00:00.000Z"),
  };

  await assert.rejects(
    () => driveSupervisor({ store: deps, observe, dispatchItem }, { runId: RUN_ID, engine: "claude", resume: true }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.match((err as Error).message, /live observation failed/);
      assert.match((err as Error).message, /gh unavailable/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
  const finalLedger = await readLedger(deps, RUN_ID);
  assert.equal(finalLedger.stop?.reason, "run_fatal");
  assert.equal(finalLedger.stop?.time, ORIGINAL_STOP_TIME);
});

// ---------------------------------------------------------------------------
// 1.3 — re-drive that fatals again is a new stop
// ---------------------------------------------------------------------------

function alwaysReadyObserve(): ReconcileObserveDeps {
  return {
    async getIssueStateAndLabels() {
      return { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      return null;
    },
    async getPrDetail() {
      return null;
    },
    async getPrChecks() {
      return [];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-08-27T16:00:00.000Z"),
  };
}

test("eligible run_fatal resume that fatals again records a new stop time", async () => {
  const contract = testContract({ items: [{ id: "1253", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({ "1253": itemEntry("1253", "pending") });
  const { deps } = await seedStoppedRun(contract, ledger);
  const { dispatchItem, calls } = coordinatedFakes(() => "some-unrecognized-outcome");

  const result = await driveSupervisor(
    { store: deps, observe: alwaysReadyObserve(), dispatchItem },
    { runId: RUN_ID, engine: "claude", resume: true },
  );

  assert.ok(calls.length >= 1, "dispatchItem must have been called");
  assert.equal(result.stop?.reason, "run_fatal");
  assert.notEqual(result.stop?.time, ORIGINAL_STOP_TIME, "new stop must not reuse the superseded time");
  const events = await readEvents(deps, RUN_ID);
  const stopEvents = events.filter((e) => e.kind === "loop_run_stopped");
  assert.ok(stopEvents.length >= 2, "original stop event plus a new stop event");
  assert.ok(events.some((e) => e.kind === LOOP_RUN_FATAL_SUPERSEDED));
});

// ---------------------------------------------------------------------------
// 1.4 — live-drive run_fatal policy is unchanged
// ---------------------------------------------------------------------------

test("live (non-resume) drive still persists run_fatal for workflow-engine-defect", async () => {
  const contract = testContract({ items: [{ id: "1253", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({ "1253": itemEntry("1253", "pending") }, null);
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { dispatchItem, calls } = coordinatedFakes(() => "some-unrecognized-outcome");

  const result = await driveSupervisor(
    { store: deps, observe: alwaysReadyObserve(), dispatchItem },
    { runId: RUN_ID, engine: "claude" },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.stop?.reason, "run_fatal");
  assert.equal(result.stop?.theme, "workflow-engine-defect");
  assert.equal(result.resumed, false);
  assert.equal(DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].run_fatal, true);
});

// ---------------------------------------------------------------------------
// 3.1–3.4 — stop supersede (store / engine)
// ---------------------------------------------------------------------------

test("eligible supersede clears ledger.stop and preserves the original stop event", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "1253": itemEntry("1253", "pending"),
    "1254": itemEntry("1254", "pending"),
  });
  const { deps, files, originalStopEventLine } = await seedStoppedRun(contract, ledger);
  const { token } = await acquireLock(deps, RUN_ID, "claude");
  const prior = await supersedeRunFatalStop(deps, RUN_ID, token);
  assert.equal(prior.time, ORIGINAL_STOP_TIME);
  const after = await readLedger(deps, RUN_ID);
  assert.equal(after.stop, null);
  const events = await readEvents(deps, RUN_ID);
  const original = events.find((e) => e.kind === "loop_run_stopped");
  const supersede = events.find((e) => e.kind === LOOP_RUN_FATAL_SUPERSEDED);
  assert.ok(original);
  assert.ok(supersede);
  assert.equal((supersede!.data as { time: string; theme: string }).time, ORIGINAL_STOP_TIME);
  assert.equal((supersede!.data as { theme: string }).theme, "workflow-engine-defect");
  const eventsPath = [...files.keys()].find((k) => k.endsWith("/events.jsonl"))!;
  assert.ok(files.get(eventsPath)!.includes(originalStopEventLine));

  const { observe } = coordinatedFakes();
  const reconciliation = await reconcile(deps, observe, { runId: RUN_ID, token, engine: "claude" });
  assert.ok(reconciliation);
  const advanced = await transitionItem(deps, observe, contract, {
    runId: RUN_ID,
    token,
    itemId: "1253",
    engine: "claude",
    to: "in_progress",
  });
  assert.equal(advanced.items["1253"].state, "in_progress");
  await releaseLock(deps, RUN_ID, token);
});

test("supersede refuses a non-run_fatal stop and leaves it in place", async () => {
  const contract = testContract({ items: [{ id: "1253", depends_on: [], external_depends_on: [] }] });
  const stop: LoopStopRecord = {
    reason: "recovery_exhausted",
    time: ORIGINAL_STOP_TIME,
    item_id: "1253",
    theme: "implementation-ci",
    outstanding_ready: [],
  };
  const ledger = testLedger({ "1253": itemEntry("1253", "blocked") }, stop);
  const { deps } = await seedStoppedRun(contract, ledger);
  const { token } = await acquireLock(deps, RUN_ID, "claude");
  await assert.rejects(() => supersedeRunFatalStop(deps, RUN_ID, token), /no run_fatal stop to supersede/);
  const after = await readLedger(deps, RUN_ID);
  assert.equal(after.stop?.reason, "recovery_exhausted");
  await releaseLock(deps, RUN_ID, token);
});

test("resume of recovery_exhausted does not clear that stop or dispatch", async () => {
  const contract = testContract({ items: [{ id: "1253", depends_on: [], external_depends_on: [] }] });
  const stop: LoopStopRecord = {
    reason: "recovery_exhausted",
    time: ORIGINAL_STOP_TIME,
    item_id: "1253",
    theme: "implementation-ci",
    outstanding_ready: [],
  };
  const ledger = testLedger({ "1253": itemEntry("1253", "pending") }, stop);
  const { deps } = await seedStoppedRun(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem },
    { runId: RUN_ID, engine: "claude", resume: true },
  );
  assert.equal(result.resumed, true);
  assert.equal(result.dispatched, 0);
  assert.equal(result.stop?.reason, "recovery_exhausted");
  assert.equal(result.stop?.time, ORIGINAL_STOP_TIME);
  assert.equal(calls.length, 0);
  const finalLedger = await readLedger(deps, RUN_ID);
  assert.equal(finalLedger.stop?.reason, "recovery_exhausted");
  const { token } = await acquireLock(deps, RUN_ID, "claude");
  await assert.rejects(
    () =>
      transitionItem(deps, observe, contract, {
        runId: RUN_ID,
        token,
        itemId: "1253",
        engine: "claude",
        to: "in_progress",
      }),
    (err: unknown) => {
      assert.ok(err instanceof LoopError);
      assert.equal(err.loopFailureClass, "stop");
      assert.match(err.message, /recovery_exhausted/);
      return true;
    },
  );
  await releaseLock(deps, RUN_ID, token);
});

test("formatRunFatalResumeRefusal names time, theme, item, and recovery commands", () => {
  const message = formatRunFatalResumeRefusal("loop-68575cf7a09c849c", runFatalStop());
  assert.match(message, /2026-08-27T15:27:13/);
  assert.match(message, /theme=workflow-engine-defect/);
  assert.match(message, /item_id=1253/);
  assert.match(message, /pipeline loop --resume loop-68575cf7a09c849c --audit/);
  assert.match(message, /pipeline loop --new-run/);
});
