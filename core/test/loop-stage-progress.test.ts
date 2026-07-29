// Unit tests for per-item loop stage-progress observability (#611, capability
// `loop-item-stage-progress`). Injected store / advance-event seams only —
// no real network, git, or live supervisor subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOOP_ITEM_STAGE_PROGRESS,
  applyAdvanceEventsToStageProgress,
  buildStageProgressTable,
  followLoopStageProgress,
  formatAuditStageTableRow,
  formatStageProgressFollowLine,
  isMaterialStageChange,
  mapAdvanceEventToStageDelta,
  parseAdvanceEventsJsonl,
  parseStageProgressEventData,
  projectionFromItem,
  recordItemStageProgress,
  reconcileTerminalStageProgress,
  type ItemStageProjection,
} from "../scripts/loop/stage-progress.ts";
import {
  acquireLock,
  getStatus,
  initRun,
  readEvents,
  readLedger,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { auditSupervisor, LOOP_ITEM_ADVANCE_LINKED, runSupervisorCycle } from "../scripts/loop/supervisor.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import type { ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopItemLedgerEntry,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";
import { normalizeLoopArgs, LoopArgError } from "../scripts/loop-preflight.ts";

// ---------------------------------------------------------------------------
// In-memory store fake
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-27T19:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-stage-progress-${counter++}` };

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

function itemEntry(id: string, state: LoopItemLedgerEntry["state"], extra: Partial<LoopItemLedgerEntry> = {}): LoopItemLedgerEntry {
  return {
    id,
    state,
    history: [],
    recovery_budgets_remaining: { default: 3 },
    ...extra,
  };
}

function testContract(overrides: Partial<LoopContract> = {}): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    engine: "claude",
    repo: { name: "acme/w", base_branch: "main" },
    selector: { type: "work-list", value: ["607", "608"] },
    objective: "test",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    authority_grants: [],
    recovery_budgets: { default: 3 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: {},
    report_format: "json",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [
      { id: "607", depends_on: [], external_depends_on: [] },
      { id: "608", depends_on: [], external_depends_on: [] },
    ],
    canonical_hash: "hash-1",
    ...overrides,
  };
}

function testLedger(items: Record<string, LoopItemLedgerEntry>): LoopLedger {
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

// ---------------------------------------------------------------------------
// 5.1 Pure mapping
// ---------------------------------------------------------------------------

test("mapAdvanceEventToStageDelta: stage_start updates stage", () => {
  const delta = mapAdvanceEventToStageDelta(
    { type: "stage_start", stage: "implementing", at: "2026-07-27T19:31:00Z" },
    null,
    { advance_run_id: "607-2026-07-27T19-31-29-328Z", now: "2026-07-27T19:31:00Z" },
  );
  assert.equal(delta.material, true);
  if (!delta.material) return;
  assert.equal(delta.projection.current_stage, "implementing");
  assert.equal(delta.projection.advance_run_id, "607-2026-07-27T19-31-29-328Z");
});

test("mapAdvanceEventToStageDelta: review_verdict records round", () => {
  const current: ItemStageProjection = {
    current_stage: "plan-review",
    current_stage_updated_at: "t0",
    advance_run_id: "607-x",
  };
  const delta = mapAdvanceEventToStageDelta(
    { type: "review_verdict", round: 1, at: "t1" },
    current,
    { advance_run_id: "607-x", now: "t1" },
  );
  assert.equal(delta.material, true);
  if (!delta.material) return;
  assert.equal(delta.projection.current_stage, "plan-review");
  assert.equal(delta.projection.current_stage_round, 1);
});

test("mapAdvanceEventToStageDelta: non-material duplicate stage_start is skipped", () => {
  const current: ItemStageProjection = {
    current_stage: "implementing",
    current_stage_updated_at: "t0",
    advance_run_id: "607-x",
  };
  const delta = mapAdvanceEventToStageDelta(
    { type: "stage_start", stage: "implementing", at: "t1" },
    current,
    { advance_run_id: "607-x", now: "t1" },
  );
  assert.equal(delta.material, false);
});

test("mapAdvanceEventToStageDelta: unknown event types are non-material", () => {
  const delta = mapAdvanceEventToStageDelta(
    { type: "gate_result", stage: "implementing" },
    null,
    { now: "t0" },
  );
  assert.equal(delta.material, false);
});

test("isMaterialStageChange: round change is material", () => {
  assert.equal(
    isMaterialStageChange(
      { current_stage: "review", current_stage_round: 1, current_stage_updated_at: "t0" },
      { current_stage: "review", current_stage_round: 2, current_stage_updated_at: "t1" },
    ),
    true,
  );
});

// ---------------------------------------------------------------------------
// 5.2 Ledger + event write path with injected store
// ---------------------------------------------------------------------------

test("recordItemStageProgress: writes projection and structured loop event; coarse state stays closed", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress"),
    "608": itemEntry("608", "pending"),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");

  await recordItemStageProgress(deps, {
    runId: "run-1",
    token,
    itemId: "607",
    projection: {
      current_stage: "implementing",
      current_stage_updated_at: "2026-07-27T19:31:00Z",
      advance_run_id: "607-2026-07-27T19-31-29-328Z",
    },
  });

  const after = await readLedger(deps, "run-1");
  assert.equal(after.items["607"].state, "in_progress", "coarse state must remain a closed item state");
  assert.equal(after.items["607"].current_stage, "implementing");
  assert.equal(after.items["607"].advance_run_id, "607-2026-07-27T19-31-29-328Z");
  assert.notEqual(after.items["607"].state, after.items["607"].current_stage);

  const events = await readEvents(deps, "run-1");
  const progress = events.filter((e) => e.kind === LOOP_ITEM_STAGE_PROGRESS);
  assert.equal(progress.length, 1);
  assert.equal((progress[0].data as { stage: string }).stage, "implementing");
  assert.equal((progress[0].data as { advance_run_id: string }).advance_run_id, "607-2026-07-27T19-31-29-328Z");
});

// Regression for #611 review finding d9543320: concurrent observers must not
// clobber each other's whole-ledger writes. Without per-run serialization the
// delayed first write loses the second item's projection (last-write-wins).
test("recordItemStageProgress: concurrent updates for two items both persist projections", async () => {
  const contract = testContract({
    max_active_items: 2,
    items: [
      { id: "607", depends_on: [], external_depends_on: [] },
      { id: "608", depends_on: [], external_depends_on: [] },
    ],
  });
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress"),
    "608": itemEntry("608", "in_progress"),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");

  // Stretch ledger writes so concurrent RMW without a queue would both read the
  // pre-update ledger and the later write would drop the earlier item's stage.
  let ledgerWrites = 0;
  const baseWrite = deps.writeFileAtomic.bind(deps);
  deps.writeFileAtomic = async (p, content) => {
    if (p.endsWith("/ledger.json") || p.endsWith("ledger.json")) {
      ledgerWrites++;
      // Yield so a second concurrent caller can interleave its read before we commit.
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    await baseWrite(p, content);
  };

  await Promise.all([
    recordItemStageProgress(deps, {
      runId: "run-1",
      token,
      itemId: "607",
      projection: {
        current_stage: "implementing",
        current_stage_updated_at: "2026-07-27T19:31:00Z",
        advance_run_id: "607-2026-07-27T19-31-29-328Z",
      },
    }),
    recordItemStageProgress(deps, {
      runId: "run-1",
      token,
      itemId: "608",
      projection: {
        current_stage: "planning",
        current_stage_updated_at: "2026-07-27T19:31:01Z",
        advance_run_id: "608-2026-07-27T19-32-00-000Z",
      },
    }),
  ]);

  const after = await readLedger(deps, "run-1");
  assert.equal(after.items["607"].current_stage, "implementing", "item 607 projection must survive concurrent sibling write");
  assert.equal(after.items["607"].advance_run_id, "607-2026-07-27T19-31-29-328Z");
  assert.equal(after.items["608"].current_stage, "planning", "item 608 projection must survive concurrent sibling write");
  assert.equal(after.items["608"].advance_run_id, "608-2026-07-27T19-32-00-000Z");
  assert.equal(after.items["607"].state, "in_progress");
  assert.equal(after.items["608"].state, "in_progress");
  assert.ok(ledgerWrites >= 2, "both items must have performed a ledger write");

  const events = await readEvents(deps, "run-1");
  const progress = events.filter((e) => e.kind === LOOP_ITEM_STAGE_PROGRESS);
  assert.equal(progress.length, 2, "both stage-progress events must be on the trail");
  const stages = new Set(
    progress.map((e) => {
      const d = e.data as { item_id: string; stage: string };
      return `${d.item_id}:${d.stage}`;
    }),
  );
  assert.ok(stages.has("607:implementing"));
  assert.ok(stages.has("608:planning"));
});

test("applyAdvanceEventsToStageProgress: injected fake advance events update projection mid-advance", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress"),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");

  const advanceEvents = [
    { type: "stage_start", stage: "planning", at: "t1" },
    { type: "stage_start", stage: "implementing", at: "t2" },
    { type: "stage_start", stage: "implementing", at: "t3" }, // duplicate — non-material
  ];

  const result = await applyAdvanceEventsToStageProgress(deps, {
    runId: "run-1",
    token,
    itemId: "607",
    advance_run_id: "607-2026-07-27T19-31-29-328Z",
    events: advanceEvents,
  });

  assert.equal(result.updates, 2, "duplicate implementing must not count as a third update");
  const after = await readLedger(deps, "run-1");
  assert.equal(after.items["607"].state, "in_progress");
  assert.equal(after.items["607"].current_stage, "implementing");
  assert.equal(after.items["607"].advance_run_id, "607-2026-07-27T19-31-29-328Z");
});

test("older ledger without stage fields still loads; status treats projection as absent", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  // Ensure no stage fields on the raw entry
  delete (ledger.items["100"] as { current_stage?: string }).current_stage;
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const status = await getStatus(deps, "run-1");
  assert.equal(status.items["100"].state, "pending");
  assert.equal(status.items["100"].current_stage, undefined);
  assert.equal(projectionFromItem((await readLedger(deps, "run-1")).items["100"]), null);
});

// ---------------------------------------------------------------------------
// 5.3 Audit renderer: stage + advance run-id; queued omit fabricated ids
// ---------------------------------------------------------------------------

test("audit stage table includes stage + advance run-id; queued items omit fabricated live ids", async () => {
  const contract = testContract();
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress", {
      current_stage: "implementing",
      current_stage_updated_at: "t1",
      advance_run_id: "607-2026-07-27T19-31-29-328Z",
    }),
    "608": itemEntry("608", "pending"),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);

  const report = await auditSupervisor(deps, "run-1");
  assert.ok(report.stage_progress, "audit report must include stage_progress section");
  const row607 = report.stage_progress.find((r) => r.item_id === "607");
  const row608 = report.stage_progress.find((r) => r.item_id === "608");
  assert.ok(row607);
  assert.equal(row607!.stage_presentation, "implementing");
  assert.equal(row607!.advance_run_id, "607-2026-07-27T19-31-29-328Z");
  assert.ok(row608);
  assert.equal(row608!.stage_presentation, "pending");
  assert.equal(row608!.advance_run_id, undefined, "must not invent a live advance run-id for queued items");

  const line607 = formatAuditStageTableRow(row607!);
  assert.match(line607, /#607/);
  assert.match(line607, /implementing/);
  assert.match(line607, /607-2026-07-27T19-31-29-328Z/);
  assert.ok(!line607.includes("pipeline-loop-"), "must prefer real advance run id, not synthetic-only");

  const line608 = formatAuditStageTableRow(row608!);
  assert.match(line608, /#608/);
  assert.match(line608, /queued|pending/);
  assert.ok(!line608.includes("advance run"), "queued row must not fabricate advance run drill-down");
});

// ---------------------------------------------------------------------------
// 5.5 Regression: audit without stage table fails when only coarse in_progress
// ---------------------------------------------------------------------------

test("regression: audit with recorded stage requires stage name + advance run-id in stage_progress (bites omission)", async () => {
  const contract = testContract({ items: [{ id: "607", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress", {
      current_stage: "plan-review",
      current_stage_round: 1,
      current_stage_updated_at: "t1",
      advance_run_id: "607-2026-07-27T19-31-29-328Z",
    }),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const report = await auditSupervisor(deps, "run-1");

  // Coarse state alone is not enough — this is the regression that fails when
  // stage_progress is omitted from the audit surface.
  assert.equal(report.status.items["607"].state, "in_progress");
  assert.ok(
    report.stage_progress?.some(
      (r) =>
        r.item_id === "607" &&
        r.stage_presentation.includes("plan-review") &&
        r.advance_run_id === "607-2026-07-27T19-31-29-328Z",
    ),
    "audit stage_progress must surface stage + advance run-id; coarse in_progress alone is insufficient",
  );
});

// ---------------------------------------------------------------------------
// 5.4 Follow format helpers + read-only argv classification
// ---------------------------------------------------------------------------

test("formatStageProgressFollowLine: clean one-line stage event without harness prose", () => {
  const line = formatStageProgressFollowLine({
    item_id: "607",
    stage: "implementing",
    advance_run_id: "607-2026-07-27T19-31-29-328Z",
    at: "2026-07-27T19:31:00.000Z",
  });
  assert.match(line, /#607/);
  assert.match(line, /implementing/);
  assert.match(line, /607-2026-07-27T19-31-29-328Z/);
  assert.ok(!line.includes("Now the design"), "must not look like harness stream-of-consciousness");
});

test("parseStageProgressEventData: only LOOP_ITEM_STAGE_PROGRESS kind", () => {
  assert.equal(parseStageProgressEventData("other", { item_id: "1", stage: "x" }), null);
  const data = parseStageProgressEventData(LOOP_ITEM_STAGE_PROGRESS, {
    item_id: "607",
    stage: "implementing",
    advance_run_id: "607-x",
    at: "t",
  });
  assert.ok(data);
  assert.equal(data!.stage, "implementing");
});

test("normalizeLoopArgs: --audit --follow is accepted; --follow alone is refused", () => {
  const ok = normalizeLoopArgs({ resume: "run-1", audit: true, follow: true });
  assert.equal(ok.audit, true);
  assert.equal(ok.follow, true);
  assert.equal(ok.resumeRunId, "run-1");

  assert.throws(
    () => normalizeLoopArgs({ resume: "run-1", follow: true }),
    (err: unknown) => err instanceof LoopArgError && /--follow requires --audit/.test((err as Error).message),
  );
});

test("followLoopStageProgress once: emits stage lines from durable events only", async () => {
  const contract = testContract({ items: [{ id: "607", depends_on: [], external_depends_on: [] }] });
  // Start without projection so the first recordItemStageProgress is material and appends an event.
  const ledger = testLedger({
    "607": itemEntry("607", "in_progress"),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  await recordItemStageProgress(deps, {
    runId: "run-1",
    token,
    itemId: "607",
    projection: {
      current_stage: "implementing",
      current_stage_updated_at: "2026-07-27T19:31:00.000Z",
      advance_run_id: "607-2026-07-27T19-31-29-328Z",
    },
  });

  const out: string[] = [];
  await followLoopStageProgress("run-1", {
    store: deps,
    once: true,
    stdoutWrite: (s) => out.push(s),
    stderrWrite: () => {},
  });
  const joined = out.join("");
  assert.match(joined, /#607/);
  assert.match(joined, /implementing/);
  assert.match(joined, /607-2026-07-27T19-31-29-328Z/);
  assert.ok(!joined.includes("Now the"), "must not dump harness prose");
});

// ---------------------------------------------------------------------------
// Supervisor observation with injected advance-event reader
// ---------------------------------------------------------------------------

test("supervisor mid-advance observation updates ledger from injected advance events (#611)", async () => {
  const contract = testContract({
    items: [{ id: "607", depends_on: [], external_depends_on: [] }],
  });
  const ledger = testLedger({ "607": itemEntry("607", "pending") });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);

  const realRunId = "607-2026-07-27T19-31-29-328Z";
  const eventsPath = `/repo/.agent-pipeline/runs/${realRunId}/events.jsonl`;
  let advanceEvents: Array<{ type: string; stage?: string; round?: number; at?: string }> = [
    { type: "stage_start", stage: "planning", at: "t1" },
  ];

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: dispatched.has(String(issueNumber))
          ? ["pipeline:ready-to-deploy"]
          : ["pipeline:ready"],
      };
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
    now: () => new Date("2026-07-27T19:00:00.000Z"),
  };

  const dispatchItem = async (
    request: { item_id: string; run_id: string },
    hooks?: { onAdvanceLinked?(l: { item_id: string; pipeline_run_id: string; events: string }): void | Promise<void> },
  ): Promise<LoopExecutionResponse> => {
    await hooks?.onAdvanceLinked?.({
      item_id: request.item_id,
      pipeline_run_id: realRunId,
      events: eventsPath,
    });
    // Mid-wait: more advance events appear (observer should pick these up).
    advanceEvents = [
      { type: "stage_start", stage: "planning", at: "t1" },
      { type: "stage_start", stage: "implementing", at: "t2" },
    ];
    // Give the observer a tick to poll (sleep is immediate in this test).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: {
        pr_number: 1,
        pipeline_run_id: realRunId,
        events_path: eventsPath,
      },
    };
  };

  const { token } = await acquireLock(deps, "run-1", "claude");
  await runSupervisorCycle(
    {
      store: deps,
      observe,
      dispatchItem,
      readAdvanceEvents: async () => advanceEvents,
      stageProgressPollMs: 1,
      // Must yield to the event loop so dispatch's setImmediate ticks run (empty sleep busy-spins).
      sleep: () => new Promise((r) => setImmediate(r)),
    },
    "run-1",
    token,
    "claude",
  );

  const after = await readLedger(deps, "run-1");
  // Terminal reconcile may set ready-to-deploy; at least one material stage was recorded.
  const events = await readEvents(deps, "run-1");
  assert.ok(events.some((e) => e.kind === LOOP_ITEM_ADVANCE_LINKED));
  const stageEvents = events.filter((e) => e.kind === LOOP_ITEM_STAGE_PROGRESS);
  assert.ok(stageEvents.length >= 1, "structured stage-progress events must appear on the loop trail");
  const stages = stageEvents.map((e) => (e.data as { stage: string }).stage);
  assert.ok(
    stages.includes("implementing") || stages.includes("planning") || stages.includes("ready-to-deploy"),
    `expected mid-advance or terminal stage in ${JSON.stringify(stages)}`,
  );
  // Prefer real advance run id on stage events
  for (const e of stageEvents) {
    const id = (e.data as { advance_run_id?: string }).advance_run_id;
    if (id) {
      assert.equal(id, realRunId);
      assert.ok(!id.startsWith("pipeline-loop-"));
    }
  }
  // Coarse terminal state still from existing mapping
  assert.equal(after.items["607"].state, "ready");
});

test("buildStageProgressTable: pending without projection shows queued presentation", () => {
  const ledger = testLedger({
    "608": itemEntry("608", "pending"),
    "610": itemEntry("610", "pending"),
  });
  const table = buildStageProgressTable(ledger);
  assert.equal(table.length, 2);
  for (const row of table) {
    assert.equal(row.has_projection, false);
    assert.equal(row.advance_run_id, undefined);
    assert.equal(row.stage_presentation, "pending");
  }
});

test("parseAdvanceEventsJsonl: skips corrupt lines", () => {
  const events = parseAdvanceEventsJsonl(
    '{"type":"stage_start","stage":"planning"}\nnot-json\n{"type":"stage_start","stage":"implementing"}\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[1].stage, "implementing");
});

test("reconcileTerminalStageProgress: ready_to_deploy presentation without inventing advance id", async () => {
  const contract = testContract({ items: [{ id: "1", depends_on: [], external_depends_on: [] }] });
  const ledger = testLedger({
    "1": itemEntry("1", "in_progress", {
      current_stage: "pre-merge",
      current_stage_updated_at: "t0",
    }),
  });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);
  const { token } = await acquireLock(deps, "run-1", "claude");
  await reconcileTerminalStageProgress(deps, {
    runId: "run-1",
    token,
    itemId: "1",
    outcome: "ready_to_deploy",
  });
  const after = await readLedger(deps, "run-1");
  assert.equal(after.items["1"].current_stage, "ready-to-deploy");
  assert.equal(after.items["1"].advance_run_id, undefined);
});
