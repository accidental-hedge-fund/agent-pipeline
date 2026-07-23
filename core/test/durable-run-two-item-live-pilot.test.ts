// The bounded two-item durable-loop live pilot (#515, capability
// `durable-run-two-item-live-pilot`). Proves — through the *existing*
// SupervisorDeps/ReconcileObserveDeps seams, with zero real network, git, or
// subprocess access anywhere in this file — that the composed durable-loop
// runtime (supervisor cycle, verified reconciliation, external-dependency
// merge-refresh barrier, recoverable-blocker recovery with same-item resume,
// evidence reporting, and the no-duplicate-external-action invariant) holds
// together across a real multi-item run with a real recoverable interruption.
//
// See openspec/changes/durable-run-two-item-live-pilot/design.md. This file
// is Tier 1 (the hermetic composition simulation); Tier 2 is the live-pilot
// runbook at docs/durable-run-two-item-live-pilot-runbook.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSupervisor,
  driveSupervisor,
  runSupervisorCycle,
  type SupervisorDeps,
} from "../scripts/loop/supervisor.ts";
import {
  acquireLock,
  appendActionEvidence,
  initRun,
  readActionEvidence,
  readEvents,
  readLedger,
  readLock,
  releaseLock,
  writeLedger,
  type LoopStoreDeps,
} from "../scripts/loop/store.ts";
import { blockItem, recoverItem, DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { computeExternalDependencyStatuses } from "../scripts/loop/dependencies.ts";
import { eligibleIndependentItems } from "../scripts/loop/recovery.ts";
import { reconcile, transitionItem, type ReconcileObserveDeps } from "../scripts/loop/reconcile.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";
import { LOOP_EXECUTION_CONTRACT_SCHEMA, type LoopExecutionRequest, type LoopExecutionResponse } from "../scripts/loop-execution-contract.ts";

const READY_LABEL = "pipeline:ready-to-deploy";
const ITEM_A = "100";
const ITEM_B = "200";
const PR_A = 501;
const PR_B = 502;

// ---------------------------------------------------------------------------
// 1.1/1.2 — shared pilot fixture builder + scripted execution fake.
// ---------------------------------------------------------------------------

let counter = 0;

function fakeDeps(): LoopStoreDeps {
  const files = new Map<string, string>();
  let clock = new Date("2026-07-23T00:00:00.000Z").getTime();
  let uuidCounter = 0;
  const env = { AGENT_PIPELINE_STATE_HOME: `/state-pilot-${counter++}` };

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

/** The bounded two-item fixture: item A with no dependencies, item B carrying
 *  an `external_depends_on` edge on A (design.md decision 2), under
 *  `max_active_items: 1`. */
function pilotContract(): LoopContract {
  return {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "pilot-run-1",
    engine: "claude",
    repo: { name: "acme/widgets", base_branch: "main" },
    selector: { type: "issue-set", value: [ITEM_A, ITEM_B] },
    objective: "two-item durable pilot (#515)",
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
      { id: ITEM_A, depends_on: [], external_depends_on: [] },
      { id: ITEM_B, depends_on: [], external_depends_on: [ITEM_A] },
    ],
    canonical_hash: "pilot-deadbeef",
  } as LoopContract;
}

function itemEntry(id: string): LoopLedger["items"][string] {
  return { id, state: "pending", history: [], recovery_budgets_remaining: { default: 3 } };
}

function pilotLedger(): LoopLedger {
  return {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "pilot-run-1",
    items: { [ITEM_A]: itemEntry(ITEM_A), [ITEM_B]: itemEntry(ITEM_B) },
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

/** Scripted observe + dispatch fakes sharing mutable pilot state: item A's
 *  dispatch outcome sequence (crash-after-recording-a-recoverable-blocker,
 *  then succeed) and a `merged` flag the test flips to model the human
 *  merging A's PR (design.md decision 4 — the pilot only observes it). */
function pilotFakes(deps: LoopStoreDeps, contract: LoopContract) {
  let aDispatchCount = 0;
  let aDispatched = false;
  let bDispatched = false;
  let aMerged = false;
  const calls: string[] = [];

  const observe: ReconcileObserveDeps = {
    async getIssueStateAndLabels(issueNumber) {
      if (issueNumber === Number(ITEM_A)) return { state: "open", labels: aDispatched ? [READY_LABEL] : [] };
      if (issueNumber === Number(ITEM_B)) return { state: "open", labels: bDispatched ? [READY_LABEL] : [] };
      return null;
    },
    async findPrForIssue(issueNumber) {
      if (issueNumber === Number(ITEM_A)) return aDispatched ? PR_A : null;
      if (issueNumber === Number(ITEM_B)) return bDispatched ? PR_B : null;
      return null;
    },
    async getPrDetail(prNumber) {
      if (prNumber === PR_A) {
        return { state: aMerged ? "merged" : "open", head_ref: "pipeline/100-x", head_sha: "sha-a", merge_commit_sha: aMerged ? "merge-sha-a" : null };
      }
      if (prNumber === PR_B) {
        return { state: "open", head_ref: "pipeline/200-x", head_sha: "sha-b", merge_commit_sha: null };
      }
      return null;
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
    async getExternalDependencyIssueState(issueNumber) {
      if (issueNumber === Number(ITEM_A)) return { state: "open", stateReason: null };
      return null;
    },
    now: () => new Date("2026-07-23T00:00:00.000Z"),
  };

  const dispatchItem: SupervisorDeps["dispatchItem"] = async (request: LoopExecutionRequest) => {
    calls.push(`dispatch:${request.item_id}`);
    if (request.item_id === ITEM_A) {
      aDispatchCount++;
      if (aDispatchCount === 1) {
        // Simulate the real per-item Pipeline execution recording a
        // recoverable blocker (a typed classification an outer failure
        // handler already resolved) durably BEFORE the process crashes —
        // exactly the interruption a same-item resume must survive.
        const lock = await readLock(deps, request.run_id);
        if (!lock) throw new Error("pilot fixture invariant: dispatchItem invoked with no lock held");
        await blockItem(deps, contract, {
          runId: request.run_id,
          token: lock.token,
          itemId: ITEM_A,
          engine: request.engine,
          blockerClass: "transient-rate-limit",
          evidence: "GitHub API rate limit exceeded while pushing commits for item 100",
        });
        throw new Error("simulated crash: dispatch process terminated after recording the blocker");
      }
      aDispatched = true;
      const response: LoopExecutionResponse = {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: ITEM_A,
        run_id: request.run_id,
        outcome: "ready_to_deploy",
        evidence: { pr_number: PR_A, pipeline_run_id: "pipeline-run-100" },
      };
      return response;
    }
    if (request.item_id === ITEM_B) {
      bDispatched = true;
      const response: LoopExecutionResponse = {
        schema: LOOP_EXECUTION_CONTRACT_SCHEMA,
        item_id: ITEM_B,
        run_id: request.run_id,
        outcome: "ready_to_deploy",
        evidence: { pr_number: PR_B, pipeline_run_id: "pipeline-run-200" },
      };
      return response;
    }
    throw new Error(`pilot fixture invariant: unexpected dispatch for item ${request.item_id}`);
  };

  return { observe, dispatchItem, calls, setAMerged: (v: boolean) => { aMerged = v; } };
}

async function setup(contract: LoopContract, ledger: LoopLedger) {
  const deps = fakeDeps();
  await initRun(deps, contract, ledger);
  return deps;
}

// ---------------------------------------------------------------------------
// 4 — evidence bundle: derived from recorded run state, never a narrative
// (design.md decision 5).
// ---------------------------------------------------------------------------

interface PilotEvidenceBundle {
  runId: string;
  items: LoopLedger["items"];
  recoveryAttempts: LoopLedger["recovery_attempts"];
  actionEvidence: Awaited<ReturnType<typeof readActionEvidence>>;
  reconciliations: Array<{ seq: number; time: string; data: unknown }>;
  mergeObservation: { itemId: string; identity: unknown } | null;
  terminal: { stop: LoopLedger["stop"]; allItemsDone: boolean };
}

const DONE_STATES = new Set(["ready", "merged", "released", "deployed", "abandoned", "skipped"]);

async function buildPilotEvidenceBundle(deps: LoopStoreDeps, runId: string): Promise<PilotEvidenceBundle> {
  const ledger = await readLedger(deps, runId);
  const actionEvidence = await readActionEvidence(deps, runId);
  const events = await readEvents(deps, runId);
  const reconciliations = events.filter((e) => e.kind === "loop_reconciled").map((e) => ({ seq: e.seq, time: e.time, data: e.data }));
  const aIdentity = ledger.items[ITEM_A]?.last_verified_identity;
  return {
    runId,
    items: ledger.items,
    recoveryAttempts: ledger.recovery_attempts,
    actionEvidence,
    reconciliations,
    mergeObservation: aIdentity ? { itemId: ITEM_A, identity: aIdentity } : null,
    terminal: {
      stop: ledger.stop,
      allItemsDone: Object.values(ledger.items).every((i) => DONE_STATES.has(i.state)),
    },
  };
}

// ---------------------------------------------------------------------------
// 6.1 — the composed end-to-end simulation.
// ---------------------------------------------------------------------------

test(
  "two-item durable pilot: recoverable blocker + same-item resume + merge-refresh barrier + evidence bundle + no duplicate external action, with zero real network/git/subprocess access",
  async () => {
    const contract = pilotContract();
    const ledger = pilotLedger();
    const deps = await setup(contract, ledger);
    const { observe, dispatchItem, calls, setAMerged } = pilotFakes(deps, contract);

    // --- 2.1: drive item A into a blocked transition carrying a recoverable
    // DurableBlockerClass; the dispatch "crashes" right after recording it. ---
    const { token: token1 } = await acquireLock(deps, "pilot-run-1", "claude");
    await assert.rejects(
      () => runSupervisorCycle({ store: deps, observe, dispatchItem }, "pilot-run-1", token1, "claude"),
      /simulated crash/,
    );

    const ledgerAfterCrash = await readLedger(deps, "pilot-run-1");
    assert.equal(ledgerAfterCrash.items[ITEM_A].state, "blocked");
    assert.equal(ledgerAfterCrash.items[ITEM_A].blocked_theme, "transient-rate-limit");
    assert.equal(ledgerAfterCrash.stop, null, "a recoverable (non-run_fatal) class must not stop the whole run");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_A}`).length, 1);

    // --- 2.1 (recovery): apply the recovery path back to in_progress, using
    // the still-held token (the crash was a thrown exception in-process; the
    // lock was never released). ---
    const recovered = await recoverItem(deps, contract, {
      runId: "pilot-run-1",
      token: token1,
      itemId: ITEM_A,
      engine: "claude",
      actions: ["wait_and_retry"],
      succeeded: true,
    });
    assert.equal(recovered.attempt.outcome, "recovered");
    assert.equal(recovered.ledger.items[ITEM_A].state, "in_progress");

    // Release the lock: the recovery step itself does not keep driving —
    // a subsequent resume takes over, mirroring a real crash-recovery boundary.
    await releaseLock(deps, "pilot-run-1", token1);

    // --- 3.1: while A's PR is still unmerged, B remains ineligible — checked
    // at the moment it matters most (A mid-recovery, not yet redispatched). ---
    let statuses = await computeExternalDependencyStatuses(observe, contract);
    assert.equal(statuses[ITEM_A], "pending");
    assert.deepEqual(eligibleIndependentItems(contract, recovered.ledger, statuses), []);

    // --- 2.2: exercise a supervisor resume over the now-free lock. attach
    // reports resumed:true; the resume reconciles first and appends a
    // "resume" action-evidence marker BEFORE the run continues driving the
    // SAME item A. (A single controlled cycle is driven directly here, rather
    // than via driveSupervisor's automatic loop, so the test can flip the
    // merge-observation fake at the exact safe boundary before continuing —
    // see the merge-refresh-barrier step below.) ---
    const attach = await attachSupervisor({ store: deps, observe, dispatchItem }, { runId: "pilot-run-1", engine: "claude", resume: true });
    assert.equal(attach.resumed, true);
    const token2 = attach.token;

    await reconcile(deps, observe, { runId: "pilot-run-1", token: token2, engine: "claude" });
    await appendActionEvidence(deps, "pilot-run-1", token2, {
      item_id: null,
      action: "resume",
      outcome: "resumed",
      next_action: null,
      progress: "progress",
    });

    const resumedCycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "pilot-run-1", token2, "claude");
    assert.equal(resumedCycle.stop, null);

    const trailAfterResume = await readActionEvidence(deps, "pilot-run-1");
    assert.ok(trailAfterResume.some((e) => e.action === "resume"), "a resume marker must be appended to the action-evidence trail");

    const ledgerAfterResumedCycle = await readLedger(deps, "pilot-run-1");
    const aFreshStarts = ledgerAfterResumedCycle.items[ITEM_A].history.filter((h) => h.to === "in_progress" && h.from === "pending");
    assert.equal(aFreshStarts.length, 1, "item A must never be freshly re-started from pending — its only pending->in_progress transition is the original start");
    const aRecoveries = ledgerAfterResumedCycle.items[ITEM_A].history.filter((h) => h.to === "in_progress" && h.from === "blocked");
    assert.equal(aRecoveries.length, 1, "exactly one recovery transition (blocked->in_progress) must be recorded — the same-item resume continuation");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_A}`).length, 2, "the resumed cycle dispatches the SAME item A a second time — a recovery continuation, not a fresh start");
    assert.equal(ledgerAfterResumedCycle.items[ITEM_A].state, "ready", "A's second dispatch succeeds and reaches ready, awaiting a human merge (golden rule #4: the pipeline never merges)");

    // --- 3.3: a caller-supplied claim that A is merged, absent a supporting
    // live observation, does NOT release B — the barrier resolves from
    // verified truth only (design.md decision 3). ---
    statuses = await computeExternalDependencyStatuses(observe, contract);
    assert.equal(statuses[ITEM_A], "pending", "A's PR is still observed unmerged");
    assert.deepEqual(eligibleIndependentItems(contract, ledgerAfterResumedCycle, statuses), [], "B must not be eligible while A's PR is unmerged");

    await assert.rejects(
      () => transitionItem(deps, observe, contract, { runId: "pilot-run-1", token: token2, itemId: ITEM_A, engine: "claude", to: "merged" }),
      /not supported by the engine's verified external identity/,
    );
    const ledgerAfterClaim = await readLedger(deps, "pilot-run-1");
    assert.equal(ledgerAfterClaim.items[ITEM_A].state, "ready", "a refused caller claim must leave A's ledger state untouched");
    statuses = await computeExternalDependencyStatuses(observe, contract);
    assert.deepEqual(eligibleIndependentItems(contract, ledgerAfterClaim, statuses), [], "B must still be ineligible after the refused caller claim");

    await releaseLock(deps, "pilot-run-1", token2);

    // --- 3.2 + 6.1 terminal: the human merges A's PR (out of band); the
    // pilot only observes it (design.md decision 4). Flipping the fake here —
    // BEFORE any further cycle runs — is what "the pilot only observes it"
    // means in the hermetic simulation. The very next reconciliation observes
    // the merge and clears the barrier; B becomes eligible on that same
    // cycle, subject to the single-active-item invariant, and the run drives
    // cleanly to its terminal condition. ---
    setAMerged(true);

    const finalDrive = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "pilot-run-1", engine: "claude" });
    assert.equal(finalDrive.stop, null);
    assert.equal(finalDrive.allDone, true);

    const finalLedger = await readLedger(deps, "pilot-run-1");
    assert.equal(finalLedger.items[ITEM_A].state, "merged", "A's ledger repairs forward to merged once the merge is verified-observed (never via a caller claim)");
    assert.equal(finalLedger.items[ITEM_B].state, "ready");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_B}`).length, 1, "B is dispatched exactly once, only after the barrier clears");
    assert.ok(finalLedger.last_reconciliation);
    assert.ok(finalLedger.last_reconciliation!.sequence > 0);

    // --- 5.1: no duplicate external action — a redundant reconciliation over
    // the already-merged item appends no new history and dispatches nothing. ---
    const historyLenBefore = finalLedger.items[ITEM_A].history.length;
    const { token: replayToken } = await acquireLock(deps, "pilot-run-1", "claude");
    await reconcile(deps, observe, { runId: "pilot-run-1", token: replayToken, engine: "claude" });
    await releaseLock(deps, "pilot-run-1", replayToken);
    const ledgerAfterReplay = await readLedger(deps, "pilot-run-1");
    assert.equal(ledgerAfterReplay.items[ITEM_A].history.length, historyLenBefore, "a redundant reconciliation over an already-merged item must append no new history entry");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_A}`).length, 2, "no additional dispatch for A after the replay");
    assert.equal(calls.filter((c) => c === `dispatch:${ITEM_B}`).length, 1, "no additional dispatch for B after the replay");

    // ...and a crash-and-resume replay (an extra cycle after the run is
    // already terminal) likewise dispatches nothing further.
    const { token: extraToken } = await acquireLock(deps, "pilot-run-1", "claude");
    const extraCycle = await runSupervisorCycle({ store: deps, observe, dispatchItem }, "pilot-run-1", extraToken, "claude");
    assert.equal(extraCycle.allDone, true);
    await releaseLock(deps, "pilot-run-1", extraToken);
    assert.equal(calls.filter((c) => c.startsWith("dispatch:")).length, 3, "no dispatch call beyond the original three (A's blocked attempt, A's recovered attempt, B) is ever recorded");

    // --- 4.1/4.2: the evidence bundle is derived from recorded run state and
    // locates every one of the five exercised behaviors. ---
    const bundle = await buildPilotEvidenceBundle(deps, "pilot-run-1");
    assert.ok(
      bundle.items[ITEM_A].history.some((h) => h.to === "blocked" && h.theme === "transient-rate-limit"),
      "recoverable blocker must be locatable in item A's ledger history",
    );
    assert.ok(
      bundle.recoveryAttempts.some((a) => a.item_id === ITEM_A && a.outcome === "recovered"),
      "the recovery attempt must be locatable in the recovery-attempts record",
    );
    assert.ok(bundle.actionEvidence.some((e) => e.action === "resume"), "the resume marker must be locatable in the action-evidence timeline");
    assert.ok(bundle.reconciliations.length > 0, "sequence-numbered reconciliation records must be locatable");
    assert.deepEqual(
      bundle.reconciliations.map((r) => r.seq),
      [...bundle.reconciliations.map((r) => r.seq)].sort((a, b) => a - b),
      "reconciliation records must be strictly sequence-ordered",
    );
    assert.ok(bundle.mergeObservation, "the merge observation that cleared the barrier must be locatable");
    assert.equal((bundle.mergeObservation!.identity as { pr_state: string }).pr_state, "merged");
    assert.equal(bundle.terminal.stop, null);
    assert.equal(bundle.terminal.allItemsDone, true, "the terminal condition must be locatable");
  },
);

