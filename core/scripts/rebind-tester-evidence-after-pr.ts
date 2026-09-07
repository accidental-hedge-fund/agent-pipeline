// Post-PR Tester bind-or-reproduce (#1468).
//
// After implementing pushes and a linked PR makes candidate / trusted-surface
// identity observable, bind or reproduce SHA-matched Tester evidence with
// implementation role and a well-formed evidence_subject before the first
// consumer delivery-stage observer. Shared by ordinary advance, nested
// advance, single, loop, and FRG because they enter runAdvance.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  isDeliveryStage,
  requiredEvidenceRoleForStage,
  type DeliveryStage,
} from "./issue-stage-adapters.ts";
import {
  buildEvidenceSubject,
  buildRequiredEvidenceSetRevisionFromGates,
  parseEvidenceSubjectDetailed,
  resolveVerifierFingerprint,
} from "./evidence-subject.ts";
import {
  buildStageDiagnostic,
  isNestedAdvanceProcessExit,
  STAGE_DIAGNOSTIC_SCHEMA,
  type StageDiagnostic,
} from "./stage-diagnostic.ts";
import {
  candidateShaMatches,
  normalizeCandidateSha,
  readTesterEvidence,
  writeTesterEvidence,
  type TesterEvidence,
  type TesterEvidenceIoDeps,
  type WriteTesterEvidenceResult,
} from "./tester-evidence.ts";
import { isTrustedSurfaceSentinelSha } from "./trusted-surface-candidate.ts";
import type { RecoveryRecipe } from "./loop/types.ts";
import type { PipelineConfig } from "./types.ts";

/** Locked recipe id — must stay in {@link RecoveryRecipe} and policy/call sites. */
export const REBIND_TESTER_EVIDENCE_AFTER_PR = "rebind_tester_evidence_after_pr" as const;

export const TESTER_REBIND_BLOCKER_FILENAME = "tester-rebind-blocker.json";

export const TESTER_REBIND_BLOCKER_CODES = [
  "tester_rebind_pr_head_unobservable",
  "tester_rebind_pr_head_mismatch",
  "tester_rebind_trusted_surface_unobservable",
  "tester_rebind_stage_label_unrestored",
] as const;

export type TesterRebindBlockerCode = (typeof TESTER_REBIND_BLOCKER_CODES)[number];

export function isTesterRebindBlockerCode(
  value: unknown,
): value is TesterRebindBlockerCode {
  return (
    typeof value === "string" &&
    (TESTER_REBIND_BLOCKER_CODES as readonly string[]).includes(value)
  );
}

export const TESTER_EVIDENCE_ORDERING_KIND = "tester_rebind_after_pr" as const;

export const TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES = [
  "unlink_engine_scratch",
  "checkpoint_owned_harness_dirt",
  "publish_unpublished_stage_commit",
] as const;

export interface TesterEvidenceOrderingFields {
  kind: typeof TESTER_EVIDENCE_ORDERING_KIND;
  required_role: "implementation";
  observed_role: "missing" | "planning" | string;
  trusted_surface_outcome?: "passthrough" | "rebound" | "blocked" | string;
  subject_omitted_because_unobservable?: boolean;
  pr_head?: string | null;
  blocker_code?: TesterRebindBlockerCode | string;
}

export interface TesterRebindBlockerRecord {
  schema_version: 1;
  kind: "tester_rebind_blocker";
  code: TesterRebindBlockerCode;
  candidate_sha: string | null;
  pr: number | null;
  summary: string;
}

export type TrustedSurfaceRebindDecision = {
  outcome: string;
  candidate_sha: string;
  effective_verifier_hash: string | null;
};

export type RebindTesterEvidenceResult =
  | {
      ok: true;
      action: "bind" | "reproduce" | "already-bound" | "not-applicable";
      candidateSha: string;
      evidence: TesterEvidence | null;
      suiteCommandInvoked: boolean;
    }
  | {
      ok: false;
      code: TesterRebindBlockerCode;
      summary: string;
      candidateSha: string | null;
      evidence: TesterEvidence | null;
      diagnostic: StageDiagnostic;
      blocker: TesterRebindBlockerRecord;
    };

export interface ReproduceTesterEvidenceInput {
  candidateSha: string;
  runDir: string;
  prNumber: number | null;
}

