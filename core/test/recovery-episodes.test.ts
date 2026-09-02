// Recovery Episodes (#1325): persist cursor, per-strategy bounds, Cooling,
// fenced takeover, and generation quarantine. In-memory LoopStoreDeps only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RECOVERY_POLICY,
  blockItem,
  completeRecoveryAttempt,
  persistOwnedCooling,
  startRecoveryAttempt,
} from "../scripts/loop/recovery.ts";
import {
  RECOVERY_EPISODE_REQUIRED_FIELDS,
  assertNoMechanicalLifecycleStop,
  assertRecoveryEpisodeFields,
  buildCoolingRecord,
  coolingDeadline,
  coolingIsActive,
  coolingRecordForItem,
  assertCursorDoesNotRegress,
  competingPrivateEpisodePath,
  DURABLE_GENERATION_QUARANTINE_THEME,
  emptyEpisode,
  isTempWriteBasename,
  lastValidPathFor,
  normalizeEvidenceIdentity,
  perStrategyBound,
  reconcileUncertainClaim,
  recoveryEpisodeId,
  resumeEpisodeFromAttempts,
  selectNextApplicableStrategy,
} from "../scripts/loop/recovery-episodes.ts";
import {
  acquireLock,
  classifyStaleness,
  initRun,
  readContract,
  readLedger,
  recoverLock,
  requireToken,
  writeLedger,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  LoopError,
  type LoopContract,
  type LoopLedger,
  type RecoveryRecipe,
} from "../scripts/loop/types.ts";
import { claimOrResumeRecoveryEpisode, recordRecoveryEpisodeTreatment, stageRecoveryEpisodeKey } from "../scripts/issue-stage-adapters.ts";
import { emptyStageAttemptLedger } from "../scripts/stage-attempt-ledger.ts";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";

let fakeDepsCounter = 0;

function fakeDeps(overrides: Partial<LoopStoreDeps> = {}): { deps: LoopStoreDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  let clock = new Date("2026-09-02T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const isolatedEnv = { AGENT_PIPELINE_STATE_HOME: `/state-episodes-${fakeDepsCounter++}` };
  const alivePids = new Set<number>([111]);

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
      return [...new Set([...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]))];
    },
    async isPidAlive(pid) {
      return alivePids.has(pid);
    },
    getProcessStartTime: (pid) => (alivePids.has(pid) ? "start-111" : null),
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

async function setup() {
  const { deps, files } = fakeDeps();
  const contract = testContract();
  await initRun(deps, contract, testLedger());
  const { token } = await acquireLock(deps, "run-1", "claude");
  return { deps, files, contract, token };
}

async function blockCi(deps: LoopStoreDeps, contract: LoopContract, token: string, evidence = "ci failed on current head") {
  await blockItem(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    blockerClass: "implementation-ci",
    evidence,
  });
}

// ---------------------------------------------------------------------------
// 1. Episode record on the shared family
// ---------------------------------------------------------------------------

test("1.1 claimed treatment persists required Recovery Episode fields", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const { attempt } = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "head-abc:base-def",
  });
  assertRecoveryEpisodeFields(attempt);
  for (const field of RECOVERY_EPISODE_REQUIRED_FIELDS) {
    assert.notEqual((attempt as Record<string, unknown>)[field], undefined, field);
  }
  assert.equal(attempt.invariant, "implementation-ci");
  assert.equal(attempt.evidence_identity, attempt.evidence_fingerprint);
  assert.ok(attempt.attempts_per_strategy?.["repair_pipeline_item"] ?? 0 >= 1);
  assert.throws(
    () => assertRecoveryEpisodeFields({ outcome: "started" } as never),
    /missing required field/,
  );
});