// ---------------------------------------------------------------------------
// 6.3 — bite checks: each composed assertion is proven to fail when its
// underlying behavior is defeated.
// ---------------------------------------------------------------------------

test("bite check: skipping item A's recovery leaves the resumed run permanently gated (dependency_deadlock) instead of reaching completion — same-item resume is load-bearing", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { observe, dispatchItem } = pilotFakes(deps, contract);

  const { token: token1 } = await acquireLock(deps, "pilot-run-1", "claude");
  await assert.rejects(() => runSupervisorCycle({ store: deps, observe, dispatchItem }, "pilot-run-1", token1, "claude"), /simulated crash/);
  await releaseLock(deps, "pilot-run-1", token1);

  // No recoverItem call here — A stays blocked.
  const result = await driveSupervisor({ store: deps, observe, dispatchItem }, { runId: "pilot-run-1", engine: "claude", resume: true });

  assert.equal(result.allDone, false);
  assert.equal(result.stop?.reason, "dependency_deadlock", "without recovery, A stays blocked and B's external dependency never resolves, so the run cannot progress");
});

test("bite check: an item cannot be blocked twice without an intervening recovery — proves the no-duplicate-block invariant that idempotent replay relies on", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { token } = await acquireLock(deps, "pilot-run-1", "claude");

  await writeLedger(deps, { ...ledger, items: { ...ledger.items, [ITEM_A]: { ...ledger.items[ITEM_A], state: "in_progress" } } }, token);
  await blockItem(deps, contract, { runId: "pilot-run-1", token, itemId: ITEM_A, engine: "claude", blockerClass: "transient-rate-limit", evidence: "first block" });

  await assert.rejects(
    () => blockItem(deps, contract, { runId: "pilot-run-1", token, itemId: ITEM_A, engine: "claude", blockerClass: "transient-rate-limit", evidence: "second block attempt" }),
    /only an in_progress item may transition into blocked/,
  );
});

test("bite check: a caller cannot force a remote-proving transition without a supporting live observation — the barrier is not a caller assertion", async () => {
  const contract = pilotContract();
  const ledger = pilotLedger();
  const deps = await setup(contract, ledger);
  const { observe } = pilotFakes(deps, contract);
  const { token } = await acquireLock(deps, "pilot-run-1", "claude");

  await writeLedger(deps, { ...ledger, items: { ...ledger.items, [ITEM_A]: { ...ledger.items[ITEM_A], state: "in_progress" } } }, token);

  await assert.rejects(
    () => transitionItem(deps, observe, contract, { runId: "pilot-run-1", token, itemId: ITEM_A, engine: "claude", to: "ready" }),
    /not supported by the engine's verified external identity/,
    "with no PR ever dispatched, the observe seam supports no forward state — the transition must be refused",
  );
});
