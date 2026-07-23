// Tests for durable paused/waiting states & audited authority amendments
// (#510, capability `durable-pause-and-authority`). Every test runs through
// an in-memory LoopStoreDeps fake (mirrors loop-store.test.ts /
// loop-recovery.test.ts) — no real filesystem, process, network, or
// subprocess access.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pauseItem,
  waitItem,
  abandonHold,
  resumeHold,
  recordAuthorityAmendment,
  authorizeGatedTransition,
  handoffRun,
  upgradeLedgerForPauseAuthority,
} from "../scripts/loop/pause.ts";
import { blockItem } from "../scripts/loop/recovery.ts";
import { initRun, readLedger, readEvents, readDecisions, acquireLock, getStatus, type LoopStoreDeps } from "../scripts/loop/store.ts";
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA, LoopError, type LoopContract, type LoopLedger } from "../scripts/loop/types.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";

// ---------------------------------------------------------------------------
// In-memory fake filesystem (mirrors loop-recovery.test.ts's fakeDeps).
// ---------------------------------------------------------------------------

let fakeDepsCounter = 0;

function fakeDeps(overrides: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const isolatedEnv = { AGENT_PIPELINE_STATE_HOME: `/state-pause-${fakeDepsCounter++}` };

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
    async isPidAlive() {
      return true;
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
    authority_grants: [],
    recovery_budgets: { default: 3 },
    recovery_policy: DEFAULT_RECOVERY_POLICY,
    consecutive_blocked_limit: 3,
    verification: null,
    report_format: "markdown",
    ordering: "dependency_sequential",
    max_active_items: 1,
    concurrency_model: "exclusive_lock_single_engine",
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
    canonical_hash: "deadbeef",
    ...overrides,
  };
}

function testLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {
      "100": { id: "100", state: "in_progress", history: [], recovery_budgets_remaining: { default: 3 } },
      "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
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

async function setup(contractOverrides: Partial<LoopContract> = {}) {
  const { deps, files } = fakeDeps();
  const contract = testContract(contractOverrides);
  await initRun(deps, contract, testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  return { deps, files, contract, token };
}

const NATIVE_GOAL_OK = { engine: "claude" as const, run_id: "run-1", status: "active", checked_at: "2026-07-23T00:00:00.000Z" };
const PREFLIGHT_OK = { passed: true, checked_at: "2026-07-23T00:00:00.000Z" };

function assertClass(err: unknown, cls: string) {
  assert.ok(err instanceof LoopError);
  assert.equal(err.loopFailureClass, cls);
  return true;
}

// ---------------------------------------------------------------------------
// Entering a hold — admission and non-charging.
// ---------------------------------------------------------------------------

test("pauseItem: an in_progress item enters paused, no budget charged, no block counted", async () => {
  const { deps, token } = await setup();
  const before = (await readLedger(deps, "run-1")).items["100"].recovery_budgets_remaining;
  const ledger = await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  assert.equal(ledger.items["100"].state, "paused");
  assert.deepEqual(ledger.items["100"].recovery_budgets_remaining, before, "no budget charged entering a hold");
  assert.equal(ledger.consecutive_blocked, 0, "no block counted entering a hold");
  assert.equal(ledger.items["100"].blocked_theme, undefined, "no DurableBlockerClass theme carried");
});

test("waitItem: an in_progress item enters waiting carrying the request, no budget charged, no block counted", async () => {
  const { deps, token } = await setup();
  const ledger = await waitItem(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    request: { kind: "decision", prompt: "which base branch?", permitted_responses: ["main", "staging"] },
  });
  assert.equal(ledger.items["100"].state, "waiting");
  assert.equal(ledger.consecutive_blocked, 0);
  assert.equal(ledger.items["100"].blocked_theme, undefined);
  const req = ledger.items["100"].hold_request;
  assert.ok(req);
  assert.equal(req!.item_id, "100");
  assert.equal(req!.kind, "decision");
  assert.equal(req!.prompt, "which base branch?");
  assert.deepEqual(req!.permitted_responses, ["main", "staging"]);
  assert.equal(req!.requested_by_engine, "claude");
  assert.ok(req!.request_id.length > 0);
});

test("pauseItem: an engine that does not match the current lock holder is refused, leaving state unchanged", async () => {
  const { deps, token } = await setup(); // lock is held by "claude"
  await assert.rejects(
    () => pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "codex" }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress", "no spoofed-engine hold was recorded");
});

test("pauseItem/waitItem: only an in_progress item may enter a hold — refused naming both states, leaving state unchanged", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => pauseItem(deps, { runId: "run-1", token, itemId: "200", engine: "claude" }), // "200" is pending
    (err: unknown) => {
      assertClass(err, "validation");
      assert.match((err as Error).message, /"pending"/);
      assert.match((err as Error).message, /"paused"/);
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["200"].state, "pending");
});

