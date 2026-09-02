// Closed RecoverySupervisor lifecycle-state law (#1322). Injected facts only.

import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import { lookupCommandForm } from "../scripts/command-form-inventory.ts";
import { hostCatalogVerbsMissingForms } from "../scripts/command-form-inventory.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";
import { STAGES, TERMINAL_STAGES } from "../scripts/types.ts";
import { observationFromAdapterAttempt } from "../scripts/issue-stage-adapters.ts";
import {
  PUBLIC_TYPED_REQUESTS,
  resolveTypedRequest,
  validateAuthorityRequest,
} from "../scripts/typed-request-resolution.ts";
import {
  autoLoopExhaustedBlockedOutcome,
  iterationBudgetExhaustedMessage,
  materializeExhaustedBlockedOutcome,
  MAX_ITERATIONS,
} from "../scripts/pipeline-run.ts";
import { interventionKindGrantsHumanOwnership } from "../scripts/intervention.ts";
import {
  AUTHORITATIVE_OBSERVER_SYSTEMS,
  FORBIDDEN_PUBLIC_LIFECYCLE_VERBS,
  LEGACY_TERMINAL_MIGRATION,
  MECHANICAL_FAULT_CLASSES,
  RECOVERY_LIFECYCLE_STATES,
  assertRecoveryLifecycleState,
  compatibilityStopAllowsIndependentSiblings,
  deriveLifecycleState,
  executionDispositionForForm,
  isRecoveryLifecycleState,
  lifecycleAfterProcessExit,
  lifecycleForMechanicalFault,
  mutatingSurfaceVerbsMissingInventory,
  observerCatalogHas,
  registeredForbiddenLifecycleVerbs,
  supervisorCycleDispositionForStop,
  typedRequestForRawFailure,
} from "../scripts/recovery-lifecycle-ownership.ts";
import { collectNeedsHumanParkWithoutClassifier } from "../scripts/fault-recovery-static-guards.ts";
import {
  eligibleIndependentItems,
} from "../scripts/loop/recovery.ts";
import {
  LOOP_CONTRACT_SCHEMA,
  LOOP_LEDGER_SCHEMA,
  type LoopContract,
  type LoopLedger,
} from "../scripts/loop/types.ts";

test("1.1 closed lifecycle-state union round-trips six values and rejects a seventh", () => {
  assert.deepEqual([...RECOVERY_LIFECYCLE_STATES], [
    "active",
    "cooling",
    "external-condition-wait",
    "typed-input-wait",
    "succeeded",
    "cancelled",
  ]);
  for (const state of RECOVERY_LIFECYCLE_STATES) {
    assert.equal(isRecoveryLifecycleState(state), true);
    assert.equal(assertRecoveryLifecycleState(state), state);
  }
  assert.equal(isRecoveryLifecycleState("waiting"), false);
  assert.equal(isRecoveryLifecycleState("complete"), false);
  assert.equal(isRecoveryLifecycleState("needs-human"), false);
  assert.throws(() => assertRecoveryLifecycleState("ownerless"), /invalid recovery lifecycle state/);
  assert.throws(() => assertRecoveryLifecycleState("terminal"), /invalid recovery lifecycle state/);
});

test("1.2 leftover needs-human label without a typed request is not typed-input-wait", () => {
  const out = deriveLifecycleState({
    labels: ["pipeline:needs-human", "pipeline:review-2"],
    typedRequest: null,
  });
  assert.equal(out.state, "cooling");
  assert.equal(out.owned, true);
  assert.equal(out.ownerless, false);
  assert.equal(out.human_owned, false);
  assert.equal(out.typed_request, null);
  assert.notEqual(out.state, "typed-input-wait");
  assert.notEqual(out.state, "cancelled");
});

test("1.2 blocked label and train STOP are compatibility projections, not lifecycle truth", () => {
  const blocked = deriveLifecycleState({ labels: ["blocked"], typedRequest: null });
  assert.equal(blocked.state, "cooling");
  const trainStop = deriveLifecycleState({ trainOutcome: "STOP" });
  assert.equal(trainStop.state, "cooling");
  assert.equal(trainStop.cancelled, false);
  const stopReason = deriveLifecycleState({ stopReason: "run_fatal" });
  assert.equal(stopReason.state, "cooling");
});