export interface RebindTesterEvidenceAfterPrInput {
  cfg: Pick<PipelineConfig, "domain" | "repo" | "test_gate" | "eval_gate" | "visual_gate" | "shipcheck_gate">;
  issueNumber: number;
  stage: string;
  runDir: string;
  prNumber: number | null;
  prHeadSha: string | null | undefined;
  pushedHeadSha?: string | null;
  /** PR identity paired with pushedHeadSha when a stage-owned successor is handed off. */
  pushedPrNumber?: number | null;
  trustedSurface: TrustedSurfaceRebindDecision | null;
  domain?: string;
  engineFingerprint?: string | null;
  io?: TesterEvidenceIoDeps;
  writeTesterEvidence?: (
    runDir: string,
    evidence: TesterEvidence,
    opts?: { io?: TesterEvidenceIoDeps; appendEvent?: boolean },
  ) => Promise<WriteTesterEvidenceResult>;
  /** When SHA-matched passed evidence is absent/stale/malformed, run the producer. */
  reproduce?: (input: ReproduceTesterEvidenceInput) => Promise<{
    ok: boolean;
    candidate_sha?: string | null;
    /** True when the producer could not run (no worktree / gate). */
    unavailable?: boolean;
  }>;
  /**
   * Successor-run lookup (#1468 review 2): a SHA-matched passed Tester record
   * from a prior run of the same issue, identified by exact candidate SHA.
   * Adopted into the current runDir so the consumer observer can read it.
   */
  resolvePriorShaMatchedTester?: (candidateSha: string) => Promise<TesterEvidence | null>;
  persistBlocker?: (record: TesterRebindBlockerRecord) => Promise<void>;
}

export interface TesterImplementationRoleObservation {
  evidenceRole: "implementation";
  artifactIdentity: string;
  candidateSha: string;
  evidence: TesterEvidence;
}

const defaultIo: TesterEvidenceIoDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
};

export function isConsumerImplementationStage(stage: string | null | undefined): boolean {
  if (!stage || !isDeliveryStage(stage)) return false;
  if (stage === "implementing") return false;
  return requiredEvidenceRoleForStage(stage) === "implementation";
}

/** Consumer stages that may push a new PR head during their attempt. */
export function consumerStageMayPushPrHead(stage: string | null | undefined): boolean {
  return stage === "fix-1" || stage === "fix-2" || stage === "pre-merge";
}

export function testerArtifactIdentity(candidateSha: string): string {
  return `tester:${candidateSha}`;
}

export function trustworthyTrustedSurfacePin(
  decision: TrustedSurfaceRebindDecision | null | undefined,
  expectedSha?: string | null,
): { ok: true; hash: string; outcome: "passthrough" | "rebound" } | { ok: false } {
  if (!decision) return { ok: false };
  if (decision.outcome !== "passthrough" && decision.outcome !== "rebound") {
    return { ok: false };
  }
  const sha = normalizeCandidateSha(decision.candidate_sha);
  if (!sha || isTrustedSurfaceSentinelSha(sha)) return { ok: false };
  if (expectedSha && !candidateShaMatches(sha, expectedSha)) return { ok: false };
  const hash = decision.effective_verifier_hash;
  if (typeof hash !== "string" || hash.trim().length === 0) return { ok: false };
  return { ok: true, hash: hash.trim(), outcome: decision.outcome };
}

export function isTesterEvidenceOrderingDiagnostic(diagnostic: unknown): boolean {
  if (typeof diagnostic !== "object" || diagnostic === null) return false;
  const detail = (diagnostic as { detail?: { evidence_ordering?: unknown } }).detail;
  const ordering = detail?.evidence_ordering;
  if (typeof ordering !== "object" || ordering === null) return false;
  const fields = ordering as TesterEvidenceOrderingFields;
  if (fields.kind !== TESTER_EVIDENCE_ORDERING_KIND) return false;
  if (fields.required_role !== "implementation") return false;
  if (fields.observed_role !== "missing") return false;
  if (typeof fields.blocker_code === "string" && fields.blocker_code.startsWith("tester_rebind_")) {
    return true;
  }
  const ts = fields.trusted_surface_outcome;
  const subjectOmitted = fields.subject_omitted_because_unobservable === true;
  // A stale pre-PR blocked decision is also a legitimate rebind input: the
  // executor refreshes it against the current PR head before binding.
  if (ts !== "passthrough" && ts !== "rebound" && ts !== "blocked" && !subjectOmitted) return false;
  if (fields.pr_head != null && fields.pr_head !== "") {
    if (!normalizeCandidateSha(fields.pr_head)) return false;
  }
  return true;
}