test("waitItem: a missing request is refused as a validation failure, leaving state unchanged", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: undefined as never }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("waitItem: an unknown request kind is refused naming the offending kind", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "vibes", prompt: "x" } }),
    (err: unknown) => {
      assertClass(err, "validation");
      assert.match((err as Error).message, /"vibes"/);
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("waitItem: an empty permitted_responses is refused as a validation failure", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "x", permitted_responses: [] } }),
    (err: unknown) => assertClass(err, "validation"),
  );
});

test("a paused/waiting hold survives restart — a fresh read sees the same hold and request", async () => {
  const { deps, token } = await setup();
  await waitItem(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    request: { kind: "answer", prompt: "which env?" },
  });
  const resumed = await readLedger(deps, "run-1");
  assert.equal(resumed.items["100"].state, "waiting");
  assert.equal(resumed.items["100"].hold_request?.prompt, "which env?");
});

test("blockItem refuses to block a paused/waiting item — a hold is not a failure state", async () => {
  const { deps, contract, token } = await setup();
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  await assert.rejects(
    () => blockItem(deps, contract, { runId: "run-1", token, itemId: "100", engine: "claude", blockerClass: "implementation-ci", evidence: "x" }),
    (err: unknown) => assertClass(err, "validation"),
  );
});

// ---------------------------------------------------------------------------
// Abandon.
// ---------------------------------------------------------------------------

test("abandonHold: a paused item may be abandoned", async () => {
  const { deps, token } = await setup();
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  const ledger = await abandonHold(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  assert.equal(ledger.items["100"].state, "abandoned");
});

test("abandonHold: an illegal transition out of a hold is refused naming both states, leaving state unchanged", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => abandonHold(deps, { runId: "run-1", token, itemId: "100", engine: "claude" }), // "100" is in_progress, not a hold
    (err: unknown) => {
      assertClass(err, "validation");
      assert.match((err as Error).message, /"in_progress"/);
      assert.match((err as Error).message, /"abandoned"/);
      return true;
    },
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("abandonHold: an engine that does not match the current lock holder is refused, leaving the hold intact", async () => {
  const { deps, token } = await setup(); // lock is held by "claude"
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  await assert.rejects(
    () => abandonHold(deps, { runId: "run-1", token, itemId: "100", engine: "codex" }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "paused", "no spoofed-engine abandon was recorded");
});

// ---------------------------------------------------------------------------
// Audited, fail-closed resume.
// ---------------------------------------------------------------------------

test("resumeHold: an engine that does not match the current lock holder is refused, leaving the hold intact", async () => {
  const { deps, token } = await setup(); // lock is held by "claude"
  await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token, // still claude's token — a spoofed "codex" claim on it must be refused
        itemId: "100",
        engine: "codex",
        actor: "human:bob",
        response: { value: "go" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: { engine: "codex", run_id: "run-1", status: "active", checked_at: "2026-07-23T00:00:00.000Z" },
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting", "no spoofed-engine resume was recorded");
});

test("resumeHold: a satisfying, evidenced resume advances waiting -> in_progress and clears the request", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    request: { kind: "decision", prompt: "go ahead?", permitted_responses: ["yes", "no"] },
  });
  const requestId = waiting.items["100"].hold_request!.request_id;

  const ledger = await resumeHold(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    actor: "human:alice",
    response: { request_id: requestId, value: "yes" },
    pipeline_preflight: PREFLIGHT_OK,
    native_goal: NATIVE_GOAL_OK,
  });
  assert.equal(ledger.items["100"].state, "in_progress");
  assert.equal(ledger.items["100"].hold_request, undefined, "outstanding request cleared on success");

  const decisions = await readDecisions(deps, "run-1");
  const resumeDecision = decisions.find((d) => d.kind === "loop_hold_resumed");
  assert.ok(resumeDecision);
  assert.equal((resumeDecision!.data as Record<string, unknown>).actor, "human:alice");
});

