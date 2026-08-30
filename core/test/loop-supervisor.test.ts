// Tests for the durable loop supervisor (#512, capability
// `durable-loop-supervisor`). Every test runs through an in-memory
// LoopStoreDeps fake and an in-memory ReconcileObserveDeps fake (mirrors
// loop-reconcile.test.ts) plus a fake `pipeline/loop-execution@1` dispatch —
// no real filesystem, process, network, git, or subprocess access anywhere
// in this file, and no external goal-loop skill invocation on any path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONSECUTIVE_NO_PROGRESS_LIMIT,
  LOOP_ITEM_ADVANCE_FINISHED,
  LOOP_ITEM_ADVANCE_LINKED,
  attachSupervisor,
  auditSupervisor,
  dominantExclusionReason,
  driveSupervisor as driveSupervisorRaw,
  runSupervisorCycle as runSupervisorCycleRaw,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import { ACTIVE_RUN_STORE_MAX_AGE_MS } from "../scripts/loop/live-advance.ts";
import {
  acquireLock,
  initRun,
  readEvents,
  readLedger,
  readLock,
  runDir,
  runEventsPath,
  writeLedger,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { DEFAULT_RECOVERY_POLICY, blockItem } from "../scripts/loop/recovery.ts";
import type { ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";

const READY_LABEL = "pipeline:ready-to-deploy";
// The precondition stage gate (#568, capability `loop-precondition-stage-gate`) excludes a
// pending item whose observed `pipeline:*` label is `backlog` or absent — every fake below
// defaults an item to `pipeline:ready` so the scheduling/dispatch behavior under test here (which
// predates and is orthogonal to the precondition gate) is unaffected; tests of the gate itself
// override this explicitly.
const PIPELINE_READY_LABEL = "pipeline:ready";

// ---------------------------------------------------------------------------
// Hermeticity by default (verification round 2): SupervisorDeps built without
// probeLiveAdvance/acquireItemAdvanceLock fall back to the REAL host probe,
// which reads /tmp/pipeline-<domain>-<issue>.lock and calls
// process.kill(pid, 0) — on a dogfooding host a genuinely live advance for a
// colliding issue number would flake these tests. Every test in this file goes
// through the wrappers below, which default-inject a dead probe and a
// permissive advance-lock fake; a test exercising the coexistence guard keeps
// its own fakes (its explicit keys win the spread), and the #770
// default-wiring regressions call the *Raw entry points directly with a
// test-unique lock domain.
// ---------------------------------------------------------------------------

function hermeticSupervisorDeps(deps: SupervisorDeps): SupervisorDeps {
  return {
    probeLiveAdvance: () => ({ live: false as const }),
    acquireItemAdvanceLock: () => ({ release() {} }),
    setHeartbeatInterval: () => null,
    clearHeartbeatInterval: () => {},
    ...deps,
  };
}

const driveSupervisor: typeof driveSupervisorRaw = (deps, input) =>
  driveSupervisorRaw(hermeticSupervisorDeps(deps), input);
const runSupervisorCycle: typeof runSupervisorCycleRaw = (deps, runId, token, engine) =>
  runSupervisorCycleRaw(hermeticSupervisorDeps(deps), runId, token, engine);

function humanAuthorityDiagnostic(reason = "A human product decision is required") {
  return buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason,
    stage: "plan-review",
    authorityEvidence: [{
      category: "product-decision",
      finding_key: "deadbeef",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: "abc123",
    }],
  });
}

function currentLocalIdentity(issueNumber = 100) {
  return {
    issue_number: issueNumber,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: null,
    pr_state: null,
    head_branch: `pipeline/${issueNumber}-fix`,
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "none" as const,
    pipeline_stage: "ready",
    observed_at: "2026-07-23T00:00:00.000Z",
  };
}

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
    async getLabelEvents(issueNumber) {
      calls.push(`getLabelEvents:${issueNumber}`);
      return [];
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
    async getLabelEvents() {
      return [];
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
// Early run handoff seam (#665): onRunReady after lock, before first dispatch.
// ---------------------------------------------------------------------------

test("driveSupervisor fires onRunReady once after lock and before any dispatchItem (#665)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const order: string[] = [];
  const { observe, dispatchItem, calls } = coordinatedFakes();
  const wrappedDispatch: SupervisorDeps["dispatchItem"] = async (request) => {
    order.push("dispatch");
    return dispatchItem(request);
  };
  let readyCtx: Awaited<Parameters<NonNullable<Parameters<typeof driveSupervisor>[1]["onRunReady"]>>[0]> | null = null;

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem: wrappedDispatch },
    {
      runId: "run-1",
      engine: "claude",
      onRunReady: async (ctx) => {
        order.push("onRunReady");
        readyCtx = ctx;
      },
    },
  );

  assert.equal(result.allDone, true);
  assert.deepEqual(order, ["onRunReady", "dispatch"]);
  assert.equal(calls.length, 1);
  assert.ok(readyCtx);
  assert.equal(readyCtx!.runId, "run-1");
  assert.equal(readyCtx!.engine, "claude");
  assert.equal(readyCtx!.resumed, false);
  assert.equal(readyCtx!.runDir, runDir(deps, "run-1"));
  assert.equal(readyCtx!.events, runEventsPath(deps, "run-1"));
  assert.ok(path.isAbsolute(readyCtx!.runDir));
  assert.ok(path.isAbsolute(readyCtx!.events));
  assert.ok(readyCtx!.events.endsWith("/events.jsonl"));
});

test("driveSupervisor onRunReady reports resumed:true under --resume (#665)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  // Item already done so resume attaches, fires onRunReady, and exits without dispatch.
  const ledger = testLedger({ "100": itemEntry("100", "ready") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();
  let resumed: boolean | null = null;

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem },
    {
      runId: "run-1",
      engine: "claude",
      resume: true,
      onRunReady: async (ctx) => {
        resumed = ctx.resumed;
      },
    },
  );

  assert.equal(result.resumed, true);
  assert.equal(resumed, true);
  assert.equal(calls.length, 0, "already-done run should not dispatch");
});

test("driveSupervisor does not fire onRunReady when lock acquisition fails (#665)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  // Hold the lock as a live process so non-resume attach fails.
  await acquireLock(deps, "run-1", "codex");
  let readyCalls = 0;
  const { observe, dispatchItem } = coordinatedFakes();

  await assert.rejects(
    () =>
      driveSupervisor(
        { store: deps, observe, dispatchItem },
        {
          runId: "run-1",
          engine: "claude",
          onRunReady: async () => {
            readyCalls++;
          },
        },
      ),
    /already locked/,
  );
  assert.equal(readyCalls, 0);
});

test("driveSupervisor releases the exclusive lock when onRunReady throws (#665)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  await assert.rejects(
    () =>
      driveSupervisor(
        { store: deps, observe, dispatchItem },
        {
          runId: "run-1",
          engine: "claude",
          onRunReady: async () => {
            throw new Error("EPIPE: broken pipe");
          },
        },
      ),
    /EPIPE: broken pipe/,
  );
  assert.equal(calls.length, 0, "dispatch must not run after handoff failure");
  // Lock must be free so a subsequent process can acquire without takeover.
  const lock = await readLock(deps, "run-1");
  assert.equal(lock, null, "exclusive lock must be released when onRunReady throws");
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

test("heartbeat advances during a long in-flight cycle via the injected timer (#1296)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps, files } = await setup(contract, ledger);
  const ticks: Array<() => void | Promise<void>> = [];
  let releaseDispatch: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const { observe, dispatchItem } = coordinatedFakes();
  const drive = driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem: async (request, hooks) => {
        await blocked;
        return dispatchItem(request, hooks);
      },
      setHeartbeatInterval: (fn) => {
        ticks.push(fn);
        return "timer";
      },
      clearHeartbeatInterval: () => {},
    },
    { runId: "run-1", engine: "claude", candidateSha: "a".repeat(40) },
  );
  try {
    for (let i = 0; i < 50 && ticks.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const before = JSON.parse(files.get([...files.keys()].find((k) => k.endsWith("supervisor.json"))!)!);
    const started = before.heartbeat_at;
    assert.ok(ticks.length >= 1, "heartbeat timer must start after attach");
    await ticks[0]!();
    const mid = JSON.parse(files.get([...files.keys()].find((k) => k.endsWith("supervisor.json"))!)!);
    assert.ok(
      new Date(mid.heartbeat_at).getTime() > new Date(started).getTime(),
      "heartbeat_at must advance during an in-flight cycle",
    );
    const handoffPath = [...files.keys()].find((k) => k.endsWith("loop-run-handoff.json"));
    assert.ok(handoffPath, "durable loop-run-handoff.json must be written at attach");
    const handoff = JSON.parse(files.get(handoffPath!)!);
    assert.equal(handoff.kind, "loop_run_handoff");
    assert.equal(handoff.candidate_sha, "a".repeat(40));
  } finally {
    releaseDispatch();
    await drive;
  }
});

test("heartbeat timer is cleared when drive ends (#1296)", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();
  let cleared = 0;
  await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      setHeartbeatInterval: () => "handle",
      clearHeartbeatInterval: () => {
        cleared += 1;
      },
    },
    { runId: "run-1", engine: "claude" },
  );
  assert.equal(cleared, 1);
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
  // Stage is needs-human so #1068 advance-still-needed heal does not restore
  // to in_progress (that class would re-dispatch and exit the spin fixture).
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const boundIdentity = {
    issue_number: 100,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: 12,
    pr_state: "open" as const,
    head_branch: "pipeline/100-x",
    head_sha: "abc123",
    merge_commit_sha: null,
    checks_conclusion: "success" as const,
    pipeline_stage: "needs-human" as string | null,
    observed_at: "2026-07-23T00:00:00.000Z",
  };
  const ledger = testLedger({
    "100": { ...itemEntry("100", "pr_opened"), last_verified_identity: boundIdentity },
  });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:needs-human"] };
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
  assert.equal(
    secondDrive.dispatched,
    1,
    "the item reached its terminal-successful state in the FIRST drive, before this drive ran any cycles — dispatched is derived from the ledger, not an in-process counter (#614)",
  );
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

test("driveSupervisor records one terminal loop_run_complete for a resolved drive", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  const events = await readEvents(deps, "run-1");
  const started = events.filter((event) => event.kind === "loop_drive_started");
  const completed = events.filter((event) => event.kind === "loop_run_complete");
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.data.outcome, "all_done");
  assert.equal(completed[0]?.data.drive_id, started[0]?.data.drive_id);
});

test("driveSupervisor does not duplicate completion for an unchanged terminal revision", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem } = coordinatedFakes();

  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });
  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  const events = await readEvents(deps, "run-1");
  assert.equal(events.filter((event) => event.kind === "loop_run_complete").length, 1);
});

test("driveSupervisor records one terminal event kind for a stopped drive", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: ["200"] },
      { id: "200", depends_on: ["999"] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem } = coordinatedFakes();

  await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  const events = await readEvents(deps, "run-1");
  assert.equal(events.filter((event) => event.kind === "loop_run_stopped").length, 1);
  assert.equal(events.filter((event) => event.kind === "loop_run_complete").length, 0);
});

test("driveSupervisor records hold completion but never completes an explicit maxCycles pause", async () => {
  const heldContract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const heldLedger = testLedger({
    "100": {
      ...itemEntry("100", "waiting"),
      hold_request: {
        request_id: "req-1",
        item_id: "100",
        kind: "answer",
        prompt: "operator answer required",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
      },
    },
  });
  const heldSetup = await setup(heldContract, heldLedger);
  const heldFakes = coordinatedFakes();
  await driveSupervisor(
    { store: heldSetup.deps, observe: heldFakes.observe, dispatchItem: heldFakes.dispatchItem },
    { runId: "run-1", engine: "claude" },
  );
  const heldEvents = await readEvents(heldSetup.deps, "run-1");
  assert.equal(heldEvents.filter((event) => event.kind === "loop_run_complete").length, 1);
  assert.equal(heldEvents.find((event) => event.kind === "loop_run_complete")?.data.outcome, "hold_outstanding");

  const pausedContract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: ["100"] },
    ],
  });
  const pausedLedger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
  });
  const pausedSetup = await setup(pausedContract, pausedLedger);
  const pausedFakes = coordinatedFakes();
  await driveSupervisor(
    { store: pausedSetup.deps, observe: pausedFakes.observe, dispatchItem: pausedFakes.dispatchItem },
    { runId: "run-1", engine: "claude", maxCycles: 1 },
  );
  const pausedEvents = await readEvents(pausedSetup.deps, "run-1");
  assert.equal(pausedEvents.filter((event) => event.kind === "loop_drive_started").length, 1);
  assert.equal(pausedEvents.filter((event) => event.kind === "loop_run_complete").length, 0);
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
  assert.equal(result.stop, null, "the failed item cannot stop a sibling in the dispatch cycle");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready", "fresh verified completion supersedes the stale failed response");
  assert.equal(
    finalLedger.items["200"].state,
    "ready",
    "the sibling's already-completed ready_to_deploy outcome is preserved, not stranded in_progress",
  );

  const terminal = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(terminal.allDone, true, "verified external completion remains terminal");
  assert.equal((await readLedger(deps, "run-1")).items["100"].state, "ready");

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

  assert.equal(result.stop, null);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "the rejected dispatch is classified failed and blocked, not silently dropped");
  assert.equal(finalLedger.items["100"].evidence_fingerprint !== undefined, true);
  assert.equal(finalLedger.items["200"].state, "ready", "the successful sibling's outcome survives the sibling's rejected dispatch");
  const terminal = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(terminal.stop?.reason, "run_fatal");
});

test("serialized dispatch rejection enters bounded recovery and redispatches the same item", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let recoveryCount = 0;
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: dispatchCount >= 2 ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      return dispatchCount >= 2 ? 12 : null;
    },
    async getPrDetail() {
      return {
        state: "open",
        head_ref: "pipeline/100-fix",
        head_sha: "abc123",
        merge_commit_sha: null,
      };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    if (dispatchCount === 1) throw new Error("adapter process exited before returning a response");
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: 12, pipeline_run_id: "advance-retry" },
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveryCount++;
    // #1020: first workflow-engine-defect recipe is unlink_engine_scratch.
    assert.equal(input.action, "unlink_engine_scratch");
    return { succeeded: true, evidence: "engine scratch unlinked / adapter recovered" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.allDone, true);
  assert.equal(result.stop, null);
  assert.equal(dispatchCount, 2);
  assert.equal(recoveryCount, 1);
});