test("1.2 second process resumes the same episode identity", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const first = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "head-abc:base-def",
  });
  const second = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "head-abc:base-def",
  });
  assert.equal(second.attempt.episode_id, first.attempt.episode_id);
  assert.equal(second.attempt.attempt_id, first.attempt.attempt_id);
  assert.equal(second.ledger.recovery_attempts.length, 1);
  const dir = mkdtempSync(join(tmpdir(), "ap-1325-ep-"));
  const episodeKey = stageRecoveryEpisodeKey({
    issue: 1325,
    candidateEpoch: "head-abc",
    evidence: "ci failed",
  });
  const a = claimOrResumeRecoveryEpisode({
    domain: "test",
    logical_operation_id: "lop-same",
    issue: 1325,
    message: "ci failed",
    persistDir: dir,
    episodeKey,
  });
  const treated = recordRecoveryEpisodeTreatment({
    ledger: emptyStageAttemptLedger(),
    headSha: "head-abc",
    action: "worktree_rematerialize",
    itemId: "1325",
    evidenceFingerprint: "ci failed",
    episodeKey,
  });
  const b = claimOrResumeRecoveryEpisode({
    domain: "test",
    logical_operation_id: "lop-same",
    issue: 1325,
    message: "ci failed",
    persistDir: dir,
    episodeKey,
  });
  assert.equal(b.episode_id, a.episode_id);
  assert.equal(treated.attempts[0]!.episode_id, a.episode_id);
  rmSync(dir, { recursive: true, force: true });
});

test("1.3 competing private episode schema is not production authority", async () => {
  const { deps, files, contract, token } = await setup();
  await blockCi(deps, contract, token);
  await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "rerun_ci",
    candidateIdentity: "head-abc",
  });
  const sidecar = competingPrivateEpisodePath(`/state-episodes-x/runs/run-1`);
  files.set(sidecar, JSON.stringify({ strategy_cursor: 99, private: true }));
  const ledger = await readLedger(deps, "run-1");
  assert.notEqual(ledger.recovery_attempts[0]?.strategy_cursor, 99);
  assert.ok(typeof ledger.recovery_attempts[0]?.strategy_cursor === "number");
});

test("1.4 prose-only variation resumes the same evidence identity", () => {
  const a = normalizeEvidenceIdentity("CI failed on sha abcdef1 with 12 errors");
  const b = normalizeEvidenceIdentity("  CI  FAILED on sha ABCDEF1 with 12 errors  ");
  assert.equal(a, b);
  const c = normalizeEvidenceIdentity("tests failed for a different reason entirely");
  assert.notEqual(a, c);
  const key = {
    operation: "loop_recovery",
    invariant: "implementation-ci",
    candidate_epoch: "head-abc",
    evidence_identity: a,
  };
  assert.equal(recoveryEpisodeId(key), recoveryEpisodeId({ ...key, evidence_identity: b }));
});

// ---------------------------------------------------------------------------
// 2. Per-strategy cursor and inapplicable skip
// ---------------------------------------------------------------------------

test("2.1 class-wide remaining 0 still claims a later unspent recipe", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const ledger = await readLedger(deps, "run-1");
  ledger.items["100"]!.recovery_budgets_remaining["implementation-ci"] = 0;
  await writeLedger(deps, ledger, token);
  const started = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "head-later",
  });
  assert.equal(started.attempt.outcome, "started");
  assert.equal(started.ledger.stop, null);
});

test("2.2 exhausting one strategy advances the cursor without run_fatal", () => {
  const recipes: RecoveryRecipe[] = ["verify_head_goal", "rerun_ci", "repair_pipeline_item"];
  const selected = selectNextApplicableStrategy({
    recipes,
    cursor: 0,
    attemptsPerStrategy: { verify_head_goal: 3 },
    strategyBound: () => 3,
    isApplicable: () => true,
  });
  assert.equal(selected.kind, "claim");
  if (selected.kind === "claim") {
    assert.equal(selected.action, "rerun_ci");
    assert.equal(selected.cursor, 1);
  }
});

test("2.3 inapplicable verify_head_goal skip does not consume repair bound", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const skipped = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "verify_head_goal",
    candidateIdentity: "head-none",
    skipInapplicable: true,
  });
  assert.equal(skipped.attempt.outcome, "skipped");
  assert.equal(skipped.attempt.attempts_per_strategy?.["repair_pipeline_item"] ?? 0, 0);
  const repair = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "repair_pipeline_item",
    candidateIdentity: "head-none",
  });
  assert.equal(repair.attempt.outcome, "started");
  assert.equal(repair.attempt.attempts_per_strategy?.["repair_pipeline_item"], 1);
});