export function filterRecipesForTesterEvidenceOrdering<T extends string>(
  recipes: readonly T[],
): T[] {
  const skip = new Set<string>(TESTER_EVIDENCE_ORDERING_INAPPLICABLE_RECIPES);
  return recipes.filter((recipe) => !skip.has(recipe));
}

/** Recipes applicable for a workflow-engine-defect diagnostic. */
export function filterRecipesForWorkflowEngineDiagnostic<T extends string>(
  recipes: readonly T[],
  diagnostic: unknown,
): T[] {
  const candidate = diagnostic as Partial<StageDiagnostic> | null;
  const processExit = candidate?.detail?.process_exit;
  if (
    candidate?.schema === STAGE_DIAGNOSTIC_SCHEMA &&
    candidate.reason_code === "workflow-engine-defect" &&
    candidate.detail?.blocker_kind === "harness-failure" &&
    candidate.detail.stage === "loop-dispatch" &&
    isNestedAdvanceProcessExit(processExit)
  ) {
    return recipes.filter((recipe) => recipe === "restart_workflow_engine");
  }
  if (isTesterEvidenceOrderingDiagnostic(diagnostic)) {
    return filterRecipesForTesterEvidenceOrdering(recipes);
  }
  return recipes.filter((recipe) => recipe !== REBIND_TESTER_EVIDENCE_AFTER_PR);
}

export function observeTesterImplementationRole(
  evidence: TesterEvidence | null | undefined,
  candidateSha: string,
  expectedPrNumber?: number | null,
): TesterImplementationRoleObservation | null {
  if (!evidence) return null;
  const sha = normalizeCandidateSha(candidateSha);
  if (!sha || !candidateShaMatches(evidence.candidate_sha, sha)) return null;
  if (evidence.overall_status !== "passed") return null;
  const subject = parseEvidenceSubjectDetailed(evidence.evidence_subject);
  if (subject.status !== "ok") return null;
  if (!candidateShaMatches(subject.subject.candidate_sha, sha)) return null;
  if (
    expectedPrNumber !== undefined &&
    (evidence.pr !== expectedPrNumber || subject.subject.pr !== expectedPrNumber)
  ) return null;
  return {
    evidenceRole: "implementation",
    artifactIdentity: testerArtifactIdentity(sha),
    candidateSha: sha,
    evidence,
  };
}

export function testerRebindBlockerPath(runDir: string): string {
  return path.join(runDir, TESTER_REBIND_BLOCKER_FILENAME);
}

export function buildTesterRebindFailClosedDiagnostic(input: {
  stage: string;
  code: TesterRebindBlockerCode;
  summary: string;
  prHead?: string | null;
  trustedSurfaceOutcome?: string | null;
}): StageDiagnostic {
  return buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: input.summary,
    stage: input.stage,
    evidenceOrdering: {
      kind: TESTER_EVIDENCE_ORDERING_KIND,
      required_role: "implementation",
      observed_role: "missing",
      blocker_code: input.code,
      ...(input.trustedSurfaceOutcome
        ? { trusted_surface_outcome: input.trustedSurfaceOutcome }
        : {}),
      ...(input.prHead ? { pr_head: input.prHead } : {}),
    },
  });
}

export function buildTesterEvidenceOrderingDiagnostic(input: {
  stage: string;
  prHead?: string | null;
  trustedSurfaceOutcome?: "passthrough" | "rebound" | "blocked" | string;
  subjectOmittedBecauseUnobservable?: boolean;
}): StageDiagnostic {
  return buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: input.stage,
    evidenceOrdering: {
      kind: TESTER_EVIDENCE_ORDERING_KIND,
      required_role: "implementation",
      observed_role: "missing",
      ...(input.trustedSurfaceOutcome
        ? { trusted_surface_outcome: input.trustedSurfaceOutcome }
        : {}),
      ...(input.prHead ? { pr_head: input.prHead } : {}),
      ...(input.subjectOmittedBecauseUnobservable
        ? { subject_omitted_because_unobservable: true }
        : {}),
    },
  });
}