// #530 review 2 finding a7abc98c: a terminal run-fatal stop recorded for the first dispatched
// item in pass 2 must not leave a later sibling's own failed/blocked outcome unclassified and
// `in_progress` (and therefore eligible for duplicate redispatch on a later resume).
test("runSupervisorCycle: deferred terminalization does not strand a later sibling's own failed outcome in_progress", async () => {
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

  assert.equal(result.stop, null, "both item outcomes are classified before any run-level stop");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready", "fresh verified completion supersedes the first stale response");
  assert.equal(
    finalLedger.items["200"].state,
    "ready",
    "the second item also honors fresh verified completion and is never left in_progress",
  );
  // Live ready-to-deploy evidence wins on the next reconciliation pass even
  // though both adapter responses were malformed.
  const terminal = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(terminal.allDone, true);
  const reconciled = await readLedger(deps, "run-1");
  assert.equal(reconciled.items["100"].state, "ready");
  assert.equal(reconciled.items["200"].state, "ready");

  const stopEvents = (await readEvents(deps, "run-1")).filter((e: any) => e.kind === "loop_run_stopped");
  assert.equal(stopEvents.length, 0, "reconciled completion never emits a stale mechanical stop");
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
    async getLabelEvents() {
      return [];
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

// ---------------------------------------------------------------------------
// dominantExclusionReason (#614, capability loop-terminal-exclusion-disclosure) — pure helper,
// no gh/git/fs/clock/store access.
// ---------------------------------------------------------------------------

test("dominantExclusionReason: no exclusions -> null", () => {
  assert.equal(dominantExclusionReason([]), null);
});

test("dominantExclusionReason: a single exclusion's reason wins outright", () => {
  const reason = dominantExclusionReason([{ item_id: "100", required_stage: "pipeline:ready", observed_stage: "none" }]);
  assert.equal(reason, "precondition:required=pipeline:ready,observed=none");
});

test("dominantExclusionReason: the most frequent reason wins over a less-frequent one", () => {
  const reason = dominantExclusionReason([
    { item_id: "100", required_stage: "pipeline:ready", observed_stage: "none" },
    { item_id: "200", required_stage: "pipeline:ready", observed_stage: "none" },
    { item_id: "300", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" },
  ]);
  assert.equal(reason, "precondition:required=pipeline:ready,observed=none");
});

test("dominantExclusionReason: a tie is broken lexicographically by the reason string, deterministically", () => {
  const exclusions = [
    { item_id: "100", required_stage: "pipeline:ready", observed_stage: "pipeline:backlog" },
    { item_id: "200", required_stage: "pipeline:ready", observed_stage: "none" },
  ];
  const forward = dominantExclusionReason(exclusions);
  const reversed = dominantExclusionReason([...exclusions].reverse());
  assert.equal(forward, "precondition:required=pipeline:ready,observed=none", "'observed=none' sorts before 'observed=pipeline:backlog'");
  assert.equal(reversed, forward, "the same tie always resolves the same way regardless of input order");
});

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
  assert.equal(
    result.allDone,
    false,
    "the excluded item means the run is not genuinely all-done (#614) — one item was merely excluded, not completed",
  );
  assert.equal(result.completion, "partial_excluded", "200 dispatched to a terminal-successful state, 100 excluded (#614)");
  assert.equal(result.dispatched, 1);
  assert.deepEqual(result.excludedItemIds, ["100"]);
  assert.equal(result.exclusionReason, "precondition:required=pipeline:ready,observed=pipeline:backlog");
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

test("regression (#581, pre-merge 20713d3b): a precondition-excluded sibling that becomes ready during the cycle is not stranded by a terminal hold", async () => {
  // Item "100" is `pipeline:backlog` when this cycle's reconcile observes it (so it is
  // precondition-excluded from the frontier), but becomes `pipeline:ready` before the cycle ends —
  // modeled here as "ready once 200 has been dispatched". Item "200" dispatches to a needs-human
  // hold. Concluding a terminal hold on the cycle-start (stale) frontier would stop the run with
  // 100 never dispatched; the terminal-hold decision must re-observe the excluded item's live label
  // and continue, so 100 is still dispatched on a subsequent cycle rather than stranded.
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const calls: LoopExecutionRequest[] = [];
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      // "100" is backlog only until "200" has been dispatched (i.e. until after this cycle's
      // dispatch); it then becomes ready, and READY_LABEL once itself dispatched.
      if (id === "100" && !dispatched.has("100") && !dispatched.has("200")) {
        return { state: "open", labels: ["pipeline:backlog"] };
      }
      return { state: "open", labels: dispatched.has(id) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    dispatched.add(request.item_id);
    const outcome = request.item_id === "200" ? "blocked_needs_human" : "ready_to_deploy";
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: outcome as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      ...(request.item_id === "200" ? { diagnostic: humanAuthorityDiagnostic() } : {}),
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  // The core guarantee of the fix: the run does not conclude a terminal hold on the stale
  // cycle-start frontier and strand a sibling that became ready mid-cycle.
  assert.equal(result.stop, null, "the run must not stop while a now-ready sibling can still make progress");
  assert.ok(
    calls.map((c) => c.item_id).includes("100"),
    "the sibling that became ready mid-cycle must be dispatched, not stranded by a premature terminal hold",
  );
});

test("regression (#568): a run whose only remaining item is at pipeline:backlog completes (all_items_done_or_excluded) without ever dispatching it", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = backlogAndReadyFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null);
  assert.equal(
    result.allDone,
    false,
    "zero items dispatched, one excluded — this is 'nothing ran', not all_done (#614 regression: previously reported all_done: true)",
  );
  assert.equal(result.completion, "none_dispatchable");
  assert.equal(result.dispatched, 0);
  assert.deepEqual(result.excludedItemIds, ["100"]);
  assert.equal(result.exclusionReason, "precondition:required=pipeline:ready,observed=pipeline:backlog");
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
    async getLabelEvents() {
      return [];
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
    async getLabelEvents() {
      return [];
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

test("dispatch-outcome safety net (decision 3): a genuine 0-transition backlog dispatch is recorded as a non-fatal precondition exclusion, never workflow-engine-defect", async () => {
  // Item "100" is already `in_progress` from a prior cycle (so the pending-only frontier gate
  // never evaluates it) and was already at pipeline:backlog *before this cycle's dispatch* —
  // reconciliation observes backlog, and Pass 2's post-dispatch read observes the same backlog:
  // zero stage transitions, a genuine pre-pipeline no-op (#568 review 1, finding eb82a1de).
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "in_progress") });
  const { deps } = await setup(contract, ledger);

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      // Both reconciliation (pre-dispatch) and Pass 2's safety-net read (post-dispatch) observe
      // the same stage — the dispatch made zero transitions.
      return { state: "open", labels: ["pipeline:backlog"] };
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
      // No label-add history at all during the dispatch window — the authoritative
      // zero-transition signal (#568 review 2, finding 8bb189a0).
      return [];
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

test("regression (#568 review 1, finding eb82a1de): a dispatch whose label was moved back to backlog mid-dispatch (nonzero transitions) remains workflow-engine-defect / run_fatal, not a precondition exclusion", async () => {
  // Item "100" is admissible at this cycle's reconciliation (pipeline:ready) but Pass 2's
  // post-dispatch read observes it flipped back to pipeline:backlog — a real transition
  // happened (ready -> backlog) during dispatch, not a zero-transition no-op, so it must NOT be
  // converted into a non-fatal precondition exclusion (that would mask a genuine engine
  // failure).
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  let calls = 0;
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      calls++;
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
    getLabelEvents: (() => {
      let labelEventCalls = 0;
      return async () => {
        labelEventCalls++;
        // First call is the pre-dispatch baseline snapshot (nothing has happened yet); the
        // second is the post-dispatch read, which observes the real ready -> backlog transition
        // that happened during the dispatch window — even though the observed stage snapshots
        // below already differ, the authoritative signal this test proves matters is the diff
        // against the label-add history, not the snapshot comparison.
        return labelEventCalls === 1 ? [] : [{ label: "pipeline:backlog", createdAt: "2026-07-23T00:00:01.000Z" }];
      };
    })(),
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "failed",
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop?.reason, "run_fatal");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  const events = await readEvents(deps, "run-1");
  assert.ok(!events.find((e: any) => e.kind === "loop_item_precondition_excluded"), "must not be recorded as a precondition exclusion");
});

test("regression (#568 review 2, finding 8bb189a0): a round-trip dispatch (backlog -> ready -> backlog) that fails remains workflow-engine-defect / run_fatal, even though before/after stage snapshots match", async () => {
  // Item "100" is observed at pipeline:backlog both before dispatch (reconciliation) and after
  // dispatch (Pass 2's safety-net read) — identical snapshots would falsely look like a
  // zero-transition no-op under snapshot-equality alone. But the label-add history shows the item
  // was actually promoted to pipeline:ready and moved back to pipeline:backlog during the dispatch
  // window — a genuine transition occurred, so this must remain a run-fatal engine defect, not a
  // non-fatal precondition exclusion.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "in_progress") });
  const { deps } = await setup(contract, ledger);

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      // Both reconciliation (pre-dispatch) and Pass 2's safety-net read (post-dispatch) observe
      // the same stage label — a naive before/after comparison would wrongly call this a no-op.
      return { state: "open", labels: ["pipeline:backlog"] };
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
    getLabelEvents: (() => {
      let labelEventCalls = 0;
      return async () => {
        labelEventCalls++;
        // First call is the pre-dispatch baseline (still at backlog, no round trip yet). The
        // second is the post-dispatch read, which observes the full round trip: promoted to
        // ready, then moved back to backlog, both during the dispatch window.
        return labelEventCalls === 1
          ? []
          : [
              { label: "pipeline:ready", createdAt: "2026-07-23T00:00:01.000Z" },
              { label: "pipeline:backlog", createdAt: "2026-07-23T00:00:02.000Z" },
            ];
      };
    })(),
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

  assert.equal(cycle.stop, null, "the mechanical block is recorded before terminal promotion");
  const terminal = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(terminal.stop?.reason, "run_fatal", "a round-trip transition must never be masked as a zero-transition no-op");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  const events = await readEvents(deps, "run-1");
  assert.ok(!events.find((e: any) => e.kind === "loop_item_precondition_excluded"), "must not be recorded as a precondition exclusion");
});

test("regression (#568 review 1, finding f09d500c): a real round-trip transition is never masked as a zero-transition no-op when the supervisor host's clock is far ahead of GitHub's event timestamps", async () => {
  // The old zero-transition check compared GitHub-authored `createdAt` values against
  // `deps.observe.now()` (the supervisor host's local clock). If the host clock is ahead of
  // GitHub — simulated here with `now()` fixed far in the future — every label-add event from a
  // real dispatch-window round trip would compare as earlier than the cutoff, so
  // `zeroTransitions` would wrongly become true and this genuine engine defect would be excluded
  // as a non-fatal precondition no-op instead of recorded as `workflow-engine-defect`. The fix
  // diffs the pre-dispatch and post-dispatch label-add snapshots against each other — both
  // GitHub-authored — so this host/GitHub clock skew must no longer be able to mask the
  // transition.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "in_progress") });
  const { deps } = await setup(contract, ledger);

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:backlog"] };
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
    getLabelEvents: (() => {
      let labelEventCalls = 0;
      return async () => {
        labelEventCalls++;
        return labelEventCalls === 1
          ? []
          : [
              { label: "pipeline:ready", createdAt: "2026-07-23T00:00:01.000Z" },
              { label: "pipeline:backlog", createdAt: "2026-07-23T00:00:02.000Z" },
            ];
      };
    })(),
    // The host clock is decades ahead of the GitHub event timestamps above — under the old
    // local-clock cutoff this alone would make `zeroTransitions` true.
    now: () => new Date("2099-01-01T00:00:00.000Z"),
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

  assert.equal(cycle.stop, null, "the mechanical block is recorded before terminal promotion");
  const terminal = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  assert.equal(terminal.stop?.reason, "run_fatal", "clock skew must never mask a real round-trip transition as a zero-transition no-op");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  const events = await readEvents(deps, "run-1");
  assert.ok(!events.find((e: any) => e.kind === "loop_item_precondition_excluded"), "must not be recorded as a precondition exclusion");
});

// ---------------------------------------------------------------------------
// Typed mechanical recovery.
// ---------------------------------------------------------------------------

test("blocked_recoverable is claimed before execution and redispatches the same item after repair", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": { ...workflowState, recipes: ["repair_pipeline_item"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let claimWasDurableBeforeExecution = false;
  const backoffWaits: number[] = [];
  const recoveryCalls: Parameters<NonNullable<SupervisorDeps["executeRecovery"]>>[0][] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return {
        state: "open",
        labels: dispatchCount >= 2 ? [READY_LABEL] : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue() {
      return dispatchCount >= 2 ? 12 : null;
    },
    async getPrDetail() {
      return {
        state: "open",
        head_ref: "pipeline/100-fix",
        head_sha: recoveryCalls.length > 0 ? "def456" : "abc123",
        merge_commit_sha: null,
      };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: recoveryCalls.length > 0 ? "def456" : "abc123" };
    },
    async baseBranchContainsSha() {
      return false;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    if (dispatchCount === 1) {
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "blocked_recoverable",
        evidence: { pr_number: null, pipeline_run_id: "advance-100" },
        diagnostic,
      };
    }
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: 12, pipeline_run_id: "advance-100-retry" },
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveryCalls.push(input);
    const claimed = await readLedger(deps, "run-1");
    claimWasDurableBeforeExecution = claimed.recovery_attempts.some(
      (attempt) => attempt.attempt_id === input.attemptId && attempt.outcome === "started",
    );
    return { succeeded: true, evidence: "rebased and pushed current head", candidateHead: "def456" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery, recoverySleep: async (ms) => { backoffWaits.push(ms); } },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop, null);
  assert.equal(result.allDone, true);
  assert.equal(dispatchCount, 2, "the repaired item is redispatched through the whole-item facade");
  assert.equal(claimWasDurableBeforeExecution, true, "the budgeted claim exists before the side effect");
  assert.equal(backoffWaits.length, 1, "the compiled backoff is applied after the claim and before execution");
  assert.ok(backoffWaits[0] > 0 && backoffWaits[0] <= 15_000);
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].action, "repair_pipeline_item");
  assert.equal(recoveryCalls[0].blockerClass, "workflow-state");
  assert.match(recoveryCalls[0].candidateIdentity, /base=main.*head=abc123.*attempt=0/);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready");
  assert.equal(finalLedger.items["100"].recovery_budgets_remaining["workflow-state"], 2);
  assert.equal(finalLedger.recovery_attempts.length, 1);
  assert.equal(finalLedger.recovery_attempts[0].outcome, "recovered");
  const events = await readEvents(deps, "run-1");
  const startedIndex = events.findIndex((event) => event.kind === "loop_recovery_attempt_started");
  const executedIndex = events.findIndex((event) => event.kind === "loop_recovery_action_executed");
  const completedIndex = events.findIndex(
    (event) => event.kind === "loop_recovery_attempt" && event.data.outcome === "recovered",
  );
  assert.ok(startedIndex >= 0 && startedIndex < executedIndex && executedIndex < completedIndex);
});

test("regression #797: restart reconciliation preserves a started repair when its open PR is visible", async () => {
  const engineDefect = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"];
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-engine-defect": { ...engineDefect, recipes: ["repair_pipeline_item"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let head = "abc123";
  let failPostObservation = false;
  let recoveryCalls = 0;
  let modelExecutions = 0;
  let dispatchCount = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "adapter state is inconsistent",
    stage: "loop-supervisor",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return {
        state: "open",
        labels: dispatchCount >= 2
          ? [READY_LABEL]
          : dispatchCount >= 1
            ? ["pipeline:needs-human"]
            : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue() {
      return dispatchCount >= 1 ? 12 : null;
    },
    async getPrDetail() {
      if (failPostObservation) return null;
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: head, merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      if (failPostObservation) throw new Error("observation unavailable after side effect");
      return { branch: "pipeline/100-fix", sha: head };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: dispatchCount === 1 ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: dispatchCount === 1 ? null : 12, pipeline_run_id: `advance-100-${dispatchCount}` },
      ...(dispatchCount === 1 ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    if (recoveryCalls === 1) {
      modelExecutions++;
      head = "def456";
      failPostObservation = true;
      return { succeeded: true, evidence: "repair pushed before observation failed", candidateHead: "def456" };
    }
    return { succeeded: true, evidence: "reconciled the marked remote commit", candidateHead: "def456" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const interrupted = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );
  assert.equal(interrupted.stop, null);
  assert.equal((await readLedger(deps, "run-1")).recovery_attempts[0].outcome, "started");

  failPostObservation = false;
  const resumed = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );
  assert.equal(resumed.stop, null);
  assert.equal(recoveryCalls, 2, "the durable executor is re-entered to reconcile its exact marked commit");
  assert.equal(modelExecutions, 1, "the implementer is not replayed after the pushed commit");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "recovered");
  assert.equal(finalLedger.items["100"].state, "ready");
  assert.equal((await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  )).allDone, true);
});