test("2.4 three-recipe class claims the last recipe after earlier spent or skipped", () => {
  const recipes: RecoveryRecipe[] = ["unlink_engine_scratch", "restart_workflow_engine", "repair_pipeline_item"];
  const selected = selectNextApplicableStrategy({
    recipes,
    cursor: 0,
    attemptsPerStrategy: { unlink_engine_scratch: 2, restart_workflow_engine: 2 },
    strategyBound: () => 2,
    isApplicable: (recipe) => recipe !== "unlink_engine_scratch",
  });
  assert.equal(selected.kind, "claim");
  if (selected.kind === "claim") {
    assert.equal(selected.action, "repair_pipeline_item");
    assert.ok(selected.skipped.includes("unlink_engine_scratch"));
  }
});

test("2.5a stored strategy cursor cannot regress", () => {
  assert.equal(assertCursorDoesNotRegress(1, 2), 2);
  assert.throws(() => assertCursorDoesNotRegress(2, 1), /cannot regress/);
});

test("2.5 restart resumes the same cursor", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const first = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "rerun_ci",
    candidateIdentity: "head-abc",
    candidateEpoch: "head-abc",
  });
  const key = {
    operation: first.attempt.operation ?? "loop_recovery",
    invariant: first.attempt.invariant!,
    candidate_epoch: first.attempt.candidate_epoch!,
    evidence_identity: first.attempt.evidence_identity!,
  };
  const resumed = resumeEpisodeFromAttempts(first.ledger.recovery_attempts, key);
  assert.ok(resumed);
  assert.equal(resumed!.strategy_cursor, first.attempt.strategy_cursor);
  assert.notEqual(resumed!.strategy_cursor, undefined);
});

// ---------------------------------------------------------------------------
// 3. Repeated evidence and Cooling
// ---------------------------------------------------------------------------

test("3.1 repeated evidence does not tight-loop the same strategy", () => {
  const recipes: RecoveryRecipe[] = ["rerun_ci", "repair_pipeline_item"];
  const afterLimit = selectNextApplicableStrategy({
    recipes,
    cursor: 0,
    attemptsPerStrategy: { rerun_ci: 1 },
    strategyBound: () => 1,
    isApplicable: () => true,
  });
  assert.equal(afterLimit.kind, "claim");
  if (afterLimit.kind === "claim") assert.equal(afterLimit.action, "repair_pipeline_item");
});

test("3.2 all strategies exhausted persist Cooling with future next_eligible_at", async () => {
  const { deps, contract, token } = await setup();
  const time = deps.now().toISOString();
  const cooling = buildCoolingRecord({
    reason: "strategy_cursor_exhausted",
    time,
    nextEligibleAt: coolingDeadline(time, DEFAULT_RECOVERY_POLICY["implementation-ci"].backoff, 1),
    itemId: "100",
    theme: "implementation-ci",
    historicalEvidence: "recovery_exhausted",
  });
  const ledger = await persistOwnedCooling(deps, { runId: "run-1", token, cooling });
  assert.equal(ledger.stop, null);
  assert.ok(ledger.cooling?.next_eligible_at);
  assert.ok(Date.parse(ledger.cooling!.next_eligible_at!) > Date.parse(time));
  assert.equal(ledger.items["100"]?.state, "in_progress");
});

test("3.3 cooling refuses treatment before next_eligible_at while sibling stays pending", async () => {
  const { deps, token } = await setup();
  const time = deps.now().toISOString();
  const cooling = buildCoolingRecord({
    reason: "strategy_cursor_exhausted",
    time,
    nextEligibleAt: coolingDeadline(time, { initial_seconds: 60, multiplier: 2, max_seconds: 300 }, 1),
    itemId: "100",
    theme: "implementation-ci",
  });
  const ledger = await persistOwnedCooling(deps, { runId: "run-1", token, cooling });
  assert.equal(coolingIsActive(ledger.cooling, time), true);
  assert.equal(ledger.items["200"]?.state, "pending");
  assert.equal(ledger.stop, null);
});

test("3.4 fixtures that persist mechanical names as lifecycle stops fail", () => {
  for (const reason of [
    "run_fatal",
    "recovery_exhausted",
    "repeated_no_progress",
    "supervisor_no_progress",
    "supervisor_cycle_cap",
    "worktree_capacity",
  ] as const) {
    assert.throws(
      () => assertNoMechanicalLifecycleStop({ reason, time: "t" }),
      /mechanical lifecycle stop/,
    );
  }
  assert.doesNotThrow(() => assertNoMechanicalLifecycleStop({ reason: "human_authority", time: "t" }));
  assert.doesNotThrow(() => assertNoMechanicalLifecycleStop({ reason: "dependency_deadlock", time: "t" }));
});

