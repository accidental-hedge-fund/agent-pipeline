// Unit tests for pre-merge gate sub-event progress mirror (#682).
// Pure mapping + spam control + supervisor join-key integration — no network,
// git, or subprocess.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  armProgressMirror,
  classifyCiBlockerReason,
  createProgressMirrorState,
  LOOP_ITEM_PROGRESS,
  mapAdvanceEventsToProgress,
  mapNewAdvanceLinesToProgress,
  type LoopItemProgressPayload,
  type ProgressLinkage,
} from "../scripts/loop/pre-merge-progress.ts";
import {
  LOOP_ITEM_ADVANCE_FINISHED,
  LOOP_ITEM_ADVANCE_LINKED,
  runSupervisorCycle,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import {
  acquireLock,
  initRun,
  readEvents,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import type { ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA } from "../scripts/loop-execution-contract.ts";

const LINKAGE: ProgressLinkage = {
  item_id: "554",
  pipeline_run_id: "554-2026-07-29T17-23-40-332Z",
  events: "/repo/.agent-pipeline/runs/554-2026-07-29T17-23-40-332Z/events.jsonl",
};

const READY_LABEL = "pipeline:ready-to-deploy";
const PIPELINE_READY_LABEL = "pipeline:ready";

let counter = 0;

function fakeDeps(): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-progress-${counter++}` };

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

function gate(
  gateName: string,
  result: string,
  reason?: string,
): Record<string, unknown> {
  return {
    schema_version: 1,
    type: "gate_result",
    at: "2026-07-29T17:00:00Z",
    gate: gateName,
    result,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function steps(payloads: LoopItemProgressPayload[]): string[] {
  return payloads.map((p) => `${p.step}/${p.status}`);
}

// ---------------------------------------------------------------------------
// Pure mapping catalog
// ---------------------------------------------------------------------------

test("map: CI waiting / pass / fail with classification", () => {
  const waiting = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "partial", "CI still running")]);
  assert.deepEqual(steps(waiting.payloads), ["ci/waiting"]);
  assert.equal(waiting.payloads[0].item_id, "554");
  assert.equal(waiting.payloads[0].pipeline_run_id, LINKAGE.pipeline_run_id);
  assert.equal(waiting.payloads[0].events, LINKAGE.events);
  assert.equal(waiting.payloads[0].domain, "pre_merge");

  const pass = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "pass")], waiting.state);
  assert.deepEqual(steps(pass.payloads), ["ci/pass"]);

  const fail = mapAdvanceEventsToProgress(
    LINKAGE,
    [gate("ci", "fail", "CI failed")],
    createProgressMirrorState(),
  );
  assert.deepEqual(steps(fail.payloads), ["ci/fail"]);
  assert.equal(fail.payloads[0].detail?.classification, "ci_failed");
});

test("map: OpenSpec archive pass / skipped / fail", () => {
  const seq = [
    gate("openspec-archive", "pass", "change-id"),
    gate("openspec-archive", "skipped", "no-candidates"),
    gate("openspec-archive", "fail", "archive commit failed"),
  ];
  const { payloads } = mapAdvanceEventsToProgress(LINKAGE, seq);
  assert.deepEqual(steps(payloads), [
    "openspec_archive/pass",
    "openspec_archive/skipped",
    "openspec_archive/fail",
  ]);
});

test("map: delta started / approve / needs_attention with blocking_count", () => {
  const started = mapAdvanceEventsToProgress(LINKAGE, [
    { type: "delta_round", at: "t", round: 1, cap: 3 },
  ]);
  assert.deepEqual(steps(started.payloads), ["delta_review/started"]);

  const approve = mapAdvanceEventsToProgress(LINKAGE, [gate("delta-review", "pass")], started.state);
  assert.deepEqual(steps(approve.payloads), ["delta_review/approve"]);

  const needs = mapAdvanceEventsToProgress(LINKAGE, [
    gate("delta-review", "fail", "blocking_count=2"),
  ]);
  assert.deepEqual(steps(needs.payloads), ["delta_review/needs_attention"]);
  assert.equal(needs.payloads[0].detail?.blocking_count, 2);
});

test("map: autofix attempted / success / exhausted", () => {
  const attempted = mapAdvanceEventsToProgress(LINKAGE, [gate("pre-merge-autofix", "partial")]);
  assert.deepEqual(steps(attempted.payloads), ["autofix/attempted"]);

  const success = mapAdvanceEventsToProgress(LINKAGE, [gate("pre-merge-autofix", "pass")], attempted.state);
  assert.deepEqual(steps(success.payloads), ["autofix/success"]);

  const exhausted = mapAdvanceEventsToProgress(LINKAGE, [gate("pre-merge-autofix", "fail")]);
  assert.deepEqual(steps(exhausted.payloads), ["autofix/exhausted"]);
});

test("map: terminal blocked / advanced from stage_complete", () => {
  const blocked = mapAdvanceEventsToProgress(LINKAGE, [
    { type: "stage_complete", stage: "pre-merge", outcome: "blocked" },
  ]);
  assert.deepEqual(steps(blocked.payloads), ["terminal/blocked"]);
  assert.equal(blocked.payloads[0].detail?.reason_class, "blocked");

  const advanced = mapAdvanceEventsToProgress(LINKAGE, [
    { type: "stage_complete", stage: "pre-merge", outcome: "advanced" },
  ]);
  assert.deepEqual(steps(advanced.payloads), ["terminal/advanced"]);
});

test("map: blocker_set CI-shaped reason emits ci/fail as fallback", () => {
  const { payloads } = mapAdvanceEventsToProgress(LINKAGE, [
    { type: "blocker_set", reason: "CI failed" },
  ]);
  assert.deepEqual(steps(payloads), ["ci/fail"]);
  assert.equal(payloads[0].detail?.classification, "ci_failed");
  assert.equal(payloads[0].detail?.source_advance_type, "blocker_set");
});

// ---------------------------------------------------------------------------
// Spam control + idempotency
// ---------------------------------------------------------------------------

test("regression: three identical CI waiting polls → exactly one waiting progress", () => {
  let state = createProgressMirrorState();
  const all: LoopItemProgressPayload[] = [];
  for (let i = 0; i < 3; i++) {
    const r = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "partial", "CI still running")], state);
    all.push(...r.payloads);
    state = r.state;
  }
  assert.equal(all.filter((p) => p.step === "ci" && p.status === "waiting").length, 1);
});

test("regression: waiting then fail still emits fail", () => {
  let state = createProgressMirrorState();
  const w = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "partial")], state);
  state = w.state;
  const f = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "fail", "CI failed")], state);
  assert.deepEqual(steps([...w.payloads, ...f.payloads]), ["ci/waiting", "ci/fail"]);
});

test("regression: re-read same openspec gate_result does not duplicate", () => {
  let state = createProgressMirrorState();
  const first = mapAdvanceEventsToProgress(LINKAGE, [gate("openspec-archive", "pass", "id")], state);
  state = first.state;
  const second = mapAdvanceEventsToProgress(LINKAGE, [gate("openspec-archive", "pass", "id")], state);
  assert.equal(first.payloads.length, 1);
  assert.equal(second.payloads.length, 0);
});

test("regression: CI pass → rebase waiting → pass emits a second pass (#682 ca081002)", () => {
  // A successful rebase starts a new CI waiting stretch; the next definitive
  // pass must not be suppressed by the permanent fingerprint of the first pass.
  let state = createProgressMirrorState();
  const all: LoopItemProgressPayload[] = [];
  const seq = [
    gate("ci", "partial", "CI still running"),
    gate("ci", "pass"),
    gate("ci", "partial", "rebased; CI re-running"),
    gate("ci", "partial", "CI still running"), // spam within stretch
    gate("ci", "pass"),
  ];
  for (const ev of seq) {
    const r = mapAdvanceEventsToProgress(LINKAGE, [ev], state);
    all.push(...r.payloads);
    state = r.state;
  }
  assert.deepEqual(steps(all), [
    "ci/waiting",
    "ci/pass",
    "ci/waiting",
    "ci/pass",
  ]);
  // Re-read of the final pass remains idempotent.
  const reread = mapAdvanceEventsToProgress(LINKAGE, [gate("ci", "pass")], state);
  assert.equal(reread.payloads.length, 0);
});

test("regression: autofix success + delta-review pass maps approve after needs_attention (#682 9b5d8c51)", () => {
  // Advance-side sequence after a successful auto-fix re-review: initial
  // delta fail, autofix attempt/pass, then the approving delta-review gate_result.
  const { payloads } = mapAdvanceEventsToProgress(LINKAGE, [
    gate("delta-review", "fail", "blocking_count=1"),
    gate("pre-merge-autofix", "partial", "attempted"),
    gate("pre-merge-autofix", "pass"),
    gate("delta-review", "pass"),
  ]);
  assert.deepEqual(steps(payloads), [
    "delta_review/needs_attention",
    "autofix/attempted",
    "autofix/success",
    "delta_review/approve",
  ]);
});

test("regression: re-read identical waiting via mapNewAdvanceLinesToProgress is once", () => {
  const line = JSON.stringify(gate("ci", "partial", "CI still running"));
  // Three poll observations of the same file growing with duplicate lines.
  const body1 = `${line}\n`;
  const body2 = `${line}\n${line}\n`;
  const body3 = `${line}\n${line}\n${line}\n`;
  let state = createProgressMirrorState();
  const a = mapNewAdvanceLinesToProgress(LINKAGE, body1, state);
  state = a.state;
  const b = mapNewAdvanceLinesToProgress(LINKAGE, body2, state);
  state = b.state;
  const c = mapNewAdvanceLinesToProgress(LINKAGE, body3, state);
  const waiting = [...a.payloads, ...b.payloads, ...c.payloads].filter(
    (p) => p.step === "ci" && p.status === "waiting",
  );
  assert.equal(waiting.length, 1);
});

test("regression: partial JSONL tail is not permanently skipped (#682 ac434766)", () => {
  const fullEvent = gate("openspec-archive", "pass", "change-id");
  const fullLine = JSON.stringify(fullEvent);
  // Mid-append: truncated JSON without a terminating newline.
  const partial = fullLine.slice(0, Math.floor(fullLine.length / 2));
  let state = createProgressMirrorState();
  const a = mapNewAdvanceLinesToProgress(LINKAGE, partial, state);
  state = a.state;
  assert.equal(a.payloads.length, 0);
  assert.equal(
    state.linesConsumed,
    0,
    "unterminated partial tail must not advance the consume cursor",
  );

  // Writer finishes the record; next poll must mirror the gate outcome.
  const b = mapNewAdvanceLinesToProgress(LINKAGE, `${fullLine}\n`, state);
  assert.deepEqual(steps(b.payloads), ["openspec_archive/pass"]);
  assert.equal(b.state.linesConsumed, 1);
});

test("regression: partial gate_result after complete lines is deferred then mirrored", () => {
  const waitingLine = JSON.stringify(gate("ci", "partial", "CI still running"));
  const failFull = JSON.stringify(gate("ci", "fail", "CI failed"));
  const failPartial = failFull.slice(0, 24);
  let state = createProgressMirrorState();
  const a = mapNewAdvanceLinesToProgress(LINKAGE, `${waitingLine}\n${failPartial}`, state);
  state = a.state;
  assert.deepEqual(steps(a.payloads), ["ci/waiting"]);
  assert.equal(state.linesConsumed, 1, "only the complete waiting line is consumed");

  const b = mapNewAdvanceLinesToProgress(LINKAGE, `${waitingLine}\n${failFull}\n`, state);
  assert.deepEqual(steps(b.payloads), ["ci/fail"]);
  assert.equal(b.payloads[0].detail?.classification, "ci_failed");
  assert.equal(b.state.linesConsumed, 2);
});

test("classifyCiBlockerReason maps stable tokens", () => {
  assert.equal(classifyCiBlockerReason("CI failed"), "ci_failed");
  assert.equal(classifyCiBlockerReason("ci_mode: local — inline test gate failed"), "ci_mode_local");
});

// ---------------------------------------------------------------------------
// Injected multi-gate sequence (acceptance scenario)
// ---------------------------------------------------------------------------

test("injected gate outcomes drive progress events with join keys", () => {
  const seq = [
    gate("openspec-archive", "pass", "change"),
    gate("ci", "partial", "CI still running"),
    gate("ci", "partial", "CI still running"),
    gate("ci", "fail", "CI failed"),
    { type: "stage_complete", stage: "pre-merge", outcome: "blocked" },
  ];
  const { payloads } = mapAdvanceEventsToProgress(LINKAGE, seq);
  assert.deepEqual(steps(payloads), [
    "openspec_archive/pass",
    "ci/waiting",
    "ci/fail",
    "terminal/blocked",
  ]);
  for (const p of payloads) {
    assert.equal(p.item_id, "554");
    assert.equal(p.pipeline_run_id, "554-2026-07-29T17-23-40-332Z");
    assert.equal(p.events, LINKAGE.events);
    assert.equal(p.domain, "pre_merge");
  }
});

// ---------------------------------------------------------------------------
// armProgressMirror + supervisor join keys
// ---------------------------------------------------------------------------

test("armProgressMirror drains new advance lines and stops cleanly", async () => {
  let file = "";
  const appended: LoopItemProgressPayload[] = [];
  const mirror = armProgressMirror(LINKAGE, {
    readAdvanceEventsFile: async () => file,
    appendProgress: async (p) => {
      appended.push(p);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs: 5,
  });
  file = `${JSON.stringify(gate("ci", "partial"))}\n`;
  await new Promise((r) => setTimeout(r, 30));
  file += `${JSON.stringify(gate("ci", "fail", "CI failed"))}\n`;
  await new Promise((r) => setTimeout(r, 30));
  await mirror.stop();
  assert.ok(appended.some((p) => p.step === "ci" && p.status === "waiting"));
  assert.ok(appended.some((p) => p.step === "ci" && p.status === "fail"));
});

// ---------------------------------------------------------------------------
// Supervisor integration-style: join keys match linkage
// ---------------------------------------------------------------------------

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
    items: [{ id: "554", depends_on: [] }],
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

test("supervisor: progress events join on the same item_id + pipeline_run_id as linkage (#682)", async () => {
  const contract = testContract({ items: [{ id: "554", depends_on: [] }] });
  const ledger = testLedger({ "554": itemEntry("554", "pending") });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);

  const realRunId = "554-2026-07-29T17-23-40-332Z";
  const eventsPath = `/repo/.agent-pipeline/runs/${realRunId}/events.jsonl`;
  // Trailing newline required: mirror only consumes newline-terminated records
  // (production appendEvent writes `${JSON.stringify(event)}\n`).
  const advanceBody =
    [
      gate("openspec-archive", "pass", "loop-positional"),
      gate("ci", "fail", "CI failed"),
      { type: "stage_complete", stage: "pre-merge", outcome: "blocked" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n";

  // Coordinated observe: ready labels only after dispatch (same pattern as loop-supervisor tests).
  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: dispatched.has(String(issueNumber)) ? [READY_LABEL] : [PIPELINE_READY_LABEL],
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
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    await hooks?.onAdvanceLinked?.({
      item_id: request.item_id,
      pipeline_run_id: realRunId,
      events: eventsPath,
    });
    // Allow the mirror to drain the injected advance body before exit.
    await new Promise((r) => setTimeout(r, 40));
    dispatched.add(request.item_id);
    return {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: request.item_id,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: {
        pr_number: 12,
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
      readAdvanceEventsFile: async () => advanceBody,
      progressMirrorPollMs: 5,
      progressMirrorSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    "run-1",
    token,
    "claude",
  );

  const events = await readEvents(deps, "run-1");
  const start = events.find((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_LINKED) as
    | { data: { item_id: string; pipeline_run_id: string; events: string } }
    | undefined;
  assert.ok(start);
  assert.equal(start!.data.pipeline_run_id, realRunId);

  const progress = events.filter((e: { kind: string }) => e.kind === LOOP_ITEM_PROGRESS) as Array<{
    data: LoopItemProgressPayload;
  }>;
  assert.ok(progress.length >= 2, `expected progress events, got ${progress.length}: ${JSON.stringify(progress.map((p) => p.data))}`);
  for (const ev of progress) {
    assert.equal(ev.data.item_id, "554");
    assert.equal(ev.data.pipeline_run_id, realRunId);
    assert.equal(ev.data.events, eventsPath);
    assert.equal(ev.data.domain, "pre_merge");
  }
  const kinds = progress.map((e) => `${e.data.step}/${e.data.status}`);
  assert.ok(kinds.includes("openspec_archive/pass"), `kinds=${kinds.join(",")}`);
  assert.ok(kinds.includes("ci/fail"), `kinds=${kinds.join(",")}`);
  assert.ok(kinds.includes("terminal/blocked"), `kinds=${kinds.join(",")}`);

  const finished = events.find((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_FINISHED);
  assert.ok(finished);
});

test("supervisor: mirror append failure does not fail advance child", async () => {
  const contract = testContract({ items: [{ id: "100", depends_on: [] }] });
  const ledger = testLedger({ "100": itemEntry("100", "pending") });
  const { deps } = fakeDeps();
  await initRun(deps, contract, ledger);

  const realRunId = "100-2026-07-29T00-00-00-000Z";
  const eventsPath = `/repo/.agent-pipeline/runs/${realRunId}/events.jsonl`;

  const dispatched = new Set<string>();
  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      return {
        state: "open",
        labels: dispatched.has(String(issueNumber)) ? [READY_LABEL] : [PIPELINE_READY_LABEL],
      };
    },
    async findPrForIssue(issueNumber) {
      return dispatched.has(String(issueNumber)) ? 1 : null;
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

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request, hooks) => {
    await hooks?.onAdvanceLinked?.({
      item_id: request.item_id,
      pipeline_run_id: realRunId,
      events: eventsPath,
    });
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
      armProgressMirror: (_linkage, mirrorDeps) => ({
        stop: async () => {
          // Simulate a throwing progress append during drain; armProgressMirror
          // and the supervisor both treat this as non-fatal.
          try {
            await mirrorDeps.appendProgress({
              item_id: "100",
              pipeline_run_id: realRunId,
              domain: "pre_merge",
              step: "ci",
              status: "pass",
            });
            throw new Error("simulated loop store write failure after append");
          } catch {
            // non-fatal
          }
        },
      }),
    },
    "run-1",
    token,
    "claude",
  );
  const events = await readEvents(deps, "run-1");
  assert.ok(events.some((e: { kind: string }) => e.kind === LOOP_ITEM_ADVANCE_FINISHED));
});