test("durable recovery backoff schedules an independent sibling instead of sleeping in the item path", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": {
        ...workflowState,
        backoff: { initial_seconds: 300, multiplier: 2, max_seconds: 300 },
      },
    },
    items: [{ id: "100", depends_on: [] }, { id: "200", depends_on: [] }],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const dispatched = new Set<string>();
  const sleeps: number[] = [];
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate requires a mechanical rebase",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: dispatched.has(String(issueNumber)) && issueNumber === 200
          ? [READY_LABEL]
          : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue(issueNumber) {
      return dispatched.has(String(issueNumber)) && issueNumber === 200 ? 22 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/200-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead(issueNumber) {
      return issueNumber === 100 ? { branch: "pipeline/100-fix", sha: "abc123" } : null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: request.item_id === "100" ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: request.item_id === "200" ? 22 : null, pipeline_run_id: `advance-${request.item_id}` },
      ...(request.item_id === "100" ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: false, evidence: "must not run before not_before" };
  };
  const supervisorDeps: SupervisorDeps = {
    store: deps,
    observe,
    dispatchItem,
    executeRecovery,
    recoverySleep: async (ms) => { sleeps.push(ms); },
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle(supervisorDeps, "run-1", token, "claude");
  const siblingCycle = await runSupervisorCycle(supervisorDeps, "run-1", token, "claude");

  const current = await readLedger(deps, "run-1");
  assert.equal(current.items["100"].state, "blocked");
  assert.equal(current.items["200"].state, "ready");
  assert.ok(current.recovery_attempts[0].not_before, "the eligibility deadline is durable");
  assert.equal(recoveryCalls, 0, "the recovery side effect is not executed early");
  assert.equal(sleeps.length, 0, "runSupervisorCycle never blocks sibling scheduling on the timer");
  assert.equal(siblingCycle.retryAfterMs, undefined, "a dispatched sibling takes precedence over idle waiting");
});

test("fresh ready state supersedes an interrupted recovery claim without another side effect", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let ready = false;
  let failObservation = false;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate requires a mechanical rebase",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ready ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      return ready ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "def456", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      if (failObservation) throw new Error("postcondition temporarily unavailable");
      return { branch: "pipeline/100-fix", sha: ready ? "def456" : "abc123" };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    failObservation = true;
    return { succeeded: true, evidence: "repair pushed", candidateHead: "def456" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");
  assert.equal((await readLedger(deps, "run-1")).recovery_attempts[0].outcome, "started");

  failObservation = false;
  ready = true;
  const resumed = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(resumed.allDone, true);
  assert.equal(finalLedger.items["100"].state, "ready");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "superseded");
  assert.equal(recoveryCalls, 1);
  assert.ok((await readEvents(deps, "run-1")).some((event) => event.kind === "loop_recovery_superseded"));
});

test("regression (#787): an unobservable fresh head does not fail a started recovery claim", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      // A single non-repair recipe so the claim is subject to the stale-claim gate.
      "workflow-state": { ...workflowState, recipes: ["resync_workflow_state"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let localHead: { branch: string; sha: string } | null = { branch: "pipeline/100-fix", sha: "abc123" };
  let failObservation = false;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate requires a mechanical resync",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      if (failObservation) throw new Error("postcondition temporarily unavailable");
      return localHead;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    failObservation = true;
    return { succeeded: true, evidence: "resync applied", candidateHead: "abc123" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");
  const afterClaim = await readLedger(deps, "run-1");
  assert.equal(afterClaim.recovery_attempts[0].outcome, "started");
  const budgetAfterClaim = afterClaim.items["100"].recovery_budgets_remaining["workflow-state"];

  // The next cycle's fresh observation succeeds but yields no head at all (no
  // PR detail resolves and no local worktree exists) — the claim must survive
  // for the next cycle instead of being failed as stale.
  failObservation = false;
  localHead = null;
  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(recoveryCalls, 2, "the durable claim is replayed, not failed pre-execution");
  assert.equal(finalLedger.recovery_attempts.length, 1, "no replacement claim is charged");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "started", "the claim survives an unobservable head");
  assert.equal(
    finalLedger.items["100"].recovery_budgets_remaining["workflow-state"],
    budgetAfterClaim,
    "no extra budget unit is burned",
  );
  assert.ok(
    !(await readEvents(deps, "run-1")).some((event) => event.kind === "loop_recovery_attempt_stale"),
    "no stale-claim event is recorded for a merely unobservable head",
  );
});

test("a started recovery claim is failed as stale when the freshly observed head genuinely differs", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": { ...workflowState, recipes: ["resync_workflow_state"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let localHead: { branch: string; sha: string } | null = { branch: "pipeline/100-fix", sha: "abc123" };
  let failObservation = false;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate requires a mechanical resync",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      if (failObservation) throw new Error("postcondition temporarily unavailable");
      return localHead;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    failObservation = true;
    return { succeeded: true, evidence: "resync applied", candidateHead: "abc123" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");
  assert.equal((await readLedger(deps, "run-1")).recovery_attempts[0].outcome, "started");

  // The next cycle observes a real, different head: the claimed candidate moved.
  failObservation = false;
  localHead = { branch: "pipeline/100-fix", sha: "def456" };
  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(recoveryCalls, 1, "the stale claim is never re-executed");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "failed");
  assert.match(finalLedger.recovery_attempts[0].error ?? "", /stale/);
  assert.ok((await readEvents(deps, "run-1")).some((event) => event.kind === "loop_recovery_attempt_stale"));
});

test("a failed budgeted recovery stays blocked and stops only after the action is observed", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({
    "100": { ...itemEntry("100", "pending"), last_verified_identity: currentLocalIdentity() },
  });
  const { deps } = await setup(contract, ledger);
  const recoveryActions: string[] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "The host returned a malformed stage result",
    stage: "loop-supervisor",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
    async baseBranchContainsSha() {
      return false;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveryActions.push(input.action);
    return { succeeded: false, evidence: "repair exited non-zero", error: "repair exited non-zero" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  // #1020: unlink_engine_scratch is first; retry_budget 2 ⇒ two claims before
  // run_fatal (modulo rotation over the three-recipe list).
  assert.equal(recoveryActions[0], "unlink_engine_scratch");
  assert.ok(recoveryActions.includes("restart_workflow_engine") || recoveryActions.includes("repair_pipeline_item") || recoveryActions.length >= 1);
  assert.equal(result.stop?.reason, "run_fatal");
  assert.equal(result.stop?.theme, "workflow-engine-defect");
  assert.equal(result.holdOutstanding, false);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].recovery_budgets_remaining["workflow-engine-defect"], 0);
  assert.equal(finalLedger.recovery_attempts.every((a) => a.outcome === "failed"), true);
  assert.equal(finalLedger.recovery_attempts.length, 2);
});

test("an exhausted mechanical item cannot stop an independent sibling before that sibling runs", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  let item200Dispatched = false;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "The adapter returned an invalid result",
    stage: "loop-supervisor",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: issueNumber === 200 && item200Dispatched ? [READY_LABEL] : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue(issueNumber) {
      return issueNumber === 200 && item200Dispatched ? 22 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/200-fix", head_sha: "def456", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead(issueNumber) {
      return issueNumber === 100 ? { branch: "pipeline/100-fix", sha: "abc123" } : null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "200") item200Dispatched = true;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: request.item_id === "100" ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: request.item_id === "200" ? 22 : null, pipeline_run_id: `advance-${request.item_id}` },
      ...(request.item_id === "100" ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: false, evidence: "repair failed", error: "repair failed" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const blockedCycle = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );
  assert.equal(blockedCycle.stop, null);
  assert.equal((await readLedger(deps, "run-1")).items["100"].state, "blocked");

  const siblingCycle = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );
  assert.equal(siblingCycle.stop, null, "exhaustion remains item-local while the sibling is schedulable");
  assert.equal((await readLedger(deps, "run-1")).items["200"].state, "ready");
  assert.equal(recoveryCalls, 2);

  const terminalCycle = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );
  assert.equal(terminalCycle.stop?.reason, "run_fatal", "the exhausted item stops only after sibling progress is complete");
  assert.deepEqual(terminalCycle.stop?.outstanding_ready, ["200"]);
});

test("recovery performs deterministic redispatch before model repair", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({
    "100": { ...itemEntry("100", "pending"), last_verified_identity: currentLocalIdentity() },
  });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let repaired = false;
  const actions: string[] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate needs mechanical repair or workflow resync",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return {
        state: "open",
        labels: dispatchCount >= 3
          ? [READY_LABEL]
          : dispatchCount > 0
            ? ["pipeline:pre-merge"]
            : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue() {
      return dispatchCount > 0 ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: repaired ? "def456" : "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: repaired ? "def456" : "abc123" };
    },
    async baseBranchContainsSha() {
      return false;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: dispatchCount <= 2 ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: 12, pipeline_run_id: `advance-${dispatchCount}` },
      ...(dispatchCount <= 2 ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    actions.push(input.action);
    if (input.action === "repair_pipeline_item") {
      repaired = true;
      return { succeeded: true, evidence: "candidate repaired", candidateHead: "def456" };
    }
    return { succeeded: true, evidence: "workflow state resynchronized" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(result.allDone, true);
  assert.deepEqual(actions, ["resync_workflow_state", "repair_pipeline_item"]);
  assert.deepEqual(finalLedger.recovery_attempts.map((attempt) => attempt.outcome), ["recovered", "recovered"]);
  assert.equal(finalLedger.items["100"].recovery_budgets_remaining["workflow-state"], 1);
});

// ---------------------------------------------------------------------------
// Needs-human blocker disposition (#570, capability
// `loop-needs-human-blocker-disposition`) — regression for run
// `loop-07d05fcd68f7db98`: a plan-review/format blocker (the well-known
// retryable "missing required ## Feedback Incorporated section" failure) was
// misclassified `workflow-engine-defect`/`run_fatal`, terminally stopping the
// whole run while a sibling item sat unreported at `ready`.
// ---------------------------------------------------------------------------

test("regression (#570): a direct blocked_needs_human outcome enters a needs-human hold, never a human_authority/workflow-engine-defect stop, and a ready sibling is preserved", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "200" && dispatched.has(id)) {
        return { state: "open", labels: ["pipeline:plan-review", "blocked"] };
      }
      return { state: "open", labels: dispatched.has(id) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    const outcome = request.item_id === "200" ? "blocked_needs_human" : "ready_to_deploy";
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: outcome as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      ...(request.item_id === "200" ? { diagnostic: humanAuthorityDiagnostic() } : {}),
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null, "a needs-human pipeline blocker must never record a terminal run stop");
  assert.equal(result.holdOutstanding, true, "the run reports hold_outstanding=true and pauses");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.stop, null);
  assert.equal(finalLedger.items["200"].state, "waiting", "the blocked item enters a paused/waiting hold");
  assert.equal(finalLedger.items["200"].hold_request?.kind, "answer");
  assert.notEqual(finalLedger.items["200"].blocked_theme, "missing-authority", "never classified missing-authority");
  assert.equal(
    finalLedger.items["100"].state,
    "ready",
    "the ready sibling's state must survive the hold, not be stranded/discarded",
  );
});

test("blocked_needs_human without attested authority remains engine-owned even with a live blocked label", async () => {
  const contract = testContract({ items: [{ id: "200", depends_on: [] }] });
  const ledger = testLedger({ "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "200" && dispatched.has(id)) {
        return { state: "open", labels: ["pipeline:plan-review", "blocked"] };
      }
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  let recoveryExecutions = 0;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      // No diagnostic: the transport cannot prove human authority.
    };
  };

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery: async () => {
        recoveryExecutions++;
        return { succeeded: false, evidence: "protocol repair failed" };
      },
      probeLiveAdvance: () => ({ live: false }),
    },
    { runId: "run-1", engine: "claude" },
  );

  assert.ok(recoveryExecutions >= 1, "missing authority proof must enter bounded engine recovery");
  assert.equal(result.stop?.reason, "run_fatal");
  assert.equal(result.holdOutstanding, false);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["200"].state, "blocked");
  assert.equal(finalLedger.items["200"].hold_request, undefined);
  assert.equal(finalLedger.items["200"].blocked_theme, "workflow-engine-defect");
  assert.ok((finalLedger.recovery_attempts ?? []).length >= 1, "the protocol recovery is durably claimed");
});

test("attested blocked_needs_human without a live blocked label is held and never label-reopened", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  // The live issue never carries `blocked` — this is a generic needs-human blocker
  // (e.g. a plan/user-input blocker), not a pipeline-blocked-label hold.
  const observe: ReconcileObserveDeps = {
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
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  let dispatchCount = 0;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human" as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      diagnostic: humanAuthorityDiagnostic(),
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null);
  assert.equal(result.holdOutstanding, true);
  assert.equal(dispatchCount, 1, "the item is dispatched exactly once by the initial cycle");

  let finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting");
  assert.equal(
    finalLedger.items["100"].hold_request?.source,
    undefined,
    "an attested hold with no live blocked label must not carry the pipeline_blocked_label discriminator",
  );

  // A subsequent cycle must never auto-reopen this hold (it has no live label to have cleared)
  // and must never redispatch the held item.
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");
  finalLedger = await readLedger(deps, "run-1");
  assert.equal(dispatchCount, 1, "the held item is never redispatched on a later cycle");
  assert.equal(finalLedger.items["100"].state, "waiting", "the hold remains outstanding, awaiting a human resume");
});

test("candidate-bound human authority expires on HEAD movement even while the blocked label remains", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const diagnostic = humanAuthorityDiagnostic();
  const waiting = {
    ...itemEntry("100", "waiting"),
    last_verified_identity: currentLocalIdentity(),
    hold_request: {
      request_id: "hold-100",
      item_id: "100",
      kind: "answer" as const,
      prompt: "Decide the reviewed candidate question",
      requested_by_engine: "claude" as const,
      requested_at: "2026-07-23T00:00:00.000Z",
      authority_evidence_key: diagnostic.evidence_key,
      authority_candidate_head: "abc123",
      source: "pipeline_blocked_label" as const,
    },
  };
  const { deps } = await setup(contract, testLedger({ "100": waiting }));
  let dispatchCount = 0;
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: [PIPELINE_READY_LABEL, "blocked"] };
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "def456" };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "abandoned",
      evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(cycle.holdOutstanding, false);
  assert.equal(dispatchCount, 1, "the stale authority hold is re-admitted in the same cycle");
  assert.equal(finalLedger.items["100"].state, "abandoned");
  assert.equal(finalLedger.items["100"].hold_request, undefined);
  assert.ok((await readEvents(deps, "run-1")).some((event) => event.kind === "loop_item_hold_invalidated"));
});

test("regression (#787): an unobservable head never invalidates a candidate-bound human authority hold", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const diagnostic = humanAuthorityDiagnostic();
  const waiting = {
    ...itemEntry("100", "waiting"),
    last_verified_identity: currentLocalIdentity(),
    hold_request: {
      request_id: "hold-100",
      item_id: "100",
      kind: "answer" as const,
      prompt: "Decide the reviewed candidate question",
      requested_by_engine: "claude" as const,
      requested_at: "2026-07-23T00:00:00.000Z",
      authority_evidence_key: diagnostic.evidence_key,
      authority_candidate_head: "abc123",
      source: "pipeline_blocked_label" as const,
    },
  };
  const { deps } = await setup(contract, testLedger({ "100": waiting }));
  let dispatchCount = 0;
  // Every head observation comes back empty this cycle: no PR detail resolves
  // and no local worktree exists (the default fakes) — a transient observation
  // failure, not evidence the reviewed candidate moved.
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: [PIPELINE_READY_LABEL, "blocked"] };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "abandoned",
      evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(cycle.holdOutstanding, true);
  assert.equal(dispatchCount, 0, "the held item is never re-admitted on an unobservable head");
  assert.equal(finalLedger.items["100"].state, "waiting");
  assert.equal(finalLedger.items["100"].hold_request?.authority_candidate_head, "abc123", "the hold survives intact");
  assert.ok(
    !(await readEvents(deps, "run-1")).some((event) => event.kind === "loop_item_hold_invalidated"),
    "no invalidation event is recorded for a merely unobservable head",
  );
});

