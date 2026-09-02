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
  consumeOwnedOperation,
  mechanicalFaultObservation,
  mintObservationIdentity,
  ownedAdmissionObservation,
  persistOperationObservation,
  reportMechanicalFault,
  reportOwnedOperation,
  type ObservationLifecycleState,
  type OperationObservation,
  type ReportOperationObservation,
  type SideEffectCertainty,
} from "./operation-observation.ts";
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

export interface DeliveryStageInvariant {
  operation: DeliveryStage;
  precondition: string;
  postcondition: string;
  observer: string;
  candidate_binding: string;
  replay_rule: string;
}

const INVARIANT_BY_STAGE: Record<DeliveryStage, DeliveryStageInvariant> = {
  planning: {
    operation: "planning",
    precondition: "issue is admitted at pipeline:ready or recovered planning; no live foreign workspace owner",
    postcondition: "a plan artifact is bound to this issue and the stage label has advanced past planning",
    observer: "GitHub issue comments plus pipeline stage label",
    candidate_binding: "repository, issue, planning worktree branch",
    replay_rule: "observe existing plan artifact before re-authoring; do not treat process exit as completion",
  },
  "plan-review": {
    operation: "plan-review",
    precondition: "a completed plan artifact exists for the issue",
    postcondition: "plan-review verdict is recorded against the bound plan and the stage may advance",
    observer: "schema-satisfying plan-review verdict on the issue",
    candidate_binding: "repository, issue, plan artifact identity",
    replay_rule: "observe the latest plan-review verdict before replay; malformed output is not a pass",
  },
  "pre-code-attestation": {
    operation: "pre-code-attestation",
    precondition: "plan-review is complete; attestation is enabled and a risk trigger matches, or the stage is inert",
    postcondition: "attestation is approved, inert-passed, or a typed authority hold is projected",
    observer: "pre-code attestation state comments plus stage label",
    candidate_binding: "repository, issue, plan identity",
    replay_rule: "observe current attestation state before creating a new hold",
  },
  implementing: {
    operation: "implementing",
    precondition: "planning is complete; a managed worktree exists or can be materialized",
    postcondition: "implementation commits exist on the candidate or a clean no-op goal is satisfied",
    observer: "git ancestry of the issue branch versus base plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "observe HEAD and goal satisfaction before treating a no-new-commit as success",
  },
  "design-gate": {
    operation: "design-gate",
    precondition: "implementation candidate exists; gate enabled with a matching trigger, or the stage is inert",
    postcondition: "design-gate is inert-passed or an approved decision record exists for this candidate",
    observer: "design-gate state comments bound to the candidate",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "observe current gate state for this HEAD before re-challenging",
  },
  "review-1": {
    operation: "review-1",
    precondition: "an open PR exists for the candidate",
    postcondition: "a schema-satisfying review-1 verdict is recorded for this HEAD",
    observer: "review.verdict@1 artifact bound to PR head SHA",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch verdict does not authorize a new HEAD",
  },
  "fix-1": {
    operation: "fix-1",
    precondition: "review-1 produced residual blocking findings at the bound HEAD",
    postcondition: "fix-1 commits address the findings or a clean no-op goal is satisfied at HEAD",
    observer: "git range since review-1 SHA plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "one harness attempt per adapter invocation; crashed work is preserved",
  },
  "review-2": {
    operation: "review-2",
    precondition: "fix-1 advanced or review-1 had no blocking findings requiring fix-1",
    postcondition: "a schema-satisfying review-2 verdict is recorded for this HEAD",
    observer: "review.verdict@1 artifact bound to PR head SHA",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch verdict does not authorize a new HEAD",
  },
  "fix-2": {
    operation: "fix-2",
    precondition: "review-2 produced residual blocking findings at the bound HEAD",
    postcondition: "fix-2 commits address the findings or a clean no-op goal is satisfied at HEAD",
    observer: "git range since review-2 SHA plus stage goal check",
    candidate_binding: "repository, issue, worktree HEAD SHA",
    replay_rule: "one harness attempt per adapter invocation; crashed work is preserved",
  },
  "pre-merge": {
    operation: "pre-merge",
    precondition: "review is current for this HEAD; OpenSpec/CI/autofix gates are applicable",
    postcondition: "pre-merge gates pass for this candidate and the stage may advance",
    observer: "CI, OpenSpec validation, review-SHA gate, and live PR head",
    candidate_binding: "repository, PR, live HEAD SHA",
    replay_rule: "observe live HEAD before treating a prior gate result as current",
  },
  "visual-gate": {
    operation: "visual-gate",
    precondition: "pre-merge completed; visual_gate.enabled is true or the stage is inert",
    postcondition: "visual command passes for this candidate or the gate is disabled",
    observer: "visual gate command exit plus configured enablement",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "a prior-epoch visual result does not authorize a new HEAD",
  },
  "eval-gate": {
    operation: "eval-gate",
    precondition: "visual-gate completed; eval_gate.enabled is true or the stage is inert",
    postcondition: "eval command passes for this candidate or the gate is disabled",
    observer: "eval gate command exit plus configured enablement",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "a prior-epoch eval result does not authorize a new HEAD",
  },
  "shipcheck-gate": {
    operation: "shipcheck-gate",
    precondition: "eval-gate completed; shipcheck is configured",
    postcondition: "shipcheck verdict passes for this candidate or advisory mode records without blocking",
    observer: "schema-satisfying shipcheck verdict bound to HEAD",
    candidate_binding: "repository, PR, inspected HEAD SHA",
    replay_rule: "a prior-epoch shipcheck verdict does not authorize a new HEAD",
  },
  "ready-to-deploy": {
    operation: "ready-to-deploy",
    precondition: "upstream delivery gates passed for this candidate",
    postcondition: "the issue is labeled pipeline:ready-to-deploy and no merge was invoked",
    observer: "GitHub stage label plus absence of merge side effects from this adapter",
    candidate_binding: "repository, issue, candidate HEAD SHA",
    replay_rule: "observe the stage label; never submit merge from advance/single/loop",
  },
};