export function testerSubjectOmittedBecauseUnobservable(
  evidence: TesterEvidence | null | undefined,
): boolean {
  if (!evidence) return false;
  return parseEvidenceSubjectDetailed(evidence.evidence_subject).status !== "ok";
}

/** Attach structured evidence-ordering fields to a real missing-role refuse. */
export function testerEvidenceOrderingDiagnosticForRefuse(input: {
  stage: string;
  bindingFailure: string | null | undefined;
  prHead: string | null | undefined;
  trustedSurface: TrustedSurfaceRebindDecision | null | undefined;
  subjectOmittedBecauseUnobservable?: boolean;
}): StageDiagnostic | null {
  const failure = input.bindingFailure ?? "";
  if (!failure.includes("required implementation evidence role, observed missing")) {
    return null;
  }
  const prHead = normalizeCandidateSha(input.prHead);
  const pin = trustworthyTrustedSurfacePin(input.trustedSurface, prHead);
  const subjectOmitted = input.subjectOmittedBecauseUnobservable === true;
  if (!pin.ok && !subjectOmitted) return null;
  return buildTesterEvidenceOrderingDiagnostic({
    stage: input.stage,
    ...(prHead ? { prHead } : {}),
    ...(pin.ok
      ? { trustedSurfaceOutcome: pin.outcome }
      : input.trustedSurface?.outcome
        ? { trustedSurfaceOutcome: input.trustedSurface.outcome }
        : {}),
    ...(subjectOmitted ? { subjectOmittedBecauseUnobservable: true } : {}),
  });
}

function failClosed(
  input: RebindTesterEvidenceAfterPrInput,
  code: TesterRebindBlockerCode,
  summary: string,
  candidateSha: string | null,
  evidence: TesterEvidence | null,
): Extract<RebindTesterEvidenceResult, { ok: false }> {
  const blocker: TesterRebindBlockerRecord = {
    schema_version: 1,
    kind: "tester_rebind_blocker",
    code,
    candidate_sha: candidateSha,
    pr: input.prNumber,
    summary,
  };
  return {
    ok: false,
    code,
    summary,
    candidateSha,
    evidence,
    diagnostic: buildTesterRebindFailClosedDiagnostic({
      stage: input.stage,
      code,
      summary,
      prHead: candidateSha,
      trustedSurfaceOutcome: input.trustedSurface?.outcome ?? null,
    }),
    blocker,
  };
}

