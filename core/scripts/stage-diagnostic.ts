// Provider-neutral diagnostic transport from one Pipeline advance into the
// durable loop supervisor. The projection is deliberately structural: labels
// and free-form blocker prose never grant human-authority status.

import { createHash } from "node:crypto";
import {
  PRE_MERGE_OFFRAMP_CLASSES,
  isPreMergeOfframpClass,
  type PreMergeOfframpClass,
} from "./pre-merge-offramp.ts";
import { BLOCKER_KINDS, type BlockerKind } from "./types.ts";
import type { DurableBlockerClass } from "./loop/types.ts";

export const STAGE_DIAGNOSTIC_SCHEMA = "pipeline/stage-diagnostic@1";

export const STAGE_DIAGNOSTIC_REASON_CODES = [
  "workflow-state",
  "implementation-ci",
  "review-findings",
  "workflow-engine-defect",
  "environment-auth",
  "worktree-capacity",
  "human-decision-required",
  "openspec-archive-apply-conflict",
  // No engine stage emits this exact code today: planning/plan-review
  // validation failures project the coarse implementation-ci diagnostic (see
  // specs/openspec-integration). The member is accepted for external
  // loop-execution producers (LoopExecutionResponse.diagnostic) through the
  // exact-acceptance branch in projectStageDiagnostic below.
  "openspec-generated-delta-invalid",
  // #760 — mechanical harness / forge / budget classes (additive; no competing enum).
  "transient-infra",
  "harness-timeout",
  "harness-contract",
  "repair-budget-exhausted",
  "external-wait",
  "human-context-required",
  // Distinct from environment-auth: missing forge capability/permission (e.g. 403
  // resource not accessible) vs credential/authentication failure.
  "capability-refusal",
  // #1299: typed complete/fail without delivery or foreground-join inside grace.
  // Distinct from harness-timeout; never inferred from silence or transcript.
  "harness-background-wait",
  // #870: Claude model entitlement / usage-credit refusal (Fable credits).
  // Projects to environment-auth so metrics separate account entitlement from
  // forge credential failures, without collapsing to workflow-engine-defect.
  "model-entitlement-required",
] as const;

export type StageDiagnosticReasonCode = (typeof STAGE_DIAGNOSTIC_REASON_CODES)[number];

export const HUMAN_AUTHORITY_CATEGORIES = ["product-decision", "authority"] as const;
export type HumanAuthorityCategory = (typeof HUMAN_AUTHORITY_CATEGORIES)[number];

export interface HumanAuthorityEvidence {
  category: HumanAuthorityCategory;
  finding_key: string;
  finding_fingerprint: string;
  reviewed_sha: string;
}

export interface StageDiagnosticDetail {
  blocker_kind: BlockerKind;
  reason: string;
  stage?: string;
  offramp_class?: PreMergeOfframpClass;
  /** Positive authority proof emitted only after the fix stage matched a
   * declaration to a current blocking finding at the reviewed candidate. */
  authority_evidence?: HumanAuthorityEvidence[];
}

export interface StageDiagnostic {
  readonly schema: typeof STAGE_DIAGNOSTIC_SCHEMA;
  reason_code: StageDiagnosticReasonCode;
  evidence_key: string;
  detail: StageDiagnosticDetail;
}

export type StageDiagnosticDisposition =
  | "recover"
  | "human_authority"
  | "capacity"
  | "protocol_failure";

export interface StageDiagnosticProjection {
  blockerClass: DurableBlockerClass;
  disposition: StageDiagnosticDisposition;
  protocolError?: string;
}

export interface StageDiagnosticResolution extends StageDiagnosticProjection {
  diagnostic: StageDiagnostic | null;
}

const BLOCKER_KIND_SET: ReadonlySet<string> = new Set(BLOCKER_KINDS);

function isBlockerKind(value: unknown): value is BlockerKind {
  return typeof value === "string" && BLOCKER_KIND_SET.has(value);
}