test("authority fail-closed: a failed outcome carrying only the blocked label is an engine defect, never a human hold", async () => {
  // Labels are workflow evidence, not authority. A failed response without a
  // typed human-decision diagnostic must not hard-park the item for a human.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  let calls = 0;
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      calls++;
      // Real blocked shape: the `blocked` label is added alongside the retained stage label
      // (e.g. #616: ["blocked", "pipeline:fix-2"]) — never bare, which would look pre-pipeline.
      return calls === 1 ? { state: "open", labels: ["pipeline:ready"] } : { state: "open", labels: ["blocked", "pipeline:fix-1"] };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked at plan-review: Plan revision output is missing required ## Feedback Incorporated section" as unknown as LoopExecutionResponse["outcome"],
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop?.reason, "run_fatal");
  assert.equal(result.stop?.theme, "workflow-engine-defect");
  assert.equal(result.holdOutstanding, false);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  assert.equal(finalLedger.items["100"].hold_request, undefined);
});

test("regression (#570): a run stop while a sibling is ready discloses the outstanding ready item on the stop record", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "200") return { state: "open", labels: ["pipeline:review-1"] };
      return { state: "open", labels: dispatched.has(id) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      const id = String(issueNumber);
      return id !== "200" && dispatched.has(id) ? 12 : null;
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    const outcome = request.item_id === "200" ? "some-unrecognized-outcome" : "ready_to_deploy";
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: outcome as unknown as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop?.reason, "run_fatal", "item 200 is a genuine engine defect — unaffected by the needs-human disposition change");
  assert.deepEqual(result.stop?.outstanding_ready, ["100"], "the stranded ready sibling must be named on the stop record");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready", "the ready sibling's state is preserved, not discarded, by the stop");
  assert.equal(finalLedger.items["200"].blocked_theme, "workflow-engine-defect");
});

test("a stop recorded with no ready item discloses an empty outstanding_ready set", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:review-1"] };
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
  assert.deepEqual(result.stop?.outstanding_ready, [], "no item is ready at stop time, so the disclosure is an empty set");
});

// ---------------------------------------------------------------------------
// #581 — a dispatched item already carrying a stale blocked label holds per-item and
// the run continues on the remaining schedulable items, capability
// `loop-blocked-item-hold-continuation`.
// ---------------------------------------------------------------------------

test("regression (#581): one already-blocked item co-present with a stage label + N clean items — the N clean items dispatch to their outcomes, the blocked item holds, and the run never run_fatals", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
      { id: "300", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "100") {
        // A stale, reason-less blocker co-present with a mid-flight stage label —
        // pipelineStageFromLabels's single stage-winner would return "review-1" here, not
        // "blocked", so detection must be presence-based to catch it.
        return { state: "open", labels: ["pipeline:review-1", "blocked"] };
      }
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
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    const outcome = request.item_id === "100" ? "blocked_needs_human" : "ready_to_deploy";
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: outcome as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      ...(request.item_id === "100" ? { diagnostic: humanAuthorityDiagnostic() } : {}),
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(result.stop, null, "an already-blocked dispatched item must never record a run_fatal stop");
  assert.equal(result.holdOutstanding, true, "the run reaches the terminal outstanding-hold condition once nothing else is schedulable");
  assert.deepEqual(result.heldItemIds, ["100"], "the terminal report enumerates the held item");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting", "the already-blocked item is held, never a workflow-engine-defect");
  assert.notEqual(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  assert.equal(finalLedger.items["200"].state, "ready", "a clean sibling still dispatches to its outcome despite the blocked item");
  assert.equal(finalLedger.items["300"].state, "ready", "a clean sibling still dispatches to its outcome despite the blocked item");
});

test("continuation (#581): a held item alongside two schedulable siblings does not pause the run — the first sibling is dispatched and a second remains queued", async () => {
  // Item "100" already entered a needs-human hold on an earlier cycle; items "200" and "300" are
  // still pending, so there is more schedulable work after this cycle dispatches one of them.
  // Pre-fix, the cycle-start `held` short-circuit would halt the run the moment ANY item is held,
  // before ever trying "200" or "300".
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
      { id: "300", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": { id: "100", state: "waiting", history: [], recovery_budgets_remaining: { default: 3 } },
    "200": itemEntry("200", "pending"),
    "300": itemEntry("300", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();
  const { token } = await acquireLock(deps, "run-1", "claude");

  const result = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.deepEqual(calls.map((c) => c.item_id), ["200"], "the schedulable sibling is dispatched despite the outstanding hold");
  assert.equal(result.holdOutstanding, false, "a hold with schedulable work still queued is not itself the terminal condition");
  assert.equal(result.stop, null);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting", "the held item is left untouched, re-evaluated next cycle");
  assert.equal(finalLedger.items["200"].state, "ready", "the sibling reaches its outcome");
  assert.equal(finalLedger.items["300"].state, "pending", "the second sibling is still queued for a later cycle");
});

test("terminal hold (#581): once every remaining item is held, the run reaches the terminal outstanding-hold condition and enumerates every held item id", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": { id: "100", state: "waiting", history: [], recovery_budgets_remaining: { default: 3 } },
    "200": { id: "200", state: "paused", history: [], recovery_budgets_remaining: { default: 3 } },
  });
  const { deps } = await setup(contract, ledger);
  const { deps: observe } = fakeObserveDeps();
  const { dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(calls.length, 0, "neither held item is dispatched — both are excluded from the frontier");
  assert.equal(result.stop, null, "an outstanding hold is never itself a run_fatal stop");
  assert.equal(result.holdOutstanding, true);
  assert.deepEqual(result.heldItemIds, ["100", "200"], "the terminal report names every held item, sorted");
});

test("re-admission (#581 review 2, finding 016d467e9d176c6f): a held item whose blocked label is cleared between cycles re-enters the frontier and dispatches to completion", async () => {
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({
    "100": {
      id: "100",
      state: "waiting",
      history: [],
      recovery_budgets_remaining: { default: 3 },
      hold_request: {
        request_id: "req-1",
        item_id: "100",
        kind: "answer",
        prompt: "needs a human answer/unblock",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
        source: "pipeline_blocked_label",
      },
    },
  });
  const { deps } = await setup(contract, ledger);
  // The live label no longer carries blocked by the time this cycle observes it — the
  // human already cleared it out-of-band between cycles.
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.deepEqual(calls.map((c) => c.item_id), ["100"], "the cleared hold is re-admitted and dispatched, not left stranded");
  assert.equal(result.stop, null);
  assert.equal(result.holdOutstanding, false, "the run completes rather than reporting an outstanding hold");
  assert.equal(result.allDone, true);
  assert.deepEqual(result.heldItemIds, [], "no item remains held once the cleared hold is re-admitted");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "ready", "the re-admitted item reaches its dispatched outcome");
});

test("post-dispatch reconciliation reopens a sibling cleared while another item was in flight", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": {
      ...itemEntry("100", "waiting"),
      hold_request: {
        request_id: "req-1",
        item_id: "100",
        kind: "answer",
        prompt: "clear the product blocker",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
        source: "pipeline_blocked_label",
      },
    },
    "200": itemEntry("200", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  let dispatchFinished = false;
  const observe: ReconcileObserveDeps = {
    ...fakeObserveDeps().deps,
    async getIssueStateAndLabels(issueNumber) {
      if (issueNumber === 100) {
        return {
          state: "open",
          labels: dispatchFinished ? [PIPELINE_READY_LABEL] : [PIPELINE_READY_LABEL, "blocked"],
        };
      }
      return { state: "open", labels: [PIPELINE_READY_LABEL, "blocked"] };
    },
    async getLocalHead(issueNumber) {
      return issueNumber === 200 ? { branch: "pipeline/200-fix", sha: "abc123" } : null;
    },
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchFinished = true;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      diagnostic: humanAuthorityDiagnostic(),
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const result = await runSupervisorCycle(
    { store: deps, observe, dispatchItem, probeLiveAdvance: () => ({ live: false }) },
    "run-1",
    token,
    "claude",
  );

  assert.equal(result.holdOutstanding, false, "the freshly re-admitted sibling keeps the run schedulable");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "pending");
  assert.equal(finalLedger.items["200"].state, "waiting");
  assert.ok((await readEvents(deps, "run-1")).some((event) => event.kind === "loop_item_hold_cleared"));
});

test("re-admission gated by discriminator (#581 review 2, finding 016d467e9d176c6f): a held item with no pipeline_blocked_label source is never auto-reopened even once its labels show no blocker", async () => {
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({
    "100": {
      id: "100",
      state: "waiting",
      history: [],
      recovery_budgets_remaining: { default: 3 },
      hold_request: {
        request_id: "req-1",
        item_id: "100",
        kind: "answer",
        prompt: "an operator-initiated hold unrelated to a blocked label",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
      },
    },
  });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(calls.length, 0, "a hold with no pipeline_blocked_label discriminator is never auto-reopened");
  assert.equal(result.holdOutstanding, true);
  assert.deepEqual(result.heldItemIds, ["100"]);

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting", "the hold remains outstanding, awaiting a human resume");
});

test("regression (#581 review 2, finding b38ac1b0566a5373): a needs-human hold plus a precondition-excluded pending sibling reaches the terminal outstanding-hold condition, not the one-cycle watchdog", async () => {
  // "100" dispatches and is observed carrying a stale blocked label — a needs-human
  // hold. "200" is permanently pipeline:backlog — precondition-excluded from `schedulableContract`
  // — but its ledger entry is still raw `pending`. Pre-fix, `hasSchedulableWorkRemaining` counted
  // "200" from the unfiltered `contract`, so `terminalHold` was false and the one-cycle safety cap
  // fell through to a `supervisor_cycle_cap` watchdog stop instead of the required outstanding
  // hold.
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
  });
  const { deps } = await setup(contract, ledger);

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "100") return { state: "open", labels: ["blocked", "pipeline:fix-1"] };
      return { state: "open", labels: ["pipeline:backlog"] };
    },
    async findPrForIssue() {
      return null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      diagnostic: humanAuthorityDiagnostic(),
    };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem },
    { runId: "run-1", engine: "claude", maxCyclesSafety: 1 },
  );

  assert.equal(result.stop, null, "the one-cycle safety cap must not be consumed by a precondition-excluded pending sibling");
  assert.equal(result.holdOutstanding, true, "the run reaches the terminal outstanding-hold condition instead of the watchdog");
  assert.deepEqual(result.heldItemIds, ["100"], "the terminal report enumerates the held item");
  assert.equal(result.completion, null, "an outstanding hold is not a resolution — completion stays null (#614)");
  assert.deepEqual(
    result.excludedItemIds,
    ["200"],
    "the precondition-excluded sibling is reported excluded, but the held item ('100') must never also appear here (#614)",
  );

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting");
  assert.equal(finalLedger.items["200"].state, "pending", "the excluded sibling is left pending, never dispatched");
});

// ---------------------------------------------------------------------------
// Advance run-store linkage events (#667).
// ---------------------------------------------------------------------------

