// Risk-triggered design-interrogation gate stage (#436) — sits between
// `implementing` and `review-1`. Inert unless `design_gate.enabled` is true
// AND a risk trigger matches the changed-file set/labels/diff size; a
// disabled or untriggered run advances immediately with a recorded reason and
// no harness call, keeping the change default-inert.
//
// When triggered, this single stage handler runs the entire bounded
// interrogation loop in one invocation (mirroring visual.ts's inline fix-round
// loop): obtain a decision record from the implementer, interrogate it with
// the independent reviewer harness, and — while blocking challenges remain —
// alternate implementer response rounds with re-review, bounded by
// `design_gate.max_rounds` and recurrence-aware (a blocking challenge key that
// reappears after a response round parks at `needs-human` immediately).
//
// Crash/resume (#436 D8): state is not kept in memory across separate CLI
// invocations (each `pipeline <issue>` run gets its own `runDir`) — it is
// reconstructed from the issue's own `## Design Interrogation` comments, each
// of which carries the FULL current `DesignGateState` as a hidden base64
// artifact. This mirrors `ReviewArtifact`'s persistence model exactly: GitHub
// labels/comments remain authoritative, not local files.

import {
  ARCHITECTURE_FILE_THRESHOLD,
  DESIGN_GATE_COMMENT_HEADING,
  boundDesignDecisionRecord,
  challengeKey,
  decodeDesignGateState,
  DesignRecordLimitsError,
  encodeDesignGateState,
  evaluateDesignGateTrigger,
  isBlockingChallenge,
  parseDesignDecisionRecord,
  parseDesignResponses,
  parseDesignVerdict,
  redactDesignDecisionRecord,
  validateDesignDecisionRecord,
} from "../design-gate.ts";
import {
  ensureManagedWorktree,
  getForIssue as defaultGetForIssue,
  isOccupiedWorktreeFault,
  type EnsureManagedWorktreeDeps,
  type EnsureManagedWorktreeResult,
} from "../worktree.ts";
import {
  getGhActor as defaultGetGhActor,
  getIssueDetail as defaultGetIssueDetail,
  getPrDetail as defaultGetPrDetail,
  getPrDiff as defaultGetPrDiff,
  getPrForIssue as defaultGetPrForIssue,
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { invoke as defaultInvoke, type HarnessResult, type InvokeOptions } from "../harness.ts";
import {
  buildDesignDecisionRecordPrompt,
  buildDesignInterrogationPrompt,
  buildDesignResponsePrompt,
} from "../prompts/index.ts";
import { recordDesignInterrogation } from "../evidence-bundle.ts";
import { invokeClaudeReviewerWithEntitlementFallback } from "../self-review.ts";
import {
  expandAutoEffort,
  resolveReviewerModelForHarness,
  reviewerModelSourceWasAuto,
} from "../stage-routing.ts";
import {
  classifyReviewerHarnessFailure,
  isClaudeModelEntitlementFailure,
} from "../model-entitlement.ts";
import { buildStageDiagnostic, type StageDiagnostic } from "../stage-diagnostic.ts";
import { extractPlan } from "./review-acquisition.ts";
import { attestPipelineComment, diffFilePaths } from "./review-parsing.ts";
import type {
  BlockerKind,
  DesignChallenge,
  DesignChallengeResponse,
  DesignDecisionRecord,
  DesignDecisionRecordBounding,
  DesignGateRound,
  DesignGateState,
  Harness,
  Outcome,
  PipelineConfig,
  Stage,
} from "../types.ts";

const NEXT_STAGE: Stage = "review-1";

/** Signature of the harness `invoke` — injectable so the gate loop is unit-testable. */
export type InvokeFn = (
  harness: Harness | string,
  worktreeDir: string,
  prompt: string,
  opts?: InvokeOptions,
) => Promise<HarnessResult>;

export interface DesignGateDeps {
  getForIssue?: (cfg: PipelineConfig, issueNumber: number) => Promise<{ path: string; slug: string } | null>;
  getIssueDetail?: typeof defaultGetIssueDetail;
  getPrForIssue?: typeof defaultGetPrForIssue;
  getPrDetail?: typeof defaultGetPrDetail;
  getPrDiff?: typeof defaultGetPrDiff;
  getGhActor?: () => Promise<string | null>;
  transition?: (cfg: PipelineConfig, issueNumber: number, from: Stage, to: Stage, reason: string) => Promise<void>;
  silentTransition?: (cfg: PipelineConfig, issueNumber: number, from: Stage, to: Stage) => Promise<void>;
  setBlocked?: (cfg: PipelineConfig, issueNumber: number, reason: string, stage: Stage | null, kind?: BlockerKind) => Promise<void>;
  postComment?: (cfg: PipelineConfig, issueNumber: number, body: string) => Promise<void>;
  invoke?: InvokeFn;
  /** #760: rematerialize before worktree-missing park (transient-retryable). */
  ensureManagedWorktree?: (
    cfg: PipelineConfig,
    issueNumber: number,
    ensureDeps?: EnsureManagedWorktreeDeps,
  ) => Promise<EnsureManagedWorktreeResult>;
}

export interface AdvanceDesignGateOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir (#147); when set, the gate's final state
   *  (trigger record, decision record, rounds, outcome) is recorded under
   *  `bundle.designInterrogation`. Undefined → recording disabled. */
  stateDir?: string;
}

function isHarnessUnavailable(result: HarnessResult): boolean {
  return !result.success && (result.spawn_error === true || result.timed_out);
}

/**
 * Reviewer invoke failures that must short-circuit before verdict parse / re-ask
 * (#870). Entitlement and ordinary throttle are first-class; other unsuccessful
 * harness results are also typed via {@link classifyReviewerHarnessFailure}.
 * Successful responses that are merely malformed still take the bounded re-ask path.
 */
function isReviewerInvocationFailure(result: HarnessResult): boolean {
  if (isClaudeModelEntitlementFailure(result.stdout, result.stderr, result)) return true;
  if (result.throttled) return true;
  if (isHarnessUnavailable(result)) return true;
  return !result.success;
}

function reviewerInvocationFailureBlock(
  result: HarnessResult,
  reviewerHarness: string,
  roundNum: number,
): { blocked: string; diagnostic: StageDiagnostic } {
  const reasonCode = classifyReviewerHarnessFailure(result);
  const excerpt = `${result.stderr || result.stdout}`.trim().slice(0, 400);
  let blocked: string;
  if (isHarnessUnavailable(result)) {
    blocked = `reviewer harness (${reviewerHarness}) unavailable during interrogation round ${roundNum}`;
  } else if (reasonCode === "model-entitlement-required") {
    blocked =
      `reviewer model entitlement failure during interrogation round ${roundNum}` +
      (excerpt ? `: ${excerpt}` : "");
  } else if (reasonCode === "transient-infra") {
    blocked =
      `reviewer harness throttled during interrogation round ${roundNum}` +
      (excerpt ? `: ${excerpt}` : "");
  } else if (reasonCode === "harness-timeout") {
    blocked = `reviewer harness timed out during interrogation round ${roundNum}`;
  } else {
    blocked =
      `reviewer harness (${reviewerHarness}) failed during interrogation round ${roundNum}` +
      (excerpt ? `: ${excerpt}` : "");
  }
  const diagnostic = buildStageDiagnostic({
    reasonCode,
    blockerKind: "harness-failure",
    reason: blocked,
    stage: "design-gate",
  });
  return { blocked, diagnostic };
}

/**
 * Render the human-readable body for a `## Design Interrogation` comment, plus
 * the trailing hidden `DesignGateState` artifact, then a generic pipeline
 * attestation marker (#471). Pure + exported so the PIPELINE_COMMENT_KINDS
 * drift guard exercises the real renderer and so design-gate posts self-exclude
 * from `findUnacknowledgedComments` (challenge prose trips negation patterns).
 */
export function buildDesignGateComment(state: DesignGateState, note: string): string {
  const lines: string[] = [DESIGN_GATE_COMMENT_HEADING, ""];
  lines.push(`**Matched triggers**: ${state.trigger.matched.map((m) => m.trigger).join(", ") || "(none)"}`);
  if (state.reviewerIdentity) {
    lines.push(
      `**Reviewer**: \`${state.reviewerIdentity.harness}\` (${state.reviewerIdentity.independence})`,
    );
  }
  lines.push("", note, "");
  for (const round of state.rounds) {
    lines.push(`### Round ${round.round}`);
    for (const c of round.challenges) {
      const disposition = round.responses.find((r) => r.challengeKey === c.challengeKey);
      const status = disposition ? disposition.disposition : c.blocking ? "unresolved" : "advisory";
      lines.push(`- \`${c.challengeKey}\` [${c.severity}] ${c.title} — **${status}**`);
    }
    lines.push("");
  }
  if (state.outcome) lines.push(`**Outcome**: ${state.outcome}`, "");
  // design-gate-state must precede pipeline-attest: attestation verification
  // requires the marker to be the last non-empty line of the body.
  lines.push("---", "*Automated by Claude Code Pipeline Skill*", "", encodeDesignGateState(state));
  return attestPipelineComment("design-interrogation", lines.join("\n"));
}

function decisionRecordJson(state: DesignGateState): string {
  const latest = state.decisionRecordVersions.at(-1);
  return latest ? JSON.stringify(latest, null, 2) : "{}";
}

function formatChallengesForResponse(challenges: (DesignChallenge & { challengeKey: string })[]): string {
  return challenges
    .map(
      (c) =>
        `- \`${c.challengeKey}\` [${c.severity}, confidence ${c.confidence}] **${c.title}** (decision: ${c.decision_id}, required: ${c.required_action})\n  Falsifier: ${c.falsifier}\n  Evidence requested: ${c.evidence_request}`,
    )
    .join("\n");
}

function formatPriorDispositions(round: DesignGateRound): string {
  return round.responses
    .map((r) => {
      const c = round.challenges.find((ch) => ch.challengeKey === r.challengeKey);
      return `- \`${r.challengeKey}\` ${c ? `(${c.title})` : ""}: **${r.disposition}** — ${r.evidence}`;
    })
    .join("\n");
}

function buildRoundChallenges(
  challenges: DesignChallenge[],
  policy: Pick<PipelineConfig["design_gate"], "block_threshold" | "min_confidence">,
): (DesignChallenge & { challengeKey: string; blocking: boolean })[] {
  return challenges.map((c) => ({
    ...c,
    challengeKey: challengeKey(c),
    blocking: isBlockingChallenge(c, policy),
  }));
}

export async function advanceDesignGate(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceDesignGateOpts = {},
  deps: DesignGateDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: design-gate`);

  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getPrForIssueFn = deps.getPrForIssue ?? defaultGetPrForIssue;
  const getPrDetailFn = deps.getPrDetail ?? defaultGetPrDetail;
  const getPrDiffFn = deps.getPrDiff ?? defaultGetPrDiff;
  const getGhActorFn = deps.getGhActor ?? defaultGetGhActor;
  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const invokeFn = deps.invoke ?? defaultInvoke;

  async function record(s: DesignGateState): Promise<void> {
    if (opts.stateDir) await recordDesignInterrogation(opts.stateDir, issueNumber, s).catch(() => {});
  }

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would evaluate the design-interrogation gate`);
    return { advanced: true, from: "design-gate", to: NEXT_STAGE, summary: "[dry-run]" };
  }

  if (!cfg.design_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: design-gate disabled; skipping.`);
    await silentTransitionFn(cfg, issueNumber, "design-gate", NEXT_STAGE);
    await record({
      schema_version: 1,
      trigger: { triggered: false, matched: [], reason: "gate-disabled" },
      reviewerIdentity: null,
      decisionRecordVersions: [],
      bounding: null,
      rounds: [],
      outcome: null,
    });
    return { advanced: true, from: "design-gate", to: NEXT_STAGE, summary: "design-gate disabled (gate-disabled)" };
  }

  const issue = await getIssueDetailFn(cfg, issueNumber);
  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "design-gate: no pull request found for this issue.",
      "design-gate",
      "no-pull-request",
    );
    return { advanced: false, status: "blocked", reason: "no pull request", blockerKind: "no-pull-request" };
  }
  const prDetail = await getPrDetailFn(cfg, prNumber);
  const diff = await getPrDiffFn(cfg, prNumber);
  const changedFiles = diffFilePaths(diff);

  const trigger = evaluateDesignGateTrigger(cfg, {
    changedFiles,
    labels: issue.labels,
    diffAdditions: prDetail.additions,
    diffDeletions: prDetail.deletions,
  });

  if (!trigger.triggered) {
    console.log(`[pipeline] #${issueNumber}: design-gate not triggered (${trigger.reason}); skipping.`);
    await silentTransitionFn(cfg, issueNumber, "design-gate", NEXT_STAGE);
    await record({
      schema_version: 1,
      trigger,
      reviewerIdentity: null,
      decisionRecordVersions: [],
      bounding: null,
      rounds: [],
      outcome: null,
    });
    return { advanced: true, from: "design-gate", to: NEXT_STAGE, summary: `design-gate not triggered (${trigger.reason})` };
  }

  let wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    // #760: transient-retryable worktree-missing — rematerialize before park.
    // EnsureManagedWorktreeResult uses pass|skipped|fail (not "ok"); treat only
    // fail as terminal — successful recreate must continue (#882 recovery).
    const ensureFn = deps.ensureManagedWorktree ?? ensureManagedWorktree;
    const remat = await ensureFn(cfg, issueNumber, { getOnDiskForIssue: getForIssueFn });
    // Only proceed with a materialized worktree. `skipped`/`pass` without a
    // non-null worktree is not usable (runtime type-stripping + injectable
    // fakes can return that shape) — park as worktree-missing (#882 review-2).
    if (remat.result === "fail" || !remat.worktree) {
      if (remat.result === "fail" && isOccupiedWorktreeFault(remat)) {
        return { advanced: false, status: "waiting", reason: remat.reason };
      }
      const blockerKind =
        remat.result === "fail" && remat.blockerKind
          ? remat.blockerKind
          : "worktree-missing";
      const reason =
        remat.result === "fail"
          ? `design-gate: no worktree found and rematerialize failed (${blockerKind}): ${remat.reason}`
          : `design-gate: no worktree found and rematerialize returned ${remat.result} without a worktree: ${remat.reason}`;
      // Explicit kind literals keep the blocked-recipes / disposition scanners honest.
      if (blockerKind === "worktree-capacity") {
        await setBlockedFn(cfg, issueNumber, reason, "design-gate", "worktree-capacity");
        return { advanced: false, status: "blocked", reason, blockerKind: "worktree-capacity" };
      }
      if (blockerKind === "worktree-creation-failed") {
        await setBlockedFn(cfg, issueNumber, reason, "design-gate", "worktree-creation-failed");
        return { advanced: false, status: "blocked", reason, blockerKind: "worktree-creation-failed" };
      }
      await setBlockedFn(cfg, issueNumber, reason, "design-gate", "worktree-missing");
      return { advanced: false, status: "blocked", reason, blockerKind: "worktree-missing" };
    }
    wt = { path: remat.worktree.path, slug: remat.worktree.slug };
  }

  // Reconstruct prior state from this issue's own design-gate comments (#436 D8).
  const actor = await getGhActorFn();
  const trustedComments = actor ? issue.comments.filter((c) => c.author === actor) : [];
  const priorGateComments = trustedComments.filter((c) => c.body.startsWith(DESIGN_GATE_COMMENT_HEADING));
  const lastGateComment = priorGateComments.at(-1);
  let state: DesignGateState =
    (lastGateComment && decodeDesignGateState(lastGateComment.body)) ?? {
      schema_version: 1,
      trigger,
      reviewerIdentity: null,
      decisionRecordVersions: [],
      bounding: null,
      rounds: [],
      outcome: null,
    };

  const plan = extractPlan(issue.comments);
  const implementerHarness = cfg.harnesses.implementer;
  const reviewerHarness = cfg.harnesses.reviewer;
  // Shared reviewer model chain (#870): structured review_harness.model when set,
  // else models.review after auto expansion / resolveReviewerModelForHarness.
  // Never leave model undefined under auto so Claude does not inherit a host
  // Fable default by omitting --model.
  const reviewerModelWasAuto = reviewerModelSourceWasAuto(cfg, undefined);
  const resolvedReviewerModel = resolveReviewerModelForHarness(
    cfg.harnesses.reviewerModel ?? cfg.models.review,
    reviewerHarness,
    reviewerModelWasAuto,
  );
  const resolvedReviewerEffort =
    expandAutoEffort(
      cfg.harnesses.reviewerEffort ?? cfg.effort?.review,
      "review-2",
      "claude",
    ) ?? cfg.harnesses.reviewerEffort;
  if (!state.reviewerIdentity) {
    state.reviewerIdentity = {
      harness: reviewerHarness,
      model: resolvedReviewerModel,
      effort: resolvedReviewerEffort,
      independence: reviewerHarness === implementerHarness ? "same-harness-fallback" : "independent",
    };
  } else if (
    // Prior gate comments may have decoded null/empty model under unstructured auto.
    (!state.reviewerIdentity.model || state.reviewerIdentity.model === "") &&
    reviewerModelWasAuto
  ) {
    state.reviewerIdentity = {
      ...state.reviewerIdentity,
      harness: state.reviewerIdentity.harness || reviewerHarness,
      model: resolvedReviewerModel,
      effort: state.reviewerIdentity.effort ?? resolvedReviewerEffort,
    };
  }

  async function blockAndReturn(
    reason: string,
    opts?: { diagnostic?: StageDiagnostic; blockerKind?: BlockerKind },
  ): Promise<Outcome> {
    state.outcome = "blocked";
    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, reason)).catch(() => {});
    // Literal blocker kinds keep the escalation inventory drift-guard honest
    // (dynamic variables become site_id …:dynamic#N).
    if (opts?.blockerKind === "harness-failure") {
      await setBlockedFn(cfg, issueNumber, `design-gate: ${reason}`, "design-gate", "harness-failure");
      await record(state);
      return {
        advanced: false,
        status: "blocked",
        reason,
        blockerKind: "harness-failure",
        ...(opts.diagnostic ? { diagnostic: opts.diagnostic } : {}),
      };
    }
    await setBlockedFn(cfg, issueNumber, `design-gate: ${reason}`, "design-gate", "design-gate-failed");
    await record(state);
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "design-gate-failed",
      ...(opts?.diagnostic ? { diagnostic: opts.diagnostic } : {}),
    };
  }

  // Step 1: obtain a validated, bounded, redacted decision record if we don't have one yet.
  if (state.decisionRecordVersions.length === 0) {
    const triggerSummary = trigger.matched.map((m) => `${m.trigger} (${m.evidence})`).join("; ");
    const basePrompt = buildDesignDecisionRecordPrompt({
      issueNumber,
      body: issue.body,
      plan,
      changedFiles,
      triggerSummary,
    });
    let result = await invokeFn(implementerHarness, wt.path, basePrompt, {
      timeoutSec: cfg.implementation_timeout,
      model: cfg.models.implementing,
    });
    if (isHarnessUnavailable(result)) {
      return blockAndReturn(`implementer harness (${implementerHarness}) unavailable while producing the decision record`);
    }
    let parsed = parseDesignDecisionRecord(result.stdout);
    if (!parsed.record) {
      const reaskPrompt = `${basePrompt}\n\nYour previous response could not be parsed: ${parsed.errors.join("; ")}. Return ONLY the valid JSON object — no other text.`;
      result = await invokeFn(implementerHarness, wt.path, reaskPrompt, {
        timeoutSec: cfg.implementation_timeout,
        model: cfg.models.implementing,
      });
      if (isHarnessUnavailable(result)) {
        return blockAndReturn(`implementer harness (${implementerHarness}) unavailable while producing the decision record`);
      }
      parsed = parseDesignDecisionRecord(result.stdout);
    }
    if (!parsed.record) {
      return blockAndReturn(`could not obtain a valid decision record after one bounded re-ask: ${parsed.errors.join("; ")}`);
    }
    const redacted = redactDesignDecisionRecord(parsed.record);
    let bounded: DesignDecisionRecord;
    let bounding: DesignDecisionRecordBounding;
    try {
      ({ record: bounded, bounding } = boundDesignDecisionRecord(redacted, cfg.design_gate.limits));
    } catch (err) {
      if (err instanceof DesignRecordLimitsError) return blockAndReturn(err.message);
      throw err;
    }
    state.decisionRecordVersions.push(bounded);
    state.bounding = bounding;
    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, "Decision record recorded.")).catch(() => {});
  }

  const policy = { block_threshold: cfg.design_gate.block_threshold, min_confidence: cfg.design_gate.min_confidence };

  async function invokeReviewerRound(prompt: string): Promise<HarnessResult> {
    const model = state.reviewerIdentity?.model;
    const effort = state.reviewerIdentity?.effort;
    const invokeOpts: InvokeOptions = {
      timeoutSec: cfg.review_timeout,
      model,
      reasoningEffort: effort,
      modelWasAuto: reviewerModelWasAuto,
    };
    // #870: share auto entitlement allowlisted retry with plan-review when
    // the effective reviewer is claude and the model originated from auto.
    if (reviewerHarness === "claude") {
      const { result, entitlementFallback, resolvedModel } =
        await invokeClaudeReviewerWithEntitlementFallback(wt.path, prompt, invokeOpts, invokeFn);
      if (entitlementFallback && resolvedModel && state.reviewerIdentity) {
        // Record the successful fallback model on identity for later rounds /
        // evidence, without mutating config-load auto preference.
        state.reviewerIdentity = { ...state.reviewerIdentity, model: resolvedModel };
      }
      return result;
    }
    return invokeFn(reviewerHarness, wt.path, prompt, invokeOpts);
  }

  async function getVerdict(
    roundNum: number,
    priorRound: DesignGateRound | null,
  ): Promise<
    | { round: DesignGateRound }
    | { blocked: string; diagnostic?: StageDiagnostic }
  > {
    const prompt = buildDesignInterrogationPrompt({
      body: issue.body,
      plan,
      decisionRecordJson: decisionRecordJson(state),
      priorDispositions: priorRound ? formatPriorDispositions(priorRound) : undefined,
    });
    let result = await invokeReviewerRound(prompt);
    // Invocation failures (entitlement, throttle, spawn, timeout, non-success)
    // are first-class typed outcomes — never parse as verdicts or consume re-ask (#870).
    if (isReviewerInvocationFailure(result)) {
      return reviewerInvocationFailureBlock(result, reviewerHarness, roundNum);
    }
    let verdict = parseDesignVerdict(result.stdout);
    if (!verdict) {
      // Bounded re-ask is reserved for successful reviewer responses that are
      // merely malformed — not for harness/throttle/entitlement failures.
      const reaskPrompt = `${prompt}\n\nYour previous response could not be parsed into a valid verdict. Return ONLY the valid JSON object described above — no other text.`;
      result = await invokeReviewerRound(reaskPrompt);
      if (isReviewerInvocationFailure(result)) {
        return reviewerInvocationFailureBlock(result, reviewerHarness, roundNum);
      }
      verdict = parseDesignVerdict(result.stdout);
    }
    if (!verdict) {
      return { blocked: `reviewer produced an unparseable verdict after one bounded re-ask in round ${roundNum}` };
    }
    return {
      round: {
        round: roundNum,
        reviewerRaw: result.stdout.slice(0, 4000),
        challenges: buildRoundChallenges(verdict.challenges, policy),
        responses: [],
      },
    };
  }

  async function getResponse(
    blocking: (DesignChallenge & { challengeKey: string; blocking: boolean })[],
  ): Promise<{ responses: DesignChallengeResponse[] } | { blocked: string }> {
    const prompt = buildDesignResponsePrompt({
      body: issue.body,
      decisionRecordJson: decisionRecordJson(state),
      challengesText: formatChallengesForResponse(blocking),
    });
    const result = await invokeFn(implementerHarness, wt.path, prompt, {
      timeoutSec: cfg.fix_timeout,
      model: cfg.models.fix,
    });
    if (isHarnessUnavailable(result)) return { responses: [] };
    const payload = parseDesignResponses(result.stdout);
    if (payload.revisedRecord) {
      const redacted = redactDesignDecisionRecord(payload.revisedRecord);
      let bounded: DesignDecisionRecord;
      let bounding: DesignDecisionRecordBounding;
      try {
        ({ record: bounded, bounding } = boundDesignDecisionRecord(redacted, cfg.design_gate.limits));
      } catch (err) {
        if (err instanceof DesignRecordLimitsError) return { blocked: err.message };
        throw err;
      }
      state.decisionRecordVersions.push(bounded);
      state.bounding = bounding;
    }
    return { responses: payload.responses };
  }

  // Step 2: bounded interrogation/response loop.
  if (state.rounds.length === 0) {
    const result = await getVerdict(1, null);
    if ("blocked" in result) {
      return blockAndReturn(
        result.blocked,
        result.diagnostic
          ? { diagnostic: result.diagnostic, blockerKind: "harness-failure" }
          : undefined,
      );
    }
    state.rounds.push(result.round);
    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, "Round 1 interrogation complete.")).catch(() => {});
  }

  for (;;) {
    const current = state.rounds.at(-1)!;
    const blocking = current.challenges.filter((c) => c.blocking);

    if (blocking.length === 0) {
      state.outcome = "advanced";
      await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, "No unresolved blocking challenges. Advancing to review.")).catch(() => {});
      await transitionFn(cfg, issueNumber, "design-gate", NEXT_STAGE, "Design interrogation resolved; advancing to review.");
      await record(state);
      return { advanced: true, from: "design-gate", to: NEXT_STAGE, summary: "design-gate resolved; advanced to review" };
    }

    if (current.responses.length === 0) {
      const responseResult = await getResponse(blocking);
      if ("blocked" in responseResult) return blockAndReturn(responseResult.blocked);
      current.responses = responseResult.responses;
      await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, `Round ${current.round} response recorded.`)).catch(() => {});
    }

    const stillUnresolved = blocking.filter((c) => !current.responses.some((r) => r.challengeKey === c.challengeKey));

    if (current.round >= cfg.design_gate.max_rounds) {
      if (stillUnresolved.length === 0) {
        state.outcome = "advanced";
        await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, "All blocking challenges resolved within budget. Advancing to review.")).catch(() => {});
        await transitionFn(cfg, issueNumber, "design-gate", NEXT_STAGE, "Design interrogation resolved; advancing to review.");
        return { advanced: true, from: "design-gate", to: NEXT_STAGE, summary: "design-gate resolved; advanced to review" };
      }
      state.outcome = "parked-needs-human";
      const punchList = stillUnresolved
        .map((c) => `- \`${c.challengeKey}\` [${c.severity}] ${c.title} — required: ${c.required_action}`)
        .join("\n");
      await postCommentFn(
        cfg,
        issueNumber,
        buildDesignGateComment(state, `Round budget (${cfg.design_gate.max_rounds}) exhausted with unresolved blocking challenges:\n\n${punchList}`),
      ).catch(() => {});
      await transitionFn(cfg, issueNumber, "design-gate", "needs-human", "Design-interrogation round budget exhausted with blocking challenges unresolved.");
      await record(state);
      return { advanced: true, from: "design-gate", to: "needs-human", summary: "design-gate round budget exhausted" };
    }

    const verdictResult = await getVerdict(current.round + 1, current);
    if ("blocked" in verdictResult) {
      return blockAndReturn(
        verdictResult.blocked,
        verdictResult.diagnostic
          ? { diagnostic: verdictResult.diagnostic, blockerKind: "harness-failure" }
          : undefined,
      );
    }
    const nextRound = verdictResult.round;
    const priorBlockingKeys = new Set(blocking.map((c) => c.challengeKey));
    const recurring = nextRound.challenges.filter((c) => c.blocking && priorBlockingKeys.has(c.challengeKey));
    state.rounds.push(nextRound);

    if (recurring.length > 0) {
      state.outcome = "parked-needs-human";
      const punchList = recurring
        .map((c) => `- \`${c.challengeKey}\` [${c.severity}] ${c.title} — required: ${c.required_action} (recurring)`)
        .join("\n");
      await postCommentFn(
        cfg,
        issueNumber,
        buildDesignGateComment(state, `A blocking challenge recurred after a response round:\n\n${punchList}`),
      ).catch(() => {});
      await transitionFn(cfg, issueNumber, "design-gate", "needs-human", "A blocking design-interrogation challenge recurred after a response round.");
      await record(state);
      return { advanced: true, from: "design-gate", to: "needs-human", summary: "design-gate recurring blocking challenge" };
    }

    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, `Round ${nextRound.round} interrogation complete.`)).catch(() => {});
    // Loop again with nextRound as current.
  }
}
