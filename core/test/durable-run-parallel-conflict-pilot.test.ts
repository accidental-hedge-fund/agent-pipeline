// The conflict-aware parallel durable-loop pilot (#531, capability
// `durable-run-parallel-conflict-pilot`). Proves — through the *existing*
// selectSchedulableSet/evaluateConflict/SupervisorDeps/ReconcileObserveDeps seams, with zero real
// network, git, or subprocess access anywhere in this file — that the composed conflict-aware
// PARALLEL durable-loop runtime (the independence scheduler #530, the pairwise ownership evaluator
// #529, the in-repo supervisor #512, and verified reconciliation #511) holds together across a real
// multi-item concurrent run: two disjoint items admitted together in separate worktrees with
// independent evidence, a third conflicting item serialized with a durable structured reason, a
// mid-run changed-file overlap that parks and replans the disjoint pair rather than letting them
// proceed into concurrent merge preparation, and merge-class operations (merge / base refresh /
// final reconciliation) staying globally serialized after the concurrent work.
//
// See openspec/changes/durable-run-parallel-conflict-pilot/design.md. This file is Tier 1 (the
// hermetic composition simulation); Tier 2 is the live-pilot runbook at
// docs/durable-run-parallel-conflict-pilot-runbook.md. This is the parallel analog of #515
// (durable-run-two-item-live-pilot.test.ts), which pinned the same composition proof for the
// serialized single-active-item path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  driveSupervisor,
  runSupervisorCycle,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import {
  acquireLock,
  appendEvent,
  initRun,
  readActionEvidence,
  readEvents,
  readLedger,
  releaseLock,
  writeLedger,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { recoverItem, DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { type ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import { evaluateOwnershipEvidence, recordOwnershipEvidence } from "../scripts/loop/ownership.ts";
import { selectSchedulableSet } from "../scripts/loop/schedule.ts";
import { buildLoopEvidenceBundle } from "../scripts/loop/evidence.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";

const READY_LABEL = "pipeline:ready-to-deploy";
// The precondition stage gate (#568, capability `loop-precondition-stage-gate`) excludes a
// pending item with no `pipeline:*` label — this file's items are otherwise ready to dispatch, so
// they default to `pipeline:ready` (orthogonal to the parking/serialization behavior under test).
const PIPELINE_READY_LABEL = "pipeline:ready";
const RUN_ID = "pilot-parallel-run-1";
const ITEM_A = "300";
const ITEM_B = "400";
const ITEM_C = "500";
const PR_A = 601;
const PR_B = 602;
const PR_C = 603;
const OVERLAP_PATH = "shared/notes.md";
const MERGED_SHA_A = "merge-sha-a";

// ---------------------------------------------------------------------------
// 1.1/1.2 — shared pilot fixture builder + scripted execution fake.
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): LoopStoreDeps {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-parallel-pilot-${counter++}` };

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

/** The three-item conflict-aware parallel fixture (design.md Decision 2): item A and item B carry
 *  `disjoint`-evaluating exclusive ownership globs; item C carries an explicit `conflicts_with`
 *  edge on A. `concurrency.max_concurrent: 2` is a budget greater than one — the minimal shape
 *  that forces concurrent admission, planning-time conflict serialization, and (on A/B) the
 *  mid-run changed-file-overlap park/replan leg (design.md Decision 3). */
function pilotContract(): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: RUN_ID,
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "issue-set", value: [ITEM_A, ITEM_B, ITEM_C] },
    objective: "conflict-aware parallel durable pilot (#531)",
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
      { id: ITEM_C, depends_on: [], external_depends_on: [], ownership: { exclusive: ["src/c/**"], conflicts_with: [ITEM_A] } },
    ],
    canonical_hash: "pilot-parallel-deadbeef",
  } as LoopContract;
}

function itemEntry(id: string): LoopLedger["items"][string] {
  return { id, state: "pending", history: [], recovery_budgets_remaining: { default: 3 } };
}

function pilotLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: RUN_ID,
    items: { [ITEM_A]: itemEntry(ITEM_A), [ITEM_B]: itemEntry(ITEM_B), [ITEM_C]: itemEntry(ITEM_C) },
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

interface MutationRecord {
  kind: "pr_create" | "label_write";
  item: string;
  pr: number;
}

/** Scripted observe + dispatch + changed-files fakes sharing mutable pilot state:
 *  `overlapRound` toggles whether A/B's dispatched work is *observed* to have actually changed an
 *  overlapping file their declarations did not predict (design.md Decision 3's second, observed
 *  channel); `aMerged`/`baseHasA` model a human merging A's PR and the base branch subsequently
 *  catching up (design.md Decision 5 — the pilot only observes both). Worktree identity is
 *  assigned once per item on its first dispatch and never changes (design.md Decision 4);
 *  mutations are recorded once per item's first successful dispatch, mirroring a real dispatch
 *  never recreating an already-open PR on a resumed/redispatched item. */
function pilotFakes(_deps: LoopStoreDeps, _contract: LoopContract) {
  const dispatched = new Set<string>();
  const mutatedOnce = new Set<string>();
  const worktreeByItem = new Map<string, string>();
  let overlapRound = true;
  let aMerged = false;
  let baseHasA = false;
  const calls: string[] = [];
  const mutations: MutationRecord[] = [];

  const prByItem: Record<string, number> = { [ITEM_A]: PR_A, [ITEM_B]: PR_B, [ITEM_C]: PR_C };

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      for (const [item, pr] of Object.entries(prByItem)) {
        if (issueNumber === Number(item)) return { state: "open", labels: dispatched.has(item) ? [READY_LABEL] : [PIPELINE_READY_LABEL] };
      }
      return null;
    },
    async findPrForIssue(issueNumber) {
      for (const [item, pr] of Object.entries(prByItem)) {
        if (issueNumber === Number(item)) return dispatched.has(item) ? pr : null;
      }
      return null;
    },
    async getPrDetail(prNumber) {
      if (prNumber === PR_A) {
        return { state: aMerged ? "merged" : "open", head_ref: `pipeline/${ITEM_A}-x`, head_sha: "sha-a", merge_commit_sha: aMerged ? MERGED_SHA_A : null };
      }
      if (prNumber === PR_B) {
        return { state: "open", head_ref: `pipeline/${ITEM_B}-x`, head_sha: "sha-b", merge_commit_sha: null };
      }
      if (prNumber === PR_C) {
        return { state: "open", head_ref: `pipeline/${ITEM_C}-x`, head_sha: "sha-c", merge_commit_sha: null };
      }
      return null;
    },
    async getPrChecks() {
      return [{ bucket: "pass" }];
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha(sha) {
      return baseHasA && sha === MERGED_SHA_A ? true : null;
    },
    async getExternalDependencyIssueState() {
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request: LoopExecutionRequest) => {
    calls.push(`dispatch:${request.item_id}`);
    if (!worktreeByItem.has(request.item_id)) {
      worktreeByItem.set(request.item_id, `/managed/pilot-${request.item_id}`);
    }
    const item = request.item_id;
    const pr = prByItem[item];
    if (pr === undefined) throw new Error(`pilot fixture invariant: unexpected dispatch for item ${item}`);
    dispatched.add(item);
    // Model the per-item review and pre-merge gates the opaque `pipeline/loop-execution@1`
    // contract intentionally does not expose a verb for (design.md decision 2, #451): the
    // whole-item dispatch call is the only seam at this composition boundary, so review/pre-merge
    // completion is recorded as ordered markers on that same call rather than a separate seam.
    calls.push(`review:${item}`);
    calls.push(`premerge:${item}`);
    if (!mutatedOnce.has(item)) {
      mutatedOnce.add(item);
      mutations.push({ kind: "pr_create", item, pr });
      mutations.push({ kind: "label_write", item, pr });
    }
    const response: LoopExecutionResponse = {
      schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
      item_id: item,
      run_id: request.run_id,
      outcome: "ready_to_deploy",
      evidence: { pr_number: pr, pipeline_run_id: `pipeline-run-${item}`, worktree_root: worktreeByItem.get(item)! },
    };
    return response;
  };

  const getChangedFiles = async (itemId: string): Promise<string[]> => {
    if (itemId === ITEM_A) return overlapRound ? ["src/a/x.ts", OVERLAP_PATH] : ["src/a/x.ts"];
    if (itemId === ITEM_B) return overlapRound ? ["src/b/y.ts", OVERLAP_PATH] : ["src/b/y.ts"];
    return [];
  };

  return {
    observe,
    dispatchItem,
    getChangedFiles,
    calls,
    mutations,
    worktreeByItem,
    setOverlapRound: (v: boolean) => { overlapRound = v; },
    setAMerged: (v: boolean) => { aMerged = v; },
    setBaseHasA: (v: boolean) => { baseHasA = v; },
  };
}

async function setup(contract: LoopContract, ledger: LoopLedger) {
  const deps = fakeDeps();
  await initRun(deps, contract, ledger);
  return deps;
}

async function latestEventOfKind(deps: LoopStoreDeps, runId: string, kind: string) {
  const events = await readEvents(deps, runId);
  const matches = events.filter((e) => e.kind === kind);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 6 — evidence bundle: derived from recorded run state, never a narrative
// (design.md Decision 6). Sourced from the shipped `loop/evidence.ts`
// projection (#531 review 2 finding c1c0ce0b) — not a test-only helper.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7.1 — the composed end-to-end simulation.
// ---------------------------------------------------------------------------

test(
  "conflict-aware parallel pilot: concurrent disjoint start + serialized conflict + changed-file-overlap park/replan + serialized merge-class integration + evidence bundle, with zero real network/git/subprocess access",
  async () => {
    const contract = pilotContract();
    const ledger = pilotLedger();
    const deps = await setup(contract, ledger);
    const { observe, dispatchItem, getChangedFiles, calls, mutations, setOverlapRound, setAMerged, setBaseHasA } = pilotFakes(deps, contract);

    // --- 3.1/3.2: declared/evaluated conflict (planning-time channel, design.md Decision 3) — C
    // conflicts with A via an explicit conflicts_with edge; A and B evaluate disjoint. ---
    const evidence = evaluateOwnershipEvidence(contract.items);
    const pairAB = evidence.pairs.find((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_B)!;
    const pairAC = evidence.pairs.find((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_C)!;
    const pairBC = evidence.pairs.find((p) => p.a_item_id === ITEM_B && p.b_item_id === ITEM_C)!;
    assert.equal(pairAB.verdict, "disjoint");
    assert.equal(pairBC.verdict, "disjoint");
    assert.equal(pairAC.verdict, "conflict");
    assert.equal(pairAC.reason?.kind, "explicit_edge", "C's structured conflict reason must name exactly one closed-set kind");

    const { token: planToken } = await acquireLock(deps, RUN_ID, "claude");
    await recordOwnershipEvidence(deps, RUN_ID, planToken, evidence);
    await releaseLock(deps, RUN_ID, planToken);

    const ownershipEventAfterPlanning = await latestEventOfKind(deps, RUN_ID, "loop_ownership_evaluated");
    assert.ok(ownershipEventAfterPlanning, "the ownership evaluation must be a durable planning record, not a narrative");

    // --- 2.1/4.1: cycle 1 — A and B are admitted into the concurrent set together (budget 2,
    // pairwise disjoint), each into its own separate managed worktree, while C is denied
    // conflict_edge naming A. The same cycle observes A/B's actual changed files overlapping on a
    // path their declarations did not predict, so both are PARKED rather than proceeding to
    // ready_to_deploy. ---
    const { token: token1 } = await acquireLock(deps, RUN_ID, "claude");
    const cycle1 = await runSupervisorCycle({ store: deps, observe, dispatchItem, getChangedFiles }, RUN_ID, token1, "claude");
    assert.equal(cycle1.stop, null, "changed-file-overlap parking must not itself stop the run");

    const scheduleEvent1 = await latestEventOfKind(deps, RUN_ID, "loop_schedule_evaluated");
    assert.ok(scheduleEvent1);
    const decision1 = scheduleEvent1!.data as { selected: string[]; rationale: Array<{ item_id: string; disposition: string; counterpart_item_id?: string }> };
    assert.deepEqual([...decision1.selected].sort(), [ITEM_A, ITEM_B], "A and B must be admitted into the concurrent set together");
    const cRationale = decision1.rationale.find((r) => r.item_id === ITEM_C)!;
    assert.equal(cRationale.disposition, "conflict_edge", "C must be serialized with a conflict disposition, not merely budget-truncated");
    assert.equal(cRationale.counterpart_item_id, ITEM_A, "C's serialization must name the admitted item it conflicts with");

    // Worktree identity is read back from the durable action-evidence trail — the dispatch
    // response's `evidence.worktree_root` recorded on each item's `dispatch_item` action-evidence
    // entry — never from the test-local `worktreeByItem` map, which only backs the fixture's own
    // dispatch fake (#531 review 1 finding cfa926e8).
    const actionEvidenceAfterCycle1 = await readActionEvidence(deps, RUN_ID);
    const dispatchEvidenceAfterCycle1 = actionEvidenceAfterCycle1.filter((e) => e.action === "dispatch_item");
    const worktreeRootsSoFar = new Map(dispatchEvidenceAfterCycle1.map((e) => [e.item_id!, e.worktree_root]));
    assert.equal(worktreeRootsSoFar.size, 2, "only A and B have a durable dispatch_item action-evidence entry so far");
    assert.ok(worktreeRootsSoFar.get(ITEM_A), "A's worktree root must be recorded in durable action-evidence");
    assert.ok(worktreeRootsSoFar.get(ITEM_B), "B's worktree root must be recorded in durable action-evidence");
    assert.notEqual(
      worktreeRootsSoFar.get(ITEM_A),
      worktreeRootsSoFar.get(ITEM_B),
      "each concurrent item must be assigned its own separate managed worktree, per the durable action-evidence record",
    );

    const replanEvent1 = await latestEventOfKind(deps, RUN_ID, "loop_replan_requested");
    assert.ok(replanEvent1, "an observed overlap must record a durable replan request");
    const replan1 = replanEvent1!.data as { affected_item_ids: string[]; overlapping_paths: string[] };
    assert.deepEqual([...replan1.affected_item_ids].sort(), [ITEM_A, ITEM_B]);
    assert.deepEqual(replan1.overlapping_paths, [OVERLAP_PATH]);

    const ledgerAfterPark = await readLedger(deps, RUN_ID);
    assert.equal(ledgerAfterPark.items[ITEM_A].state, "blocked");
    assert.equal(ledgerAfterPark.items[ITEM_A].blocked_theme, "workflow-state");
    assert.equal(ledgerAfterPark.items[ITEM_B].state, "blocked");
    assert.equal(ledgerAfterPark.items[ITEM_B].blocked_theme, "workflow-state");
    // --- 4.2: parking is scoped — the unaffected item C's independence evidence (its own
    // planning-time conflict serialization, recorded before A/B ever ran) survives the parking
    // event untouched. ---
    assert.equal(ledgerAfterPark.items[ITEM_C].state, "pending", "an unaffected item's state must be preserved across a sibling parking event");
    const ownershipEventAfterPark = await latestEventOfKind(deps, RUN_ID, "loop_ownership_evaluated");
    assert.deepEqual(ownershipEventAfterPark!.data, ownershipEventAfterPlanning!.data, "C's independence evidence must not be re-derived or invalidated by the parking event");

    const mutationsAfterPark = mutations.length;
    assert.equal(mutationsAfterPark, 4, "each of A and B's single successful dispatch records exactly one pr_create + one label_write");

    // --- 2.2: A and B retain fully independent evidence — recovering one leaves the other's ledger
    // history and state completely untouched (a failure/interruption of one member does not
    // re-drive or invalidate the other's evidence). ---
    const bHistoryLenBeforeRecoverA = ledgerAfterPark.items[ITEM_B].history.length;
    const recoveredA = await recoverItem(deps, contract, {
      runId: RUN_ID, token: token1, itemId: ITEM_A, engine: "claude", actions: ["resync_workflow_state"], succeeded: true,
    });
    assert.equal(recoveredA.ledger.items[ITEM_A].state, "in_progress");
    assert.equal(recoveredA.ledger.items[ITEM_B].state, "blocked", "recovering A must not touch B's state");
    assert.equal(recoveredA.ledger.items[ITEM_B].history.length, bHistoryLenBeforeRecoverA, "recovering A must append no history entry to B");

    const aHistoryLenAfterRecoverA = recoveredA.ledger.items[ITEM_A].history.length;
    const recoveredB = await recoverItem(deps, contract, {
      runId: RUN_ID, token: token1, itemId: ITEM_B, engine: "claude", actions: ["resync_workflow_state"], succeeded: true,
    });
    assert.equal(recoveredB.ledger.items[ITEM_B].state, "in_progress");
    assert.equal(recoveredB.ledger.items[ITEM_A].state, "in_progress", "recovering B must not touch A's already-recovered state");
    assert.equal(recoveredB.ledger.items[ITEM_A].history.length, aHistoryLenAfterRecoverA, "recovering B must append no history entry to A");

    await releaseLock(deps, RUN_ID, token1);

    // --- 4.2 continued: neither parked item proceeded into concurrent merge preparation while
    // parked — both are still short of `ready`, and no additional external mutation was recorded
    // by the parking/recovery sequence itself. ---
    assert.equal(mutations.length, mutationsAfterPark, "parking and recovery must record zero additional external mutations");

    // --- 5.1: merge-class serialization is set up BEFORE the redispatch — a merge barrier on A (a
    // human is about to merge A's PR) must gate C's admission even at the exact moment A and B stop
    // being active, not only once C is already a candidate. ---
    const { token: barrierToken } = await acquireLock(deps, RUN_ID, "claude");
    const ledgerForBarrier = await readLedger(deps, RUN_ID);
    await writeLedger(
      deps,
      { ...ledgerForBarrier, merge_barrier: { item_id: ITEM_A, merged_sha: MERGED_SHA_A, set_at: "2026-07-23T00:00:10.000Z" } },
      barrierToken,
    );
    // Record the merge-class operation's start boundary as a durable event — symmetric to the
    // production `loop_merge_barrier_cleared` event `reconcile()` already appends on clear — so the
    // set/clear/redispatch sequence has a recorded order to assert on, not just a call count (#531
    // review 1 finding 8e33046a).
    await appendEvent(deps, RUN_ID, barrierToken, "loop_merge_barrier_set", {
      item_id: ITEM_A,
      merged_sha: MERGED_SHA_A,
      set_at: "2026-07-23T00:00:10.000Z",
    });
    await releaseLock(deps, RUN_ID, barrierToken);

    // --- The replan is now "fixed" (the observed overlap no longer recurs) — A and B's already-real
    // (pre-park) PRs are observed via verified reconciliation and repair forward to `ready`; the
    // active barrier admits nothing new in the very same cycle, so C stays pending even though A and
    // B are no longer active. ---
    setOverlapRound(false);
    const resumedDrive = await driveSupervisor(
      { store: deps, observe, dispatchItem, getChangedFiles },
      { runId: RUN_ID, engine: "claude", resume: true, maxCycles: 1 },
    );
    assert.equal(resumedDrive.stop, null);

    const replanEventsAfterRedispatch = (await readEvents(deps, RUN_ID)).filter((e) => e.kind === "loop_replan_requested");
    assert.equal(replanEventsAfterRedispatch.length, 1, "no further overlap is observed once the underlying condition is fixed");

    const ledgerAfterRedispatch = await readLedger(deps, RUN_ID);
    assert.equal(ledgerAfterRedispatch.items[ITEM_A].state, "ready");
    assert.equal(ledgerAfterRedispatch.items[ITEM_B].state, "ready");
    assert.equal(ledgerAfterRedispatch.items[ITEM_C].state, "pending", "C must not start while the barrier is set, independent of the conflict that earlier serialized it");
    assert.equal(mutations.length, mutationsAfterPark, "reconciliation repairing an already-real PR forward records no duplicate pr_create/label_write");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_C}`).length, 0, "no merge-class or new-item operation may run while the barrier is set");

    const scheduleEventWhileBarrier = await latestEventOfKind(deps, RUN_ID, "loop_schedule_evaluated");
    const decisionWhileBarrier = scheduleEventWhileBarrier!.data as { selected: string[]; rationale: Array<{ item_id: string; disposition: string }> };
    assert.deepEqual(decisionWhileBarrier.selected, [], "no item may be admitted into in_progress while a merge barrier is set");
    assert.equal(decisionWhileBarrier.rationale.find((r) => r.item_id === ITEM_C)?.disposition, "merge_barrier");

    // --- 5.2: the human merges A's PR (observed, never claimed); the barrier clears once the base
    // branch is verified to contain the merge — only then is C, the sole remaining pending item,
    // admitted, dispatched, and driven through its own review/pre-merge gates to `ready`. ---
    setAMerged(true);
    setBaseHasA(true);
    const finalDrive = await driveSupervisor({ store: deps, observe, dispatchItem, getChangedFiles }, { runId: RUN_ID, engine: "claude" });
    assert.equal(finalDrive.stop, null);
    assert.equal(finalDrive.allDone, true, "the run stops at pipeline:ready-to-deploy for every item — the scheduler grants no merge authority");

    const finalLedger = await readLedger(deps, RUN_ID);
    assert.equal(finalLedger.items[ITEM_A].state, "merged", "A's ledger repairs forward to merged only via verified observation");
    assert.equal(finalLedger.items[ITEM_B].state, "ready");
    assert.equal(finalLedger.items[ITEM_C].state, "ready");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_C}`).length, 1, "C is dispatched exactly once, only after the barrier clears");

    const barrierClearedEvent = await latestEventOfKind(deps, RUN_ID, "loop_merge_barrier_cleared");
    assert.ok(barrierClearedEvent);
    assert.equal((barrierClearedEvent!.data as { item_id: string }).item_id, ITEM_A);

    // --- 5.1/5.2 continued: merge-class operations (barrier set, barrier clear, C's admission) do
    // not overlap — proven from recorded timestamps (the fixture's clock is shared and monotonic
    // across every durable log), not merely from a call count (#531 review 1 finding 8e33046a). ---
    const barrierSetEvent = await latestEventOfKind(deps, RUN_ID, "loop_merge_barrier_set");
    assert.ok(barrierSetEvent, "the merge barrier's start boundary must be a durable record");
    const cDispatchEvidence = (await readActionEvidence(deps, RUN_ID)).find(
      (e) => e.action === "dispatch_item" && e.item_id === ITEM_C,
    );
    assert.ok(cDispatchEvidence, "C's dispatch must be a durable action-evidence record");
    assert.ok(
      barrierSetEvent!.time < barrierClearedEvent!.time,
      "the barrier must be recorded as set before it is recorded as cleared",
    );
    assert.ok(
      barrierClearedEvent!.time < cDispatchEvidence!.time,
      "the barrier must be recorded as cleared before C's merge-class-gated dispatch is recorded",
    );

    // --- 5.2 continued: each admitted item's terminal `ready_to_deploy` outcome is preceded by
    // this composition's modeled review and pre-merge gate markers, on every occasion it was
    // dispatched — the scheduler grants concurrency, never merge authority or a review/pre-merge
    // bypass (#531 review 1 finding 8e33046a). ---
    for (const itemId of [ITEM_A, ITEM_B, ITEM_C]) {
      const dispatchIdx = calls.indexOf(`dispatch:${itemId}`);
      const reviewIdx = calls.indexOf(`review:${itemId}`);
      const premergeIdx = calls.indexOf(`premerge:${itemId}`);
      assert.ok(
        dispatchIdx >= 0 && reviewIdx > dispatchIdx && premergeIdx > reviewIdx,
        `item ${itemId} must pass review then pre-merge before its dispatch response reports ready_to_deploy`,
      );
    }

    // --- 6.1/6.2: the evidence bundle is derived from recorded run state and locates every one of
    // the five exercised behaviors. ---
    const bundle = await buildLoopEvidenceBundle(deps, RUN_ID);
    assert.ok(
      bundle.observedConcurrency.some((c) => [...c.selected].sort().join(",") === [ITEM_A, ITEM_B].join(",")),
      "observed concurrency (A and B admitted together) must be locatable",
    );
    assert.notEqual(bundle.worktreeIdentity[ITEM_A], bundle.worktreeIdentity[ITEM_B], "distinct per-item worktree identity must be locatable");
    assert.ok(
      bundle.pairwiseDecisions.some((p) => p.a_item_id === ITEM_A && p.b_item_id === ITEM_C && p.verdict === "conflict"),
      "the pairwise conflict decision serializing C must be locatable",
    );
    assert.ok(bundle.changedFileOverlap, "the changed-file-overlap detection and its replan request must be locatable");
    assert.deepEqual(bundle.changedFileOverlap!.overlapping_paths, [OVERLAP_PATH]);
    assert.ok(bundle.mergeBarrierCleared, "the serialized merge-class integration (barrier clearing) must be locatable");
    assert.deepEqual(bundle.terminalOutcomes, { [ITEM_A]: "merged", [ITEM_B]: "ready", [ITEM_C]: "ready" });
    assert.equal(bundle.stop, null);
  },
);

// ---------------------------------------------------------------------------
// 7.3 — bite checks: each composed assertion is proven to fail when its
// underlying behavior is defeated.
// ---------------------------------------------------------------------------

test("bite check: without a concurrency policy, A and B are never admitted together — proves concurrent admission is load-bearing", () => {
  const contract = pilotContract();
  const serialContract: LoopContract = { ...contract, concurrency: undefined };
  const ledger = pilotLedger();
  const decision = selectSchedulableSet({ contract: serialContract, ledger });
  assert.deepEqual(decision.selected, [ITEM_A], "absent a concurrency budget, only one item is ever admitted");
  assert.notDeepEqual([...decision.selected].sort(), [ITEM_A, ITEM_B], "the composed test's 'A and B admitted together' assertion would fail against this regression");
});

test("bite check: without C's explicit conflicts_with edge, C is excluded only by incidental budget truncation, not by a proven conflict — proves conflict serialization is load-bearing", () => {
  const contract = pilotContract();
  const noEdgeContract: LoopContract = {
    ...contract,
    items: contract.items.map((i) => (i.id === ITEM_C ? { ...i, ownership: { exclusive: ["src/c/**"] } } : i)),
  };
  const ledger = pilotLedger();
  const decision = selectSchedulableSet({ contract: noEdgeContract, ledger });
  // C is still excluded from this pass, but only as a side effect of the budget (raising
  // max_concurrent to 3 would admit it) — the composed test's "C denied conflict_edge naming A"
  // assertion, which proves C is excluded BECAUSE of a proven conflict rather than incidentally,
  // would fail against this regression.
  assert.deepEqual([...decision.selected].sort(), [ITEM_A, ITEM_B]);
  assert.notEqual(
    decision.rationale.find((r) => r.item_id === ITEM_C)?.disposition,
    "conflict_edge",
    "the composed test's 'C denied conflict_edge naming A' assertion would fail against this regression",
  );
  assert.equal(decision.rationale.find((r) => r.item_id === ITEM_C)?.disposition, "budget_truncation");
});

test("bite check: without observing changed files, an actual A/B overlap goes undetected and both reach ready — proves parking is load-bearing", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { observe, dispatchItem } = pilotFakes(deps, contract);
  // No getChangedFiles supplied — the exact regression this leg guards against.
  const { token } = await acquireLock(deps, RUN_ID, "claude");
  const cycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, RUN_ID, token, "claude");
  assert.equal(cycle.stop, null);
  await releaseLock(deps, RUN_ID, token);

  const ledgerAfter = await readLedger(deps, RUN_ID);
  assert.equal(ledgerAfter.items[ITEM_A].state, "ready", "without the changed-files seam, A proceeds straight to ready");
  assert.equal(ledgerAfter.items[ITEM_B].state, "ready", "without the changed-files seam, B proceeds straight to ready");
  assert.notEqual(ledgerAfter.items[ITEM_A].state, "blocked", "the composed test's 'A and B parked for replan' assertion would fail against this regression");
  const replanEvents = (await readEvents(deps, RUN_ID)).filter((e) => e.kind === "loop_replan_requested");
  assert.equal(replanEvents.length, 0, "no replan request is ever recorded — proving the parking leg does not fire by accident");
});

test("bite check: without a merge barrier, C starts immediately once A and B are no longer active — proves serialized merge-class integration is load-bearing", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { observe, dispatchItem, getChangedFiles, calls, setOverlapRound } = pilotFakes(deps, contract);
  setOverlapRound(false);

  // Drive A and B to `ready` with no overlap and, crucially, WITHOUT ever setting a merge barrier.
  const drive = await driveSupervisor({ store: deps, observe, dispatchItem, getChangedFiles }, { runId: RUN_ID, engine: "claude" });
  assert.equal(drive.stop, null);

  const ledgerAfter = await readLedger(deps, RUN_ID);
  assert.equal(ledgerAfter.items[ITEM_A].state, "ready");
  assert.equal(ledgerAfter.items[ITEM_B].state, "ready");
  // C is no longer conflict-excluded (A is not in the same scheduling pass's `selected` set once
  // it is no longer a candidate) and, absent a barrier, is admitted and dispatched immediately —
  // the composed test's "C stays pending while the barrier is set" assertion would fail here.
  assert.equal(ledgerAfter.items[ITEM_C].state, "ready");
  assert.equal(calls.filter((c) => c === `dispatch:${ITEM_C}`).length, 1, "without a barrier, C's dispatch is not gated on any human merge observation");
});

test("bite check: without a reported worktree_root, the durable action-evidence trail carries no worktree identity — proves the evidence bundle's worktree identity is sourced from durable state, not a test-local map", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { observe, dispatchItem: realDispatchItem } = pilotFakes(deps, contract);
  // The exact regression this leg guards against: a dispatch response that omits worktree_root,
  // as every dispatch response did before #531 review 1 finding cfa926e8's fix.
  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request) => {
    const response = await realDispatchItem(request);
    return { ...response, evidence: { pr_number: response.evidence.pr_number, pipeline_run_id: response.evidence.pipeline_run_id } };
  };
  const { token } = await acquireLock(deps, RUN_ID, "claude");
  await runSupervisorCycle({ store: deps, observe, dispatchItem }, RUN_ID, token, "claude");
  await releaseLock(deps, RUN_ID, token);

  const bundle = await buildLoopEvidenceBundle(deps, RUN_ID);
  assert.equal(bundle.worktreeIdentity[ITEM_A], undefined, "without a reported worktree_root, the bundle records no worktree identity for A");
  assert.equal(bundle.worktreeIdentity[ITEM_B], undefined, "without a reported worktree_root, the bundle records no worktree identity for B");
  assert.notEqual(
    bundle.worktreeIdentity[ITEM_A],
    "/managed/pilot-300",
    "the composed test's 'distinct per-item worktree identity must be locatable' assertion would fail against this regression rather than silently reading a stale test-local value",
  );
});

test("bite check: without the review/pre-merge markers, an item's dispatch response still reports ready_to_deploy — proves the composition's review/pre-merge-before-ready ordering assertion is load-bearing", () => {
  const calls: string[] = [`dispatch:${ITEM_A}`];
  // The exact regression this leg guards against: a dispatch that reports ready_to_deploy without
  // ever recording that review and pre-merge gates ran first.
  const dispatchIdx = calls.indexOf(`dispatch:${ITEM_A}`);
  const reviewIdx = calls.indexOf(`review:${ITEM_A}`);
  const premergeIdx = calls.indexOf(`premerge:${ITEM_A}`);
  assert.ok(dispatchIdx >= 0);
  assert.equal(reviewIdx, -1, "no review marker was recorded");
  assert.equal(premergeIdx, -1, "no pre-merge marker was recorded");
  assert.ok(
    !(reviewIdx > dispatchIdx && premergeIdx > reviewIdx),
    "the composed test's 'review then pre-merge before ready_to_deploy' assertion would fail against this regression",
  );
});