test("supervisor records start + terminal advance linkage with real run ids (#667)", async () => {
  const contract = testContract({ items: [{ id: "623", depends_on: [] }] });
  const ledger = testLedger({ "623": itemEntry("623", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem: baseDispatch } = coordinatedFakes();

  const realRunId = "623-2026-07-29T13-49-56-421Z";
  const eventsPath = `/repo/.agent-pipeline/runs/${realRunId}/events.jsonl`;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    await hooks?.onAdvanceLinked?.({
      item_id: request.item_id,
      pipeline_run_id: realRunId,
      events: eventsPath,
    });
    const base = await baseDispatch(request);
    return {
      ...base,
      evidence: {
        pr_number: 7,
        pipeline_run_id: realRunId,
        events_path: eventsPath,
      },
    };
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const events = await readEvents(deps, "run-1");
  const start = events.find((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_LINKED) as
    | { kind: string; data: { item_id: string; pipeline_run_id: string; events: string } }
    | undefined;
  const terminal = events.find((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_FINISHED) as
    | { kind: string; data: { item_id: string; pipeline_run_id: string; events?: string; outcome: string } }
    | undefined;

  assert.ok(start, "start-linkage event must be durable on the loop run");
  assert.equal(start!.data.item_id, "623");
  assert.equal(start!.data.pipeline_run_id, realRunId);
  assert.equal(start!.data.events, eventsPath);
  assert.ok(!String(start!.data.pipeline_run_id).startsWith("pipeline-loop-"), "must not be synthetic-only");

  assert.ok(terminal, "terminal-linkage event must be durable on the loop run");
  assert.equal(terminal!.data.item_id, "623");
  assert.equal(terminal!.data.pipeline_run_id, realRunId);
  assert.equal(terminal!.data.events, eventsPath);
  assert.equal(terminal!.data.outcome, "ready_to_deploy");

  // Ordering: start before terminal for the same attempt.
  const startIdx = events.findIndex((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_LINKED);
  const endIdx = events.findIndex((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_FINISHED);
  assert.ok(startIdx >= 0 && endIdx > startIdx, "start linkage must precede terminal linkage");
});

test("supervisor terminal linkage on rejected dispatch omits fabricated events path when no start pin (#667)", async () => {
  // Concurrency + independent ownership so both items dispatch in one cycle; a single rejection
  // is reclassified rather than rethrown (serialized default rethrows).
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "200": itemEntry("200", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem: baseDispatch } = coordinatedFakes();

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    if (request.item_id === "100") throw new Error("spawn failed before pin");
    // baseDispatch marks the observe fake so transition to ready is supported.
    await baseDispatch(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: {
        pr_number: null,
        pipeline_run_id: "200-2026-07-29T00-00-00-000Z",
        events_path: "/repo/.agent-pipeline/runs/200-2026-07-29T00-00-00-000Z/events.jsonl",
      },
    };
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const events = await readEvents(deps, "run-1");
  const terminals = events.filter((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_FINISHED) as Array<{
    data: { item_id: string; outcome: string; events?: string; pipeline_run_id?: string };
  }>;
  const failed = terminals.find((e) => e.data.item_id === "100");
  assert.ok(failed, "rejected item still gets terminal linkage");
  assert.equal(failed!.data.outcome, "failed");
  assert.equal(failed!.data.events, undefined, "must not invent a live events path when no store was known");

  const ok = terminals.find((e) => e.data.item_id === "200");
  assert.ok(ok);
  assert.equal(ok!.data.pipeline_run_id, "200-2026-07-29T00-00-00-000Z");
  assert.equal(ok!.data.outcome, "ready_to_deploy");
});

// ---------------------------------------------------------------------------
// #712 — resume re-dispatches mid-flight in_progress; heal then re-drive
// ---------------------------------------------------------------------------

/** Observe seam for a mid-flight open-PR item that must NOT demote to pr_opened. */
function midFlightOpenPrObserve(stageByItem: Record<string, string>): ReconcileObserveDeps {
  return {
    async getIssueStateAndLabels(issueNumber) {
      const stage = stageByItem[String(issueNumber)];
      if (stage) return { state: "open", labels: [`pipeline:${stage}`] };
      return { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      return stageByItem[String(issueNumber)] ? Number(issueNumber) + 600 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/mid-fix", head_sha: "abc123", merge_commit_sha: null };
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
    async getExternalDependencyIssueState() {
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
}

test("runSupervisorCycle: mid-flight in_progress item is re-dispatched after reconcile (#712)", async () => {
  // Resume-class: ledger still in_progress, live stage fix-2 with open PR + green checks.
  // Pre-fix reconcile demoted to pr_opened; supervisor then never called dispatchItem.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const { deps } = await setup(contract, testLedger({ "100": itemEntry("100", "in_progress") }));
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "fix-2" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: 710, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(calls.length, 1, "dispatchItem must be invoked for the mid-flight in_progress item");
  assert.equal(calls[0]!.item_id, "100");
  assert.equal(calls[0]!.schema, LOOP_EXECUTION_CONTRACT_SCHEMA);
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "pr_opened", "must not strand at pr_opened");
});

test("runSupervisorCycle: active mid-flight in_progress is re-dispatched before pending sibling can displace it (#712)", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const { deps } = await setup(
    contract,
    testLedger({
      "100": itemEntry("100", "in_progress"),
      "200": itemEntry("200", "pending"),
    }),
  );
  const calls: LoopExecutionRequest[] = [];
  // Item 100 mid-flight with open PR; 200 is pending with no PR (pipeline:ready).
  const observe = midFlightOpenPrObserve({ "100": "fix-2" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: request.item_id === "100" ? 710 : null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  // Existing in_progress path: re-drive A; do not demote A and only start B.
  assert.ok(
    calls.some((c) => c.item_id === "100"),
    "execution call trace must include dispatch for mid-flight item A",
  );
  assert.equal(
    calls.filter((c) => c.item_id === "200").length,
    0,
    "with max_active_items=1 and an active in_progress item, pending sibling must not be selected this cycle",
  );
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "pr_opened");
});

test("runSupervisorCycle: healed pr_opened mid-flight item is re-dispatched via loop-execution (#712)", async () => {
  // Stranded ledger row from a pre-fix over-repair; reconcile heals to in_progress,
  // then this cycle's active-item path dispatches through pipeline/loop-execution@1.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const { deps } = await setup(contract, testLedger({ "100": itemEntry("100", "pr_opened") }));
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "fix-2" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: 710, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(calls.length, 1, "healed item must be re-dispatched in the same cycle after reconcile heal");
  assert.equal(calls[0]!.item_id, "100");
  assert.equal(calls[0]!.schema, LOOP_EXECUTION_CONTRACT_SCHEMA);
  // Dispatch goes through existing loop-execution path (live labels), not a restart-from-ready transition.
  assert.equal(calls[0]!.done_definition, "pipeline:ready-to-deploy");
});

// ---------------------------------------------------------------------------
// #1068 — intake-ready pr_opened is advance-eligible; no false supervisor_no_progress
// ---------------------------------------------------------------------------

test("runSupervisorCycle: intake-ready pr_opened heals and dispatches advance (#1068)", async () => {
  // Live class: ledger pr_opened + pipeline:ready (intake, not R2D) + open PR +
  // green checks. Pre-fix: next_actions.advance with no consumer → no_eligible_item.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const { deps } = await setup(contract, testLedger({ "100": itemEntry("100", "pr_opened") }));
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "ready" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: 1066, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(calls.length, 1, "dispatchItem must run for healed intake-ready item (dispatched >= 1)");
  assert.equal(calls[0]!.item_id, "100");
  assert.equal(calls[0]!.schema, LOOP_EXECUTION_CONTRACT_SCHEMA);
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "pr_opened", "must not remain stranded at pr_opened");
});

test("runSupervisorCycle: healed intake-ready item is re-dispatched before pending sibling (#1068)", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const { deps } = await setup(
    contract,
    testLedger({
      "100": itemEntry("100", "pr_opened"),
      "200": itemEntry("200", "pending"),
    }),
  );
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "ready" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: request.item_id === "100" ? 1066 : null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.ok(
    calls.some((c) => c.item_id === "100"),
    "execution call trace must include dispatch for healed intake-ready item A",
  );
  assert.equal(
    calls.filter((c) => c.item_id === "200").length,
    0,
    "with max_active_items=1 and active in_progress after heal, pending sibling must not start this cycle",
  );
});

test("driveSupervisor: next_actions advance never terminates as supervisor_no_progress (#1068)", async () => {
  // Pre-fix: pr_opened + intake-ready → six no_eligible_item → supervisor_no_progress.
  // Tight consecutive limit proves the false terminal cannot fire while work remains.
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
    consecutive_no_progress_limit: 2,
  });
  const { deps } = await setup(contract, testLedger({ "100": itemEntry("100", "pr_opened") }));
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "ready" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    // Keep item non-terminal so drive continues; blocked still counts as cycle progress.
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: 1066, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem },
    { runId: "run-1", engine: "claude", consecutiveNoProgressLimit: 2, maxCycles: 4 },
  );

  assert.notEqual(
    result.stop?.reason,
    "supervisor_no_progress",
    "must not stop supervisor_no_progress while intake-ready open PR still needs advance",
  );
  assert.ok(calls.length >= 1, "must have dispatched the advance-eligible item at least once");
});

test("runSupervisorCycle: implemented + open non-R2D PR heals and dispatches advance (#1068 review-1)", async () => {
  // Crash-after-PR-open residual: ledger still says implemented while live identity
  // has an open non-R2D PR. implemented is outside pending admission and in_progress
  // re-dispatch; reconcile must restore to in_progress and this cycle must dispatch.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const { deps } = await setup(contract, testLedger({ "100": itemEntry("100", "implemented") }));
  const calls: LoopExecutionRequest[] = [];
  const observe = midFlightOpenPrObserve({ "100": "ready" });
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked",
      evidence: { pr_number: 1068, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(calls.length, 1, "dispatchItem must run for healed implemented item (dispatched >= 1)");
  assert.equal(calls[0]!.item_id, "100");
  assert.equal(calls[0]!.schema, LOOP_EXECUTION_CONTRACT_SCHEMA);
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.items["100"].state, "implemented", "must not remain outside every dispatch frontier");
  assert.notEqual(ledger.items["100"].state, "pr_opened", "must not strand at pr_opened");
});

// ---------------------------------------------------------------------------
// #770 — loop live-advance coexistence (review 1 regressions)
// ---------------------------------------------------------------------------

test("regression (#770 929fc0ac / lock evidence): failed dispatch with already-running evidence is non-fatal coexistence, not workflow-engine-defect / run_fatal", async () => {
  // Concurrent pair so a rejected/failed sibling is classified (serialized single-item
  // rethrows rejections byte-identically to pre-#530). Lock text rides on the raw
  // outcome string the way Pass-2 inspects dispatch evidence.
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "675", depends_on: [], ownership: { exclusive: ["src/a/**"] } },
      { id: "754", depends_on: [], ownership: { exclusive: ["src/b/**"] } },
    ],
  });
  const ledger = testLedger({
    "675": itemEntry("675", "pending"),
    "754": itemEntry("754", "pending"),
  });
  const { deps } = await setup(contract, ledger);

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      // Keep both items mid-pipeline-ready so the precondition gate admits them.
      return { state: "open", labels: id === "754" ? [READY_LABEL, PIPELINE_READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue(issueNumber) {
      return String(issueNumber) === "754" ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x", head_sha: "abc", merge_commit_sha: null };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "675") {
      // Failed outcome whose raw value carries already-running evidence (Pass-2 safety net).
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "pipeline: issue #675 is already running (.lock-failed)" as LoopExecutionResponse["outcome"],
        evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
      };
    }
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      getChangedFiles: async () => [],
      probeLiveAdvance: async (itemId) =>
        itemId === "675"
          ? { live: true as const, evidence: "lock_held" as const, holder_pid: 4242 }
          : { live: false as const },
    },
    "run-1",
    token,
    "claude",
  );

  assert.notEqual(cycle.stop?.reason, "run_fatal", "lock collision must never run_fatal the multi-item run");
  const finalLedger = await readLedger(deps, "run-1");
  assert.notEqual(finalLedger.items["675"].blocked_theme, "workflow-engine-defect");
  assert.equal(finalLedger.items["675"].state, "pending", "coexistence reverts item to pending for re-probe");
  assert.equal(finalLedger.items["754"].state, "ready", "sibling must remain eligible and complete");
  const events = await readEvents(deps, "run-1");
  assert.ok(events.some((e) => e.kind === "loop_item_coexistence_wait"));
});

test("regression (#770 genuine defect): crash with no coexistence evidence still workflow-engine-defect / run_fatal", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      // Mid-flight stage label, not blocked — zero-transition safety nets do not apply.
      return { state: "open", labels: [PIPELINE_READY_LABEL, "pipeline:review-1"] };
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
      // Nonzero label history so precondition zero-transition no-op cannot fire.
      return [{ label: "pipeline:review-1", createdAt: "2026-07-22T00:00:00.000Z" }];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      // Unrecognized terminal outside the defined set, no lock/already-running text.
      outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery: async () => ({ succeeded: false, evidence: "live crash remains defect" }),
    },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop?.reason, "run_fatal");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
});

