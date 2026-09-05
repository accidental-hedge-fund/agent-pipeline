// Issue-advancement stages as RecoverySupervisor operation adapters (#1328).
//
// Each delivery stage performs one bounded attempt and reports a typed
// observation. RecoverySupervisor remains the sole lifecycle owner. This
// module is not a second supervisor, worktree subsystem, attempt ledger,
// grant schema, or public CLI verb.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMigratedOutcome, type MigratedOutcome } from "./escalation-dispositions.ts";
import {
  completedOperationObservation,
  consumeOwnedOperation,
  mayReplaySideEffect,
  mechanicalFaultObservation,
  mintObservationIdentity,
  ownedAdmissionObservation,
  persistOperationObservation,
  loadOwnedOperationClaim,
  reportMechanicalFault,
  reportOwnedOperation,
  treatmentForSideEffectCertainty,
  type ObservationLifecycleState,
  type ArtifactEvidenceRole,
  type OperationObservation,
  type ReportOperationObservation,
  type SideEffectCertainty,
} from "./operation-observation.ts";
import {
  assertCompleteRecoveryEpisodeKey,
  assertCursorDoesNotRegress,
  assertRecoveryEpisodeFields,
  emptyEpisode,
  normalizeEvidenceIdentity,
  recoveryEpisodeId,
  resumeEpisodeFromAttempts,
  type RecoveryEpisodeKey,
} from "./loop/recovery-episodes.ts";
import type { LoopRecoveryAttempt } from "./loop/types.ts";
import {
  claimStageAttempt,
  persistStageAttemptLedger,
  type StageAttemptLedger,
} from "./stage-attempt-ledger.ts";
import type { BlockerKind, Outcome, PipelineConfig } from "./types.ts";

export const DELIVERY_STAGE_OPERATION = "issue_delivery_stage" as const;

/** Delivery stages from `planning` through `ready-to-deploy`. Admission waits
 *  (`backlog`, `needs-spec`) and the `ready` claim-to-plan hop are not adapters. */
export const DELIVERY_STAGES = [
  "planning",
  "plan-review",
  "pre-code-attestation",
  "implementing",
  "design-gate",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "pre-merge",
  "visual-gate",
  "eval-gate",
  "shipcheck-gate",
  "ready-to-deploy",
] as const;

export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export function isDeliveryStage(stage: string): stage is DeliveryStage {
  return (DELIVERY_STAGES as readonly string[]).includes(stage);
}

export const OPERATION_INVARIANT_FIELDS = [
  "precondition",
  "postcondition",
  "observer",
  "candidate_binding",
  "replay_rule",
  "side_effect_identity",
  "safe_replay_predicate",
  "reconstruction_rule",
] as const;

export type OperationInvariantField = (typeof OPERATION_INVARIANT_FIELDS)[number];

export interface DeliveryStageInvariant {
  operation: DeliveryStage;
  precondition: string;
  postcondition: string;
  observer: string;
  candidate_binding: string;
  replay_rule: string;
  side_effect_identity: string;
  safe_replay_predicate: string;
  reconstruction_rule: string;
}

