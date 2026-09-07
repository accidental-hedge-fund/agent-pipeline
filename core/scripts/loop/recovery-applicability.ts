import {
  filterRecipesForHarnessBackgroundWait,
  filterRecipesForNeverStartedPreflight,
} from "../harness-adapters/background-job-lifecycle.ts";
import { filterRecipesForWorkflowEngineDiagnostic } from "../rebind-tester-evidence-after-pr.ts";
import { projectStageDiagnostic, type StageDiagnostic } from "../stage-diagnostic.ts";
import type { DurableBlockerClass, RecoveryRecipe } from "./types.ts";

export interface RecoveryApplicabilityInput {
  action: RecoveryRecipe;
  blockerClass: DurableBlockerClass;
  diagnostic: StageDiagnostic;
  candidateHeadPresent: boolean;
}

export type RecoveryApplicability =
  | { applicable: true }
  | { applicable: false; reason: string };

/**
 * Shared selector/executor applicability contract for deterministic recovery
 * recipes. Applicability is diagnostic- and capability-based; recipe names do
 * not imply whether an action repairs content or only makes redispatch safe.
 */
export function recoveryRecipeApplicability(
  input: RecoveryApplicabilityInput,
): RecoveryApplicability {
  const projection = projectStageDiagnostic(input.diagnostic);
  if (projection.disposition !== "recover" || projection.blockerClass !== input.blockerClass) {
    return {
      applicable: false,
      reason: `diagnostic disposition ${projection.disposition} does not match class ${input.blockerClass}`,
    };
  }

  let eligible: readonly RecoveryRecipe[] = [input.action];
  if (input.diagnostic.reason_code === "harness-background-wait") {
    eligible = filterRecipesForHarnessBackgroundWait(eligible);
  }
  if (input.diagnostic.detail.preflight_failed === true) {
    eligible = filterRecipesForNeverStartedPreflight(eligible);
  }
  if (input.blockerClass === "workflow-engine-defect") {
    eligible = filterRecipesForWorkflowEngineDiagnostic(eligible, input.diagnostic);
  }
  if (!eligible.includes(input.action)) {
    return { applicable: false, reason: `diagnostic contract excludes ${input.action}` };
  }

  if (
    (input.action === "verify_head_goal" || input.action === "repair_pipeline_item") &&
    !input.candidateHeadPresent
  ) {
    return { applicable: false, reason: `${input.action} requires a current candidate head` };
  }
  if (
    input.action === "verify_head_goal" &&
    input.diagnostic.detail.blocker_kind !== "no-commits"
  ) {
    return {
      applicable: false,
      reason: `verify_head_goal does not apply to blocker_kind=${input.diagnostic.detail.blocker_kind}`,
    };
  }
  return { applicable: true };
}

/** Stable progress identity excludes run/transport envelopes and reason prose. */
export function recoveryProgressEvidence(input: {
  blockerClass: DurableBlockerClass;
  diagnostic: StageDiagnostic;
}): string {
  // An authoritative implementation stage is part of the invariant: planning
  // and implementing can run different goal checks even for the same blocker
  // kind. A later stage-omitted attestation is joined to its preceding
  // unresolved invariant by the supervisor's durable-history resolver, not by
  // erasing every stage here. Other classes retain the full diagnostic identity
  // so material facts such as HTTP status remain distinct.
  const { reason: _reason, ...invariantDetail } = input.diagnostic.detail;
  const evidence = input.blockerClass === "implementation-ci"
    ? {
        reason_code: input.diagnostic.reason_code,
        detail: invariantDetail,
      }
    : { diagnostic: input.diagnostic };
  return JSON.stringify({
    schema: "pipeline/recovery-progress-evidence@1",
    blocker_class: input.blockerClass,
    ...evidence,
  });
}

/** Production candidate identities encode an absent head as `head=none`. */
export function candidateHeadPresentInRecoveryIdentity(candidateIdentity: string): boolean {
  const match = /(?:^|\|)head=([^|]+)(?:\||$)/i.exec(candidateIdentity);
  return match ? match[1]!.toLowerCase() !== "none" : candidateIdentity.trim().length > 0;
}

/** These recipes prove only that normal whole-item redispatch is admissible. */
export function recoveryRecipeOnlyProvesRedispatch(action: RecoveryRecipe): boolean {
  return action === "rerun_ci" || action === "resync_workflow_state" ||
    action === "retry_upstream_check" || action === "restart_workflow_engine" ||
    action === "wait_and_retry" || action === "verify_authentication";
}