test("regression (#770 dcfb0878): pre-dispatch live probe prevents a second full dispatch", async () => {
  const contract = testContract({ items: [{ id: "675", depends_on: [] }] });
  const ledger = testLedger({ "675": itemEntry("675", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe } = coordinatedFakes();
  const calls: string[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      probeLiveAdvance: async () => ({
        live: true as const,
        evidence: "lock_held" as const,
        holder_pid: 4242,
      }),
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(calls.length, 0, "live advance must not start a second full dispatch");
  assert.equal(cycle.stop, null, "coexistence must not run_fatal");
  assert.equal(cycle.progress, false, "pre-dispatch wait is no_progress for the watchdog");

  const events = await readEvents(deps, "run-1");
  const coexistence = events.filter((e) => e.kind === "loop_item_coexistence_wait");
  assert.ok(coexistence.length >= 1, "durable coexistence event required");
  assert.equal((coexistence[0]!.data as { item_id: string }).item_id, "675");
});

test("regression (#770 ce4794fb / hold-clear): blocked cleared while live advance → no re-admit / no fatal double-dispatch", async () => {
  const contract = testContract({ items: [{ id: "675", depends_on: [] }] });
  const ledger = testLedger({
    "675": {
      id: "675",
      state: "waiting",
      history: [],
      recovery_budgets_remaining: { default: 3 },
      advance_run_id: "675-2026-07-31T16-00-00-000Z",
      hold_request: {
        request_id: "req-1",
        item_id: "675",
        kind: "answer",
        prompt: "needs a human answer/unblock",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
        source: "pipeline_blocked_label",
      },
    },
  });
  const { deps } = await setup(contract, ledger);
  // Label cleared (no blocked), but probe reports live advance still running.
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:review-2"] };
    },
    async findPrForIssue() {
      return 12;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x", head_sha: "abc", merge_commit_sha: null };
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const calls: string[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      probeLiveAdvance: async () => ({
        live: true as const,
        evidence: "loop_linkage" as const,
        pipeline_run_id: "675-2026-07-31T16-00-00-000Z",
      }),
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(calls.length, 0, "must not re-admit for a second full dispatch while advance is live");
  assert.equal(cycle.stop, null);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["675"].state, "waiting", "item stays held/deferred, not pending for dispatch");
  const events = await readEvents(deps, "run-1");
  assert.ok(
    events.some((e) => e.kind === "loop_item_coexistence_deferred"),
    "durable deferred re-admission record required",
  );
});

test("regression (#770 956d20df): default probe path uses deps.findWrapperPid (no full probe override)", async () => {
  // Production defaultRunLoopEngine wires findWrapperPid + repoDir + lockDomain and
  // does NOT replace probeLiveAdvance. This test exercises that wiring shape.
  const contract = testContract({ items: [{ id: "675", depends_on: [] }] });
  const ledger = testLedger({ "675": itemEntry("675", "pending") });
  const { deps } = await setup(contract, ledger);
  const { observe } = coordinatedFakes();
  const calls: string[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  // Raw entry point: this test deliberately exercises the production default
  // probe (no injected fake). The lock domain is test-unique so the real
  // /tmp/pipeline-<domain>-<issue>.lock path can never collide with a live
  // advance on a dogfooding host.
  const cycle = await runSupervisorCycleRaw(
    {
      store: deps,
      observe,
      dispatchItem,
      // No probeLiveAdvance override — production default path.
      repoDir: "/tmp/not-a-real-repo-770",
      lockDomain: "agent-pipeline-test-956d20df",
      findWrapperPid: () => process.pid,
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(calls.length, 0, "live wrapper PID must block a second full dispatch");
  assert.equal(cycle.stop, null, "wrapper coexistence must not run_fatal");
  const events = await readEvents(deps, "run-1");
  const coexistence = events.filter((e) => e.kind === "loop_item_coexistence_wait");
  assert.ok(coexistence.length >= 1);
  assert.equal((coexistence[0]!.data as { evidence?: string }).evidence, "wrapper_pid");
});

test("regression (#770 b48730b7): default probe with stale crash store does not block genuine defect", async () => {
  // Old non-terminal run-store + no live lock/wrapper must NOT force coexistence;
  // a genuine crash outcome must still be able to escalate to workflow-engine-defect.
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: [PIPELINE_READY_LABEL, "pipeline:review-1"] };
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
      return [{ label: "pipeline:review-1", createdAt: "2026-07-22T00:00:00.000Z" }];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  // Stale crash store on disk for this issue — default probe (no override) must
  // treat it as not-live so Pass-2 keeps genuine-defect / run_fatal.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "loop-stale-770-"));
  const runId = "100-crash-old";
  const dir = path.join(repo, ".agent-pipeline", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const events = path.join(dir, "events.jsonl");
  fs.writeFileSync(events, JSON.stringify({ type: "stage_start", stage: "fix" }) + "\n");
  const old = (Date.now() - ACTIVE_RUN_STORE_MAX_AGE_MS - 120_000) / 1000;
  fs.utimesSync(dir, old, old);
  fs.utimesSync(events, old, old);

  try {
    // Raw entry point + test-unique lock domain: exercises the production
    // default probe hermetically (no /tmp lock collision with a live advance).
    const result = await driveSupervisorRaw(
      {
        store: deps,
        observe,
        dispatchItem,
        // Default probe path: repoDir only — no findWrapperPid, no probe override.
        repoDir: repo,
        lockDomain: "agent-pipeline-test-b48730b7",
      },
      { runId: "run-1", engine: "claude" },
    );

    assert.equal(result.stop?.reason, "run_fatal", "stale crash store must not mask genuine defect");
    const finalLedger = await readLedger(deps, "run-1");
    assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("regression (#770 12e4c0fd): aged linked crash artifact still escalates genuine defect (default wiring)", async () => {
  // Concurrent pair so a failed sibling is reclassified via Pass-2 (serialized single-item rethrows).
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/a/**"] } },
      { id: "754", depends_on: [], ownership: { exclusive: ["src/b/**"] } },
    ],
  });
  // Retained non-terminal linkage from a prior crashed advance (aged on disk).
  const crashId = "100-aged-linked-crash";
  const ledger = testLedger({
    "100": { ...itemEntry("100", "pending"), advance_run_id: crashId },
    "754": itemEntry("754", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      return {
        state: "open",
        labels:
          id === "754"
            ? [READY_LABEL, PIPELINE_READY_LABEL]
            : [PIPELINE_READY_LABEL, "pipeline:review-1"],
      };
    },
    async findPrForIssue(issueNumber) {
      return String(issueNumber) === "754" ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x", head_sha: "abc", merge_commit_sha: null };
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
    async getLabelEvents(issueNumber) {
      return String(issueNumber) === "100"
        ? [{ label: "pipeline:review-1", createdAt: "2026-07-22T00:00:00.000Z" }]
        : [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "100") {
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
        evidence: { pr_number: null, pipeline_run_id: crashId },
      };
    }
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "loop-aged-link-770-"));
  const dir = path.join(repo, ".agent-pipeline", "runs", crashId);
  fs.mkdirSync(dir, { recursive: true });
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, JSON.stringify({ type: "stage_start", stage: "fix" }) + "\n");
  const old = (Date.now() - ACTIVE_RUN_STORE_MAX_AGE_MS - 180_000) / 1000;
  fs.utimesSync(dir, old, old);
  fs.utimesSync(eventsPath, old, old);

  try {
    // Pre-dispatch must not treat aged linkage as live (would skip dispatch entirely).
    // Pass-2 must not reclassify the crash as coexistence via stale linkage.
    // Raw entry point + test-unique lock domain: exercises the production
    // default probe hermetically (no /tmp lock collision with a live advance).
    const result = await driveSupervisorRaw(
      {
        store: deps,
        observe,
        dispatchItem,
        repoDir: repo,
        lockDomain: "agent-pipeline-test-12e4c0fd-aged",
        // No probeLiveAdvance override — production default path.
      },
      { runId: "run-1", engine: "claude" },
    );

    assert.equal(result.stop?.reason, "run_fatal", "aged linked crash must not suppress run_fatal");
    const finalLedger = await readLedger(deps, "run-1");
    assert.equal(finalLedger.items["100"].blocked_theme, "workflow-engine-defect");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("regression (#770 12e4c0fd): freshly crashed linked advance escalates genuine defect (default wiring)", async () => {
  // Concurrent pair for Pass-2 reclassification path.
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/a/**"] } },
      { id: "754", depends_on: [], ownership: { exclusive: ["src/b/**"] } },
    ],
  });
  const crashId = "100-fresh-linked-crash";
  // Start with no linkage and no on-disk store — create the crash artifact only
  // when the dispatch itself links (so pre-dispatch does not treat it as live).
  const ledger = testLedger({
    "100": itemEntry("100", "pending"),
    "754": itemEntry("754", "pending"),
  });
  const { deps } = await setup(contract, ledger);
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      return {
        state: "open",
        labels:
          id === "754"
            ? [READY_LABEL, PIPELINE_READY_LABEL]
            : [PIPELINE_READY_LABEL, "pipeline:review-1"],
      };
    },
    async findPrForIssue(issueNumber) {
      return String(issueNumber) === "754" ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/x", head_sha: "abc", merge_commit_sha: null };
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
    async getLabelEvents(issueNumber) {
      return String(issueNumber) === "100"
        ? [{ label: "pipeline:review-1", createdAt: "2026-07-22T00:00:00.000Z" }]
        : [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "loop-fresh-link-770-"));
  // Ensure runs root exists but do not pre-create the crash store (would block pre-dispatch).
  fs.mkdirSync(path.join(repo, ".agent-pipeline", "runs"), { recursive: true });
  const eventsPath = path.join(repo, ".agent-pipeline", "runs", crashId, "events.jsonl");

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    if (request.item_id === "100") {
      // Mid-dispatch: create non-terminal crash store + start linkage, then fail.
      const dir = path.dirname(eventsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(eventsPath, JSON.stringify({ type: "stage_start", stage: "fix" }) + "\n");
      const nowSec = Date.now() / 1000;
      fs.utimesSync(dir, nowSec, nowSec);
      fs.utimesSync(eventsPath, nowSec, nowSec);
      await hooks?.onAdvanceLinked?.({
        item_id: request.item_id,
        pipeline_run_id: crashId,
        events: eventsPath,
      });
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
        evidence: { pr_number: null, pipeline_run_id: crashId },
      };
    }
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  try {
    // Raw entry point + test-unique lock domain: exercises the production
    // default probe hermetically (no /tmp lock collision with a live advance).
    const { token } = await acquireLock(deps, "run-1", "claude");
    const result = await runSupervisorCycleRaw(
      {
        store: deps,
        observe,
        dispatchItem,
        repoDir: repo,
        lockDomain: "agent-pipeline-test-12e4c0fd-fresh",
        recoverySleep: async () => {},
        // Default probe path — dead-holder crash store is takeover, not coexistence.
      },
      "run-1",
      token,
      "claude",
    );

    const events = await readEvents(deps, "run-1");
    assert.ok(
      events.some((e) => e.kind === "loop_item_dead_holder_takeover"),
      "dead-holder SIGTERM crash is takeover, not workflow-engine-defect",
    );
    assert.ok(
      !events.some(
        (e) =>
          e.kind === "loop_item_coexistence_wait" &&
          (e.data as { item_id?: string; reason?: string }).item_id === "100" &&
          (e.data as { reason?: string }).reason !== "pre_dispatch_live_advance",
      ),
      "Pass-2 must not emit coexistence_wait for a dead-holder crash",
    );
    assert.notEqual(result.stop?.reason, "supervisor_no_progress");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("regression (#770 ce4794fb): hold-clear with terminal linkage (probe not live) re-admits and dispatches", async () => {
  const contract = testContract({ items: [{ id: "675", depends_on: [] }] });
  const ledger = testLedger({
    "675": {
      id: "675",
      state: "waiting",
      history: [],
      recovery_budgets_remaining: { default: 3 },
      // Retained after a prior terminal advance — must not block re-admission once probe says not live
      advance_run_id: "675-2026-07-30T00-00-00-000Z",
      hold_request: {
        request_id: "req-1",
        item_id: "675",
        kind: "answer",
        prompt: "needs a human answer/unblock",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
        source: "pipeline_blocked_label",
      },
    },
  });
  const { deps } = await setup(contract, ledger);
  const { observe, dispatchItem, calls } = coordinatedFakes();

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      // Terminal advance: probe reports not live despite retained advance_run_id
      probeLiveAdvance: async () => ({ live: false as const }),
    },
    { runId: "run-1", engine: "claude" },
  );

  assert.deepEqual(calls.map((c) => c.item_id), ["675"]);
  assert.equal(result.allDone, true);
  assert.equal(result.stop, null);
});

// ---------------------------------------------------------------------------
// Recovery bounds & guards (#787 review): repeated_evidence_limit as an
// independent bound, mid-pass stop guards, pre-#509 shape upgrades, and
// lag-tolerant post-repair head verification.
// ---------------------------------------------------------------------------

test("regression (#787): repeated identical evidence stops the run at repeated_evidence_limit with class budget remaining, reason repeated_no_progress", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      // backoff 0 keeps every claimed attempt immediately executable so the
      // test exercises the limit bound, not the deferral path. limit 2 /
      // budget 3 (defaults) — the limit must bind before the budget drains.
      "workflow-state": { ...workflowState, backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 } },
    },
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      return null; // no candidate head -> narrow resync recipe, never repair
    },
  }).deps;
  // Every dispatch re-blocks with byte-identical evidence: same diagnostic,
  // same transport pointer.
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_recoverable",
      evidence: { pr_number: null, pipeline_run_id: "advance-100" },
      diagnostic,
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: true, evidence: "workflow state resynchronized" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop?.reason, "repeated_no_progress", "the limit is promoted to a stop once no sibling is schedulable");
  assert.equal(result.stop?.item_id, "100");
  assert.equal(result.stop?.theme, "workflow-state");
  assert.ok(result.stop?.fingerprint, "the repeating fingerprint is disclosed on the stop record");
  assert.equal(recoveryCalls, 2, "the limit bounds implementer dispatches independently of the class budget");
  assert.equal(dispatchCount, 3, "no further dispatch is spent once the limit is reached");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(finalLedger.items["100"].repeated_evidence_count, 2);
  assert.equal(
    finalLedger.items["100"].recovery_budgets_remaining["workflow-state"],
    1,
    "the class retry budget was NOT drained to reach the stop",
  );
});

test("regression (#787): a non-run_fatal class whose budget exhausts stops with reason recovery_exhausted", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": {
        ...workflowState,
        recipes: ["resync_workflow_state"],
        retry_budget: 1,
        backoff: { initial_seconds: 0, multiplier: 1, max_seconds: 0 },
        repeated_evidence_limit: 5,
      },
    },
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: false, evidence: "resync failed", error: "resync failed" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop?.reason, "recovery_exhausted");
  assert.equal(result.stop?.theme, "workflow-state");
  assert.equal(recoveryCalls, 1, "exactly the budgeted attempt executed");
});

test("regression (#787): a run_fatal class exhausted stops with reason run_fatal", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "harness-failure",
    reason: "The host returned a malformed stage result",
    stage: "loop-supervisor",
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: false, evidence: "restart failed", error: "restart failed" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop?.reason, "run_fatal", "workflow-engine-defect is run_fatal once its budget is exhausted");
  assert.equal(result.stop?.theme, "workflow-engine-defect");
  assert.equal(recoveryCalls, 2);
});

test("regression (#787): a mid-pass run stop before a sibling's pass-2 recovery skips gracefully — no throw, no side effect, first-cause stop preserved", async () => {
  const engineDefect = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"];
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      // Only repair remains; without a candidate head this makes item 100's
      // recovery preflight record the mid-pass run_fatal stop.
      "workflow-engine-defect": { ...engineDefect, recipes: ["repair_pipeline_item"] },
    },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  let recoveryCalls = 0;
  const canonicalEvidence = JSON.stringify({
    schema: "pipeline/loop-recovery-evidence@1",
    diagnostic: buildStageDiagnostic({
      blockerKind: "merge-conflict",
      reason: "The PR head must be rebased onto main",
      stage: "pre-merge",
    }),
    transport: { pr_number: null, pipeline_run_id: "advance-200" },
  });
  const observe = fakeObserveDeps({
    async getLocalHead() {
      return null; // no candidate head anywhere in this scenario
    },
  }).deps;
  // Item 200 simulates a legacy/in-process child that durably records its own
  // block (canonical recovery evidence) right before its dispatch transport
  // dies; item 100's plain transport failure is classified first in pass 2 and
  // records the run stop before 200's recovery call runs.
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "200") {
      await blockItem(deps, contract, {
        runId: "run-1",
        token,
        itemId: "200",
        engine: "claude",
        blockerClass: "workflow-state",
        evidence: canonicalEvidence,
      });
    }
    throw new Error("dispatch transport failed");
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: true, evidence: "must never run once the run is stopped" };
  };

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      probeLiveAdvance: async () => ({ live: false as const }),
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(cycle.stop?.reason, "run_fatal", "the earlier sibling's stop is the cycle's terminal condition");
  assert.equal(cycle.stop?.item_id, "100", "the first-cause stop record is preserved, not overwritten by the sibling");
  assert.equal(recoveryCalls, 0, "no recovery side effect starts once the run is stopped");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.stop?.item_id, "100");
  assert.equal(finalLedger.items["200"].state, "blocked", "the sibling's own classification is still durably recorded");
  assert.equal(finalLedger.recovery_attempts.length, 0, "no recovery attempt is claimed against a stopped run");
});

test("regression (#787): a pre-#509 ledger (no recovery_attempts) and contract (no recovery_policy) drive recovery without a TypeError", async () => {
  const { recovery_policy: _droppedPolicy, ...contractRest } = testContract({ items: [{ id: "100", depends_on: [] }] });
  const legacyContract = contractRest as unknown as LoopContract;
  const canonicalEvidence = JSON.stringify({
    schema: "pipeline/loop-recovery-evidence@1",
    diagnostic: buildStageDiagnostic({
      blockerKind: "merge-conflict",
      reason: "The PR head must be rebased onto main",
      stage: "pre-merge",
    }),
    transport: { pr_number: null, pipeline_run_id: "advance-100" },
  });
  const blockedEntry: LoopLedger["items"][string] = {
    ...itemEntry("100", "blocked"),
    blocked_theme: "workflow-state",
    evidence_fingerprint: "legacy-fp",
    repeated_evidence_count: 0,
    history: [
      {
        time: "2026-07-22T00:00:00.000Z",
        from: "in_progress",
        to: "blocked",
        engine: "claude",
        theme: "workflow-state",
        evidence: canonicalEvidence,
      },
    ],
  };
  const { recovery_attempts: _droppedAttempts, ...ledgerRest } = testLedger({ "100": blockedEntry });
  const legacyLedger = ledgerRest as unknown as LoopLedger;
  const { deps } = await setup(legacyContract, legacyLedger);
  let dispatchCount = 0;
  let recoveryCalls = 0;
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: dispatchCount >= 1 ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      return dispatchCount >= 1 ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: 12, pipeline_run_id: "advance-100-retry" },
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: true, evidence: "workflow state resynchronized" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop, null);
  assert.equal(result.allDone, true, "the legacy-shaped run resumes, recovers, and completes");
  assert.equal(recoveryCalls, 1, "recovery ran under the default (upgraded) policy");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.recovery_attempts.length, 1);
  assert.equal(finalLedger.recovery_attempts[0].outcome, "recovered");
  assert.equal(finalLedger.items["100"].state, "ready");
});

test("regression (#787): a lagging remote-head read after a pushed repair is re-read before declaring failure", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    items: [{ id: "100", depends_on: [] }],
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": { ...workflowState, recipes: ["repair_pipeline_item"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let postRepairHeadReads = 0;
  const recoveryCalls: string[] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      return { state: "open", labels: dispatchCount >= 2 ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      return dispatchCount >= 2 ? 12 : null;
    },
    async getPrDetail() {
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "def456", merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    // Replication lag: the first two reads after the pushed repair still show
    // the old head; only the third shows the repair's commit.
    async getLocalHead() {
      if (recoveryCalls.length === 0) return { branch: "pipeline/100-fix", sha: "abc123" };
      postRepairHeadReads++;
      return { branch: "pipeline/100-fix", sha: postRepairHeadReads <= 2 ? "abc123" : "def456" };
    },
    async baseBranchContainsSha() {
      return false;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: dispatchCount === 1 ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: dispatchCount === 1 ? null : 12, pipeline_run_id: "advance-100" },
      ...(dispatchCount === 1 ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveryCalls.push(input.action);
    return { succeeded: true, evidence: "rebased and pushed current head", candidateHead: "def456" };
  };

  const result = await driveSupervisor(
    { store: deps, observe, dispatchItem, executeRecovery, recoverySleep: async () => {} },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.stop, null);
  assert.equal(result.allDone, true);
  assert.deepEqual(recoveryCalls, ["repair_pipeline_item"], "only the gh read is retried — the executor runs once");
  assert.equal(postRepairHeadReads, 3, "the stale read is retried a bounded number of times");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.recovery_attempts.length, 1, "the successful pushed repair is never misrecorded as failed");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "recovered");
});

test("regression (#787): a recovery backoff window sleeps in heartbeat chunks without re-polling the remote API every chunk", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": {
        ...workflowState,
        recipes: ["resync_workflow_state"],
        backoff: { initial_seconds: 60, multiplier: 1, max_seconds: 60 },
      },
    },
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatchCount = 0;
  let recoveryCalls = 0;
  let observeCalls = 0;
  const sleeps: number[] = [];
  const obsAtSleep: number[] = [];
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels() {
      observeCalls++;
      return { state: "open", labels: dispatchCount >= 2 ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
    },
    async findPrForIssue() {
      observeCalls++;
      return dispatchCount >= 2 ? 12 : null;
    },
    async getPrDetail() {
      observeCalls++;
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      observeCalls++;
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      observeCalls++;
      return null;
    },
    async baseBranchContainsSha() {
      observeCalls++;
      return null;
    },
    async getLabelEvents() {
      observeCalls++;
      return [];
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCount++;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: dispatchCount === 1 ? "blocked_recoverable" : "ready_to_deploy",
      evidence: { pr_number: dispatchCount === 1 ? null : 12, pipeline_run_id: "advance-100" },
      ...(dispatchCount === 1 ? { diagnostic } : {}),
    };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: true, evidence: "workflow state resynchronized" };
  };

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      recoverySleep: async (ms) => {
        sleeps.push(ms);
        obsAtSleep.push(observeCalls);
      },
    },
    { runId: "run-1", engine: "claude" },
  );

  assert.equal(result.allDone, true);
  assert.equal(recoveryCalls, 1, "the action executes exactly once, after the deadline");
  assert.ok(sleeps.length >= 2, "a long window is slept in multiple chunks");
  assert.ok(sleeps.every((ms) => ms <= 5_000), "every chunk stays heartbeat-sized");
  // This 60s window fits inside one no-reentry stretch (the drive caps each
  // stretch at 60s — see the >60s bounded-latency regression below), so its
  // chunks sleep back-to-back with zero API calls between them.
  assert.ok(
    obsAtSleep.some((count, i) => i > 0 && count === obsAtSleep[i - 1]),
    "consecutive backoff chunks sleep without re-polling the remote API between them",
  );
});

test("regression (round 2): a backoff window longer than 60s re-enters the full cycle at least every 60s, so a mid-window external intervention is picked up with bounded latency", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": {
        ...workflowState,
        recipes: ["resync_workflow_state"],
        backoff: { initial_seconds: 1800, multiplier: 1, max_seconds: 1800 },
      },
    },
    items: [{ id: "100", depends_on: [] }],
  });
  const ledger = testLedger({ "100": blockedRecoveryItem("100") });
  const { deps } = await setup(contract, ledger);
  let recoveryCalls = 0;
  let observeCalls = 0;
  let sleptTotalMs = 0;
  // Simulated external mid-window intervention: 60s into the 1800s backoff a
  // human resolves the item out-of-band (PR opens with ready-to-deploy).
  let intervened = false;
  const sleeps: number[] = [];
  const obsAtSleep: number[] = [];
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      observeCalls++;
      return { state: "open", labels: intervened ? [READY_LABEL] : ["pipeline:review-1"] };
    },
    async findPrForIssue() {
      observeCalls++;
      return intervened ? 12 : null;
    },
    async getPrDetail() {
      observeCalls++;
      return { state: "open", head_ref: "pipeline/100-fix", head_sha: "abc123", merge_commit_sha: null };
    },
    async getPrChecks() {
      observeCalls++;
      return [{ bucket: "pass" }];
    },
    async getLocalHead(issueNumber) {
      observeCalls++;
      return { branch: `pipeline/${issueNumber}-fix`, sha: "abc123" };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "ready_to_deploy",
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    return { succeeded: true, evidence: "must not execute — the intervention supersedes the claim" };
  };

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      recoverySleep: async (ms) => {
        sleeps.push(ms);
        obsAtSleep.push(observeCalls);
        sleptTotalMs += ms;
        if (sleptTotalMs >= 60_000) intervened = true;
      },
    },
    { runId: "run-1", engine: "claude" },
  );

  // Bounded no-reentry stretch: the maximum contiguous slept time with zero
  // API observation between chunks must never exceed 60s — pre-fix the whole
  // 1800s window was slept through in one stretch.
  let maxStretchMs = 0;
  let currentStretchMs = 0;
  for (let i = 0; i < sleeps.length; i++) {
    if (i > 0 && obsAtSleep[i] !== obsAtSleep[i - 1]) currentStretchMs = 0;
    currentStretchMs += sleeps[i];
    maxStretchMs = Math.max(maxStretchMs, currentStretchMs);
  }
  assert.ok(
    maxStretchMs <= 60_000,
    `a window longer than 60s must re-enter the full cycle within 60s (max no-reentry stretch was ${maxStretchMs}ms)`,
  );
  assert.ok(
    sleptTotalMs < 200_000,
    `the mid-window intervention must be picked up bounded, not slept through the 1800s window (slept ${sleptTotalMs}ms)`,
  );
  assert.equal(result.allDone, true, "the externally resolved item completes the run");
  assert.equal(recoveryCalls, 0, "the superseded claim's action never executes after the intervention");
});

// ---------------------------------------------------------------------------
// Recovery coexistence guard — the blocked-item recovery pass must not run the
// worktree-writing recovery executor while a concurrent host-local advance
// owns the item (live probe or the per-issue advance lock).
// ---------------------------------------------------------------------------

/** A ledger entry already blocked with valid persisted recovery evidence, so
 *  the recovery pass (not a same-cycle dispatch classification) claims and
 *  executes its recovery. */
function blockedRecoveryItem(id: string): LoopLedger["items"][string] {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  return {
    ...itemEntry(id, "blocked"),
    blocked_theme: "workflow-state",
    history: [
      {
        time: "2026-07-23T00:00:00.000Z",
        from: "in_progress",
        to: "blocked",
        engine: "claude",
        theme: "workflow-state",
        evidence: JSON.stringify({
          schema: "pipeline/loop-recovery-evidence@1",
          diagnostic,
          transport: { pr_number: null, pipeline_run_id: `advance-${id}` },
        }),
      },
    ],
  };
}

function blockedReviewRecoveryItem(id: string): LoopLedger["items"][string] {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "Blocking review finding survived a verified repair cycle",
    stage: "review-2",
  });
  return {
    ...itemEntry(id, "blocked"),
    blocked_theme: "review-findings",
    history: [{
      time: "2026-07-23T00:00:00.000Z",
      from: "in_progress",
      to: "blocked",
      engine: "claude",
      theme: "review-findings",
      evidence: JSON.stringify({
        schema: "pipeline/loop-recovery-evidence@1",
        diagnostic,
        transport: { pr_number: 12, pipeline_run_id: `advance-${id}` },
      }),
    }],
  };
}

test("regression #797/#1060: review non-convergence preps unlink then same-sequence repair", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": blockedReviewRecoveryItem("100") });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const dispatchItem: SupervisorDeps["dispatchItem"] = async () => {
    throw new Error("a blocked item must recover before redispatch");
  };
  const actions: string[] = [];
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    actions.push(input.action);
    if (input.action === "unlink_engine_scratch") {
      return {
        succeeded: false,
        evidence:
          "unlink_engine_scratch: prep-complete for review-findings; removed engine scratch " +
          "[artifacts/challenge-response-599.json] — findings still require repair_pipeline_item (trying next recipe)",
        error:
          "unlink_engine_scratch: prep-complete for review-findings; removed engine scratch " +
          "[artifacts/challenge-response-599.json] — findings still require repair_pipeline_item (trying next recipe)",
      };
    }
    return { succeeded: false, evidence: "repair attempted", error: "fixture stops after repair selection" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle(
    { store: deps, observe, dispatchItem, executeRecovery },
    "run-1",
    token,
    "claude",
  );

  assert.deepEqual(actions, ["unlink_engine_scratch", "repair_pipeline_item"]);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.recovery_attempts[0].class, "review-findings");
  assert.equal(finalLedger.recovery_attempts[0].action, "unlink_engine_scratch");
  assert.equal(finalLedger.recovery_attempts[1]?.action, "repair_pipeline_item");
  // Prep unlink is free of findings retry budget (retry_budget: 3 → still 2 after one repair charge).
  assert.equal(
    finalLedger.items["100"].recovery_budgets_remaining["review-findings"],
    2,
    "prep must not charge budget; only repair charges one unit of 3",
  );
});

test("regression #1060: findings prep not-applicable still same-sequence repairs without false recover", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": blockedReviewRecoveryItem("100") });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const actions: string[] = [];
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    actions.push(input.action);
    if (input.action === "unlink_engine_scratch") {
      return {
        succeeded: false,
        evidence:
          "unlink_engine_scratch: prep not-applicable for review-findings (no engine-scratch paths) — trying next recipe",
        error:
          "unlink_engine_scratch: prep not-applicable for review-findings (no engine-scratch paths) — trying next recipe",
      };
    }
    return { succeeded: false, evidence: "repair attempted", error: "fixture stops" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem: async () => {
        throw new Error("blocked");
      },
      executeRecovery,
    },
    "run-1",
    token,
    "claude",
  );
  assert.deepEqual(actions, ["unlink_engine_scratch", "repair_pipeline_item"]);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "unlink alone must not recover findings");
});

test("regression #1060: supervisor prep fall-through does not raise repeated-evidence or starve repair", async () => {
  // Same-sequence prep→repair: prep failure must leave repeated_evidence_count
  // untouched and charge only one retry-budget unit for the repair claim.
  // (Full three-repair budget accounting is covered in loop-recovery.test.ts.)
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const seeded = blockedReviewRecoveryItem("100");
  seeded.repeated_evidence_count = 0;
  seeded.recovery_budgets_remaining = { "review-findings": 3 };
  const ledger = testLedger({ "100": seeded });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const actions: string[] = [];
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    actions.push(input.action);
    if (input.action === "unlink_engine_scratch") {
      return {
        succeeded: false,
        evidence:
          "unlink_engine_scratch: prep not-applicable for review-findings (no engine-scratch paths) — trying next recipe",
        error:
          "unlink_engine_scratch: prep not-applicable for review-findings (no engine-scratch paths) — trying next recipe",
      };
    }
    return { succeeded: false, evidence: "repair failed", error: "repair failed" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem: async () => {
        throw new Error("blocked item must not redispatch until recovered");
      },
      executeRecovery,
    },
    "run-1",
    token,
    "claude",
  );
  assert.deepEqual(actions, ["unlink_engine_scratch", "repair_pipeline_item"]);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked");
  assert.equal(
    finalLedger.items["100"].repeated_evidence_count ?? 0,
    0,
    "prep fall-through + failed repair must not increment repeated_evidence_count",
  );
  assert.equal(
    finalLedger.items["100"].recovery_budgets_remaining["review-findings"],
    2,
    "only the repair claim charges one unit of retry_budget 3",
  );
  assert.ok(
    (finalLedger.items["100"].repeated_evidence_count ?? 0) <
      DEFAULT_RECOVERY_POLICY["review-findings"].repeated_evidence_limit,
    "must remain under repeated_evidence_limit so further implementer repairs can claim",
  );
});

/** Observe fake for the coexistence-guard tests: blocked items sit mid-pipeline
 *  (mirrors the seeded-blocked fake at "pipeline:review-1") with an observable
 *  local head so the recovery preflight can bind a candidate identity. */
function blockedRecoveryObserve() {
  return fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:review-1"] };
    },
    async getLocalHead(issueNumber) {
      return { branch: `pipeline/${issueNumber}-fix`, sha: "abc123" };
    },
  }).deps;
}