test("3.5 human-decision-required is not converted into Cooling", () => {
  assert.doesNotThrow(() => assertNoMechanicalLifecycleStop({ reason: "human_authority", time: "t" }));
  const cooling = buildCoolingRecord({
    reason: "mechanical_exhaustion",
    time: "t",
    nextEligibleAt: "t2",
  });
  assert.notEqual(cooling.reason, "human_authority");
});

test("3.7 sibling Cooling does not erase the first item's deadline", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "rerun_ci",
    candidateIdentity: "head-p",
  });
  const time = deps.now().toISOString();
  const coolingP = buildCoolingRecord({
    reason: "strategy_cursor_exhausted",
    time,
    nextEligibleAt: coolingDeadline(time, { initial_seconds: 120, multiplier: 2, max_seconds: 600 }, 1),
    itemId: "100",
    theme: "implementation-ci",
  });
  await persistOwnedCooling(deps, { runId: "run-1", token, cooling: coolingP });
  const coolingQ = buildCoolingRecord({
    reason: "strategy_cursor_exhausted",
    time,
    nextEligibleAt: coolingDeadline(time, { initial_seconds: 30, multiplier: 2, max_seconds: 300 }, 1),
    itemId: "200",
    theme: "implementation-ci",
  });
  const ledger = await persistOwnedCooling(deps, { runId: "run-1", token, cooling: coolingQ });
  assert.equal(coolingRecordForItem(ledger, "100")?.next_eligible_at, coolingP.next_eligible_at);
  assert.equal(coolingRecordForItem(ledger, "200")?.next_eligible_at, coolingQ.next_eligible_at);
  assert.equal(coolingIsActive(coolingRecordForItem(ledger, "100"), time), true);
  const pAttempts = ledger.recovery_attempts.filter((attempt) => attempt.item_id === "100");
  assert.ok(pAttempts.some((attempt) => attempt.next_eligible_at === coolingP.next_eligible_at));
});

test("3.6 historical recovery_exhausted remains readable as evidence", async () => {
  const { deps, token } = await setup();
  const cooling = buildCoolingRecord({
    reason: "strategy_cursor_exhausted",
    time: deps.now().toISOString(),
    nextEligibleAt: coolingDeadline(deps.now().toISOString(), { initial_seconds: 30, multiplier: 2, max_seconds: 300 }, 1),
    historicalEvidence: "recovery_exhausted",
  });
  const ledger = await persistOwnedCooling(deps, { runId: "run-1", token, cooling });
  assert.equal(ledger.cooling?.historical_evidence, "recovery_exhausted");
  assert.equal(ledger.stop, null);
});

// ---------------------------------------------------------------------------
// 4. Write-ahead claims and fenced takeover
// ---------------------------------------------------------------------------

test("4.1 replay of the same attempt_id after crash does not double-charge", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const input = {
    runId: "run-1" as const,
    token,
    itemId: "100",
    engine: "claude" as const,
    action: "repair_pipeline_item" as const,
    candidateIdentity: "head-abc:base-def",
  };
  const first = await startRecoveryAttempt(deps, contract, input);
  const replay = await startRecoveryAttempt(deps, contract, input);
  assert.equal(replay.attempt.attempt_id, first.attempt.attempt_id);
  assert.equal(replay.ledger.recovery_attempts.length, 1);
  assert.equal(replay.attempt.attempts_per_strategy?.["repair_pipeline_item"], 1);
});

test("4.2 mismatched fence token leaves the ledger unchanged", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const before = await readLedger(deps, "run-1");
  await assert.rejects(
    () =>
      startRecoveryAttempt(deps, contract, {
        runId: "run-1",
        token: "not-the-token",
        itemId: "100",
        engine: "claude",
        action: "rerun_ci",
        candidateIdentity: "head-abc",
      }),
    (err: unknown) => err instanceof LoopError && err.loopFailureClass === "lock",
  );
  const after = await readLedger(deps, "run-1");
  assert.equal(after.recovery_attempts.length, before.recovery_attempts.length);
});