test("resumeHold: no active hold is refused, leaving state unchanged", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100", // in_progress, not a hold
        engine: "claude",
        actor: "human:alice",
        response: { value: "yes" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
});

test("resumeHold: a response naming a different request is refused, item remains in its hold, no decision appended", async () => {
  const { deps, token } = await setup();
  await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: "req-does-not-exist", value: "anything" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0);
});

test("resumeHold: a response outside the permitted set is refused, item remains in its hold, no decision appended", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    request: { kind: "decision", prompt: "go ahead?", permitted_responses: ["yes", "no"] },
  });
  const requestId = waiting.items["100"].hold_request!.request_id;
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId, value: "maybe" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
  assert.ok(ledger.items["100"].hold_request, "request intact");
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0);
});

test("resumeHold: a satisfying response with no pipeline-preflight evidence is refused with a pipeline-mandate failure, item remains in its hold", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  const requestId = waiting.items["100"].hold_request!.request_id;
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId, value: "main" },
        pipeline_preflight: null,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "pipeline_mandate"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
});

test("resumeHold: a satisfying response with no native-goal evidence is refused with a native-goal-mandate failure, item remains in its hold", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  const requestId = waiting.items["100"].hold_request!.request_id;
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId, value: "main" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: null,
      }),
    (err: unknown) => assertClass(err, "native_goal_mandate"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
});

test("resumeHold: stale native-goal evidence outside the freshness window is refused", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  const requestId = waiting.items["100"].hold_request!.request_id;
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId, value: "main" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: { ...NATIVE_GOAL_OK, checked_at: "2026-07-22T23:00:00.000Z" }, // 1h stale
      }),
    (err: unknown) => assertClass(err, "native_goal_mandate"),
  );
});

test("resumeHold: a bare paused hold (no request) resumes with just a response and mandate evidence", async () => {
  const { deps, token } = await setup();
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  const ledger = await resumeHold(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    actor: "human:alice",
    response: { value: "resuming" },
    pipeline_preflight: PREFLIGHT_OK,
    native_goal: NATIVE_GOAL_OK,
  });
  assert.equal(ledger.items["100"].state, "in_progress");
});

test("resumeHold: a waiting request with no permitted_responses cannot be resumed with a missing response value", async () => {
  const { deps, token } = await setup();
  const waiting = await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  const requestId = waiting.items["100"].hold_request!.request_id;
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId } as never,
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting", "resume was refused, item stays in its hold");
  assert.ok(ledger.items["100"].hold_request, "outstanding request intact");
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0, "no resume decision appended for a rejected resume");
});

test("resumeHold: a non-object response is refused, leaving state unchanged", async () => {
  const { deps, token } = await setup();
  await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "answer", prompt: "which?" } });
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: null as never,
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting");
});

test("resumeHold: a decision-log append failure leaves the ledger un-resumed and the hold intact", async () => {
  const { deps, files } = fakeDeps({
    async appendLine(p, line) {
      if (p.endsWith("decisions.jsonl")) throw new Error("simulated decision-log append failure");
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
  });
  const contract = testContract();
  await initRun(deps, contract, testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  const waiting = await waitItem(deps, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    request: { kind: "decision", prompt: "go ahead?", permitted_responses: ["yes", "no"] },
  });
  const requestId = waiting.items["100"].hold_request!.request_id;

  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token,
        itemId: "100",
        engine: "claude",
        actor: "human:alice",
        response: { request_id: requestId, value: "yes" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: NATIVE_GOAL_OK,
      }),
    /simulated decision-log append failure/,
  );

  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.items["100"].state, "waiting", "no unaudited resume was left durably committed");
  assert.ok(ledger.items["100"].hold_request, "outstanding request intact — resume never took effect");
});

// ---------------------------------------------------------------------------
// Scoped, audited authority amendments.
// ---------------------------------------------------------------------------