export const DELIVERY_STAGE_INVARIANTS: readonly DeliveryStageInvariant[] = DELIVERY_STAGES.map(
  (stage) => INVARIANT_BY_STAGE[stage],
);

export function deliveryStageInvariant(stage: DeliveryStage): DeliveryStageInvariant {
  return { ...INVARIANT_BY_STAGE[stage] };
}

export function missingDeliveryStageInvariants(stages: readonly string[] = DELIVERY_STAGES): DeliveryStage[] {
  return (stages as DeliveryStage[]).filter((s) => isDeliveryStage(s) && INVARIANT_BY_STAGE[s] == null);
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
  exitCode?: number | null;
  postconditionProven?: boolean;
  outcome?: Outcome;
  error?: unknown;
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
  const proven = input.postconditionProven === true;
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
    };
  }
  if (!outcome) {
    return mechanicalFaultObservation({
      operation: invariant.operation,
      form_id,
      message: input.message ?? "adapter attempt produced no outcome",
      ...identity,
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
      certainty,
      lifecycle: proven ? "complete" : "active",
      human_owned: false,
      complete: proven,
      cancelled: false,
      process_exit_is_completion: false,
      owned: true,
      fault: null,
      message: input.message ?? outcome.summary,
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
  postconditionProven?: boolean;
  attempt: () => Promise<Outcome>;
}

export async function runDeliveryStageAdapter(input: RunDeliveryStageAdapterInput): Promise<Outcome> {
  const base = {
    stage: input.stage,
    domain: input.cfg.domain ?? "unknown",
    logical_operation_id: input.logicalOperationId,
    repository: input.cfg.repo,
    issue: input.issueNumber,
    run_id: input.pipelineRunId ?? null,
    candidateSha: input.candidateSha,
  };
  try {
    const outcome = await input.attempt();
    const obs = observationFromAdapterAttempt({
      ...base,
      outcome,
      postconditionProven: input.postconditionProven,
    });
    const reported = reportOwnedOperation(input.reportObservation, obs);
    if (!reported.complete) consumeReportedOwned(reported);
    const decision = reconcileIssueStageObservation(reported, outcome);
    if (decision.treatment === "re-entry" && !outcome.advanced && outcome.blockerKind === "head-drift") {
      const retry = await input.attempt();
      const retryObs = observationFromAdapterAttempt({
        ...base,
        outcome: retry,
        postconditionProven: input.postconditionProven,
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

export function claimOrResumeRecoveryEpisode(input: {
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  message: string;
  reportObservation?: ReportOperationObservation;
  persistDir?: string;
}): OperationObservation {
  const obs = ownedAdmissionObservation({
    operation: RECOVERY_EPISODE_CLAIM_OPERATION,
    form_id: "recovery-supervisor",
    message: input.message,
    domain: input.domain,
    logical_operation_id: input.logical_operation_id,
    repository: input.repository,
    issue: input.issue,
    run_id: input.run_id,
  });
  reportOwnedOperation(input.reportObservation, obs);
  if (input.persistDir) persistOperationObservation(obs, input.persistDir);
  return obs;
}

export function recordRecoveryEpisodeTreatment(input: {
  ledger: StageAttemptLedger;
  headSha: string;
  action: "worktree_rematerialize" | "no_run_recovery";
  itemId?: string;
  evidenceFingerprint?: string;
  typedReason?: string;
  runDir?: string;
}): StageAttemptLedger {
  const claimed = claimStageAttempt(input.ledger, {
    headSha: input.headSha,
    action: input.action,
    itemId: input.itemId,
    evidenceFingerprint: input.evidenceFingerprint,
    typedReason: input.typedReason,
    budgetBefore: 1,
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

export interface OwnedFixAttemptsResult {
  attempts: OwnedFixAttempt[];
  finalResult: OwnedFixAttempt["result"];
  budgetExhausted: boolean;
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
        return {
          attempts,
          finalResult: attempts[attempts.length - 1]!.result,
          budgetExhausted: true,
        };
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
      return { attempts, finalResult: result, budgetExhausted: false };
    }
    if (result.background_wait || result.preflight_failed) {
      return { attempts, finalResult: result, budgetExhausted: false };
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

  return {
    attempts,
    finalResult: attempts[attempts.length - 1]!.result,
    budgetExhausted: false,
  };
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