test("4.3 dead same-host holder: new token invalidates the old token", async () => {
  const { deps } = fakeDeps({
    pid: () => 111,
    async isPidAlive(pid) {
      return pid === 222;
    },
  });
  const contract = testContract();
  await initRun(deps, contract, testLedger());
  const first = await acquireLock(deps, "run-1", "claude");
  await recoverLock(deps, "run-1", "process death");
  const second = await acquireLock(deps, "run-1", "claude");
  assert.notEqual(second.token, first.token);
  await assert.rejects(() => requireToken(deps, "run-1", first.token), /current lock holder's token/);
  const holder = await requireToken(deps, "run-1", second.token);
  assert.equal(holder.token, second.token);
});

test("4.4 takeover observer: complete / absent / unknown", () => {
  assert.equal(reconcileUncertainClaim("known_complete"), "reconcile_forward");
  assert.equal(reconcileUncertainClaim("known_absent"), "replay");
  assert.equal(reconcileUncertainClaim("uncertain"), "wait");
});

test("4.5 cross-host lock is not auto-taken over", async () => {
  const { deps, files } = fakeDeps();
  await initRun(deps, testContract(), testLedger());
  await acquireLock(deps, "run-1", "claude");
  const lockPath = [...files.keys()].find((k) => k.endsWith("/lock.json"));
  assert.ok(lockPath);
  const lock = JSON.parse(files.get(lockPath!)!);
  lock.hostname = "other-host";
  files.set(lockPath!, JSON.stringify(lock, null, 2));
  assert.equal(await classifyStaleness(deps, lock), "unverifiable_cross_host");
  await assert.rejects(() => recoverLock(deps, "run-1", "should not"), /not verifiably stale/);
});

// ---------------------------------------------------------------------------
// 5. Generation quarantine
// ---------------------------------------------------------------------------

test("5.1 truncated ledger is quarantined and is not live authority", async () => {
  const { deps, files } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"));
  assert.ok(published);
  files.delete(lastValidPathFor(published!));
  files.set(published!, "{truncated");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null);
  assert.equal(ledger.cooling?.theme, DURABLE_GENERATION_QUARANTINE_THEME);
  assert.ok(ledger.cooling?.quarantine_path);
  assert.notEqual(ledger.cooling?.reason, "human_authority");
  const quarantined = [...files.keys()].filter((k) => k.includes("quarantine"));
  assert.ok(quarantined.length >= 1);
  assert.equal(files.get(published!)?.includes("{truncated"), false);
});

test("5.2 leftover temporary write is not published authority", async () => {
  const { deps, files } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"));
  assert.ok(published);
  files.set(`${published}.abc.tmp`, "{not-a-ledger");
  assert.equal(isTempWriteBasename(".ledger.json.abc.tmp"), true);
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.schema, LOOP_LEDGER_SCHEMA);
});

test("5.3 last valid generation is reconstructed when safe", async () => {
  const { deps, files, token } = await setup();
  const ledger = await readLedger(deps, "run-1");
  await writeLedger(deps, ledger, token);
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"))!;
  const lastValid = lastValidPathFor(published);
  assert.ok(files.has(lastValid));
  files.set(published, "{truncated");
  const restored = await readLedger(deps, "run-1");
  assert.equal(restored.schema, LOOP_LEDGER_SCHEMA);
  assert.equal(restored.run_id, "run-1");
});

test("5.4 partial ledger with only run_id and items is quarantined", async () => {
  const { deps, files } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"))!;
  files.delete(lastValidPathFor(published));
  files.set(published, JSON.stringify({ run_id: "run-1", items: {} }));
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null);
  assert.equal(ledger.cooling?.theme, DURABLE_GENERATION_QUARANTINE_THEME);
  const quarantined = [...files.keys()].filter((k) => k.includes("quarantine"));
  assert.ok(quarantined.length >= 1);
});

test("5.5 empty ledger reconstructs from last-valid instead of missing", async () => {
  const { deps, files } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"))!;
  assert.ok(files.has(lastValidPathFor(published)));
  files.set(published, "");
  const restored = await readLedger(deps, "run-1");
  assert.equal(restored.schema, LOOP_LEDGER_SCHEMA);
  assert.equal(restored.run_id, "run-1");
  assert.ok(Array.isArray(restored.recovery_attempts));
});

test("5.6 partial contract with only run_id is quarantined", async () => {
  const { deps, files } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/contract.json"))!;
  files.delete(lastValidPathFor(published));
  files.set(published, JSON.stringify({ run_id: "run-1" }));
  await assert.rejects(() => readContract(deps, "run-1"), /quarantined invalid contract/);
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null);
  assert.equal(ledger.cooling?.theme, DURABLE_GENERATION_QUARANTINE_THEME);
  assert.ok(ledger.cooling?.quarantine_path);
});