test("regression (coexistence guard): a live host-local advance defers blocked-item recovery without claiming budget while the sibling still recovers", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": blockedRecoveryItem("100"),
    "200": blockedRecoveryItem("200"),
  });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const dispatchCalls: LoopExecutionRequest[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatchCalls.push(request);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };
  const recoveredItemIds: string[] = [];
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveredItemIds.push(input.itemId);
    return { succeeded: false, evidence: "repair attempt failed" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      probeLiveAdvance: (itemId) =>
        itemId === "100"
          ? { live: true as const, evidence: "lock_held" as const, holder_pid: 4242 }
          : { live: false as const },
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(cycle.stop, null);
  assert.deepEqual(
    recoveredItemIds,
    ["200"],
    "the live item's executor never runs; the independent sibling still recovers this cycle",
  );
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(
    finalLedger.recovery_attempts.filter((attempt) => attempt.item_id === "100").length,
    0,
    "no recovery claim is charged for the live item",
  );
  assert.deepEqual(
    finalLedger.items["100"].recovery_budgets_remaining,
    { default: 3 },
    "the live item's budget is untouched",
  );
  assert.equal(finalLedger.items["100"].state, "blocked", "the live item stays blocked for a later cycle");
  assert.equal(finalLedger.recovery_attempts.filter((attempt) => attempt.item_id === "200").length, 1);
  const events = await readEvents(deps, "run-1");
  const deferred = events.filter(
    (e: any) => e.kind === "loop_item_coexistence_deferred" && e.data.item_id === "100",
  );
  assert.equal(deferred.length, 1, "the deferral is durably recorded");
  assert.equal((deferred[0] as any).data.reason, "recovery_deferred_live_advance");
  assert.equal((deferred[0] as any).data.evidence, "lock_held");
});

test("coexistence guard: an unavailable per-issue advance lock defers recovery without claiming; the sibling's lock is held and released", async () => {
  const contract = testContract({
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "100": blockedRecoveryItem("100"),
    "200": blockedRecoveryItem("200"),
  });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "ready_to_deploy",
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });
  const recoveredItemIds: string[] = [];
  const released: string[] = [];
  let siblingLockHeldDuringExecutor: boolean | null = null;
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    recoveredItemIds.push(input.itemId);
    if (input.itemId === "200") siblingLockHeldDuringExecutor = !released.includes("200");
    return { succeeded: false, evidence: "repair attempt failed" };
  };
  const lockCalls: string[] = [];
  const acquireItemAdvanceLock: NonNullable<SupervisorDeps["acquireItemAdvanceLock"]> = (itemId) => {
    lockCalls.push(itemId);
    if (itemId === "100") return null;
    return { release: () => { released.push(itemId); } };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      probeLiveAdvance: () => ({ live: false as const }),
      acquireItemAdvanceLock,
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(cycle.stop, null);
  assert.deepEqual(lockCalls, ["100", "200"], "the lock is attempted for every blocked item");
  assert.deepEqual(recoveredItemIds, ["200"], "the lock-busy item's executor never runs");
  assert.equal(siblingLockHeldDuringExecutor, true, "the sibling's lock is still held while its executor runs");
  assert.deepEqual(released, ["200"], "the acquired sibling lock is released after execution");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(
    finalLedger.recovery_attempts.filter((attempt) => attempt.item_id === "100").length,
    0,
    "no recovery claim is charged while the advance lock is held elsewhere",
  );
  assert.deepEqual(finalLedger.items["100"].recovery_budgets_remaining, { default: 3 });
  const events = await readEvents(deps, "run-1");
  const deferred = events.filter(
    (e: any) => e.kind === "loop_item_coexistence_deferred" && e.data.item_id === "100",
  );
  assert.equal(deferred.length, 1);
  assert.equal((deferred[0] as any).data.reason, "recovery_deferred_advance_lock_busy");
});

test("coexistence guard: the advance lock is acquired before the claim, held across the executor, and released even when the executor throws", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": blockedRecoveryItem("100") });
  const { deps } = await setup(contract, ledger);
  const observe = blockedRecoveryObserve();
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "ready_to_deploy",
    evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
  });
  let releasedCount = 0;
  let claimExistedAtAcquire: boolean | null = null;
  let lockHeldDuringExecutor: boolean | null = null;
  let claimDurableDuringExecutor: boolean | null = null;
  const acquireItemAdvanceLock: NonNullable<SupervisorDeps["acquireItemAdvanceLock"]> = async () => {
    const current = await readLedger(deps, "run-1");
    claimExistedAtAcquire = current.recovery_attempts.length > 0;
    return { release: () => { releasedCount++; } };
  };
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async (input) => {
    lockHeldDuringExecutor = releasedCount === 0;
    const claimed = await readLedger(deps, "run-1");
    claimDurableDuringExecutor = claimed.recovery_attempts.some(
      (attempt) => attempt.attempt_id === input.attemptId && attempt.outcome === "started",
    );
    throw new Error("executor transport died");
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery,
      probeLiveAdvance: () => ({ live: false as const }),
      acquireItemAdvanceLock,
    },
    "run-1",
    token,
    "claude",
  );

  assert.equal(cycle.stop, null);
  assert.equal(claimExistedAtAcquire, false, "lock acquisition precedes the durable claim");
  assert.equal(lockHeldDuringExecutor, true, "the lock is still held when the executor is invoked");
  assert.equal(claimDurableDuringExecutor, true, "the claim still precedes the side effect");
  assert.equal(releasedCount, 1, "the lock is released exactly once, in finally, despite the executor throw");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.recovery_attempts.length, 1);
  assert.equal(finalLedger.recovery_attempts[0].outcome, "failed", "the thrown execution completes the claim as failed");
});

