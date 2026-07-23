// Epic #528's owning integration test, capability `conflict-aware-parallel-execution`. Proves the
// epic's four run-level invariants — which no single child capability asserts at run scope — over
// a mixed frontier the children's own tests do not exercise together: a proven-disjoint pair, an
// unknown-ownership pair, an explicit-conflict pair, and a dependency-linked pair, through the
// existing injected scheduler / ownership / reconciliation / SupervisorDeps seams, with zero real
// network, git, or subprocess access anywhere in this file.
//
// This complements (does not duplicate) core/test/durable-run-parallel-conflict-pilot.test.ts
// (#531), which is the epic's designated end-to-end acceptance vehicle for merge-class
// serialization and changed-file-overlap park/replan — tasks.md 4.1/4.2. This file's job is the
// run-scoped parallelization ledger (tasks.md 2.*) and the "no unproven pair ever runs
// concurrently" + full evidence-reconstruction invariants (tasks.md 3.1-3.3, 3.6) — see
// openspec/changes/conflict-aware-parallel-execution/design.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { driveSupervisor, runSupervisorCycle, type SupervisorDeps } from "../scripts/loop/supervisor.ts";
import {
  acquireLock,
  initRun,
  readActionEvidence,
  readEvents,
  readLedger,
  releaseLock,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { type ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import { evaluateOwnershipEvidence, recordOwnershipEvidence } from "../scripts/loop/ownership.ts";
import { parallelizationLedgerFromEvents } from "../scripts/loop/parallelization-ledger.ts";
import { buildLoopEvidenceBundle } from "../scripts/loop/evidence.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";

const RUN_ID = "conflict-aware-run-1";
const ITEM_A = "710";
const ITEM_B = "720";
const ITEM_UNKNOWN = "730";
const ITEM_CONFLICT = "740";
const ITEM_DEP = "750";
const PR_BY_ITEM: Record<string, number> = { [ITEM_A]: 701, [ITEM_B]: 702, [ITEM_UNKNOWN]: 703, [ITEM_CONFLICT]: 704, [ITEM_DEP]: 705 };

let counter = 0;

function fakeDeps(): LoopStoreDeps {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-conflict-aware-${counter++}` };

  return {
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
}

/** A mixed frontier no child capability's own tests exercise together (design.md): A and B carry
 *  disjoint exclusive ownership; C declares no ownership at all (unknown ownership, conservative
 *  conflict against everything); E declares an explicit `conflicts_with` edge on A; D structurally
 *  depends on A and so never even enters the scheduler's frontier until A is done — proving
 *  dependency-linked serialization is enforced upstream of the scheduler, not by it. */
function contract(): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: RUN_ID,
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "issue-set", value: [ITEM_A, ITEM_B, ITEM_UNKNOWN, ITEM_CONFLICT, ITEM_DEP] },
    objective: "epic #528 conflict-aware parallel execution integration proof",
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
    concurrency: { max_concurrent: 2 },
    concurrency_model: "exclusive_lock_single_engine",
    items: [
      { id: ITEM_A, depends_on: [], external_depends_on: [], ownership: { exclusive: ["src/a/**"] } },
      { id: ITEM_B, depends_on: [], external_depends_on: [], ownership: { exclusive: ["src/b/**"] } },
      { id: ITEM_UNKNOWN, depends_on: [], external_depends_on: [] },
      {
        id: ITEM_CONFLICT,
        depends_on: [],
        external_depends_on: [],
        ownership: { exclusive: ["src/e/**"], conflicts_with: [ITEM_A] },
      },
      { id: ITEM_DEP, depends_on: [ITEM_A], external_depends_on: [], ownership: { exclusive: ["src/d/**"] } },
    ],
    canonical_hash: "conflict-aware-deadbeef",
  } as LoopContract;
}

function itemEntry(id: string): LoopLedger["items"][string] {
  return { id, state: "pending", history: [], recovery_budgets_remaining: { default: 3 } };
}

function ledgerFixture(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: RUN_ID,
    items: {
      [ITEM_A]: itemEntry(ITEM_A),
      [ITEM_B]: itemEntry(ITEM_B),
      [ITEM_UNKNOWN]: itemEntry(ITEM_UNKNOWN),
      [ITEM_CONFLICT]: itemEntry(ITEM_CONFLICT),
      [ITEM_DEP]: itemEntry(ITEM_DEP),
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: null,
    last_native_goal_check: null,
    reconciliation_sequence: 0,
    last_reconciliation: null,
    recovery_attempts: [],
    authority_amendments: [],
  };
}

const READY_LABEL = "pipeline:ready-to-deploy";

function fakes() {
  const dispatched = new Set<string>();
  const mutatedOnce = new Set<string>();
  let aMerged = false;
  let baseHasA = false;
  const calls: string[] = [];

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      const item = Object.entries(PR_BY_ITEM).find(([id]) => Number(id) === issueNumber)?.[0];
      if (!item) return null;
      return { state: "open", labels: dispatched.has(item) ? [READY_LABEL] : [] };
    },
    async findPrForIssue(issueNumber) {
      const item = Object.entries(PR_BY_ITEM).find(([id]) => Number(id) === issueNumber)?.[0];
      if (!item) return null;
      return dispatched.has(item) ? PR_BY_ITEM[item] : null;
    },
    async getPrDetail(prNumber) {
      const item = Object.entries(PR_BY_ITEM).find(([, pr]) => pr === prNumber)?.[0];
      if (!item) return null;
      if (item === ITEM_A) {
        return { state: aMerged ? "merged" : "open", head_ref: `pipeline/${ITEM_A}-x`, head_sha: "sha-a", merge_commit_sha: aMerged ? "merge-sha-a" : null };
      }
      return { state: "open", head_ref: `pipeline/${item}-x`, head_sha: `sha-${item}`, merge_commit_sha: null };
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha(sha) {
      return baseHasA && sha === "merge-sha-a" ? true : null;
    },
    async getExternalDependencyIssueState() {
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request: LoopExecutionRequest) => {
    calls.push(`dispatch:${request.item_id}`);
    const item = request.item_id;
    const pr = PR_BY_ITEM[item];
    dispatched.add(item);
    mutatedOnce.add(item);
    const response: LoopExecutionResponse = {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: item,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: pr, pipeline_run_id: `pipeline-run-${item}`, worktree_root: `/managed/conflict-aware-${item}` },
    };
    return response;
  };

  const getChangedFiles = async (itemId: string): Promise<string[]> => {
    if (itemId === ITEM_A) return ["src/a/x.ts"];
    if (itemId === ITEM_B) return ["src/b/y.ts"];
    return [];
  };

  return { observe, dispatchItem, getChangedFiles, calls, setAMerged: (v: boolean) => { aMerged = v; }, setBaseHasA: (v: boolean) => { baseHasA = v; } };
}

async function setup(): Promise<LoopStoreDeps> {
  const deps = fakeDeps();
  await initRun(deps, contract(), ledgerFixture());
  return deps;
}

test(
  "conflict-aware parallel execution (#528): no unproven pair ever runs concurrently — a mixed frontier admits only the proven-disjoint pair while the unknown-ownership, conflict, and dependency-linked pairs all serialize",
  async () => {
    const deps = await setup();
    const { observe, dispatchItem, getChangedFiles } = fakes();

    // --- Planning-time evidence (durable, not narrative) for the pairwise ownership relationships
    // this frontier exercises. ---
    const ownershipEvidence = evaluateOwnershipEvidence(contract().items);
    const { token: planToken } = await acquireLock(deps, RUN_ID, "claude");
    await recordOwnershipEvidence(deps, RUN_ID, planToken, ownershipEvidence);
    await releaseLock(deps, RUN_ID, planToken);

    // --- Cycle 1: A and B (proven disjoint) are admitted together; C (unknown ownership) and E
    // (explicit conflict) are denied against A; D (depends_on A, A not yet done) never even
    // enters the scheduler's frontier. ---
    const { token: token1 } = await acquireLock(deps, RUN_ID, "claude");
    const cycle1 = await runSupervisorCycle({ store: deps, observe, dispatchItem, getChangedFiles }, RUN_ID, token1, "claude");
    assert.equal(cycle1.stop, null);
    await releaseLock(deps, RUN_ID, token1);

    const ledgerAfterCycle1 = await readLedger(deps, RUN_ID);
    assert.equal(ledgerAfterCycle1.items[ITEM_A].state, "ready", "A is dispatched and reports ready_to_deploy in this cycle");
    assert.equal(ledgerAfterCycle1.items[ITEM_B].state, "ready", "B runs concurrently with A — both admitted in the same pass");
    assert.equal(ledgerAfterCycle1.items[ITEM_UNKNOWN].state, "pending", "C (unknown ownership) never ran concurrently with A/B");
    assert.equal(ledgerAfterCycle1.items[ITEM_CONFLICT].state, "pending", "E (explicit conflict with A) never ran concurrently with A/B");
    assert.equal(ledgerAfterCycle1.items[ITEM_DEP].state, "pending", "D (depends_on A) never ran concurrently with A — its dependency was not yet done");

    const events1 = await readEvents(deps, RUN_ID);
    const scheduleEvent1 = events1.filter((e) => e.kind === "loop_schedule_evaluated")[0];
    assert.ok(scheduleEvent1, "the scheduling pass must be a durable planning record");
    const decision1 = scheduleEvent1.data as {
      selected: string[];
      rationale: Array<{ item_id: string; disposition: string; counterpart_item_id?: string; detail?: string }>;
    };
    assert.deepEqual([...decision1.selected].sort(), [ITEM_A, ITEM_B], "only the proven-disjoint pair is admitted");
    const unknownRationale = decision1.rationale.find((r) => r.item_id === ITEM_UNKNOWN)!;
    assert.equal(unknownRationale.disposition, "unknown_ownership");
    assert.equal(unknownRationale.counterpart_item_id, ITEM_A);
    const conflictRationale = decision1.rationale.find((r) => r.item_id === ITEM_CONFLICT)!;
    assert.equal(conflictRationale.disposition, "conflict_edge");
    assert.equal(conflictRationale.counterpart_item_id, ITEM_A);
    assert.equal(
      decision1.rationale.some((r) => r.item_id === ITEM_DEP),
      false,
      "D never entered the frontier at all this pass — dependency-linked serialization is enforced upstream of the scheduler's own pairwise evaluation",
    );

    // --- The run-scoped parallelization ledger (task 2), reconstructed from the durable event log
    // alone: one entry per pair the scheduler actually evaluated. ---
    const ledgerEntries = parallelizationLedgerFromEvents(events1);
    assert.equal(ledgerEntries.length, 3, "one ledger entry per evaluated pair: (A,B), (A,C), (A,E)");
    const byPair = new Map(ledgerEntries.map((e) => [`${e.a_item_id}:${e.b_item_id}`, e]));
    assert.deepEqual(byPair.get(`${ITEM_A}:${ITEM_B}`), { a_item_id: ITEM_A, b_item_id: ITEM_B, disposition: "parallelized", reason: "admitted" });
    assert.deepEqual(byPair.get(`${ITEM_A}:${ITEM_UNKNOWN}`), {
      a_item_id: ITEM_A,
      b_item_id: ITEM_UNKNOWN,
      disposition: "serialized",
      reason: "unknown_ownership",
      detail: unknownRationale.detail,
    });
    assert.deepEqual(byPair.get(`${ITEM_A}:${ITEM_CONFLICT}`), {
      a_item_id: ITEM_A,
      b_item_id: ITEM_CONFLICT,
      disposition: "serialized",
      reason: "conflict_edge",
      ...(conflictRationale.detail !== undefined ? { detail: conflictRationale.detail } : {}),
    });

    // --- Cycle 2+: once A is done, D becomes eligible and is scheduled in a later, separate pass —
    // proving the dependency-linked pair was serialized (never concurrent), not merely delayed by
    // accident. C and E remain proven-conflicting/unknown against A and are admitted only once A is
    // no longer a concurrent candidate. ---
    const drive = await driveSupervisor({ store: deps, observe, dispatchItem, getChangedFiles }, { runId: RUN_ID, engine: "claude" });
    assert.equal(drive.stop, null);
    assert.equal(drive.allDone, true, "the run stops at pipeline:ready-to-deploy for every item — this capability grants no merge authority");

    const finalLedger = await readLedger(deps, RUN_ID);
    for (const id of [ITEM_A, ITEM_B, ITEM_UNKNOWN, ITEM_CONFLICT, ITEM_DEP]) {
      assert.equal(finalLedger.items[id].state, "ready", `item ${id} must reach ready`);
    }

    // --- No two items were EVER simultaneously in_progress unless the ledger holds a
    // parallelized/admitted decision for that exact pair — reconstructed purely from the durable
    // action-evidence trail's dispatch timing, not from any in-memory record. ---
    const finalEvents = await readEvents(deps, RUN_ID);
    const allDecisions = finalEvents.filter((e) => e.kind === "loop_schedule_evaluated").map((e) => e.data as { selected: string[] });
    const everConcurrentPairs = new Set<string>();
    for (const d of allDecisions) {
      for (let i = 0; i < d.selected.length; i++) {
        for (let j = i + 1; j < d.selected.length; j++) {
          const [x, y] = [d.selected[i], d.selected[j]].sort();
          everConcurrentPairs.add(`${x}:${y}`);
        }
      }
    }
    const finalLedgerEntries = parallelizationLedgerFromEvents(finalEvents);
    const provenDisjointPairs = new Set(
      finalLedgerEntries.filter((e) => e.disposition === "parallelized" && e.reason === "admitted").map((e) => `${e.a_item_id}:${e.b_item_id}`),
    );
    for (const pair of everConcurrentPairs) {
      assert.ok(provenDisjointPairs.has(pair), `pair ${pair} ran concurrently but the ledger holds no parallelized/admitted decision for it`);
    }
    // (ITEM_CONFLICT, ITEM_DEP) also runs concurrently in a later pass, once ITEM_A (the item
    // ITEM_CONFLICT explicitly conflicts with, and ITEM_DEP's dependency) is already done — a
    // second, legitimately proven-disjoint pair; the point is that every pair that ever ran
    // concurrently has a matching ledger decision, not that only one pair ever does.
    assert.deepEqual(
      [...everConcurrentPairs].sort(),
      [`${ITEM_A}:${ITEM_B}`, `${ITEM_CONFLICT}:${ITEM_DEP}`].sort(),
      "only pairs the ledger proves disjoint ever run concurrently across the whole run",
    );
    assert.equal(everConcurrentPairs.has(`${ITEM_A}:${ITEM_DEP}`), false, "the dependency-linked pair (A, D) never runs concurrently");
    assert.equal(everConcurrentPairs.has(`${ITEM_A}:${ITEM_UNKNOWN}`), false, "the unknown-ownership pair (A, C) never runs concurrently");
    assert.equal(everConcurrentPairs.has(`${ITEM_A}:${ITEM_CONFLICT}`), false, "the explicit-conflict pair (A, E) never runs concurrently");
  },
);

test("bite check: an unproven pair being admitted concurrently would be caught by the ledger-membership assertion above", () => {
  // Directly proves the composed assertion bites: an "everConcurrentPairs" set containing a pair
  // absent from "provenDisjointPairs" must fail the membership check.
  const everConcurrentPairs = new Set([`${ITEM_UNKNOWN}:${ITEM_A}`]);
  const provenDisjointPairs = new Set([`${ITEM_A}:${ITEM_B}`]);
  let caught = false;
  try {
    for (const pair of everConcurrentPairs) {
      assert.ok(provenDisjointPairs.has(pair), `pair ${pair} ran concurrently but the ledger holds no parallelized/admitted decision for it`);
    }
  } catch {
    caught = true;
  }
  assert.ok(caught, "the no-unproven-pair-concurrent assertion must fail when an unproven pair is admitted");
});

// ---------------------------------------------------------------------------
// 3.6 — full evidence reconstruction: every action, conflict detection, and scheduling decision is
// derivable from durable evidence alone (ledger + ownership records + action evidence), none
// provable only from an in-memory/narrative source.
// ---------------------------------------------------------------------------

test("conflict-aware parallel execution (#528): the full run reconstructs from durable evidence alone", async () => {
  const deps = await setup();
  const { observe, dispatchItem, getChangedFiles } = fakes();

  const ownershipEvidence = evaluateOwnershipEvidence(contract().items);
  const { token: planToken } = await acquireLock(deps, RUN_ID, "claude");
  await recordOwnershipEvidence(deps, RUN_ID, planToken, ownershipEvidence);
  await releaseLock(deps, RUN_ID, planToken);

  const drive = await driveSupervisor({ store: deps, observe, dispatchItem, getChangedFiles }, { runId: RUN_ID, engine: "claude" });
  assert.equal(drive.stop, null);

  // Reconstruct everything fresh from the store — never from a variable retained from the drive
  // above — proving each fact is durable evidence, not a narrative summary.
  const reconstructedEvents = await readEvents(deps, RUN_ID);
  const reconstructedLedger = await readLedger(deps, RUN_ID);
  const reconstructedActionEvidence = await readActionEvidence(deps, RUN_ID);
  const reconstructedOwnershipEvent = reconstructedEvents.find((e) => e.kind === "loop_ownership_evaluated");
  const reconstructedParallelizationLedger = parallelizationLedgerFromEvents(reconstructedEvents);
  const bundle = await buildLoopEvidenceBundle(deps, RUN_ID);

  assert.ok(reconstructedOwnershipEvent, "the ownership evaluation must be reconstructable as a durable planning record");
  const ownershipPairs = (reconstructedOwnershipEvent!.data as { pairs: Array<{ a_item_id: string; b_item_id: string; verdict: string }> }).pairs;
  assert.ok(ownershipPairs.some((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_CONFLICT && p.verdict === "conflict"));
  assert.ok(ownershipPairs.some((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_UNKNOWN && p.verdict === "conflict"));
  assert.ok(ownershipPairs.some((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_B && p.verdict === "disjoint"));

  assert.ok(reconstructedParallelizationLedger.length > 0, "the parallelization ledger must be non-empty and reconstructable from events alone");
  assert.deepEqual(bundle.parallelizationLedger, reconstructedParallelizationLedger, "the evidence bundle's ledger must match the standalone reconstruction exactly");

  for (const id of [ITEM_A, ITEM_B, ITEM_UNKNOWN, ITEM_CONFLICT, ITEM_DEP]) {
    assert.equal(reconstructedLedger.items[id].state, "ready", `item ${id}'s terminal state must be reconstructable from the durable ledger`);
    const dispatchEvidence = reconstructedActionEvidence.find((e) => e.action === "dispatch_item" && e.item_id === id);
    assert.ok(dispatchEvidence, `item ${id}'s dispatch must be a durable action-evidence record`);
    assert.ok(dispatchEvidence!.worktree_root, `item ${id}'s worktree identity must be reconstructable from durable action-evidence`);
  }

  assert.deepEqual(bundle.terminalOutcomes, {
    [ITEM_A]: "ready",
    [ITEM_B]: "ready",
    [ITEM_UNKNOWN]: "ready",
    [ITEM_CONFLICT]: "ready",
    [ITEM_DEP]: "ready",
  });
});

test("bite check: without recording ownership evidence, the conflict detection is not reconstructable from durable state — proves reconstruction is load-bearing, not incidental", async () => {
  const deps = await setup();
  // Deliberately skip recordOwnershipEvidence — the exact regression this leg guards against.
  const events = await readEvents(deps, RUN_ID);
  const ownershipEvent = events.find((e) => e.kind === "loop_ownership_evaluated");
  assert.equal(ownershipEvent, undefined, "without recording it, the ownership evaluation leaves no durable trace to reconstruct from");
});