async function persistBlockerRecord(
  input: RebindTesterEvidenceAfterPrInput,
  record: TesterRebindBlockerRecord,
): Promise<void> {
  if (input.persistBlocker) {
    await input.persistBlocker(record);
    return;
  }
  const io = input.io ?? defaultIo;
  await io.mkdir(input.runDir, { recursive: true });
  await io.writeFile(
    testerRebindBlockerPath(input.runDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function shaMatchedPassedRecord(
  read:
    | { status: "missing" }
    | { status: "malformed"; reason: string }
    | { status: "ok"; evidence: TesterEvidence },
  sha: string,
): TesterEvidence | null {
  if (read.status !== "ok") return null;
  return shaMatchedPassedTesterEvidence(read.evidence, sha);
}

/** SHA-matched Tester record that recorded a suite pass (not disabled/failed). */
export function shaMatchedPassedTesterEvidence(
  evidence: TesterEvidence | null | undefined,
  sha: string,
): TesterEvidence | null {
  if (!evidence) return null;
  if (!candidateShaMatches(evidence.candidate_sha, sha)) return null;
  if (evidence.overall_status !== "passed") return null;
  if (evidence.commands.length === 0) return null;
  if (evidence.commands.some((c) => c.status !== "passed")) return null;
  return evidence;
}

function alreadyBound(
  evidence: TesterEvidence,
  sha: string,
  verifierHash: string,
  identity: {
    issue: number;
    pr: number | null;
    domain?: string | null;
    engineFingerprint?: string | null;
  },
): boolean {
  const parsed = parseEvidenceSubjectDetailed(evidence.evidence_subject);
  if (parsed.status !== "ok") return false;
  const subject = parsed.subject;
  if (!candidateShaMatches(subject.candidate_sha, sha)) return false;
  if (subject.verifier_fingerprint !== verifierHash) return false;
  if (subject.issue !== identity.issue) return false;
  if (subject.pr !== identity.pr) return false;
  if (evidence.issue !== identity.issue) return false;
  if (evidence.pr !== identity.pr) return false;
  const domain = typeof identity.domain === "string" ? identity.domain.trim() : "";
  if (domain && subject.domain !== domain) return false;
  const engineFp =
    typeof identity.engineFingerprint === "string" ? identity.engineFingerprint.trim() : "";
  if (engineFp && subject.engine_fingerprint !== engineFp) return false;
  return true;
}

function rebindIdentity(input: RebindTesterEvidenceAfterPrInput): {
  issue: number;
  pr: number | null;
  domain?: string;
  engineFingerprint?: string | null;
} {
  return {
    issue: input.issueNumber,
    pr: input.prNumber,
    domain: input.domain ?? input.cfg.domain ?? input.cfg.repo,
    engineFingerprint: input.engineFingerprint,
  };
}

async function bindMatchedTesterEvidence(
  input: RebindTesterEvidenceAfterPrInput,
  matched: TesterEvidence,
  prHead: string,
  pin: { hash: string; outcome: "passthrough" | "rebound" },
): Promise<
  | Extract<RebindTesterEvidenceResult, { ok: true; action: "bind" }>
  | Extract<RebindTesterEvidenceResult, { ok: false }>
> {
  const io = input.io ?? defaultIo;
  const writeFn = input.writeTesterEvidence ?? writeTesterEvidence;
  const domain = (input.domain ?? input.cfg.domain ?? input.cfg.repo ?? "").trim();
  const engineFp =
    (typeof input.engineFingerprint === "string" && input.engineFingerprint.trim()) ||
    matched.evidence_subject?.engine_fingerprint ||
    "";
  const verifierFp = resolveVerifierFingerprint({
    engineFingerprint: engineFp || pin.hash,
    trustedSurface: {
      outcome: pin.outcome,
      effective_verifier_hash: pin.hash,
    },
  });
  if (!domain || !engineFp || !verifierFp) {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      "tester rebind: cannot form a well-formed evidence_subject from the trusted-surface pin",
      prHead,
      matched,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  let subject;
  try {
    subject = buildEvidenceSubject({
      domain,
      issue: input.issueNumber,
      pr: input.prNumber,
      run_id: matched.run_id,
      candidate_sha: prHead,
      diff_hash: matched.evidence_subject?.diff_hash ?? null,
      policy_hash: matched.evidence_subject?.policy_hash ?? matched.config_digest,
      engine_fingerprint: engineFp,
      verifier_fingerprint: verifierFp,
      required_evidence_set_revision:
        matched.evidence_subject?.required_evidence_set_revision ??
        buildRequiredEvidenceSetRevisionFromGates({
          testGateEnabled: input.cfg.test_gate?.enabled,
          evalGateEnabled: input.cfg.eval_gate?.enabled,
          visualGateEnabled: input.cfg.visual_gate?.enabled,
          shipcheckGateEnabled: input.cfg.shipcheck_gate?.enabled,
        }),
    });
  } catch {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      "tester rebind: evidence_subject construction failed closed",
      prHead,
      matched,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  const bound: TesterEvidence = {
    ...matched,
    candidate_sha: prHead,
    issue: input.issueNumber,
    pr: input.prNumber,
    evidence_subject: subject,
  };
  const written = await writeFn(input.runDir, bound, { io, appendEvent: false });
  if (!written.ok) {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      `tester rebind: persist failed: ${written.error ?? "write failed"}`,
      prHead,
      matched,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  return {
    ok: true,
    action: "bind",
    candidateSha: prHead,
    evidence: bound,
    suiteCommandInvoked: false,
  };
}

export async function rebindTesterEvidenceAfterPr(
  input: RebindTesterEvidenceAfterPrInput,
): Promise<RebindTesterEvidenceResult> {
  const prHead = normalizeCandidateSha(input.prHeadSha);
  if (!prHead) {
    const result = failClosed(
      input,
      "tester_rebind_pr_head_unobservable",
      "tester rebind: linked PR head is missing or is not a full 40-character hex SHA",
      null,
      null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  const pushed = normalizeCandidateSha(input.pushedHeadSha);
  if (
    pushed &&
    input.pushedPrNumber != null &&
    input.prNumber !== input.pushedPrNumber
  ) {
    const result = failClosed(
      input,
      "tester_rebind_pr_head_mismatch",
      `tester rebind: linked PR changed from #${input.pushedPrNumber} to ` +
        `${input.prNumber == null ? "unbound" : `#${input.prNumber}`} after candidate ${pushed} was pushed`,
      prHead,
      null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  if (pushed && pushed !== prHead) {
    const result = failClosed(
      input,
      "tester_rebind_pr_head_mismatch",
      `tester rebind: linked PR head ${prHead} disagrees with pushed head ${pushed}`,
      prHead,
      null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }

  const pin = trustworthyTrustedSurfacePin(input.trustedSurface, prHead);
  if (!pin.ok) {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      "tester rebind: trusted-surface is not passthrough/rebound with a trustworthy verifier pin",
      prHead,
      null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }

  const io = input.io ?? defaultIo;
  const read = await readTesterEvidence(input.runDir, io);
  let matched = shaMatchedPassedRecord(read, prHead);
  const writeFn = input.writeTesterEvidence ?? writeTesterEvidence;

  if (!matched && input.resolvePriorShaMatchedTester) {
    const prior = await input.resolvePriorShaMatchedTester(prHead);
    const priorMatched = shaMatchedPassedTesterEvidence(prior, prHead);
    if (priorMatched) {
      const adopted = await writeFn(input.runDir, priorMatched, { io, appendEvent: false });
      if (!adopted.ok) {
        const result = failClosed(
          input,
          "tester_rebind_trusted_surface_unobservable",
          `tester rebind: persist of prior-run Tester evidence failed: ${adopted.error ?? "write failed"}`,
          prHead,
          priorMatched,
        );
        await persistBlockerRecord(input, result.blocker);
        return result;
      }
      matched = priorMatched;
    }
  }

  if (matched) {
    if (alreadyBound(matched, prHead, pin.hash, rebindIdentity(input))) {
      return {
        ok: true,
        action: "already-bound",
        candidateSha: prHead,
        evidence: matched,
        suiteCommandInvoked: false,
      };
    }
    return bindMatchedTesterEvidence(input, matched, prHead, pin);
  }

  if (input.cfg.test_gate?.enabled === false) {
    return {
      ok: true,
      action: "not-applicable",
      candidateSha: prHead,
      evidence: read.status === "ok" ? read.evidence : null,
      suiteCommandInvoked: false,
    };
  }

  if (!input.reproduce) {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      "tester rebind: no SHA-matched Tester record for the PR head and no producer was supplied",
      prHead,
      read.status === "ok" ? read.evidence : null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  const reproduced = await input.reproduce({
    candidateSha: prHead,
    runDir: input.runDir,
    prNumber: input.prNumber,
  });
  const after = await readTesterEvidence(input.runDir, io);
  const afterMatched = shaMatchedPassedRecord(after, prHead);
  const afterRole = afterMatched
    ? observeTesterImplementationRole(afterMatched, prHead)
    : null;
  if (!reproduced.ok || !afterMatched || !afterRole) {
    const result = failClosed(
      input,
      "tester_rebind_trusted_surface_unobservable",
      "tester rebind: producer did not persist SHA-matched implementation-role Tester evidence for the PR head",
      prHead,
      after.status === "ok" ? after.evidence : null,
    );
    await persistBlockerRecord(input, result.blocker);
    return result;
  }
  if (alreadyBound(afterMatched, prHead, pin.hash, rebindIdentity(input))) {
    return {
      ok: true,
      action: "reproduce",
      candidateSha: prHead,
      evidence: afterMatched,
      suiteCommandInvoked: true,
    };
  }
  const bound = await bindMatchedTesterEvidence(input, afterMatched, prHead, pin);
  if (!bound.ok) return bound;
  return {
    ok: true,
    action: "reproduce",
    candidateSha: prHead,
    evidence: bound.evidence,
    suiteCommandInvoked: true,
  };
}

export function recipesClaimedOrCharged(
  attempts: readonly { action?: string; outcome?: string }[],
): string[] {
  return attempts
    .filter((attempt) => attempt.outcome !== "skipped")
    .map((attempt) => attempt.action)
    .filter((action): action is string => typeof action === "string");
}

export type { DeliveryStage, RecoveryRecipe };