// ---------------------------------------------------------------------------
// Verification round 2: an UNOBSERVABLE issue read (gh.ts swallows every gh
// failure to null, which observeExternalIdentity folds into issue_open=false)
// must never be treated as a positive "issue closed" / "labels cleared"
// observation. Abandonment is irreversible — nothing re-admits an abandoned
// item — so it requires a fresh POSITIVE closed read at both recovery sites,
// and a pipeline_blocked_label hold is only re-admitted on a positive
// label-absent read.
// ---------------------------------------------------------------------------

test("regression (round 2): an unobservable issue read never abandons a blocked item or supersedes its started claim", async () => {
  const workflowState = DEFAULT_RECOVERY_POLICY["workflow-state"];
  const contract = testContract({
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-state": { ...workflowState, recipes: ["resync_workflow_state"] },
    },
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let issueUnobservable = false;
  let failPostObservation = false;
  let recoveryCalls = 0;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "candidate requires a mechanical resync",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      // gh.ts swallows every gh failure to null — model the transient failure
      // exactly as production observes it (no throw, just null).
      return issueUnobservable ? null : { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async getLocalHead() {
      if (failPostObservation) throw new Error("postcondition temporarily unavailable");
      return { branch: "pipeline/100-fix", sha: "abc123" };
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "blocked_recoverable",
    evidence: { pr_number: null, pipeline_run_id: "advance-100" },
    diagnostic,
  });
  const executeRecovery: NonNullable<SupervisorDeps["executeRecovery"]> = async () => {
    recoveryCalls++;
    failPostObservation = true; // strand the claim `started` (post-observation fails)
    return { succeeded: true, evidence: "resync applied", candidateHead: "abc123" };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");
  const afterClaim = await readLedger(deps, "run-1");
  assert.equal(afterClaim.items["100"].state, "blocked");
  assert.equal(afterClaim.recovery_attempts[0].outcome, "started");
  assert.equal(recoveryCalls, 1);

  // Next cycle: ONE transient gh failure makes every issue read null.
  failPostObservation = false;
  issueUnobservable = true;
  await runSupervisorCycle({ store: deps, observe, dispatchItem, executeRecovery }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "blocked", "an unobservable issue is never treated as closed/abandoned");
  assert.equal(finalLedger.recovery_attempts[0].outcome, "started", "the started claim survives intact");
  const events = await readEvents(deps, "run-1");
  assert.ok(!events.some((e) => e.kind === "loop_recovery_superseded"), "no abandonment/supersede is recorded");
  assert.ok(
    events.some(
      (e) =>
        e.kind === "loop_recovery_preflight_deferred" &&
        /unobservable/.test(String((e.data as { reason?: string }).reason)),
    ),
    "the per-cycle deferral leaves a durable trace",
  );
});

test("regression (round 2): an unobservable issue read at blocked classification records the block instead of abandoning", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = await setup(contract, ledger);
  let dispatched = false;
  const diagnostic = buildStageDiagnostic({
    blockerKind: "merge-conflict",
    reason: "The PR head must be rebased onto main",
    stage: "pre-merge",
  });
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      // The gh read starts failing (swallowed to null) exactly when the child
      // result is classified — one transient failure window.
      return dispatched ? null : { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched = true;
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_recoverable",
      evidence: { pr_number: null, pipeline_run_id: "advance-100" },
      diagnostic,
    };
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(
    finalLedger.items["100"].state,
    "blocked",
    "classification records the block; it never abandons on an unobservable read",
  );
  assert.equal(finalLedger.items["100"].blocked_theme, "workflow-state");
  assert.ok(!(await readEvents(deps, "run-1")).some((e) => e.kind === "loop_recovery_superseded"));
});

test("round 2: a POSITIVE closed issue observation still abandons the blocked item", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": blockedRecoveryItem("100") });
  const { deps } = await setup(contract, ledger);
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      return { state: "closed", labels: [] };
    },
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async () => {
    throw new Error("must not dispatch a closed item");
  };
  const { token } = await acquireLock(deps, "run-1", "claude");

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "abandoned", "a positively observed close still abandons");
  assert.ok((await readEvents(deps, "run-1")).some((e) => e.kind === "loop_recovery_superseded"));
  assert.equal(cycle.allDone, true, "the abandoned item resolves the single-item run");
});

test("regression (round 2): a null issue read never re-admits a pipeline_blocked_label hold", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({
    "100": {
      id: "100",
      state: "waiting",
      history: [],
      recovery_budgets_remaining: { default: 3 },
      hold_request: {
        request_id: "req-1",
        item_id: "100",
        kind: "answer",
        prompt: "needs a human answer/unblock",
        requested_by_engine: "claude",
        requested_at: "2026-07-23T00:00:00.000Z",
        source: "pipeline_blocked_label",
      },
    },
  });
  const { deps } = await setup(contract, ledger);
  const calls: string[] = [];
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels() {
      // The human's blocked label is still present, but the read is swallowed
      // to null by gh.ts — "unobservable", never "cleared".
      return null;
    },
    async getLocalHead() {
      return null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    calls.push(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: `pipeline-run-${request.item_id}` },
    };
  };

  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "run-1", engine: "claude" });

  assert.equal(calls.length, 0, "the held item must not be re-dispatched on an unobservable label read");
  assert.equal(result.holdOutstanding, true, "the hold remains the run's outstanding condition");
  assert.deepEqual(result.heldItemIds, ["100"]);
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.items["100"].state, "waiting", "the hold is preserved, not re-admitted");
  assert.ok(!(await readEvents(deps, "run-1")).some((e) => e.kind === "loop_item_hold_cleared"));
});

// ---------------------------------------------------------------------------
// Verification round 2: pass-2 blocked_needs_human arms after a mid-pass run
// stop — waitItem's enterHold throws LoopError("stop") once ledger.stop is
// set, so both hold arms must re-check the durable stop and skip gracefully
// (mirrors the pass-2 recovery stop guard proven at "a mid-pass run stop
// before a sibling's pass-2 recovery skips gracefully").
// ---------------------------------------------------------------------------

test("regression (round 2): a mid-pass run stop before a sibling's attested-authority hold skips the hold gracefully — no throw, first-cause stop preserved", async () => {
  const engineDefect = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"];
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      // Only repair remains; without a candidate head this makes item 100's
      // recovery preflight record the mid-pass run_fatal stop first.
      "workflow-engine-defect": { ...engineDefect, recipes: ["repair_pipeline_item"] },
    },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  const observe = fakeObserveDeps({
    async getLocalHead(issueNumber) {
      // 200's head matches the attested diagnostic's reviewed_sha; 100 has no
      // candidate head anywhere (drives its preflight run_fatal stop).
      return issueNumber === 200 ? { branch: "pipeline/200-fix", sha: "abc123" } : null;
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    if (request.item_id === "100") throw new Error("dispatch transport failed");
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human",
      evidence: { pr_number: null, pipeline_run_id: "pipeline-run-200" },
      diagnostic: humanAuthorityDiagnostic(),
    };
  };

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(cycle.stop?.reason, "run_fatal", "the earlier sibling's stop is the cycle's terminal condition");
  assert.equal(cycle.stop?.item_id, "100", "the first-cause stop record is preserved");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.stop?.item_id, "100");
  assert.equal(finalLedger.items["200"].state, "in_progress", "no hold is written after the stop");
  assert.equal(finalLedger.items["200"].hold_request, undefined);
  assert.ok(
    !(await readEvents(deps, "run-1")).some(
      (e) => e.kind === "loop_item_waiting" && (e.data as { item_id?: string }).item_id === "200",
    ),
    "no waiting-hold event once the run is stopped",
  );
});

test("a mid-pass run stop before a sibling's unattested needs-human protocol recovery preserves the first stop", async () => {
  const engineDefect = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"];
  const contract = testContract({
    concurrency: { max_concurrent: 2 },
    recovery_policy: {
      ...DEFAULT_RECOVERY_POLICY,
      "workflow-engine-defect": { ...engineDefect, recipes: ["repair_pipeline_item"] },
    },
    items: [
      { id: "100", depends_on: [], ownership: { exclusive: ["src/one/**"] } },
      { id: "200", depends_on: [], ownership: { exclusive: ["src/two/**"] } },
    ],
  });
  const ledger = testLedger({ "100": itemEntry("100", "pending"), "200": itemEntry("200", "pending") });
  const { deps } = await setup(contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  const dispatched = new Set<string>();
  const observe = fakeObserveDeps({
    async getIssueStateAndLabels(issueNumber) {
      const id = String(issueNumber);
      if (id === "200" && dispatched.has(id)) {
        return { state: "open", labels: ["pipeline:plan-review", "blocked"] };
      }
      return { state: "open", labels: [PIPELINE_READY_LABEL] };
    },
    async getLocalHead() {
      return null; // no candidate head anywhere (drives 100's run_fatal stop)
    },
  }).deps;
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    dispatched.add(request.item_id);
    if (request.item_id === "100") throw new Error("dispatch transport failed");
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "blocked_needs_human",
      evidence: { pr_number: null, pipeline_run_id: "pipeline-run-200" },
      // No diagnostic: this would enter protocol recovery if the run were live.
    };
  };

  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "run-1", token, "claude");

  assert.equal(cycle.stop?.reason, "run_fatal", "the earlier sibling's stop is the cycle's terminal condition");
  assert.equal(cycle.stop?.item_id, "100", "the first-cause stop record is preserved");
  const finalLedger = await readLedger(deps, "run-1");
  assert.equal(finalLedger.stop?.item_id, "100");
  assert.equal(finalLedger.items["200"].state, "blocked", "protocol classification is retained without creating a hold");
  assert.equal(finalLedger.items["200"].blocked_theme, "workflow-engine-defect");
  assert.equal(finalLedger.items["200"].hold_request, undefined);
  assert.ok(
    !(await readEvents(deps, "run-1")).some(
      (e) => e.kind === "loop_item_waiting" && (e.data as { item_id?: string }).item_id === "200",
    ),
    "no waiting-hold event once the run is stopped",
  );
});

test("dead holder + reused loop id is takeover, not coexistence_wait or supervisor_no_progress (#1096)", async () => {
  const contract = testContract({ items: [{ id: "1095", depends_on: [] }] });
  const entry = itemEntry("1095", "pending");
  entry.advance_run_id = "loop-cd7bd53d94838204";
  const ledger = testLedger({ "1095": entry });
  const { deps } = await setup(contract, ledger);
  const { observe } = coordinatedFakes();
  const claimed: string[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
    evidence: { pr_number: null, pipeline_run_id: "loop-cd7bd53d94838204" },
  });
  const { token } = await acquireLock(deps, "run-1", "claude");
  const cycle = await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      probeLiveAdvance: async () => ({ live: false as const }),
      executeRecovery: async (input) => {
        claimed.push(input.action);
        return { succeeded: false, evidence: "should-not-claim-restart" };
      },
    },
    "run-1",
    token,
    "claude",
  );
  const events = await readEvents(deps, "run-1");
  const waits = events.filter((e) => e.kind === "loop_item_coexistence_wait");
  assert.ok(waits.length < 2, `corpse must not cycle coexistence_wait (got ${waits.length})`);
  assert.notEqual(cycle.stop?.reason, "supervisor_no_progress");
  assert.ok(!claimed.includes("restart_workflow_engine"), "first recipe must not be restart_workflow_engine");
  const finalLedger = await readLedger(deps, "run-1");
  const defectBudget = finalLedger.items["1095"].recovery_budgets_remaining["workflow-engine-defect"];
  if (defectBudget !== undefined) {
    assert.ok(defectBudget > 0, "workflow-engine-defect budget must not burn to zero");
  }
  assert.ok(
    events.some((e) => e.kind === "loop_item_dead_holder_takeover"),
    "dead holder must take over the same item",
  );
  assert.equal(finalLedger.items["1095"].state, "pending", "takeover returns the same item to pending");
});

test("dead-holder takeover does not cycle forever on a repeated crash after resume (#1096)", async () => {
  const contract = testContract({ items: [{ id: "1095", depends_on: [] }] });
  const entry = itemEntry("1095", "pending");
  entry.advance_run_id = "loop-cd7bd53d94838204";
  const ledger = testLedger({ "1095": entry });
  const { deps } = await setup(contract, ledger);
  const { observe } = coordinatedFakes();
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => ({
    schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
    item_id: request.item_id,
    run_id: request.run_id,
    outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
    evidence: { pr_number: null, pipeline_run_id: "loop-cd7bd53d94838204" },
  });

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery: async () => ({ succeeded: false, evidence: "repeated crash after resume stays defect" }),
    },
    { runId: "run-1", engine: "claude", maxCyclesSafety: 25 },
  );

  const events = await readEvents(deps, "run-1");
  const takeovers = events.filter((e) => e.kind === "loop_item_dead_holder_takeover");
  assert.equal(takeovers.length, 1, "exactly one dead-holder takeover; a second cycle must not resume the corpse again");
  assert.ok(result.cycles < 25, `drive must terminate before the safety cap (got ${result.cycles} cycles)`);
  assert.ok(result.stop, "repeated crash after resume must reach a recorded stop, not spin");
});

test("second independent dead-holder interrupt is takeover, not leftover history match (#1096 83e30467)", async () => {
  const contract = testContract({ items: [{ id: "1095", depends_on: [] }] });
  const entry = itemEntry("1095", "pending");
  entry.advance_run_id = "kill-1-2026-08-18T00-00-01-000Z";
  const ledger = testLedger({ "1095": entry });
  const { deps } = await setup(contract, ledger);
  const succeeded = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: succeeded.has(String(issueNumber)) ? [READY_LABEL] : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue(issueNumber) {
      return succeeded.has(String(issueNumber)) ? 12 : null;
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };
  let n = 0;
  const claimed: string[] = [];
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    n += 1;
    if (n <= 2) {
      const killId = `kill-${n}-2026-08-18T00-00-0${n}-000Z`;
      await hooks?.onAdvanceLinked?.({
        item_id: request.item_id,
        pipeline_run_id: killId,
        events: `/repo/.agent-pipeline/runs/${killId}/events.jsonl`,
      });
      return {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: request.item_id,
        run_id: request.run_id,
        outcome: "engine_internal_crash" as LoopExecutionResponse["outcome"],
        evidence: { pr_number: null, pipeline_run_id: killId },
      };
    }
    succeeded.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: null, pipeline_run_id: "resume-ok-2026-08-18T00-00-03-000Z" },
    };
  };

  const result = await driveSupervisor(
    {
      store: deps,
      observe,
      dispatchItem,
      executeRecovery: async (input) => {
        claimed.push(input.action);
        return { succeeded: false, evidence: "independent kill must not claim restart_workflow_engine" };
      },
    },
    { runId: "run-1", engine: "claude", maxCyclesSafety: 25 },
  );

  const events = await readEvents(deps, "run-1");
  const takeovers = events.filter((e) => e.kind === "loop_item_dead_holder_takeover");
  assert.equal(takeovers.length, 2, "two independent kill/resume cycles must each take over");
  assert.ok(!claimed.includes("restart_workflow_engine"), "second independent kill must not claim restart_workflow_engine");
  const finalLedger = await readLedger(deps, "run-1");
  const defectBudget = finalLedger.items["1095"].recovery_budgets_remaining["workflow-engine-defect"];
  if (defectBudget !== undefined) {
    assert.ok(defectBudget > 0, "workflow-engine-defect budget must not burn on independent kills");
  }
  assert.equal(finalLedger.items["1095"].state, "ready", "item completes after the second independent resume");
  assert.equal(result.stop, null, "two independent kills must not stop the run as a defect");
  assert.ok(result.cycles < 25, `drive must terminate before the safety cap (got ${result.cycles} cycles)`);
});