test("1.3 STAGES and TERMINAL_STAGES membership is unchanged", () => {
  assert.equal(STAGES.length, 18);
  assert.equal(STAGES[STAGES.length - 1], "needs-human");
  assert.deepEqual([...TERMINAL_STAGES].sort(), ["needs-human", "ready-to-deploy"]);
});

test("2.1 mechanical faults stay cooling or external-condition-wait", () => {
  for (const fault of MECHANICAL_FAULT_CLASSES) {
    const out = lifecycleForMechanicalFault(fault);
    assert.equal(out.owned, true, fault);
    assert.equal(out.ownerless, false, fault);
    assert.equal(out.human_owned, false, fault);
    assert.equal(out.cancelled, false, fault);
    assert.notEqual(out.state, "typed-input-wait", fault);
    assert.notEqual(out.state, "cancelled", fault);
    assert.notEqual(out.state, "succeeded", fault);
    if (fault === "capacity") {
      assert.equal(out.state, "external-condition-wait", fault);
    } else {
      assert.equal(out.state, "cooling", fault);
    }
  }
});

test("2.2 synthetic needs-human bypass without classifier fails the guard", () => {
  const synthetic = `await transitionFn(cfg, issueNumber, "fix-2", "needs-human", "retry exhausted");\n`;
  const hits = collectNeedsHumanParkWithoutClassifier(synthetic, "scripts/stages/fix.ts");
  assert.ok(hits.some((h) => /needs-human park without shared classifier/.test(h.reason)));
});

test("2.3 DecisionRequest, CapabilityRequest, and AuthorityRequest stay distinct; raw failure emits none", () => {
  assert.deepEqual([...PUBLIC_TYPED_REQUESTS], [
    "DecisionRequest",
    "CapabilityRequest",
    "AuthorityRequest",
  ]);
  const decision = deriveLifecycleState({ typedRequest: "DecisionRequest" });
  const capability = deriveLifecycleState({ typedRequest: "CapabilityRequest" });
  const authority = deriveLifecycleState({ typedRequest: "AuthorityRequest" });
  assert.equal(decision.state, "typed-input-wait");
  assert.equal(capability.state, "typed-input-wait");
  assert.equal(authority.state, "typed-input-wait");
  assert.equal(decision.typed_request, "DecisionRequest");
  assert.equal(capability.typed_request, "CapabilityRequest");
  assert.equal(authority.typed_request, "AuthorityRequest");
  assert.notEqual(decision.typed_request, authority.typed_request);
  assert.equal(typedRequestForRawFailure(), null);
  const raw = deriveLifecycleState({
    processExitCode: 1,
    faultClass: "mechanical-failure",
    typedRequest: typedRequestForRawFailure(),
  });
  assert.equal(raw.typed_request, null);
  assert.notEqual(raw.state, "typed-input-wait");
});

test("2.4 reversible recommendation auto-settles; AuthorityRequest never defaults a grant", () => {
  const reversible = resolveTypedRequest({
    nodeClass: "interface-contract",
    recommendation: "REST",
    factText: "REST",
  });
  assert.equal(reversible.kind, "auto-settle");
  const settled = deriveLifecycleState({ typedRequest: null, activeAttempt: true });
  assert.notEqual(settled.state, "typed-input-wait");

  const granted = validateAuthorityRequest({
    eligible_actor: "operator",
    repository: "acme/repo",
    operation: "merge",
    scope: "pr:1",
    candidate_epoch: "abc",
    evidence: ["review current"],
    expiry: "2026-09-16T00:00:00Z",
    grant: "yes",
  });
  assert.equal(granted.ok, false);
  const bound = validateAuthorityRequest({
    eligible_actor: "operator",
    repository: "acme/repo",
    operation: "merge",
    scope: "pr:1",
    candidate_epoch: "abc",
    evidence: ["review current"],
    expiry: "2026-09-16T00:00:00Z",
    grant: null,
  });
  assert.equal(bound.ok, true);
  if (bound.ok) assert.equal(bound.record.grant, null);
});

