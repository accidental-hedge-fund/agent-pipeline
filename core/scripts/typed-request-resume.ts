// Shared typed-request resume contract for unblock, override, and handoff answer (#1329).
//
// One ledger: human-question-handoff. This module does not add a second answer
// store or a new resume CLI verb.

import {
  answerAndPersistHandoff,
  HANDOFF_SCHEMA_VERSION,
  listHandoffs,
  validateHandoffResume,
  type HumanQuestionHandoff,
  type ResumeContext,
  type ResumeValidation,
} from "./human-question-handoff.ts";

export interface TypedRequestResumeDeps {
  listHandoffs?: typeof listHandoffs;
  answerAndPersistHandoff?: typeof answerAndPersistHandoff;
  validateHandoffResume?: typeof validateHandoffResume;
}

export interface TypedRequestResumeInput {
  repoDir: string;
  issueNumber: number;
  answer: string;
  actor: string;
  candidateSha: string | null;
  resumeTarget: string;
  blockedStage?: string;
}

export interface TypedRequestResumeResult {
  resume: ResumeValidation;
  handoff: HumanQuestionHandoff | null;
  fulfilled: boolean;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Test helper for resume-validation fixtures. Production resume must persist
 *  fulfillment of an existing pending request — never this in-memory object. */
export function answeredFulfillmentHandoff(input: TypedRequestResumeInput): HumanQuestionHandoff {
  return {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: `typed-response-${input.issueNumber}`,
    domain: "pipeline",
    repo: "local/repo",
    issue_number: input.issueNumber,
    run_id: null,
    attempt_id: null,
    blocked_stage: input.blockedStage ?? "needs-human",
    question: "operator typed response",
    reason: "pipeline unblock/override fulfillment",
    handoff_class: "missing_context",
    authority_mode: "non_authority",
    human_decision_required: null,
    scope: { candidate_sha: input.candidateSha },
    required_capability: ["operator-answer"],
    resolution_evidence: {
      unresolved: false,
      eligible_actors: [input.actor],
      resolution_summary: "operator typed response",
    },
    status: "answered",
    created_at: nowIso(),
    expires_at: null,
    supersedes: null,
    superseded_by: null,
    answer: {
      decision: "answer",
      responder: input.actor,
      identity_source: "gh_actor",
      answer_text: input.answer,
      answered_at: nowIso(),
      payload_hash: "typed-response",
    },
    resume_target: input.resumeTarget,
    resume_preconditions: ["answer-valid"],
  };
}

/**
 * Fulfill a pending handoff when one exists, then run the existing resume
 * validation contract. Never advances by itself.
 */
export async function fulfillTypedRequestAndValidateResume(
  input: TypedRequestResumeInput,
  deps: TypedRequestResumeDeps = {},
): Promise<TypedRequestResumeResult> {
  const listFn = deps.listHandoffs ?? listHandoffs;
  const answerFn = deps.answerAndPersistHandoff ?? answerAndPersistHandoff;
  const validateFn = deps.validateHandoffResume ?? validateHandoffResume;

  const pending = await listFn(input.repoDir, {
    issue: input.issueNumber,
    status: "pending",
  });
  const current = pending[0] ?? null;
  if (!current) {
    return {
      resume: {
        ok: false,
        reason: "no eligible current typed request to fulfill",
        code: "no_pending_request",
        advances_item: false,
      },
      handoff: null,
      fulfilled: false,
    };
  }

  let handoff = current;
  let fulfilled = false;
  const answered = await answerFn(input.repoDir, input.issueNumber, current.handoff_id, {
    decision: "answer",
    actor: input.actor,
    identitySource: "gh",
    authenticated: true,
    answerText: input.answer,
    clientRequestId: null,
  });
  if (answered.ok) {
    handoff = answered.handoff;
    fulfilled = true;
  } else {
    handoff = answered.handoff;
  }

  const ctx: ResumeContext = {
    candidate_sha: input.candidateSha,
  };
  const resume = await validateFn(handoff, ctx);
  return { resume, handoff, fulfilled };
}