function mechanicalReasonCodeForKind(kind: BlockerKind): StageDiagnosticReasonCode {
  switch (kind) {
    case "needs-human":
    case "merge-conflict":
    case "worktree-missing":
    case "worktree-creation-failed":
    case "pr-creation-failed":
    case "no-pull-request":
    case "plan-gen-failed":
    case "push-failed":
    case "head-drift":
    case "worktree-setup-failed":
      return "workflow-state";
    case "test-gate-exhausted":
    case "no-commits":
    case "openspec-invalid":
    case "openspec-stale-delta":
    case "eval-gate-misconfigured":
    case "eval-gate-failed":
    case "visual-gate-misconfigured":
    case "visual-gate-failed":
    case "shipcheck-failed":
    case "build-failed":
    case "design-gate-failed":
    case "pre-code-attestation-failed":
    case "ci-exhausted":
      return "implementation-ci";
    case "review-findings":
      return "review-findings";
    case "harness-failure":
      return "workflow-engine-defect";
    case "worktree-capacity":
      return "worktree-capacity";
    case "human-decision-required":
      return "human-decision-required";
    case "review-independent-quorum-unmet":
      return "workflow-engine-defect";
    case "review-no-usable-reviewers":
      return "harness-contract";
    case "review-prompt-too-large":
      // Mechanical payload/ceiling refusal — not a transient harness crash and
      // not human-authority. Same-payload auto-retry is forbidden (#1054).
      return "capability-refusal";
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`unmapped closed diagnostic member: ${String(value)}`);
}

function reasonCodeFor(
  kind: BlockerKind,
  offrampClass?: PreMergeOfframpClass,
): StageDiagnosticReasonCode {
  // An explicit authority diagnostic cannot be downgraded by a reporting
  // dimension such as the pre-merge path that happened to surface it.
  if (kind === "human-decision-required") return "human-decision-required";
  switch (offrampClass) {
    case "ci-failed":
    case "openspec-invalid":
    case "openspec-stale-delta":
      return "implementation-ci";
    case "delta-review":
      // Reporting path tag for pre-merge delta review / round-ceiling surfaces —
      // engine-owned review recovery, never a human-authority default (#814 / #760).
      return "review-findings";
    case "merge-conflict":
      return "workflow-state";
    case "other":
    case undefined:
      return mechanicalReasonCodeForKind(kind);
    default:
      return assertNever(offrampClass);
  }
}