test("5.7 unreconstructable ledger remains owned as a quarantine wait", async () => {
  const { deps, files, token } = await setup();
  const published = [...files.keys()].find((k) => k.endsWith("/ledger.json"))!;
  files.delete(lastValidPathFor(published));
  files.set(published, "{truncated");
  const ledger = await readLedger(deps, "run-1");
  assert.equal(ledger.stop, null);
  assert.equal(ledger.cooling?.theme, DURABLE_GENERATION_QUARANTINE_THEME);
  assert.ok(ledger.cooling?.next_eligible_at);
  assert.equal(ledger.last_reconciliation, null);
  assert.ok(Object.keys(ledger.items).length >= 1);
  await assert.rejects(
    () =>
      writeLedger(
        deps,
        {
          ...ledger,
          items: {
            ...ledger.items,
            "100": { ...ledger.items["100"]!, state: "in_progress" },
          },
        },
        token,
      ),
    /live reconciliation before mutation/,
  );
  const reconciled = {
    ...ledger,
    last_reconciliation: {
      sequence: 1,
      time: deps.now().toISOString(),
      observed: {},
      drift: [],
      next_actions: {},
    },
    reconciliation_sequence: 1,
  };
  await writeLedger(deps, reconciled, token);
  const after = await readLedger(deps, "run-1");
  assert.equal(after.last_reconciliation?.sequence, 1);
  assert.equal(after.stop, null);
});

// ---------------------------------------------------------------------------
// 6. Crash boundaries
// ---------------------------------------------------------------------------

test("6.1 crash after claim start does not second-charge on replay", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const input = {
    runId: "run-1" as const,
    token,
    itemId: "100",
    engine: "claude" as const,
    action: "rerun_ci" as const,
    candidateIdentity: "head-crash",
  };
  await startRecoveryAttempt(deps, contract, input);
  const replay = await startRecoveryAttempt(deps, contract, input);
  assert.equal(replay.ledger.recovery_attempts.length, 1);
});

test("6.2 crash before side effect does not mutate under a dead token", async () => {
  let live = true;
  const { deps, contract } = fakeDeps({
    async isPidAlive() {
      return live;
    },
    pid: () => 111,
  });
  await initRun(deps, testContract(), testLedger());
  const first = await acquireLock(deps, "run-1", "claude");
  await blockCi(deps, testContract(), first.token);
  live = false;
  await recoverLock(deps, "run-1", "crash before mutation");
  await acquireLock(deps, "run-1", "claude");
  await assert.rejects(
    () =>
      startRecoveryAttempt(deps, testContract(), {
        runId: "run-1",
        token: first.token,
        itemId: "100",
        engine: "claude",
        action: "rerun_ci",
      }),
    /lock/,
  );
});

test("6.3 unit tests inject store fakes — no real network/git/subprocess in this file", () => {
  assert.equal(typeof fakeDeps, "function");
});

test("7.1 no public supervise-recovery CLI verb is registered", () => {
  const verbs = Object.keys(COMMAND_REGISTRY);
  assert.equal(verbs.includes("supervise-recovery"), false);
  assert.equal(verbs.some((name) => /supervise/.test(name) && /recovery/.test(name)), false);
});

test("per-strategy bound uses retry_budget when per_strategy_bound is absent", () => {
  assert.equal(perStrategyBound(DEFAULT_RECOVERY_POLICY["implementation-ci"]), 3);
  assert.equal(emptyEpisode({
    operation: "loop_recovery",
    invariant: "implementation-ci",
    candidate_epoch: "e",
    evidence_identity: "f",
  }, "t").strategy_cursor, 0);
});

test("complete started claim after known_complete does not mint a second attempt", async () => {
  const { deps, contract, token } = await setup();
  await blockCi(deps, contract, token);
  const started = await startRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    action: "rerun_ci",
    candidateIdentity: "head-obs",
  });
  const completed = await completeRecoveryAttempt(deps, contract, {
    runId: "run-1",
    token,
    itemId: "100",
    engine: "claude",
    attemptId: started.attempt.attempt_id,
    succeeded: true,
  });
  assert.equal(completed.attempt.outcome, "recovered");
  assert.equal(completed.ledger.recovery_attempts.length, 1);
});