test("3.1 live run_fatal projects Cooling; siblings remain schedulable; operation is not cancelled", () => {
  const life = deriveLifecycleState({ stopReason: "run_fatal" });
  assert.equal(life.state, "cooling");
  assert.equal(life.cancelled, false);
  assert.equal(life.ownerless, false);
  assert.equal(compatibilityStopAllowsIndependentSiblings("run_fatal"), true);

  const contract: LoopContract = {
    schema: LOOP_CONTRACT_SCHEMA,
    run_id: "run-1",
    repo: { name: "acme/repo", base_branch: "main" },
    selector: { kind: "explicit", issues: [100, 200] },
    items: [
      { id: "100", depends_on: [] },
      { id: "200", depends_on: [] },
    ],
    created_at: "2026-09-02T00:00:00.000Z",
  };
  const ledger = {
    schema: LOOP_LEDGER_SCHEMA,
    run_id: "run-1",
    items: {
      "100": { id: "100", state: "blocked", history: [], recovery_budgets_remaining: { default: 3 } },
      "200": { id: "200", state: "pending", history: [], recovery_budgets_remaining: { default: 3 } },
    },
    consecutive_blocked: 0,
    merge_barrier: null,
    stop: { reason: "run_fatal", time: "2026-09-02T00:00:00.000Z", item_id: "100", theme: "workflow-engine-defect" },
    last_native_goal_check: null,
    last_reconciliation: null,
    reconciliation_sequence: 0,
    recovery_attempts: [],
  } as LoopLedger;
  assert.deepEqual(eligibleIndependentItems(contract, ledger), ["200"]);
  const withSiblings = supervisorCycleDispositionForStop({
    stop: ledger.stop,
    hasSchedulableSibling: true,
  });
  assert.equal(withSiblings.continueSiblings, true);
  assert.equal(withSiblings.stop, null);
  assert.equal(withSiblings.cooling, null);
  const noSiblings = supervisorCycleDispositionForStop({
    stop: ledger.stop,
    hasSchedulableSibling: false,
  });
  assert.equal(noSiblings.continueSiblings, false);
  assert.equal(noSiblings.stop, null);
  assert.equal(noSiblings.cooling?.reason, "mechanical_exhaustion");
  assert.equal(noSiblings.cooling?.historical_evidence, "run_fatal");
});

test("3.2 recovery_exhausted is Cooling, not human ownership", () => {
  const life = deriveLifecycleState({ stopReason: "recovery_exhausted", cooling: true });
  assert.equal(life.state, "cooling");
  assert.equal(life.human_owned, false);
  assert.equal(LEGACY_TERMINAL_MIGRATION.recovery_exhausted, "cooling");
});

test("3.3 repeated_no_progress is item-local Cooling; siblings stay schedulable", () => {
  const life = deriveLifecycleState({ stopReason: "repeated_no_progress" });
  assert.equal(life.state, "cooling");
  assert.equal(compatibilityStopAllowsIndependentSiblings("repeated_no_progress"), true);
  const noSibling = supervisorCycleDispositionForStop({
    stop: { reason: "repeated_no_progress", time: "2026-09-02T00:00:00.000Z", item_id: "100" },
    hasSchedulableSibling: false,
  });
  assert.equal(noSibling.stop, null);
  assert.equal(noSibling.cooling?.reason, "mechanical_exhaustion");
  assert.equal(noSibling.cooling?.historical_evidence, "repeated_no_progress");
});