function evidenceKeyFor(
  reasonCode: StageDiagnosticReasonCode,
  detail: StageDiagnosticDetail,
): string {
  const canonical = JSON.stringify({
    schema: STAGE_DIAGNOSTIC_SCHEMA,
    reason_code: reasonCode,
    blocker_kind: detail.blocker_kind,
    stage: detail.stage ?? null,
    offramp_class: detail.offramp_class ?? null,
    authority_evidence: detail.authority_evidence ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The single closed projection from Pipeline reason code to durable-loop
 * authority. Unknown input is a protocol failure, never a human hold.
 */
export function projectPipelineReasonCode(reasonCode: unknown): StageDiagnosticProjection {
  switch (reasonCode) {
    case "workflow-state":
      return { blockerClass: "workflow-state", disposition: "recover" };
    case "implementation-ci":
      return { blockerClass: "implementation-ci", disposition: "recover" };
    case "review-findings":
      return { blockerClass: "review-findings", disposition: "recover" };
    case "workflow-engine-defect":
      return { blockerClass: "workflow-engine-defect", disposition: "recover" };
    case "environment-auth":
      return { blockerClass: "environment-auth", disposition: "recover" };
    case "capability-refusal":
      // Same durable recovery class as auth (environment/operator setup) but a
      // distinct canonical reason so metrics and operator guidance can tell
      // permission/capability refusals from credential failures.
      return { blockerClass: "environment-auth", disposition: "recover" };
    case "model-entitlement-required":
      // #870: Fable/usage-credit model entitlement — account setup, not an
      // engine protocol defect. Distinct reason under environment-auth so
      // metrics can separate entitlement from forge credentials.
      return { blockerClass: "environment-auth", disposition: "recover" };
    case "worktree-capacity":
      return { blockerClass: "workflow-state", disposition: "capacity" };
    case "human-decision-required":
      return { blockerClass: "specification-decision", disposition: "human_authority" };
    case "openspec-archive-apply-conflict":
    case "openspec-generated-delta-invalid":
      return { blockerClass: "implementation-ci", disposition: "recover" };
    // #760 additive mechanical classes — never project to human_authority alone.
    case "transient-infra":
      return { blockerClass: "transient-rate-limit", disposition: "recover" };
    case "harness-timeout":
    case "harness-background-wait":
    case "harness-contract":
      return { blockerClass: "workflow-engine-defect", disposition: "recover" };
    case "repair-budget-exhausted":
      // Engine-owned terminal/exhaustion path — not a human hold.
      return { blockerClass: "workflow-engine-defect", disposition: "recover" };
    case "external-wait":
      return { blockerClass: "upstream-dependency", disposition: "recover" };
    case "human-context-required":
      // Underspec / missing operator context is not product authority by itself;
      // waiting/human-input protocol is a separate durable hold path.
      return { blockerClass: "specification-decision", disposition: "recover" };
    default:
      return {
        blockerClass: "workflow-engine-defect",
        disposition: "protocol_failure",
        protocolError: `unknown stage diagnostic reason_code ${JSON.stringify(reasonCode)}`,
      };
  }
}

/** Validate a typed diagnostic and project it without inspecting prose. */
export function projectStageDiagnostic(value: unknown): StageDiagnosticProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "missing pipeline/stage-diagnostic@1",
    };
  }
  const candidate = value as Partial<StageDiagnostic>;
  if (candidate.schema !== STAGE_DIAGNOSTIC_SCHEMA) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: `unsupported stage diagnostic schema ${JSON.stringify(candidate.schema)}`,
    };
  }
  const detail = candidate.detail;
  const authorityEvidence = detail && typeof detail === "object"
    ? (detail as Partial<StageDiagnosticDetail>).authority_evidence
    : undefined;
  const validAuthorityEvidence =
    Array.isArray(authorityEvidence) &&
    authorityEvidence.length > 0 &&
    authorityEvidence.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        HUMAN_AUTHORITY_CATEGORIES.includes((entry as HumanAuthorityEvidence).category) &&
        /^[0-9a-f]{8}$/.test((entry as HumanAuthorityEvidence).finding_key) &&
        /^[0-9a-f]{16}$/.test((entry as HumanAuthorityEvidence).finding_fingerprint) &&
        /^[0-9a-f]{6,64}$/i.test((entry as HumanAuthorityEvidence).reviewed_sha),
    );
  if (
    typeof detail !== "object" ||
    detail === null ||
    !isBlockerKind(detail.blocker_kind) ||
    typeof detail.reason !== "string" ||
    detail.reason.trim().length === 0 ||
    (detail.stage !== undefined &&
      (typeof detail.stage !== "string" || detail.stage.trim().length === 0)) ||
    (detail.offramp_class !== undefined && !isPreMergeOfframpClass(detail.offramp_class))
  ) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "malformed pipeline/stage-diagnostic@1 detail",
    };
  }
  if (
    (detail.blocker_kind === "human-decision-required" && !validAuthorityEvidence) ||
    (detail.blocker_kind !== "human-decision-required" && authorityEvidence !== undefined)
  ) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "human authority diagnostic is missing valid current finding evidence",
    };
  }
  const expectedReasonCode = reasonCodeFor(detail.blocker_kind, detail.offramp_class);
  const exactOpenSpecReason =
    (candidate.reason_code === "openspec-archive-apply-conflict" &&
      detail.blocker_kind === "openspec-invalid" &&
      detail.stage === "pre-merge" &&
      detail.offramp_class === "openspec-invalid") ||
    (candidate.reason_code === "openspec-generated-delta-invalid" &&
      detail.blocker_kind === "openspec-invalid" &&
      (detail.stage === "planning" || detail.stage === "plan-review") &&
      detail.offramp_class === undefined);
  const exactEnvironmentAuthReason =
    candidate.reason_code === "environment-auth" &&
    detail.blocker_kind === "harness-failure" &&
    detail.offramp_class === undefined;
  // #760: producers may attach additive mechanical reason codes on top of a
  // coarse BlockerKind when the kind alone would lossily collapse the class.
  const exactAdditiveMechanicalReason =
    (
      candidate.reason_code === "transient-infra" ||
      candidate.reason_code === "harness-timeout" ||
      candidate.reason_code === "harness-background-wait" ||
      candidate.reason_code === "harness-contract" ||
      candidate.reason_code === "repair-budget-exhausted" ||
      candidate.reason_code === "external-wait" ||
      candidate.reason_code === "human-context-required" ||
      candidate.reason_code === "capability-refusal" ||
      candidate.reason_code === "model-entitlement-required"
    ) &&
    detail.offramp_class === undefined &&
    (
      detail.blocker_kind === "harness-failure" ||
      detail.blocker_kind === "push-failed" ||
      detail.blocker_kind === "needs-human" ||
      detail.blocker_kind === "worktree-missing" ||
      detail.blocker_kind === "worktree-creation-failed" ||
      detail.blocker_kind === "worktree-setup-failed" ||
      detail.blocker_kind === "no-pull-request" ||
      detail.blocker_kind === "pr-creation-failed"
    );
  if (
    candidate.reason_code !== expectedReasonCode &&
    !exactOpenSpecReason &&
    !exactEnvironmentAuthReason &&
    !exactAdditiveMechanicalReason
  ) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: `inconsistent stage diagnostic reason_code ${JSON.stringify(candidate.reason_code)}`,
    };
  }
  if (typeof candidate.evidence_key !== "string" || candidate.evidence_key.trim().length === 0) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "stage diagnostic evidence_key is missing",
    };
  }
  return projectPipelineReasonCode(candidate.reason_code);
}