test("recordAuthorityAmendment: a well-formed amendment is persisted and appended as an audited decision", async () => {
  const { deps, token } = await setup();
  const { ledger, amendment } = await recordAuthorityAmendment(deps, {
    runId: "run-1",
    token,
    gate: "merge",
    scope_item_id: "100",
    actor: "human:alice",
    reason: "urgent hotfix",
  });
  assert.equal(amendment.gate, "merge");
  assert.equal(amendment.scope_item_id, "100");
  assert.deepEqual(ledger.authority_amendments, [amendment]);

  const decisions = await readDecisions(deps, "run-1");
  assert.ok(decisions.some((d) => d.kind === "loop_authority_amendment"));
});

test("recordAuthorityAmendment: a malformed amendment (no gate, unknown gate, or a list) is refused — nothing recorded", async () => {
  const { deps, token } = await setup();
  for (const gate of [undefined, "", "totally-made-up", ["merge", "deploy"]]) {
    await assert.rejects(
      () => recordAuthorityAmendment(deps, { runId: "run-1", token, gate, actor: "human:alice", reason: "x" }),
      (err: unknown) => assertClass(err, "validation"),
    );
  }
  const ledger = await readLedger(deps, "run-1");
  assert.equal((ledger.authority_amendments ?? []).length, 0);
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0);
});

test("recordAuthorityAmendment: a decision-log append failure leaves the ledger without an active amendment", async () => {
  const { deps, files } = fakeDeps({
    async appendLine(p, line) {
      if (p.endsWith("decisions.jsonl")) throw new Error("simulated decision-log append failure");
      const existing = files.get(p) ?? "";
      files.set(p, existing + line + "\n");
    },
  });
  const contract = testContract();
  await initRun(deps, contract, testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");

  await assert.rejects(
    () => recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "merge", scope_item_id: "100", actor: "human:alice", reason: "x" }),
    /simulated decision-log append failure/,
  );

  const ledger = await readLedger(deps, "run-1");
  assert.equal((ledger.authority_amendments ?? []).length, 0, "no unaudited amendment was left active");
});

test("authorizeGatedTransition: a scoped amendment authorizes exactly its gate and item", async () => {
  const { deps, token } = await setup();
  const { ledger } = await recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "merge", scope_item_id: "100", actor: "human:alice", reason: "x" });

  assert.doesNotThrow(() => authorizeGatedTransition([], ledger, "merge", "100", "PR #42 merged, sha abc123"));

  assert.throws(
    () => authorizeGatedTransition([], ledger, "merge", "200", "some evidence"),
    (err: unknown) => assertClass(err, "authority"),
  );
});

test("authorizeGatedTransition: an amendment does not widen to other gates", async () => {
  const { deps, token } = await setup();
  const { ledger } = await recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "merge", scope_item_id: "100", actor: "human:alice", reason: "x" });
  assert.throws(
    () => authorizeGatedTransition([], ledger, "release", "100", "evidence"),
    (err: unknown) => assertClass(err, "authority"),
  );
});

test("recordAuthorityAmendment: a broad/un-scoped amendment (no scope_item_id) is refused — nothing recorded", async () => {
  const { deps, token } = await setup();
  await assert.rejects(
    () => recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "deploy", actor: "human:alice", reason: "x" }),
    (err: unknown) => assertClass(err, "validation"),
  );
  const ledger = await readLedger(deps, "run-1");
  assert.equal((ledger.authority_amendments ?? []).length, 0);
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0);
});

test("authorizeGatedTransition: a compile-time grant authorizes independently of any amendment", async () => {
  const { deps } = await setup();
  const ledger = await readLedger(deps, "run-1");
  assert.doesNotThrow(() => authorizeGatedTransition(["push_pr"], ledger, "push_pr", "100", "evidence"));
});

test("authorizeGatedTransition: an ungranted gate refuses, item unchanged", async () => {
  const { deps } = await setup();
  const ledger = await readLedger(deps, "run-1");
  assert.throws(
    () => authorizeGatedTransition([], ledger, "merge", "100", "evidence"),
    (err: unknown) => assertClass(err, "authority"),
  );
});

test("authorizeGatedTransition: an amendment never bypasses the evidence mandate", async () => {
  const { deps, token } = await setup();
  const { ledger } = await recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "merge", scope_item_id: "100", actor: "human:alice", reason: "x" });
  assert.throws(
    () => authorizeGatedTransition([], ledger, "merge", "100", ""),
    (err: unknown) => assertClass(err, "validation"),
  );
  assert.throws(
    () => authorizeGatedTransition([], ledger, "merge", "100", undefined),
    (err: unknown) => assertClass(err, "validation"),
  );
});