test("3.4 MAX_ITERATIONS and auto-loop exhaustion are Cooling, not human-owned needs-human", () => {
  assert.equal(MAX_ITERATIONS, 12);
  const wait = { advanced: false as const, status: "waiting" as const, reason: "CI still running" };
  const auto = autoLoopExhaustedBlockedOutcome(wait, "review-1");
  const mapped = deriveLifecycleState({
    labels: ["pipeline:review-1", "blocked"],
    typedRequest: null,
    faultClass: "retry-exhaustion",
  });
  assert.equal(mapped.state, "cooling");
  assert.notEqual(auto.status, "finalized");
  assert.notEqual(mapped.state, "typed-input-wait");
  const iteration = materializeExhaustedBlockedOutcome(
    wait,
    "review-1",
    iterationBudgetExhaustedMessage("review-1", 1322),
  );
  assert.notEqual(iteration.blockerKind, "human-decision-required");
  const preMerge = materializeExhaustedBlockedOutcome(
    wait,
    "pre-merge",
    iterationBudgetExhaustedMessage("pre-merge", 1322),
  );
  assert.equal(preMerge.blockerKind, "ci-exhausted");
});

test("3.5 historical run_fatal remains the --resume handle while live treatment is Cooling", () => {
  const live = deriveLifecycleState({ stopReason: "run_fatal" });
  assert.equal(live.state, "cooling");
  assert.equal(LEGACY_TERMINAL_MIGRATION.run_fatal, "cooling");
  assert.equal(compatibilityStopAllowsIndependentSiblings("human_authority"), false);
});

test("4.1 every mutating OPERATION_SURFACE verb has a command-form inventory disposition", () => {
  assert.deepEqual(mutatingSurfaceVerbsMissingInventory(), []);
  const missing = hostCatalogVerbsMissingForms(["ghost-host-verb"]);
  assert.deepEqual(missing, ["ghost-host-verb"]);
  assert.equal(executionDispositionForForm("merge"), "supervised-lifecycle");
  assert.equal(lookupCommandForm("merge")?.authority_requirement, "protected-authority");
  assert.equal(executionDispositionForForm("merge-queue.dry-run"), "read-only");
  assert.equal(executionDispositionForForm("train.dry-run"), "read-only");
});

test("4.2 exit 0 without observer proof is not succeeded", () => {
  const after = lifecycleAfterProcessExit({
    exitCode: 0,
    observerProvedPostcondition: false,
    observerSystem: "git",
  });
  assert.notEqual(after.state, "succeeded");
  assert.equal(after.state, "cooling");
  const proven = lifecycleAfterProcessExit({
    exitCode: 0,
    observerProvedPostcondition: true,
    observerSystem: "merge",
  });
  assert.equal(proven.state, "succeeded");
  const obs = observationFromAdapterAttempt({
    stage: "implementing",
    domain: "agent-pipeline",
    logical_operation_id: "lop-" + "a".repeat(32),
    repository: "acme/repo",
    issue: 1322,
    exitCode: 0,
    postconditionProven: false,
    message: "process exited 0",
  });
  assert.equal(obs.complete, false);
  assert.equal(obs.process_exit_is_completion, false);
  assert.notEqual(obs.lifecycle, "complete");
  for (const system of AUTHORITATIVE_OBSERVER_SYSTEMS) {
    assert.equal(observerCatalogHas(system), true, system);
  }
});

test("4.3 no new public lifecycle CLI verb is registered", () => {
  assert.deepEqual(registeredForbiddenLifecycleVerbs(), []);
  for (const verb of FORBIDDEN_PUBLIC_LIFECYCLE_VERBS) {
    assert.equal(verb in COMMAND_REGISTRY, false, verb);
  }
});

test("reporting-only intervention kinds do not grant human ownership", () => {
  assert.equal(interventionKindGrantsHumanOwnership("test-build-failure"), false);
  assert.equal(interventionKindGrantsHumanOwnership("review-non-convergence"), false);
  assert.equal(interventionKindGrantsHumanOwnership("unknown"), false);
});

test("authenticated cancel is the only cancelled exit; exhaustion is Cooling", () => {
  const cancel = deriveLifecycleState({ cancelledByAuthenticatedCaller: true });
  assert.equal(cancel.state, "cancelled");
  const exhaust = deriveLifecycleState({ faultClass: "retry-exhaustion" });
  assert.equal(exhaust.state, "cooling");
  assert.equal(exhaust.cancelled, false);
});
