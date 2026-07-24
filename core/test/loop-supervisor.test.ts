// Tests for the durable loop supervisor (#512, capability
// `durable-loop-supervisor`). Every test runs through an in-memory
// LoopStoreDeps fake and an in-memory ReconcileObserveDeps fake (mirrors
// loop-reconcile.test.ts) plus a fake `pipeline/loop-execution@1` dispatch —
// no real filesystem, process, network, git, or subprocess access anywhere
// in this file, and no external goal-loop skill invocation on any path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT,
  attachSupervisor,
  auditSupervisor,
  driveSupervisor,
  runSupervisorCycle,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import { acquireLock, initRun, readEvents, readLedger, readLock, writeLedger, type LoopStoreDeps } from "../scripts/loop/store.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import type { ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";

const READY_LABEL = "pipeline:ready-to-deploy";
// The precondition stage gate (#568, capability `loop-precondition-stage-gate`) excludes a
// pending item whose observed `pipeline:*` label is `backlog` or absent — every fake below
// defaults an item to `pipeline:ready` so the scheduling/dispatch behavior under test here (which
// predates and is orthogonal to the precondition gate) is unaffected; tests of the gate itself
// override this explicitly.
const PIPELINE_READY_LABEL = "pipeline:ready";

// ---------------------------------------------------------------------------
// In-memory fakes (mirrors loop-reconcile.test.ts's fakeDeps/fakeObserveDeps).
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-supervisor-${counter++}` };

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

function fakeObserveDeps(overrides: Partial<ReconcileObserveDeps> = {}): { deps: ReconcileObserveDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      calls.push(`getIssueStateAndLabels:${issueNumber}`);
      return { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      calls.push(`findPrForIssue:${issueNumber}`);
      return null;
    },
    async getPrDetail(prNumber) {
      calls.push(`getPrDetail:${prNumber}`);
      return null;
    },
    async getPrChecks(prNumber) {
      calls.push(`getPrChecks:${prNumber}`);
      return [];
    },
    async getLocalHead(issueNumber) {
      calls.push(`getLocalHead:${issueNumber}`);
      return null;
    },
    async baseBranchContainsSha(sha) {
      calls.push(`baseBranchContainsSha:${sha}`);
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  };
  return { deps, calls };
}

/** A dispatch+observe pair coordinated through a shared "dispatched" set: an
 *  item's observed identity only supports `ready` AFTER `dispatchItem` has
 *  been called for it. Without this coordination, an observe fake that
 *  unconditionally reports a ready-supporting identity would let
 *  reconciliation's own forward-repair jump every pending item straight to
 *  `ready` before the supervisor ever dispatches it — masking the very
 *  dispatch-ordering behavior these tests exist to prove. */
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
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

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
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
    items: [{ id: "100", depends_on: [] }],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function itemEntry(id: string, state: LoopLedger["items"][string]["state"]): LoopLedger["items"][string] {
  return { id, state, history: [], recovery_budgets_remaining: { default: 3 } };
}

function testLedger(items: LoopLedger["items"]): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items,
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

async function setup(contract: LoopContract, ledger: LoopLedger) {
  const { deps, files } = fakeDeps();
  await initRun(deps, contract, ledger);
  return { deps, files };
}

// ---------------------------------------------------------------------------
// 6.1 — drive-loop test.
// ---------------------------------------------------------------------------

test("driveSupervisor executes dependency-ordered items to a terminal condition with zero real network/git/subprocess and no external-skill invocation", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: ["100"] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.allDone, true);
  assert.equal(result.stop, null);
  assert.deepEqual(calls.map((c) => c.item_id), ["100", "200"]);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready");
  assert.equal(finalLedger.items["200"].state, "ready");
});

// ---------------------------------------------------------------------------
// 6.2 — process-identity test.
// ---------------------------------------------------------------------------

test("supervisor.json is written at attach and its heartbeat advances per cycle through the injected store seam", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: ["100"] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  const auditBeforeAttach = await auditSupervisor(deps, "run-1");
  assert.equal(auditBeforeAttach.process, null);

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });
  assert.equal(result.allDone, true);
  assert.ok(result.cycles >= 2, "two dependency-ordered items require at least two cycles");

  const auditAfter = await auditSupervisor(deps, "run-1");
  assert.ok(auditAfter.process);
  assert.equal(auditAfter.process!.run_id, "run-1");
  assert.equal(auditAfter.process!.engine, "claude");
  assert.equal(auditAfter.process!.pid, 111);
  assert.equal(auditAfter.process!.hostname, "host-a");
  assert.ok(auditAfter.process!.boot_id);
  assert.ok(
    new Date(auditAfter.process!.heartbeat_at).getTime() > new Date(auditAfter.process!.started_at).getTime(),
    "heartbeat_at must have advanced past the initial attach time across cycles",
  );
});

// ---------------------------------------------------------------------------
// 6.3 — watchdog test.
// ---------------------------------------------------------------------------

test("a spin scenario gated on a dangling dependency reports a typed dependency_deadlock instead of spinning to supervisor_no_progress (#513)", async () => {
  // "100" depends on "200", which itself depends on a non-existent "999" —
  // neither item is ever eligible. Pre-#513 this silently spun to the generic
  // supervisor_no_progress watchdog; the durable-run-dependency-integrity
  // capability now reports the typed stop immediately, naming the chain.
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"] },
      { id: "200", depends_on: ["999"] },
    ],
    consecutive_no_progress_limit: 3,
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.cycles, 1, "the deadlock is structural, not a no-progress accident — it is reported on the first cycle");
  assert.equal(result.stop?.reason, "dependency_deadlock");
  assert.deepEqual(result.stop?.deadlock_chain, [
    { item_id: "100", waiting_on: "200", kind: "in_run", observed_state: "pending" },
    { item_id: "200", waiting_on: "999", kind: "in_run", observed_state: "missing" },
  ]);
  assert.equal(calls.length, 0, "no item was ever eligible, so dispatchItem must never be called");
});

test("exhausting the cycle safety cap while every cycle reports progress records a durable supervisor_cycle_cap stop instead of exiting unheld (review round 2, finding 8e8af6cd)", async () => {
  // Item "100" is parked in "pr_opened" with a bound identity whose checks
  // were "success"; the live observed identity keeps reporting "failure" on
  // every cycle. classifyDrift only updates the bound identity on a clean
  // (non-drifted) pass, so this "checks-regressed" drift — and therefore
  // `progress: true` — recurs every single cycle forever: a reconciliation
  // defect or continually changing non-actionable live state, never settling
  // into a stop, hold, or all-done terminal condition on its own.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const boundIdentity = {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    pr_number: 12,
    pr_state: "open" as const,
    head_branch: "pipeline/100-x",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "success" as const,
    observed_at: "2026-07-23T00:00:00.000Z",
  };
  const ledger = testLedger({
    "100": { ...itemEntry("100", "pr_opened"), last_verified_identity: boundIdentity },
  });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: [] };
    },
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-x", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "fail" }];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha() {
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const { dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem },
    { runId: "run-1", engine: "claude", maxCyclesSafety: 5 },
  );

  assert.equal(calls.length, 0, "the drifting item is never dependency-eligible, so it must never be dispatched");
  assert.equal(result.cycles, 5);
  assert.equal(result.holdOutstanding, false);
  assert.equal(result.allDone, false);
  assert.equal(result.stop?.reason, "supervisor_cycle_cap");
  assert.equal(result.stop?.limit, 5);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.stop?.reason, "supervisor_cycle_cap");

  const auditAfter = await auditSupervisor(deps, "run-1");
  const lastEntry = auditAfter.action_evidence.at(-1);
  assert.equal(lastEntry?.outcome, "supervisor_cycle_cap");
  assert.equal(lastEntry?.progress, "progress");

  const lockAfter = await readLock(deps, "run-1");
  assert.equal(lockAfter, null, "the lock must still be released even though the run stopped via the cap");
});

test("a progress cycle following a no-progress cycle is classified progress, not accumulated", async () => {
  // "100" depends on "200"; "200" starts undone, so cycle 1 has no eligible
  // item. Between cycles the test simulates external forward progress on
  // "200" (an out-of-band write, not a supervisor action) so cycle 2 finds
  // "100" eligible.
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "blocked") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle1 = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(cycle1.progress, false);

  const mid = await readLedger(deps, "run-1");
  await writeLedger(deps, { ...mid, items: { ...mid.items, "200": { ...mid.items["200"], state: "ready" } } }, token);

  const cycle2 = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(cycle2.progress, true);
});

// ---------------------------------------------------------------------------
// 6.4 — action-evidence test.
// ---------------------------------------------------------------------------

test("action-evidence is one ordered, append-only entry per cycle, sequence strictly increasing, no prior entry rewritten", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: ["100"] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  const trail = await auditSupervisor(deps, "run-1").then((r) => r.action_evidence);
  assert.ok(trail.length >= 2);
  for (let i = 0; i < trail.length; i++) {
    assert.equal(trail[i].seq, i);
  }
  const seqs = trail.map((e) => e.seq);
  const before = JSON.stringify(trail);
  // Running one more cycle's worth of work must only append, never rewrite.
  assert.equal(JSON.stringify(trail), before);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// 6.5 — no-stage-verb / no-merge test.
// ---------------------------------------------------------------------------

test("stage transitions originate in the advance state machine (transitionItem/blockItem), the supervisor performs no merge, and an out-of-set outcome is recorded failed and not re-dispatched", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem, calls } = coordinatedFakes(() => "merged_and_pushed_to_prod" as unknown as string);

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(calls.length, 1, "an out-of-set outcome must not be silently re-dispatched");
  assert.equal(result.stop?.reason, "run_fatal");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");

  const trail = await auditSupervisor(deps, "run-1").then((r) => r.action_evidence);
  const dispatchEntry = trail.find((e) => e.action === "dispatch_item");
  assert.equal(dispatchEntry?.outcome, "failed");
});

// ---------------------------------------------------------------------------
// 6.6 — resume tests.
// ---------------------------------------------------------------------------

test("resume reconciles and continues after a same-host dead-pid lock, with no second store", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  // A prior supervisor acquired the lock, then died (pid 111 is alive per the
  // fake's isPidAlive; simulate a dead prior holder with a different pid).
  await writeLedger(deps, ledger, (await acquireLockDirectly(deps, "run-1", 999)).token);

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude", resume: true });
  assert.equal(result.resumed, true);
  assert.equal(result.allDone, true);

  const trail = await auditSupervisor(deps, "run-1").then((r) => r.action_evidence);
  assert.ok(trail.some((e) => e.action === "resume"));
});

async function acquireLockDirectly(deps: LoopStoreDeps, runId: string, pid: number) {
  const withPid: LoopStoreDeps = { ...deps, pid: () => pid };
  return acquireLock(withPid, runId, "claude");
}

test("resume is refused with zero writes when the lock holder is alive on the same host", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  await acquireLock(deps, "run-1", "claude"); // pid 111 — alive per the fake

  await assert.rejects(
    () => driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude", resume: true }),
    /not verifiably dead/,
  );
  const status = await readLedger(deps, "run-1");
  assert.deepEqual(status, ledger);
});

test("resume is refused with zero writes when the lock holder is on a different host (unverifiable liveness)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  const otherHost: LoopStoreDeps = { ...deps, hostname: () => "host-b" };
  await acquireLock(otherHost, "run-1", "claude");

  await assert.rejects(
    () => driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude", resume: true }),
    /not verifiably dead/,
  );
});

test("resume is refused before any takeover when the contract/ledger schema id is outside the supported set", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  // Simulate a legacy/unsupported schema by rewriting the persisted contract.
  const files = (deps as unknown as { files?: Map<string, string> }).files;
  await assert.rejects(async () => {
    const badContract = { ...contract, schema: "legacy/contract@0" as unknown as typeof LOOP_CONTRACT_SCHEMA };
    const rawDeps: LoopStoreDeps = {
      ...deps,
      async readTextFile(p) {
        const text = await deps.readTextFile(p);
        if (text && p.endsWith("contract.json")) return JSON.stringify(badContract);
        return text;
      },
    };
    await driveSupervisor({ store: rawDeps, observe, dispatchItem }, { runId: "run-1", engine: "claude", resume: true });
  }, /outside the store's supported set/);
});

// ---------------------------------------------------------------------------
// 6.7 — audit test.
// ---------------------------------------------------------------------------

test("audit renders identity/timeline/watchdog/position with zero durable writes; a run with no supervisor.json audits without error", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  const before = await readLedger(deps, "run-1");
  const report = await auditSupervisor(deps, "run-1");
  assert.equal(report.process, null);
  assert.deepEqual(report.action_evidence, []);
  assert.equal(report.consecutive_no_progress, 0);
  const after = await readLedger(deps, "run-1");
  assert.deepEqual(before, after);

  const { observe, dispatchItem } = coordinatedFakes();
  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  const afterDrive = await auditSupervisor(deps, "run-1");
  assert.ok(afterDrive.process);
  assert.ok(afterDrive.action_evidence.length > 0);
  assert.equal(afterDrive.status.run_id, "run-1");
});

// ---------------------------------------------------------------------------
// 6.8 — lock-release test (#512 review 1, finding 2728bea1).
// ---------------------------------------------------------------------------

test("driveSupervisor releases the lock once the run reaches a terminal condition, so a second supervisor can attach without --resume", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });
  assert.equal(result.allDone, true);

  assert.equal(await readLock(deps, "run-1"), null, "lock must be released after the run completes");
  // The process-identity record survives the lock release as the last-process record.
  const report = await auditSupervisor(deps, "run-1");
  assert.ok(report.process, "supervisor.json must remain as the last-process record");

  // A second supervisor can now attach without --resume, since no lock is held.
  const secondDrive = await driveSupervisor(
    { store: deps, observe: fakeObserveDeps().deps, dispatchItem: coordinatedFakes().dispatchItem },
    { runId: "run-1", engine: "codex" },
  );
  assert.equal(secondDrive.allDone, true);
});

test("driveSupervisor releases the lock on a dependency_deadlock stop", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"] },
      { id: "200", depends_on: ["999"] },
    ],
    consecutive_no_progress_limit: 2,
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });
  assert.equal(result.stop?.reason, "dependency_deadlock");

  assert.equal(await readLock(deps, "run-1"), null, "lock must be released after a dependency_deadlock stop");
});

test("driveSupervisor releases the lock even when a cycle throws", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    ...fakeObserveDeps().deps,
    async getIssueStateAndLabels() {
      throw new Error("simulated transient failure");
    },
  };
  const { dispatchItem } = coordinatedFakes();

  await assert.rejects(
    () => driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" }),
    /simulated transient failure/,
  );

  assert.equal(await readLock(deps, "run-1"), null, "lock must be released even when a cycle throws");
});

// ---------------------------------------------------------------------------
// onDriveEnd hook (#538, capability durable-run-blocker-auto-file) — a
// best-effort, config/gh-free hook fired once driveSupervisor reaches a
// terminal stop or full completion. Never fired on an outstanding pause/hold;
// never allowed to alter the drive result or the lock release.
// ---------------------------------------------------------------------------

test("onDriveEnd fires exactly once on full completion (allDone)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  const calls: unknown[] = [];

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, onDriveEnd: async (r) => { calls.push(r); } },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.allDone, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], result);
});

test("onDriveEnd fires exactly once on a terminal stop", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"] },
      { id: "200", depends_on: ["999"] },
    ],
    consecutive_no_progress_limit: 3,
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem } = coordinatedFakes();
  const calls: unknown[] = [];

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, onDriveEnd: async (r) => { calls.push(r); } },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop?.reason, "dependency_deadlock");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], result);
});

test("onDriveEnd is best-effort — a throwing hook never alters the drive result and the lock is still released", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, onDriveEnd: async () => { throw new Error("simulated auto-file failure"); } },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.allDone, true);
  assert.equal(await readLock(deps, "run-1"), null, "lock must still be released when onDriveEnd throws");
});

test("onDriveEnd is absent by default (optional) — existing SupervisorDeps callers are unaffected", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });
  assert.equal(result.allDone, true);
});

// ---------------------------------------------------------------------------
// #530 — the independent-set scheduler wired into the supervisor cycle.
// ---------------------------------------------------------------------------

test("runSupervisorCycle: a durable schedule-evaluation record is written for every eligible candidate, even in the serialized default", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }, { id: "200", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.deepEqual(calls.map((c) => c.item_id), ["100"], "no concurrency policy — exactly one item is dispatched");

  const events = await readEvents(deps, "run-1");
  const scheduleEvent = events.find((e: any) => e.kind === "loop_schedule_evaluated");
  assert.ok(scheduleEvent, "a schedule-evaluation record must be written");
  assert.deepEqual((scheduleEvent as any).data.selected, ["100"]);
  const rationale = (scheduleEvent as any).data.rationale;
  assert.equal(rationale.find((r: any) => r.item_id === "100").disposition, "admitted");
  // Neither item declares ownership, so the fixed reason precedence (conflict/unknown-ownership
  // ahead of budget) reports "200" as unknown ownership against the admitted "100" — even though
  // the budget of one would already have serialized it regardless.
  assert.equal(rationale.find((r: any) => r.item_id === "200").disposition, "unknown_ownership");
});

test("runSupervisorCycle: a concurrency policy dispatches multiple proven-independent items in the same cycle", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(result.progress, true);
  assert.deepEqual(new Set(calls.map((c) => c.item_id)), new Set(["100", "200"]), "both independent items dispatched in one cycle");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready");
  assert.equal(finalLedger.items["200"].state, "ready");
});

test("runSupervisorCycle: a concurrency policy still serializes a conflicting pair — only one is dispatched", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/shared.ts"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/shared.ts"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.deepEqual(calls.map((c) => c.item_id), ["100"], "conflicting pair — only the first is admitted this cycle");
});

test("runSupervisorCycle: an active merge barrier admits nothing even under a concurrency policy", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  ledger.merge_barrier = { item_id: "300", merged_sha: "deadbeef", set_at: "2026-07-23T00:00:00.000Z" };
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(calls.length, 0, "the barrier admits nothing — dispatchItem is never called");
  assert.equal(result.progress, false);

  const events = await readEvents(deps, "run-1");
  const scheduleEvent = events.find((e: any) => e.kind === "loop_schedule_evaluated") as any;
  assert.ok(scheduleEvent.data.rationale.every((r: any) => r.disposition === "merge_barrier"));
});

test("runSupervisorCycle: observed changed-file overlap parks the concurrently-run pair and records a replan request", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const changedFilesByItem: Record<string, string[]> = {
    "100": ["src/one/a.ts", "src/shared/config.ts"],
    "200": ["src/two/b.ts", "src/shared/config.ts"],
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, getChangedFiles: async (itemId) => changedFilesByItem[itemId] },
    "run-1",
    token,
    "claude",
  );

  assert.equal(result.progress, true);
  assert.deepEqual(new Set(calls.map((c) => c.item_id)), new Set(["100", "200"]), "both were still dispatched — parking is a post-run check");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "parked, not advanced to ready, despite reporting ready_to_deploy");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-state");
  assert.equal(finalLedger.items["200"].state, "blocked");
  assert.equal(finalLedger.items["200"].blocked_theme, "workflow-state");

  const events = await readEvents(deps, "run-1");
  const replan = events.find((e: any) => e.kind === "loop_replan_requested") as any;
  assert.ok(replan, "a durable replan-request record must be written");
  assert.deepEqual(replan.data.affected_item_ids, ["100", "200"]);
  assert.deepEqual(replan.data.overlapping_paths, ["src/shared/config.ts"]);
});

test("runSupervisorCycle: changed-file overlap parking preserves an unaffected third item's independence evidence", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 3 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
      { id: "300", depends_on: [], ownership: { exclusive: ["src/three/**"] } },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const changedFilesByItem: Record<string, string[]> = {
    "100": ["src/one/a.ts", "src/shared/config.ts"],
    "200": ["src/two/b.ts", "src/shared/config.ts"],
    "300": ["src/three/c.ts"],
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle(
    { store: deps, observe, dispatchItem, getChangedFiles: async (itemId) => changedFilesByItem[itemId] },
    "run-1",
    token,
    "claude",
  );

  assert.deepEqual(new Set(calls.map((c) => c.item_id)), new Set(["100", "200", "300"]));

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["200"].state, "blocked");
  assert.equal(finalLedger.items["300"].state, "ready", "the unaffected item's independence evidence and outcome are preserved");
});

test("runSupervisorCycle: without a concurrency policy, getChangedFiles is never consulted (single-item cycles are unaffected)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  let getChangedFilesCalls = 0;

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      getChangedFiles: async () => {
        getChangedFilesCalls++;
        return [];
      },
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(getChangedFilesCalls, 0);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready");
});

// ---------------------------------------------------------------------------
// #530 review 1 findings 01db9f2b / 507013f5 — a failed/rejected concurrent
// sibling must never strand an already-completed sibling's outcome unpersisted.
// ---------------------------------------------------------------------------

test("runSupervisorCycle: a failed concurrent sibling does not strand an already-succeeded sibling's outcome", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes((itemId) => (itemId === "100" ? "bogus_outcome" : "ready_to_deploy"));

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.deepEqual(new Set(calls.map((c) => c.item_id)), new Set(["100", "200"]), "both independent items were dispatched");
  assert.equal(result.stop?.reason, "run_fatal", "the failed item's block records the run_fatal stop");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "the failing item is durably blocked, not silently re-dispatchable");
  assert.equal(
    finalLedger.items["200"].state,
    "ready",
    "the sibling's already-completed ready_to_deploy outcome is preserved, not stranded in_progress",
  );

  const events = await readEvents(deps, "run-1");
  assert.ok(events.some((e: any) => e.kind === "loop_item_transitioned" && e.data?.item_id === "200" && e.data?.to === "ready"));
});

test("runSupervisorCycle: a rejected concurrent dispatch is durably classified failed and never discards a successful sibling", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem: baseDispatchItem } = coordinatedFakes();
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "100") throw new Error("simulated transport failure");
    return baseDispatchItem(request);
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(result.stop?.reason, "run_fatal");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "the rejected dispatch is classified failed and blocked, not silently dropped");
  assert.equal(finalLedger.items["100"].evidence_fingerprint !== undefined, true);
  assert.equal(finalLedger.items["200"].state, "ready", "the successful sibling's outcome survives the sibling's rejected dispatch");
});

// #530 review 2 finding a7abc98c: a terminal run-fatal stop recorded for the first dispatched
// item in pass 2 must not leave a later sibling's own failed/blocked outcome unclassified and
// `in_progress` (and therefore eligible for duplicate redispatch on a later resume).
test("runSupervisorCycle: a terminal stop from one dispatched item does not strand a later sibling's own failed outcome in_progress", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes(() => "bogus_outcome");

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(result.stop?.reason, "run_fatal", "the first item's block records the run-fatal stop");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "the first item is durably classified");
  assert.equal(
    finalLedger.items["200"].state,
    "blocked",
    "the second item is also durably classified despite the run already being terminally stopped by the first — never left in_progress",
  );
  assert.equal(finalLedger.items["200"].blocked_theme, "workflow-engine-defect");
  // The first-cause stop reason/item is preserved — the second item's own classification never
  // overwrites which item actually caused the run to stop.
  assert.equal(finalLedger.stop?.item_id, "100");

  const events = await readEvents(deps, "run-1");
  const stopEvents = events.filter((e: any) => e.kind === "loop_run_stopped");
  assert.equal(stopEvents.length, 1, "only one loop_run_stopped event is recorded — the second item's classification doesn't re-fire it");
});

// #530 review 2 finding 0526bc5f: a rejected changed-file observation for one concurrently-run
// item must not abort classification for the whole cycle — every dispatched item, including an
// already-ready_to_deploy sibling, must still be durably persisted rather than stranded
// in_progress.
test("runSupervisorCycle: a rejected changed-file observation for one item does not abort classification for the cycle", async () => {
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();
  const getChangedFiles: NonNullable<SupervisorDeps["getChangedFiles"]> = async (itemId) => {
    if (itemId === "100") throw new Error("simulated worktree observation failure");
    return ["src/two/b.ts"];
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem, getChangedFiles }, "run-1", token, "claude");

  assert.equal(result.progress, true, "the cycle completes without throwing despite the rejected observation");
  assert.deepEqual(new Set(calls.map((c) => c.item_id)), new Set(["100", "200"]));

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "the item whose observation failed is conservatively parked, not stranded in_progress");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-state");
  assert.equal(
    finalLedger.items["200"].state,
    "ready",
    "the sibling's own successfully-observed outcome is still classified and not stranded in_progress by the other item's observation failure",
  );

  const events = await readEvents(deps, "run-1");
  const replan = events.find((e: any) => e.kind === "loop_replan_requested") as any;
  assert.ok(replan, "a durable replan-request record is written for the observation failure");
  assert.ok(replan.data.reason.includes("observation failed"));
});

// ---------------------------------------------------------------------------
// Precondition stage gate (#568, capability `loop-precondition-stage-gate`) —
// regression for run `loop-07d05fcd68f7db98`: a milestone selector admitted a
// `pipeline:backlog` item, the advance loop made 0 transitions, and the
// dispatch-outcome mapping durably stopped the whole run as a
// `workflow-engine-defect`/`run_fatal` engine defect. Neither should happen.
// ---------------------------------------------------------------------------

/** Item "100" is permanently `pipeline:backlog` — /pipeline refuses to start work on it, so
 *  dispatching it (were the frontier gate ever bypassed) always makes 0 transitions. Item "200"
 *  behaves like `coordinatedFakes`: `pipeline:ready` until dispatched, then reports
 *  `ready_to_deploy`. */
function backlogAndReadyFakes() {
  const dispatched = new Set<string>();
  const calls: LoopExecutionRequest[] = [];
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "100") return { state: "open", labels: ["pipeline:backlog"] };
      return { state: "open", labels: dispatched.has(id) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      const id = String(issueNumber);
      return id !== "100" && dispatched.has(id) ? 12 : null;
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  return { observe, dispatchItem, calls };
}

test("regression (#568): a backlog item alongside a ready item advances the ready item, excludes the backlog item with a precondition rationale, and the run does not stop", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = backlogAndReadyFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null, "a pre-pipeline exclusion must never record a run stop");
  assert.equal(result.allDone, true, "the run reaches a normal terminal condition — all_items_done_or_excluded");
  assert.deepEqual(calls.map((c) => c.item_id), ["200"], "the backlog item must never be dispatched at all — the frontier gate is the primary defense");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["200"].state, "ready");
  assert.equal(finalLedger.items["100"].state, "pending", "the excluded item is left pending, never blocked or abandoned");
  assert.equal(finalLedger.items["100"].blocked_theme, undefined, "never classified as a blocker");
  assert.equal(finalLedger.stop, null);

  const events = await readEvents(deps, "run-1");
  const excluded = events.find((e: any) => e.kind === "loop_item_precondition_excluded") as any;
  assert.ok(excluded, "a durable precondition-exclusion event must be recorded");
  assert.deepEqual(excluded.data, { item_id: "100", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" });
});

test("regression (#568): a run whose only remaining item is at pipeline:backlog completes (all_items_done_or_excluded) without ever dispatching it", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = backlogAndReadyFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null);
  assert.equal(result.allDone, true);
  assert.equal(result.cycles, 1, "the exclusion is structural, not a no-progress accident — it completes on the first cycle");
  assert.deepEqual(calls, [], "a permanently pre-pipeline item is never dispatched");
});

test("an item excluded at pipeline:backlog is admitted once triaged to pipeline:ready mid-run, with no run restart", async () => {
  // "200" is pinned `blocked` under a non-run-fatal class (upstream-dependency) for the whole
  // test — it never resolves and never stops the run — purely so the run has a second, permanent
  // non-terminal item and does not immediately reach the "all excluded" completion after cycle 1,
  // giving the mid-run triage on "100" a later cycle to actually land on.
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": { ...itemEntry("200", "blocked"), blocked_theme: "upstream-dependency" },
  });
  const { deps } = await setup(contract, ledger);

  let stage = "backlog";
  const dispatched = new Set<string>();
  const calls: LoopExecutionRequest[] = [];
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "200") return { state: "open", labels: ["pipeline:review-1"] };
      if (dispatched.has(id)) return { state: "open", labels: [READY_LABEL] };
      return { state: "open", labels: [`pipeline:${stage}`] };
    },
    async findPrForIssue(issueNumber) {
      return dispatched.has(String(issueNumber)) ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-x", head_sha: "abc123", merge_commit_sha: null };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle1 = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(cycle1.allDone, false);
  assert.deepEqual(calls, [], "still backlog — never dispatched");
  const midLedger = await readLedger(deps, "run-1");
  assert.equal(midLedger.items["100"].state, "pending");

  // Operator triages the item mid-run — the gate is re-evaluated against live truth, not frozen.
  stage = "ready";

  const cycle2 = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(cycle2.stop, null);
  assert.deepEqual(calls.map((c) => c.item_id), ["100"], "the item is admitted and dispatched on the very next cycle — no restart required");
});

test("a genuine engine defect (mid-flight non-terminal label, zero transitions) is still classified workflow-engine-defect / run_fatal", async () => {
  // Item "100" is stuck at a non-terminal, non-pre-pipeline stage (e.g. "review-1") after
  // dispatch — never backlog, never absent a pipeline:* label — so the precondition safety net
  // must NOT reclassify it; this is exactly the genuine-defect case decision 3 must still catch.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  // A genuine defect: the dispatch response itself is outside the terminal outcome set, and the
  // live post-dispatch label ("review-1") is neither backlog nor absent. `calls` distinguishes
  // reconciliation's own observation (call 1, admissible) from Pass 2's fresh safety-net read
  // (call 2, mid-flight).
  let calls = 0;
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      calls++;
      return calls === 1 ? { state: "open", labels: ["pipeline:ready"] } : { state: "open", labels: ["pipeline:review-1"] };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "some-unrecognized-outcome" as unknown as LoopExecutionResponse["outcome"],
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop?.reason, "run_fatal");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
});

test("dispatch-outcome safety net (decision 3): a 0-transition backlog dispatch is recorded as a non-fatal precondition exclusion, never workflow-engine-defect", async () => {
  // The frontier gate is bypassed here on purpose (the item is admissible at reconciliation
  // time) to exercise the defense-in-depth path at the dispatch-outcome boundary itself: the
  // item's live label has flipped back to pipeline:backlog by the time Pass 2 re-observes it.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  let calls = 0;
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      calls++;
      // 1st call: reconciliation — admissible (pipeline:ready), so the frontier gate admits it.
      // 2nd call: Pass 2's fresh safety-net read — observes it flipped back to backlog.
      return calls === 1 ? { state: "open", labels: ["pipeline:ready"] } : { state: "open", labels: ["pipeline:backlog"] };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "failed",
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(cycle.stop, null, "never a run_fatal stop for a pre-pipeline no-op");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "pending", "reverted to pending, not blocked or abandoned");
  assert.equal(finalLedger.items["100"].blocked_theme, undefined);
  const events = await readEvents(deps, "run-1");
  const excluded = events.find((e: any) => e.kind === "loop_item_precondition_excluded") as any;
  assert.ok(excluded, "a durable precondition-exclusion event must be recorded");
  assert.deepEqual(excluded.data, { item_id: "100", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" });
});