test("upgradeLedgerForPauseAuthority: a pre-#510 ledger with no authority_amendments is defaulted to an empty array", () => {
  const legacy = { ...testLedger() } as Record<string, unknown>;
  delete legacy.authority_amendments;
  const upgraded = upgradeLedgerForPauseAuthority(legacy as unknown as LoopLedger);
  assert.deepEqual(upgraded.authority_amendments, []);
});

// ---------------------------------------------------------------------------
// Audited cross-engine handoff.
// ---------------------------------------------------------------------------

test("handoffRun: a paused run is handed off — records an attributed decision and releases the lock without transferring its token", async () => {
  const { deps, token } = await setup();
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });

  await handoffRun(deps, { runId: "run-1", token, fromEngine: "claude", toEngine: "codex", reason: "switching hosts" });

  const decisions = await readDecisions(deps, "run-1");
  const handoff = decisions.find((d) => d.kind === "loop_handoff");
  assert.ok(handoff);
  assert.deepEqual(handoff!.data, { from_engine: "claude", to_engine: "codex", reason: "switching hosts", time: "2026-07-23T00:00:00.000Z" });

  const status = await getStatus(deps, "run-1");
  assert.equal(status.lock.holder, null, "lock released");

  // The receiving engine must acquire a fresh lock — the old token is dead.
  const { token: freshToken } = await acquireLock(deps, "run-1", "codex");
  assert.notEqual(freshToken, token);
});

test("handoffRun: refused while an item is in_progress, lock and ledger unchanged", async () => {
  const { deps, token } = await setup(); // "100" is in_progress
  await assert.rejects(
    () => handoffRun(deps, { runId: "run-1", token, fromEngine: "claude", toEngine: "codex", reason: "x" }),
    (err: unknown) => assertClass(err, "conflict"),
  );
  const status = await getStatus(deps, "run-1");
  assert.ok(status.lock.holder, "lock still held");
  const decisions = await readDecisions(deps, "run-1");
  assert.equal(decisions.length, 0);
});

test("handoffRun: the receiving engine must re-attest native-goal mode before resuming", async () => {
  const { deps, token } = await setup();
  await pauseItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude" });
  await handoffRun(deps, { runId: "run-1", token, fromEngine: "claude", toEngine: "codex", reason: "handing off" });

  const { token: codexToken } = await acquireLock(deps, "run-1", "codex");
  await assert.rejects(
    () =>
      resumeHold(deps, {
        runId: "run-1",
        token: codexToken,
        itemId: "100",
        engine: "codex",
        actor: "human:bob",
        response: { value: "go" },
        pipeline_preflight: PREFLIGHT_OK,
        native_goal: null,
      }),
    (err: unknown) => assertClass(err, "native_goal_mandate"),
  );

  // With fresh native-goal evidence for the receiving engine, resume succeeds.
  const ledger = await resumeHold(deps, {
    runId: "run-1",
    token: codexToken,
    itemId: "100",
    engine: "codex",
    actor: "human:bob",
    response: { value: "go" },
    pipeline_preflight: PREFLIGHT_OK,
    native_goal: { engine: "codex", run_id: "run-1", status: "active", checked_at: "2026-07-23T00:00:00.000Z" },
  });
  assert.equal(ledger.items["100"].state, "in_progress");
});

// ---------------------------------------------------------------------------
// Status projection.
// ---------------------------------------------------------------------------

test("getStatus surfaces outstanding requests and active amendments, performing zero writes", async () => {
  const { deps, files, token } = await setup();
  await waitItem(deps, { runId: "run-1", token, itemId: "100", engine: "claude", request: { kind: "decision", prompt: "go?", permitted_responses: ["yes"] } });
  await recordAuthorityAmendment(deps, { runId: "run-1", token, gate: "merge", scope_item_id: "100", actor: "human:alice", reason: "x" });

  const before = new Map(files);
  const status = await getStatus(deps, "run-1");
  assert.deepEqual([...files.entries()], [...before.entries()], "getStatus performs zero writes");

  assert.equal(status.outstanding_requests["100"].prompt, "go?");
  assert.equal(status.authority_amendments.length, 1);
  assert.equal(status.authority_amendments[0].gate, "merge");
});