/** Producer API for exact or coarse structured diagnostics. A producer-owned
 * evidence key is preserved; otherwise a deterministic key is derived only
 * from structured fields, never from free-form reason prose. */
export function buildStageDiagnostic(input: {
  reasonCode?: StageDiagnosticReasonCode;
  evidenceKey?: string;
  blockerKind: BlockerKind;
  reason: string;
  stage?: string;
  offrampClass?: PreMergeOfframpClass;
  authorityEvidence?: HumanAuthorityEvidence[];
}): StageDiagnostic {
  const detail: StageDiagnosticDetail = {
    blocker_kind: input.blockerKind,
    reason: input.reason,
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.offrampClass !== undefined ? { offramp_class: input.offrampClass } : {}),
    ...(input.authorityEvidence !== undefined ? { authority_evidence: input.authorityEvidence } : {}),
  };
  const reasonCode = input.reasonCode ?? reasonCodeFor(input.blockerKind, input.offrampClass);
  const diagnostic: StageDiagnostic = {
    schema: STAGE_DIAGNOSTIC_SCHEMA,
    reason_code: reasonCode,
    evidence_key: input.evidenceKey ?? evidenceKeyFor(reasonCode, detail),
    detail,
  };
  const projection = projectStageDiagnostic(diagnostic);
  if (projection.disposition === "protocol_failure") {
    throw new Error(projection.protocolError ?? "invalid stage diagnostic");
  }
  return diagnostic;
}

/** Human authority is current only when every attested finding names the
 * freshly reconciled candidate head. */
export function isCurrentHumanAuthorityDiagnostic(
  diagnostic: StageDiagnostic,
  currentHead: string,
): boolean {
  if (projectStageDiagnostic(diagnostic).disposition !== "human_authority") return false;
  const normalized = currentHead.trim().toLowerCase();
  return normalized.length > 0 &&
    diagnostic.detail.authority_evidence!.every(
      (evidence) => evidence.reviewed_sha.toLowerCase() === normalized,
    );
}