/** Names required invariant fields that are missing or blank. */
export function missingOperationInvariantFields(
  inv: Partial<Record<OperationInvariantField, string>> | null | undefined,
): OperationInvariantField[] {
  if (inv == null) return [...OPERATION_INVARIANT_FIELDS];
  return OPERATION_INVARIANT_FIELDS.filter((field) => {
    const value = inv[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

const INVARIANT_BY_STAGE: Record<DeliveryStage, DeliveryStageInvariant> = {
  planning: {
    operation: "planning",
    precondition: "issue is admitted at pipeline:ready or recovered planning; no live foreign workspace owner",
    postcondition: "a plan artifact is bound to this issue and the stage label has advanced past planning",
    observer: "GitHub issue comments plus pipeline stage label",
    candidate_binding: "repository, issue, planning worktree branch",
    replay_rule: "observe existing plan artifact before re-authoring; do not treat process exit as completion",
    side_effect_identity: "plan artifact for this issue and candidate epoch",
    safe_replay_predicate: "replay only when the observer proves the plan artifact is absent",
    reconstruction_rule: "reconstruct local claim from GitHub comments and stage label; do not write labels as repair",
  },
  "plan-review": {
    operation: "plan-review",
    precondition: "a completed plan artifact exists for the issue",
    postcondition: "plan-review verdict is recorded against the bound plan and the stage may advance",
    observer: "schema-satisfying plan-review verdict on the issue",
    candidate_binding: "repository, issue, plan artifact identity",
    replay_rule: "observe the latest plan-review verdict before replay; malformed output is not a pass",
    side_effect_identity: "plan-review verdict bound to the plan artifact identity",
    safe_replay_predicate: "replay only when no schema-satisfying verdict exists for this plan identity",
    reconstruction_rule: "reconstruct local claim from the latest schema-satisfying verdict; do not post a new verdict as repair",
  },
  "pre-code-attestation": {
    operation: "pre-code-attestation",
    precondition: "plan-review is complete; attestation is enabled and a risk trigger matches, or the stage is inert",
    postcondition: "attestation is approved, inert-passed, or a typed authority hold is projected",
    observer: "pre-code attestation state comments plus stage label",
    candidate_binding: "repository, issue, plan identity",
    replay_rule: "observe current attestation state before creating a new hold",
    side_effect_identity: "attestation state comment for this plan identity",
    safe_replay_predicate: "replay only when attestation state is proven absent for this plan identity",
    reconstruction_rule: "reconstruct local claim from attestation comments; do not create a new hold as repair",
  },
  implementing: {
    operation: "implementing",
    precondition: "planning is complete; a managed worktree exists or can be materialized",
    postcondition: "implementation commits exist on the candidate or a clean no-op goal is satisfied",
    observer: "git ancestry of the issue branch versus base plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "observe HEAD and goal satisfaction before treating a no-new-commit as success",
    side_effect_identity: "implementation commits on the candidate branch for this epoch",
    safe_replay_predicate: "replay only when git ancestry proves those commits are absent",
    reconstruction_rule: "reconstruct local HEAD and claim from git; do not push or open a PR as repair",
  },
  "design-gate": {
    operation: "design-gate",
    precondition: "implementation candidate exists; gate enabled with a matching trigger, or the stage is inert",
    postcondition: "design-gate is inert-passed or an approved decision record exists for this candidate",
    observer: "design-gate state comments bound to the candidate",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "observe current gate state for this HEAD before re-challenging",
    side_effect_identity: "design-gate decision record bound to candidate HEAD",
    safe_replay_predicate: "replay only when no decision record exists for this HEAD epoch",
    reconstruction_rule: "reconstruct local claim from candidate-bound comments; a prior-epoch record is invalid",
  },
  "review-1": {
    operation: "review-1",
    precondition: "an open PR exists for the candidate",
    postcondition: "a schema-satisfying review-1 verdict is recorded for this HEAD",
    observer: "review.verdict@1 artifact bound to PR head SHA",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch verdict does not authorize a new HEAD",
    side_effect_identity: "review-1 verdict artifact bound to inspected HEAD",
    safe_replay_predicate: "replay only when no schema-satisfying verdict exists for this HEAD epoch",
    reconstruction_rule: "reconstruct local claim from the SHA-bound verdict; do not treat a prior-epoch verdict as current",
  },
  "fix-1": {
    operation: "fix-1",
    precondition: "review-1 produced residual blocking findings at the bound HEAD",
    postcondition: "fix-1 commits address the findings or a clean no-op goal is satisfied at HEAD",
    observer: "git range since review-1 SHA plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "one harness attempt per adapter invocation; crashed work is preserved",
    side_effect_identity: "fix-1 commits on the candidate since the review-1 SHA",
    safe_replay_predicate: "replay only when git range proves those commits are absent for this epoch",
    reconstruction_rule: "reconstruct local HEAD from git; do not push as repair",
  },
  "review-2": {
    operation: "review-2",
    precondition: "fix-1 advanced or review-1 had no blocking findings requiring fix-1",
    postcondition: "a schema-satisfying review-2 verdict is recorded for this HEAD",
    observer: "review.verdict@1 artifact bound to PR head SHA",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch verdict does not authorize a new HEAD",
    side_effect_identity: "review-2 verdict artifact bound to inspected HEAD",
    safe_replay_predicate: "replay only when no schema-satisfying verdict exists for this HEAD epoch",
    reconstruction_rule: "reconstruct local claim from the SHA-bound verdict; do not treat a prior-epoch verdict as current",
  },
  "fix-2": {
    operation: "fix-2",
    precondition: "review-2 produced residual blocking findings at the bound HEAD",
    postcondition: "fix-2 commits address the findings or a clean no-op goal is satisfied at HEAD",
    observer: "git range since review-2 SHA plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "one harness attempt per adapter invocation; crashed work is preserved",
    side_effect_identity: "fix-2 commits on the candidate since the review-2 SHA",
    safe_replay_predicate: "replay only when git range proves those commits are absent for this epoch",
    reconstruction_rule: "reconstruct local HEAD from git; do not push or open a successor PR as repair",
  },
  "pre-merge": {
    operation: "pre-merge",
    precondition: "review is current for this HEAD; OpenSpec/CI/autofix gates are applicable",
    postcondition: "pre-merge gates pass for this candidate and the stage may advance",
    observer: "CI, OpenSpec validation, review-SHA gate, and live PR head",
    candidate_binding: "repository, PR, live HEAD SHA",
    replay_rule: "observe live HEAD before treating a prior gate result as current",
    side_effect_identity: "pre-merge gate results and OpenSpec archive bound to live HEAD",
    safe_replay_predicate: "replay a step only when that step's observer proves it absent; a completed archive is not replayed",
    reconstruction_rule: "reconstruct local claim from CI, OpenSpec, and live PR head; do not merge, push, or archive as repair",
  },
  "visual-gate": {
    operation: "visual-gate",
    precondition: "pre-merge completed; visual_gate.enabled is true or the stage is inert",
    postcondition: "visual command passes for this candidate or the gate is disabled",
    observer: "visual gate command exit plus configured enablement",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "a prior-epoch visual result does not authorize a new HEAD",
    side_effect_identity: "visual-gate result bound to candidate HEAD",
    safe_replay_predicate: "replay only when no current-epoch visual result exists",
    reconstruction_rule: "reconstruct local claim from the SHA-bound visual result; process exit is ingress only",
  },
  "eval-gate": {
    operation: "eval-gate",
    precondition: "visual-gate completed; eval_gate.enabled is true or the stage is inert",
    postcondition: "eval command passes for this candidate or the gate is disabled",
    observer: "eval gate command exit plus configured enablement",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "a prior-epoch eval result does not authorize a new HEAD",
    side_effect_identity: "eval-gate result bound to candidate HEAD",
    safe_replay_predicate: "replay only when no current-epoch eval result exists",
    reconstruction_rule: "reconstruct local claim from the SHA-bound eval result; process exit is ingress only",
  },
  "shipcheck-gate": {
    operation: "shipcheck-gate",
    precondition: "eval-gate completed; shipcheck is configured",
    postcondition: "shipcheck verdict passes for this candidate or advisory mode records without blocking",
    observer: "schema-satisfying shipcheck verdict bound to HEAD",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch shipcheck verdict does not authorize a new HEAD",
    side_effect_identity: "shipcheck verdict bound to inspected HEAD",
    safe_replay_predicate: "replay only when no schema-satisfying verdict exists for this HEAD epoch",
    reconstruction_rule: "reconstruct local claim from the SHA-bound shipcheck verdict",
  },
  "ready-to-deploy": {
    operation: "ready-to-deploy",
    precondition: "upstream delivery gates passed for this candidate",
    postcondition: "the issue is labeled pipeline:ready-to-deploy and no merge was invoked",
    observer: "GitHub stage label plus absence of merge side effects from this adapter",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "observe the stage label; never submit merge from advance/single/loop",
    side_effect_identity: "pipeline:ready-to-deploy label for this issue",
    safe_replay_predicate: "replay only when the observer proves the ready-to-deploy label is absent",
    reconstruction_rule: "reconstruct local claim from the GitHub stage label; never merge as repair",
  },
};

export const DELIVERY_STAGE_INVARIANTS: readonly DeliveryStageInvariant[] = DELIVERY_STAGES.map(
  (stage) => INVARIANT_BY_STAGE[stage],
);

export function deliveryStageInvariant(stage: DeliveryStage): DeliveryStageInvariant {
  return { ...INVARIANT_BY_STAGE[stage] };
}

export function missingDeliveryStageInvariants(stages: readonly string[] = DELIVERY_STAGES): DeliveryStage[] {
  return (stages as DeliveryStage[]).filter((s) => {
    if (!isDeliveryStage(s)) return false;
    const inv = INVARIANT_BY_STAGE[s];
    if (inv == null) return true;
    return missingOperationInvariantFields(inv).length > 0;
  });
}

export interface CandidateEpoch {
  sha: string;
  epoch_id: string;
}

export function candidateEpochFromSha(sha: string): CandidateEpoch {
  const trimmed = sha.trim().toLowerCase();
  return { sha: trimmed, epoch_id: trimmed };
}

export function candidateEpochChanged(previous: string | null | undefined, next: string | null | undefined): boolean {
  const a = (previous ?? "").trim().toLowerCase();
  const b = (next ?? "").trim().toLowerCase();
  if (!a || !b) return Boolean(a || b);
  return a !== b;
}

export const CANDIDATE_BOUND_EVIDENCE_CLASSES = [
  "implementation",
  "test",
  "review",
  "design",
  "eval",
  "shipcheck",
  "decision",
  "authority_request",
  "authority_grant",
  "completion",
] as const;

/** Every candidate-bound fact is invalid after movement; callers must re-prove it. */
export function candidateBoundEvidenceAfterMovement(
  previous: string | null | undefined,
  next: string | null | undefined,
): Record<(typeof CANDIDATE_BOUND_EVIDENCE_CLASSES)[number], boolean> {
  const remainsValid = !candidateEpochChanged(previous, next) && Boolean(previous && next);
  return Object.fromEntries(
    CANDIDATE_BOUND_EVIDENCE_CLASSES.map((kind) => [kind, remainsValid]),
  ) as Record<(typeof CANDIDATE_BOUND_EVIDENCE_CLASSES)[number], boolean>;
}

/** Candidate-bound evidence is valid only when it names the current epoch SHA. */
export function isCandidateBoundEvidenceValid(
  evidenceSha: string | null | undefined,
  currentSha: string | null | undefined,
): boolean {
  const evidence = (evidenceSha ?? "").trim().toLowerCase();
  const current = (currentSha ?? "").trim().toLowerCase();
  if (!evidence || !current) return false;
  return evidence === current;
}

export function isAuthorityHoldValidForCandidate(input: {
  holdSha: string | null | undefined;
  currentSha: string | null | undefined;
  leftoverBlockedLabel?: boolean;
}): boolean {
  if (!isCandidateBoundEvidenceValid(input.holdSha, input.currentSha)) return false;
  return true;
}

export const FORBIDDEN_ADAPTER_TREATMENT_IDS = [
  "enterCooling",
  "selectTreatment",
  "cancelLogicalOperation",
  "requestAuthority",
  "markOperationComplete",
  "markOperationCancelled",
  "transferToHumanOwner",
] as const;

export interface ForbiddenAdapterTreatmentHit {
  stage?: string;
  file: string;
  reason: string;
}

export function collectForbiddenAdapterTreatments(
  source: string,
  file = "fixture.ts",
  stage?: string,
): ForbiddenAdapterTreatmentHit[] {
  const hits: ForbiddenAdapterTreatmentHit[] = [];
  for (const id of FORBIDDEN_ADAPTER_TREATMENT_IDS) {
    const re = new RegExp(`\\b${id}\\s*\\(`);
    if (re.test(source)) {
      hits.push({
        stage,
        file,
        reason: `${stage ?? file} adapter chooses RecoverySupervisor treatment via ${id}`,
      });
    }
  }
  if (/\bhuman_owned\s*:\s*true\b/.test(source) || /\bowned\s*:\s*false\b/.test(source)) {
    hits.push({
      stage,
      file,
      reason: `${stage ?? file} adapter marks a terminal mechanical ownership transfer`,
    });
  }
  if (/\bcancelled\s*:\s*true\b/.test(source) && /mechanical|harness|timeout|crash/.test(source)) {
    hits.push({
      stage,
      file,
      reason: `${stage ?? file} adapter cancels on a mechanical fault`,
    });
  }
  return hits;
}

/** Stage-local loops that are not gh transient retry or worktree config-lock retry. */
const ERROR_NAME_CLASSIFICATION_RE =
  /catch[\s\S]{0,500}(?:message|\berr\b|\be\b)[\s\S]{0,200}(?:includes|===|==)\s*\(?\s*['"`]ambiguous pipeline stage labels/;

/** Production routing must not classify by matching a thrown error message. */
export function collectErrorNameClassificationHits(
  source: string,
  file = "fixture.ts",
): ForbiddenAdapterTreatmentHit[] {
  const hits: ForbiddenAdapterTreatmentHit[] = [];
  if (ERROR_NAME_CLASSIFICATION_RE.test(source) || /includes\(\s*['"`]ambiguous pipeline stage labels/.test(source)) {
    hits.push({
      file,
      reason: `${file} classifies a fault by matching thrown message 'ambiguous pipeline stage labels'`,
    });
  }
  return hits;
}

export function collectForbiddenLifecycleRetries(source: string, file = "fixture.ts"): ForbiddenAdapterTreatmentHit[] {
  const hits: ForbiddenAdapterTreatmentHit[] = [];
  if (
    /uncertain/.test(source) &&
    /retry|re-invoke|reinvoke/.test(source) &&
    /invokeAttempt|invoke\(|harness/.test(source) &&
    /for\s*\(|while\s*\(/.test(source)
  ) {
    hits.push({ file, reason: `${file} retries after uncertain side effects` });
  }
  if (
    /candidate.*(moved|movement|changed|epoch)/i.test(source) &&
    /retry|re-invoke|reinvoke/.test(source) &&
    /for\s*\(|while\s*\(/.test(source)
  ) {
    hits.push({ file, reason: `${file} retries after candidate movement` });
  }
  return hits;
}

const DELIVERY_STAGE_MODULE_FILES: Record<DeliveryStage, string[]> = {
  planning: ["scripts/stages/planning.ts"],
  "plan-review": ["scripts/stages/planning.ts"],
  "pre-code-attestation": ["scripts/stages/pre_code_attestation.ts"],
  implementing: ["scripts/stages/planning.ts"],
  "design-gate": ["scripts/stages/design_gate.ts"],
  "review-1": ["scripts/stages/review.ts", "scripts/stages/review-routing.ts"],
  "fix-1": ["scripts/stages/fix.ts"],
  "review-2": ["scripts/stages/review.ts", "scripts/stages/review-routing.ts"],
  "fix-2": ["scripts/stages/fix.ts"],
  "pre-merge": [
    "scripts/stages/pre_merge.ts",
    "scripts/stages/pre-merge-routing.ts",
    "scripts/stages/pre-merge-sha-gate.ts",
    "scripts/stages/pre-merge-openspec-archive.ts",
    "scripts/stages/pre-merge-autofix.ts",
    "scripts/stages/pre-merge-ci-gate.ts",
  ],
  "visual-gate": ["scripts/stages/visual.ts"],
  "eval-gate": ["scripts/stages/eval.ts"],
  "shipcheck-gate": ["scripts/stages/shipcheck.ts"],
  "ready-to-deploy": ["scripts/stages/deploy_ready.ts"],
};

export const ALLOWED_TRANSPORT_RETRY_FILES = [
  "scripts/gh.ts",
  "scripts/worktree.ts",
  "scripts/transient-wrappers.ts",
] as const;

export function deliveryStageModuleFiles(stage: DeliveryStage): readonly string[] {
  return DELIVERY_STAGE_MODULE_FILES[stage];
}

export function collectWorktreeRematerializeBypasses(
  source: string,
  file = "fixture.ts",
): ForbiddenAdapterTreatmentHit[] {
  const parksAbsence =
    new RegExp("setBlocked" + "(?:Fn)?[\\s\\S]{0,800}[\"']worktree-missing[\"']").test(source) ||
    /blockerKind:\s*"worktree-missing"/.test(source);
  if (!parksAbsence) return [];
  if (/\bensureManagedWorktree\b/.test(source)) return [];
  return [
    {
      file,
      reason: `${file} parks for worktree absence without calling ensureManagedWorktree`,
    },
  ];
}

export interface AdapterAttemptInput {
  stage: DeliveryStage;
  message?: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  candidateSha?: string | null;
  candidateEpoch?: string | null;
  evidenceRole?: ArtifactEvidenceRole | string | null;
  artifactIdentity?: string | null;
  exitCode?: number | null;
  postconditionProven?: boolean;
  requireEvidenceBeforeAttempt?: boolean;
  outcome?: Outcome;
  error?: unknown;
}

export function requiredEvidenceRoleForStage(stage: DeliveryStage): ArtifactEvidenceRole {
  return stage === "planning" || stage === "plan-review" || stage === "pre-code-attestation"
    ? "planning"
    : "implementation";
}

export function completingEvidenceBindingFailure(input: Pick<
  AdapterAttemptInput,
  "stage" | "candidateSha" | "candidateEpoch" | "evidenceRole" | "artifactIdentity"
>): string | null {
  const expectedRole = requiredEvidenceRoleForStage(input.stage);
  if (input.evidenceRole !== expectedRole) {
    return `required ${expectedRole} evidence role, observed ${input.evidenceRole ?? "missing"}`;
  }
  if (!input.artifactIdentity?.trim()) return "artifact identity is missing";
  const candidate = input.candidateSha?.trim().toLowerCase() ?? "";
  const epoch = input.candidateEpoch?.trim().toLowerCase() ?? "";
  if (!candidate || !epoch) return "candidate and Candidate epoch bindings are required";
  if (candidate !== epoch) return `prior or conflicting Candidate epoch ${epoch} for ${candidate}`;
  return null;
}

function formIdForStage(stage: DeliveryStage): string {
  return `advance.${stage}`;
}

export function observationFromAdapterAttempt(input: AdapterAttemptInput): OperationObservation {
  const identity = mintObservationIdentity(input);
  const form_id = formIdForStage(input.stage);
  const invariant = deliveryStageInvariant(input.stage);
  if (input.error) {
    return mechanicalFaultObservation({
      operation: invariant.operation,
      form_id,
      message: input.message ?? (input.error instanceof Error ? input.error.message : String(input.error)),
      ...identity,
      fault: "mechanical",
      certainty: "uncertain",
    });
  }
  const outcome = input.outcome;
  const exitZero = input.exitCode === 0;
  const bindingFailure = input.postconditionProven === true
    ? completingEvidenceBindingFailure(input)
    : null;
  const proven = input.postconditionProven === true && bindingFailure === null;
  const evidenceFields = {
    ...(input.candidateEpoch?.trim() ? { candidate_epoch: input.candidateEpoch.trim().toLowerCase() } : {}),
    ...(input.evidenceRole === "planning" || input.evidenceRole === "implementation"
      ? { evidence_role: input.evidenceRole }
      : {}),
    ...(input.artifactIdentity?.trim() ? { artifact_identity: input.artifactIdentity.trim() } : {}),
  };
  if (exitZero && !proven) {
    return {
      ...ownedAdmissionObservation({
        operation: invariant.operation,
        form_id,
        message: input.message ?? "process exited 0 without proven postcondition",
        ...identity,
      }),
      certainty: "uncertain",
      complete: false,
      process_exit_is_completion: false,
      ...evidenceFields,
    };
  }
  if (!outcome) {
    return mechanicalFaultObservation({
      operation: invariant.operation,
      form_id,
      message: input.message ?? "adapter attempt produced no outcome",
      ...identity,
      ...evidenceFields,
      certainty: "uncertain",
    });
  }
  if (outcome.advanced) {
    const certainty: SideEffectCertainty = proven ? "known_complete" : "uncertain";
    return {
      schema_version: 1,
      operation: invariant.operation,
      form_id,
      ...identity,
      ...evidenceFields,
      certainty,
      lifecycle: proven ? "complete" : "active",
      human_owned: false,
      complete: proven,
      cancelled: false,
      process_exit_is_completion: false,
      owned: true,
      fault: null,
      message: input.message ?? (bindingFailure
        ? `${outcome.summary}; completion evidence rejected: ${bindingFailure}`
        : outcome.summary),
      capability_request: null,
    };
  }
  const occupied = isOccupiedOutcome(outcome);
  const lifecycle: ObservationLifecycleState =
    outcome.status === "waiting" || occupied
      ? "waiting"
      : outcome.status === "finalized" && proven
        ? "complete"
        : "cooling";
  const fault =
    outcome.status === "blocked"
      ? outcome.blockerKind ?? "mechanical"
      : outcome.status === "error"
        ? "mechanical"
        : outcome.status === "no-op"
          ? "noop-unsatisfied"
          : null;
  return {
    schema_version: 1,
    operation: invariant.operation,
    form_id,
    ...identity,
    ...evidenceFields,
    certainty: "uncertain",
    lifecycle,
    human_owned: false,
    complete: false,
    cancelled: false,
    process_exit_is_completion: false,
    owned: true,
    fault,
    message: input.message ?? outcome.reason,
    capability_request: null,
  };
}

function isOccupiedOutcome(outcome: Outcome | undefined, message?: string): boolean {
  const text = `${outcome?.reason ?? ""} ${message ?? ""}`;
  return /\boccupied\b/i.test(text);
}

export interface IssueStageSupervisorDecision {
  treatment: MigratedOutcome;
  owned: true;
  complete: boolean;
  cancelled: false;
  human_owned: false;
  lifecycle: ObservationLifecycleState;
}

/**
 * RecoverySupervisor treatment selection for one issue-stage observation.
 * Adapters report; this owner chooses Cooling, wait, re-entry, typed request,
 * compatibility park, or authenticated cancellation. Mechanical faults never
 * mark the Logical Operation complete, cancelled, or human-owned.
 */
export function reconcileIssueStageObservation(
  obs: OperationObservation,
  outcome?: Outcome,
): IssueStageSupervisorDecision {
  if (outcome?.advanced && obs.complete) {
    return {
      treatment: "re-entry",
      owned: true,
      complete: true,
      cancelled: false,
      human_owned: false,
      lifecycle: "complete",
    };
  }
  const occupied = isOccupiedOutcome(outcome, obs.message);
  const blocker = (outcome?.status === "blocked" ? outcome.blockerKind : undefined) as
    | BlockerKind
    | undefined;
  const treatment: MigratedOutcome = occupied
    ? "external-condition wait"
    : deriveMigratedOutcome({
        blocker_kind: blocker ?? null,
        canonical_reason: obs.fault ?? "",
      });
  const lifecycle: ObservationLifecycleState =
    treatment === "external-condition wait"
      ? "waiting"
      : treatment === "re-entry"
        ? "active"
        : "cooling";
  return {
    treatment,
    owned: true,
    complete: false,
    cancelled: false,
    human_owned: false,
    lifecycle,
  };
}

/** Process stop follows supervisor treatment; ownership stays with RecoverySupervisor. */
export function applySupervisorProcessOutcome(
  obs: OperationObservation,
  outcome: Outcome,
): Outcome {
  if (outcome.advanced) return outcome;
  const decision = reconcileIssueStageObservation(obs, outcome);
  if (decision.treatment === "external-condition wait" && outcome.status !== "waiting") {
    return { advanced: false, status: "waiting", reason: outcome.reason ?? obs.message };
  }
  return outcome;
}

function consumeReportedOwned(obs: OperationObservation): void {
  consumeOwnedOperation({
    ...obs,
    observation_id: `${obs.logical_operation_id}:${obs.form_id}:${obs.operation}`,
    recorded_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

export interface RunDeliveryStageAdapterInput {
  stage: DeliveryStage;
  cfg: Pick<PipelineConfig, "repo" | "domain">;
  issueNumber: number;
  pipelineRunId?: string;
  logicalOperationId?: string | null;
  reportObservation?: ReportOperationObservation;
  candidateSha?: string | null;
  candidateEpoch?: string | null;
  evidenceRole?: ArtifactEvidenceRole | string | null;
  artifactIdentity?: string | null;
  postconditionProven?: boolean;
  /** This stage authors its required artifact; consumers must already prove it. */
  evidenceProducerBeforeAttempt?: boolean;
  observeEvidence?: (
    phase: "before" | "after",
    outcome?: Outcome,
  ) => Promise<Pick<
    AdapterAttemptInput,
    "candidateSha" | "candidateEpoch" | "evidenceRole" | "artifactIdentity" | "postconditionProven"
  >>;
  /**
   * Exact evidence captured by the producer immediately after its successful
   * handler returned. The adapter re-observes after that boundary and accepts
   * a producer-created Candidate epoch only while both observations agree.
   */
  producerCompletionEvidence?: () => DeliveryStageEvidence | null;
  attempt: () => Promise<Outcome>;
}

export type DeliveryStageEvidenceObserver = NonNullable<
  RunDeliveryStageAdapterInput["observeEvidence"]
>;

type DeliveryStageEvidence = Awaited<ReturnType<DeliveryStageEvidenceObserver>>;

function sameEvidenceBinding(before: DeliveryStageEvidence, after: DeliveryStageEvidence): boolean {
  return (
    before.candidateSha === after.candidateSha &&
    before.candidateEpoch === after.candidateEpoch &&
    before.evidenceRole === after.evidenceRole &&
    before.artifactIdentity === after.artifactIdentity
  );
}

export async function runDeliveryStageAdapter(input: RunDeliveryStageAdapterInput): Promise<Outcome> {
  let evidence = {
    candidateSha: input.candidateSha,
    candidateEpoch: input.candidateEpoch,
    evidenceRole: input.evidenceRole,
    artifactIdentity: input.artifactIdentity,
    postconditionProven: input.postconditionProven,
  };
  let preAttemptEvidence: DeliveryStageEvidence | null = null;
  const baseIdentity = {
    stage: input.stage,
    domain: input.cfg.domain ?? "unknown",
    logical_operation_id: input.logicalOperationId,
    repository: input.cfg.repo,
    issue: input.issueNumber,
    run_id: input.pipelineRunId ?? null,
  };
  try {
    if (input.requireEvidenceBeforeAttempt && !input.observeEvidence) {
      const outcome: Outcome = {
        advanced: false,
        status: "waiting",
        reason: "delivery-stage evidence observer is required before execution",
      };
      const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
        ...baseIdentity,
        ...evidence,
        outcome,
        postconditionProven: false,
      }));
      consumeReportedOwned(obs);
      return outcome;
    }
    if (input.observeEvidence) {
      evidence = await input.observeEvidence("before");
      preAttemptEvidence = evidence;
      const bindingFailure = completingEvidenceBindingFailure({
        stage: input.stage,
        ...evidence,
      });
      if (bindingFailure && !input.evidenceProducerBeforeAttempt) {
        const outcome: Outcome = {
          advanced: false,
          status: "waiting",
          reason: `delivery-stage evidence binding refused before execution: ${bindingFailure}`,
        };
        const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
          ...baseIdentity,
          ...evidence,
          outcome,
          postconditionProven: false,
        }));
        consumeReportedOwned(obs);
        return outcome;
      }
      if (!input.evidenceProducerBeforeAttempt && evidence.postconditionProven !== true) {
        const outcome: Outcome = {
          advanced: false,
          status: "waiting",
          reason: "delivery-stage evidence refused before execution: required artifact postcondition is unproved",
        };
        const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
          ...baseIdentity,
          ...evidence,
          outcome,
          postconditionProven: false,
        }));
        consumeReportedOwned(obs);
        return outcome;
      }
    }
    const outcome = await input.attempt();
    if (input.observeEvidence) {
      evidence = await input.observeEvidence("after", outcome);
      const producerCompletionEvidence = input.producerCompletionEvidence?.() ?? null;
      const producerEstablishedEvidence = input.evidenceProducerBeforeAttempt &&
        outcome.advanced &&
        Boolean(input.logicalOperationId?.trim()) &&
        preAttemptEvidence?.postconditionProven !== true &&
        evidence.postconditionProven === true &&
        completingEvidenceBindingFailure({ stage: input.stage, ...evidence }) === null &&
        producerCompletionEvidence !== null &&
        sameEvidenceBinding(producerCompletionEvidence, evidence);
      if (preAttemptEvidence && !sameEvidenceBinding(preAttemptEvidence, evidence) && !producerEstablishedEvidence) {
        const waiting: Outcome = {
          advanced: false,
          status: "waiting",
          reason: "delivery-stage Candidate binding changed during execution; RecoverySupervisor retains ownership and must rerun the stage against the replacement candidate",
        };
        const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
          ...baseIdentity,
          ...evidence,
          outcome: waiting,
          postconditionProven: false,
        }));
        consumeReportedOwned(obs);
        return waiting;
      }
    }
    const obs = observationFromAdapterAttempt({
      ...baseIdentity,
      ...evidence,
      outcome,
    });
    const reported = reportOwnedOperation(input.reportObservation, obs);
    if (!reported.complete) consumeReportedOwned(reported);
    if (outcome.advanced && !reported.complete) {
      return {
        advanced: false,
        status: "waiting",
        reason: `${reported.message}; RecoverySupervisor retains ownership until exact stage evidence is proved`,
      };
    }
    const decision = reconcileIssueStageObservation(reported, outcome);
    if (
      decision.treatment === "re-entry" &&
      !outcome.advanced &&
      outcome.blockerKind === "head-drift" &&
      mayReplaySideEffect(reported.certainty)
    ) {
      if (input.observeEvidence) {
        evidence = await input.observeEvidence("before");
        const bindingFailure = completingEvidenceBindingFailure({
          stage: input.stage,
          ...evidence,
        });
        if (bindingFailure) {
          const waiting: Outcome = {
            advanced: false,
            status: "waiting",
            reason: `delivery-stage evidence binding refused before replay: ${bindingFailure}`,
          };
          const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
            ...baseIdentity,
            ...evidence,
            outcome: waiting,
            postconditionProven: false,
          }));
          consumeReportedOwned(obs);
          return waiting;
        }
        preAttemptEvidence = evidence;
      }
      const retry = await input.attempt();
      if (input.observeEvidence) {
        evidence = await input.observeEvidence("after", retry);
        if (preAttemptEvidence && !sameEvidenceBinding(preAttemptEvidence, evidence)) {
          const waiting: Outcome = {
            advanced: false,
            status: "waiting",
            reason: "delivery-stage Candidate binding changed during replay; RecoverySupervisor retains ownership and must rerun the stage against the replacement candidate",
          };
          const obs = reportOwnedOperation(input.reportObservation, observationFromAdapterAttempt({
            ...baseIdentity,
            ...evidence,
            outcome: waiting,
            postconditionProven: false,
          }));
          consumeReportedOwned(obs);
          return waiting;
        }
      }
      const retryObs = observationFromAdapterAttempt({
        ...baseIdentity,
        ...evidence,
        outcome: retry,
      });
      const reportedRetry = reportOwnedOperation(input.reportObservation, retryObs);
      if (!reportedRetry.complete) consumeReportedOwned(reportedRetry);
      return applySupervisorProcessOutcome(reportedRetry, retry);
    }
    return applySupervisorProcessOutcome(reported, outcome);
  } catch (error) {
    const faultObs = reportMechanicalFault(input.reportObservation, {
      operation: input.stage,
      form_id: formIdForStage(input.stage),
      message: error instanceof Error ? error.message : String(error),
      domain: input.cfg.domain ?? "unknown",
      logical_operation_id: input.logicalOperationId,
      repository: input.cfg.repo,
      issue: input.issueNumber,
      run_id: input.pipelineRunId ?? null,
      fault: "mechanical",
      certainty: "uncertain",
    });
    consumeReportedOwned(faultObs);
    throw error;
  }
}

export const RECOVERY_EPISODE_CLAIM_OPERATION = "recovery_episode" as const;

/** Production order for stage-adapter recovery treatments. */
export const STAGE_RECOVERY_RECIPE_ORDER = ["worktree_rematerialize", "no_run_recovery"] as const;

/** One Recovery Episode key for both the write-ahead claim and treatment history. */
export function stageRecoveryEpisodeKey(input: {
  issue: number | string;
  candidateEpoch: string;
  evidence: string;
}): RecoveryEpisodeKey {
  return {
    operation: RECOVERY_EPISODE_CLAIM_OPERATION,
    invariant: `issue:${input.issue}`,
    candidate_epoch: input.candidateEpoch,
    evidence_identity: normalizeEvidenceIdentity(input.evidence),
  };
}

function nextMonotonicStageCursor(
  recipes: readonly string[],
  previous: number,
  action: string,
  attempts: Record<string, number>,
  bound: number,
): number {
  const actionIndex = recipes.indexOf(action);
  let cursor = previous;
  if (actionIndex >= 0 && actionIndex > cursor) cursor = actionIndex;
  if (actionIndex >= 0 && (attempts[action] ?? 0) >= bound) {
    cursor = Math.max(cursor, actionIndex + 1);
  }
  while (cursor < recipes.length && (attempts[recipes[cursor]!] ?? 0) >= bound) {
    cursor += 1;
  }
  return assertCursorDoesNotRegress(previous, cursor);
}

export function claimOrResumeRecoveryEpisode(input: {
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  message: string;
  reportObservation?: ReportOperationObservation;
  persistDir?: string;
  episodeKey: RecoveryEpisodeKey;
}): OperationObservation {
  const key = assertCompleteRecoveryEpisodeKey(input.episodeKey, "claimOrResumeRecoveryEpisode");
  const identity = mintObservationIdentity({
    domain: input.domain,
    logical_operation_id: input.logical_operation_id,
    repository: input.repository,
    issue: input.issue,
    run_id: input.run_id,
  });
  const episode = emptyEpisode(key, new Date().toISOString());
  if (input.persistDir && identity.logical_operation_id) {
    const existing = loadOwnedOperationClaim(identity.domain, identity.logical_operation_id, input.persistDir);
    if (
      existing &&
      existing.episode_id === episode.episode_id &&
      existing.invariant === episode.invariant &&
      existing.candidate_epoch === episode.candidate_epoch &&
      existing.evidence_identity === episode.evidence_identity
    ) {
      reportOwnedOperation(input.reportObservation, existing);
      return existing;
    }
  }
  const obs = ownedAdmissionObservation({
    operation: RECOVERY_EPISODE_CLAIM_OPERATION,
    form_id: "recovery-supervisor",
    message: input.message,
    domain: input.domain,
    logical_operation_id: identity.logical_operation_id,
    repository: input.repository,
    issue: input.issue,
    run_id: input.run_id,
  });
  const claimed: OperationObservation = {
    ...obs,
    episode_id: episode.episode_id,
    invariant: episode.invariant,
    candidate_epoch: episode.candidate_epoch,
    evidence_identity: episode.evidence_identity,
    attempts_per_strategy: episode.attempts_per_strategy,
    strategy_cursor: episode.strategy_cursor,
    next_eligible_at: episode.next_eligible_at,
  };
  assertRecoveryEpisodeFields(claimed);
  reportOwnedOperation(input.reportObservation, claimed);
  if (input.persistDir) persistOperationObservation(claimed, input.persistDir);
  return claimed;
}

export function recordRecoveryEpisodeTreatment(input: {
  ledger: StageAttemptLedger;
  headSha: string;
  action: "worktree_rematerialize" | "no_run_recovery";
  itemId?: string;
  evidenceFingerprint?: string;
  typedReason?: string;
  runDir?: string;
  episodeKey: RecoveryEpisodeKey;
  recipes?: readonly string[];
  strategyBound?: number;
}): StageAttemptLedger {
  const key = assertCompleteRecoveryEpisodeKey(input.episodeKey, "recordRecoveryEpisodeTreatment");
  const nowIso = new Date().toISOString();
  const recipes = input.recipes ?? STAGE_RECOVERY_RECIPE_ORDER;
  const bound = input.strategyBound ?? 1;
  const projected = resumeEpisodeFromAttempts(
    input.ledger.attempts as unknown as LoopRecoveryAttempt[],
    key,
  ) ?? emptyEpisode(key, nowIso);
  const attemptsPerStrategy = { ...projected.attempts_per_strategy };
  attemptsPerStrategy[input.action] = (attemptsPerStrategy[input.action] ?? 0) + 1;
  const strategyCursor = nextMonotonicStageCursor(
    recipes,
    projected.strategy_cursor,
    input.action,
    attemptsPerStrategy,
    bound,
  );
  const episode = {
    ...projected,
    attempts_per_strategy: attemptsPerStrategy,
    strategy_cursor: strategyCursor,
    next_eligible_at: nowIso,
  };
  const claimed = claimStageAttempt(input.ledger, {
    headSha: input.headSha,
    action: input.action,
    itemId: input.itemId,
    evidenceFingerprint: input.evidenceFingerprint,
    typedReason: input.typedReason,
    budgetBefore: 1,
    invariant: episode.invariant,
    candidateEpoch: episode.candidate_epoch,
    evidenceIdentity: episode.evidence_identity,
    attemptsPerStrategy: episode.attempts_per_strategy,
    strategyCursor: episode.strategy_cursor,
    nextEligibleAt: episode.next_eligible_at,
    episodeId: recoveryEpisodeId(key),
  });
  if (input.runDir) persistStageAttemptLedger(input.runDir, claimed.ledger);
  return claimed.ledger;
}

export function countRecoveryEpisodeTreatments(
  ledger: StageAttemptLedger,
  itemId: string,
  action: "worktree_rematerialize" | "no_run_recovery" = "no_run_recovery",
): number {
  return ledger.attempts.filter((a) => a.action === action && a.item_id === itemId).length;
}

export const FIX_RETRY_MIN_BUDGET_SEC = 60;

export function remainingFixTimeoutSec(fixTimeoutSec: number, consumedSec: number): number {
  return Math.max(0, fixTimeoutSec - consumedSec);
}

export function canStartFixReentry(remainingSec: number): boolean {
  return remainingSec > FIX_RETRY_MIN_BUDGET_SEC;
}

export interface OwnedFixAttempt {
  attempt: number;
  timeoutSec: number;
  result: { success: boolean; exit_code?: number; timed_out?: boolean; duration?: number; [k: string]: unknown };
}

export type OwnedFixObservation = "attempt" | "verified-complete" | "cooling";

export interface OwnedFixAttemptsResult {
  attempts: OwnedFixAttempt[];
  finalResult: OwnedFixAttempt["result"];
  budgetExhausted: boolean;
  certainty: SideEffectCertainty;
  observation: OwnedFixObservation;
}

export interface OwnedFixAttemptsOpts<TResult extends OwnedFixAttempt["result"]> {
  maxRetries: number;
  fixTimeoutSec: number;
  basePrompt: string;
  invokeAttempt: (prompt: string, timeoutSec: number) => Promise<TResult>;
  buildRetryPreamble: (attempt: number, limit: number, priorReason: string) => string;
  onBeforeAttempt?: (attempt: number, timeoutSec: number, prompt: string) => Promise<void> | void;
  onRetryScheduled?: (attempt: number, limit: number, reason: string) => Promise<void> | void;
  nowMs?: () => number;
  /**
   * Required on every retry-capable call path. Missing observer on re-entry is
   * fail-closed `uncertain` (cooling), never a guessed replay.
   */
  observeCertainty: () => Promise<SideEffectCertainty> | SideEffectCertainty;
  reportObservation?: ReportOperationObservation;
  identity?: {
    domain: string;
    logical_operation_id?: string | null;
    repository?: string | null;
    issue?: number | null;
    run_id?: string | null;
    stage?: "fix-1" | "fix-2";
  };
}

function haltOwnedFixOnObservation(
  attempts: OwnedFixAttempt[],
  certainty: SideEffectCertainty,
  opts: OwnedFixAttemptsOpts<OwnedFixAttempt["result"]>,
): OwnedFixAttemptsResult {
  const treatment = treatmentForSideEffectCertainty(certainty);
  const stage = opts.identity?.stage ?? "fix-2";
  if (treatment === "complete") {
    if (opts.identity) {
      reportOwnedOperation(
        opts.reportObservation,
        completedOperationObservation({
          operation: stage,
          form_id: formIdForStage(stage),
          message: "observer proved the postcondition complete; reconciling the original operation forward",
          domain: opts.identity.domain,
          logical_operation_id: opts.identity.logical_operation_id,
          repository: opts.identity.repository,
          issue: opts.identity.issue,
          run_id: opts.identity.run_id,
        }),
      );
    }
    return {
      attempts,
      finalResult: {
        success: true,
        exit_code: 0,
        duration: 0,
        observed_complete: true,
        certainty: "known_complete",
      },
      budgetExhausted: false,
      certainty: "known_complete",
      observation: "verified-complete",
    };
  }
  if (opts.identity) {
    reportMechanicalFault(opts.reportObservation, {
      operation: stage,
      form_id: formIdForStage(stage),
      message: "observer could not prove complete or absent; keeping the operation owned as cooling",
      domain: opts.identity.domain,
      logical_operation_id: opts.identity.logical_operation_id,
      repository: opts.identity.repository,
      issue: opts.identity.issue,
      run_id: opts.identity.run_id,
      fault: "mechanical",
      certainty: "uncertain",
    });
  }
  const prior = attempts[attempts.length - 1]?.result;
  return {
    attempts,
    finalResult: {
      success: false,
      exit_code: prior?.exit_code,
      timed_out: prior?.timed_out,
      duration: prior?.duration ?? 0,
      cooling: true,
      certainty: "uncertain",
    },
    budgetExhausted: false,
    certainty: "uncertain",
    observation: "cooling",
  };
}

function attemptOwnedFixResult(
  attempts: OwnedFixAttempt[],
  finalResult: OwnedFixAttempt["result"],
  budgetExhausted: boolean,
): OwnedFixAttemptsResult {
  return {
    attempts,
    finalResult,
    budgetExhausted,
    certainty: "uncertain",
    observation: "attempt",
  };
}

/**
 * RecoverySupervisor re-entry for a crashed fix adapter. The adapter itself
 * performs one harness attempt; this owner may re-enter while budget remains.
 */
export async function runOwnedFixAttempts<TResult extends OwnedFixAttempt["result"]>(
  opts: OwnedFixAttemptsOpts<TResult>,
): Promise<OwnedFixAttemptsResult> {
  const attempts: OwnedFixAttempt[] = [];
  let consumedSec = 0;
  let priorReason: string | null = null;
  const totalAttemptsCap = 1 + Math.max(0, opts.maxRetries);
  const nowMs = opts.nowMs ?? (() => performance.now());

  for (let attemptNum = 1; attemptNum <= totalAttemptsCap; attemptNum++) {
    if (attemptNum > 1) {
      const certainty = opts.observeCertainty ? await opts.observeCertainty() : "uncertain";
      if (!mayReplaySideEffect(certainty)) {
        return haltOwnedFixOnObservation(attempts, certainty, opts);
      }
    }
    let timeoutSec: number;
    if (attemptNum === 1) {
      timeoutSec = opts.fixTimeoutSec;
    } else {
      timeoutSec = remainingFixTimeoutSec(opts.fixTimeoutSec, consumedSec);
      if (!canStartFixReentry(timeoutSec)) {
        if (opts.identity) {
          reportMechanicalFault(opts.reportObservation, {
            operation: opts.identity.stage ?? "fix-2",
            form_id: formIdForStage(opts.identity.stage ?? "fix-2"),
            message: "remaining fix-timeout budget exhausted",
            domain: opts.identity.domain,
            logical_operation_id: opts.identity.logical_operation_id,
            repository: opts.identity.repository,
            issue: opts.identity.issue,
            run_id: opts.identity.run_id,
            fault: "harness-failure",
            certainty: "uncertain",
          });
        }
        return attemptOwnedFixResult(attempts, attempts[attempts.length - 1]!.result, true);
      }
      if (opts.onRetryScheduled) {
        await opts.onRetryScheduled(attemptNum, opts.maxRetries, priorReason!);
      }
    }

    const prompt =
      attemptNum === 1
        ? opts.basePrompt
        : opts.buildRetryPreamble(attemptNum, opts.maxRetries, priorReason!) + opts.basePrompt;
    if (opts.onBeforeAttempt) await opts.onBeforeAttempt(attemptNum, timeoutSec, prompt);

    const attemptStartMs = nowMs();
    const result = await opts.invokeAttempt(prompt, timeoutSec);
    const elapsedSec = Math.max(0, (nowMs() - attemptStartMs) / 1000);
    const reportedSec = Number.isFinite(result.duration) && (result.duration ?? 0) >= 0 ? Number(result.duration) : 0;
    const debitSec = Math.max(elapsedSec, reportedSec);
    attempts.push({ attempt: attemptNum, timeoutSec, result });
    consumedSec += debitSec;

    if (result.success) {
      const certainty = opts.observeCertainty ? await opts.observeCertainty() : "uncertain";
      if (!mayReplaySideEffect(certainty)) {
        return haltOwnedFixOnObservation(attempts, certainty, opts);
      }
      priorReason = "exit 0 but observer proved the postcondition absent";
      continue;
    }
    if (result.background_wait || result.preflight_failed) {
      return attemptOwnedFixResult(attempts, result, false);
    }
    priorReason = result.timed_out
      ? `timed out after ${debitSec.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    if (opts.identity) {
      reportMechanicalFault(opts.reportObservation, {
        operation: opts.identity.stage ?? "fix-2",
        form_id: formIdForStage(opts.identity.stage ?? "fix-2"),
        message: priorReason,
        domain: opts.identity.domain,
        logical_operation_id: opts.identity.logical_operation_id,
        repository: opts.identity.repository,
        issue: opts.identity.issue,
        run_id: opts.identity.run_id,
        fault: "harness-failure",
        certainty: "uncertain",
      });
    }
  }

  const last = attempts[attempts.length - 1]!.result;
  if (last.success) {
    return {
      attempts,
      finalResult: {
        success: false,
        exit_code: last.exit_code,
        duration: last.duration ?? 0,
        certainty: "known_absent",
      },
      budgetExhausted: false,
      certainty: "known_absent",
      observation: "attempt",
    };
  }
  return attemptOwnedFixResult(attempts, last, false);
}

export function scanDeliveryStageAdapterContracts(coreRoot?: string): ForbiddenAdapterTreatmentHit[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = coreRoot ?? join(here, "..");
  const hits: ForbiddenAdapterTreatmentHit[] = [];
  for (const stage of DELIVERY_STAGES) {
    for (const rel of DELIVERY_STAGE_MODULE_FILES[stage]) {
      const abs = join(root, rel);
      let source: string;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        hits.push({ stage, file: rel, reason: `missing delivery-stage module ${rel}` });
        continue;
      }
      hits.push(...collectForbiddenAdapterTreatments(source, rel, stage));
      hits.push(...collectErrorNameClassificationHits(source, rel).map((h) => ({ ...h, stage })));
      hits.push(...collectWorktreeRematerializeBypasses(source, rel).map((h) => ({ ...h, stage })));
    }
  }
  return hits;
}

export function assertNoSuperviseAdvanceCommand(registryKeys: readonly string[]): void {
  const banned = registryKeys.filter((k) => /supervise-advance|superviseAdvance|supervisor-advance/.test(k));
  if (banned.length > 0) {
    throw new Error(`public supervisor CLI verb is forbidden: ${banned.join(", ")}`);
  }
}

export function advanceNeverMerges(source: string): boolean {
  return !/\bpipeline merge\b|\bmergePr\b|\bmerge-queue/.test(source) ||
    /never merge|Advance never merges|SHALL still never merge/i.test(source);
}