/** Build a canonical diagnostic from one structured run-store blocker event. */
export function stageDiagnosticFromBlockerSet(value: unknown): StageDiagnosticResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...projectStageDiagnostic(null), diagnostic: null };
  }
  const event = value as Record<string, unknown>;
  if (
    event.type !== "blocker_set" ||
    !isBlockerKind(event.blocker_kind) ||
    typeof event.reason !== "string" ||
    event.reason.trim().length === 0 ||
    (event.stage !== undefined &&
      (typeof event.stage !== "string" || event.stage.trim().length === 0)) ||
    (event.offramp_class !== undefined && !isPreMergeOfframpClass(event.offramp_class))
  ) {
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "final blocker_set is missing a recognized blocker_kind or valid structured fields",
      diagnostic: null,
    };
  }
  if (event.diagnostic !== undefined) {
    const projection = projectStageDiagnostic(event.diagnostic);
    if (projection.disposition === "protocol_failure") {
      return { ...projection, diagnostic: null };
    }
    const diagnostic = event.diagnostic as StageDiagnostic;
    const outerMatches =
      diagnostic.detail.blocker_kind === event.blocker_kind &&
      diagnostic.detail.reason === event.reason &&
      diagnostic.detail.stage === event.stage &&
      diagnostic.detail.offramp_class === event.offramp_class;
    if (!outerMatches) {
      return {
        blockerClass: "workflow-engine-defect",
        disposition: "protocol_failure",
        protocolError: "producer diagnostic conflicts with its enclosing blocker_set",
        diagnostic: null,
      };
    }
    return { ...projection, diagnostic };
  }
  const detail: StageDiagnosticDetail = {
    blocker_kind: event.blocker_kind,
    reason: event.reason,
    ...(event.stage !== undefined ? { stage: event.stage } : {}),
    ...(event.offramp_class !== undefined ? { offramp_class: event.offramp_class } : {}),
  };
  const diagnostic = buildStageDiagnostic({
    blockerKind: detail.blocker_kind,
    reason: detail.reason,
    stage: detail.stage,
    offrampClass: detail.offramp_class,
  });
  return { ...projectStageDiagnostic(diagnostic), diagnostic };
}

/**
 * Optional write-health context for recovery fail-safe (#633). When control-
 * critical event evidence is missing after a recorded stream write failure,
 * the protocol error names the persistence failure so operators and recovery
 * consumers do not invent an unrelated class or human hold from absence.
 */
export interface DiagnosticWriteHealthHint {
  failure_count: number;
  worst_criticality?: string | null;
  last_error?: string | null;
  last_event_type?: string | null;
}

/** True when write-health indicates at least one recorded append failure. */
export function isElevatedDiagnosticWriteHealth(
  health: DiagnosticWriteHealthHint | null | undefined,
): boolean {
  return health != null && health.failure_count > 0;
}

/** Parse the final blocker_set event; never fall back to labels or prose.
 *  When the stream is empty/truncated and write-health is elevated (#633), the
 *  protocol error surfaces the persistence failure (engine-owned defect path)
 *  without inventing a human hold or unrelated recovery class. */
export function lastStageDiagnosticFromEventsJsonl(
  eventsText: string,
  writeHealth?: DiagnosticWriteHealthHint | null,
): StageDiagnosticResolution {
  let lastBlockerSet: unknown;
  for (const line of eventsText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: unknown };
      if (event?.type === "blocker_set") lastBlockerSet = event;
    } catch {
      // Non-JSON process output is not a typed blocker event.
    }
  }
  if (lastBlockerSet === undefined) {
    if (isElevatedDiagnosticWriteHealth(writeHealth)) {
      const crit = writeHealth!.worst_criticality ?? "unknown";
      const lastErr = writeHealth!.last_error ?? "unknown";
      const lastType = writeHealth!.last_event_type ?? "unknown";
      return {
        blockerClass: "workflow-engine-defect",
        disposition: "protocol_failure",
        protocolError:
          `blocked item has no final blocker_set diagnostic after event-stream write failure ` +
          `(failures=${writeHealth!.failure_count}, worst_criticality=${crit}, ` +
          `last_type=${lastType}, last_error=${lastErr})`,
        diagnostic: null,
      };
    }
    return {
      blockerClass: "workflow-engine-defect",
      disposition: "protocol_failure",
      protocolError: "blocked item has no final blocker_set diagnostic",
      diagnostic: null,
    };
  }
  return stageDiagnosticFromBlockerSet(lastBlockerSet);
}

// Runtime coverage checks accompany the exhaustive switches above and make
// taxonomy drift visible in focused tests/import smoke.
for (const kind of BLOCKER_KINDS) mechanicalReasonCodeForKind(kind);
for (const offramp of PRE_MERGE_OFFRAMP_CLASSES) reasonCodeFor("needs-human", offramp);
