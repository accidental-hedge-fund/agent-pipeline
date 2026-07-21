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
  getForIssue as defaultGetForIssue,
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
import { extractPlan } from "./review-acquisition.ts";
import { diffFilePaths } from "./review-parsing.ts";
import type {
  BlockerKind,
  DesignChallenge,
  DesignChallengeResponse,
  DesignDecisionRecord,
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

/** Render the human-readable body for a `## Design Interrogation` comment, plus
 *  the trailing hidden `DesignGateState` artifact. Pure. */
function buildDesignGateComment(state: DesignGateState, note: string): string {
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
  lines.push("---", "*Automated by Claude Code Pipeline Skill*", "", encodeDesignGateState(state));
  return lines.join("\n");
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

  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "design-gate: no worktree found for this issue. The worktree may have been removed prematurely.",
      "design-gate",
      "worktree-missing",
    );
    return { advanced: false, status: "blocked", reason: "no worktree", blockerKind: "worktree-missing" };
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
  if (!state.reviewerIdentity) {
    state.reviewerIdentity = {
      harness: reviewerHarness,
      model: cfg.harnesses.reviewerModel,
      effort: cfg.harnesses.reviewerEffort,
      independence: reviewerHarness === implementerHarness ? "same-harness-fallback" : "independent",
    };
  }

  async function blockAndReturn(reason: string): Promise<Outcome> {
    state.outcome = "blocked";
    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, reason)).catch(() => {});
    await setBlockedFn(cfg, issueNumber, `design-gate: ${reason}`, "design-gate", "design-gate-failed");
    await record(state);
    return { advanced: false, status: "blocked", reason, blockerKind: "design-gate-failed" };
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
    const { record: bounded, bounding } = boundDesignDecisionRecord(redacted, cfg.design_gate.limits);
    state.decisionRecordVersions.push(bounded);
    state.bounding = bounding;
    await postCommentFn(cfg, issueNumber, buildDesignGateComment(state, "Decision record recorded.")).catch(() => {});
  }

  const policy = { block_threshold: cfg.design_gate.block_threshold, min_confidence: cfg.design_gate.min_confidence };

  async function getVerdict(
    roundNum: number,
    priorRound: DesignGateRound | null,
  ): Promise<{ round: DesignGateRound } | { blocked: string }> {
    const prompt = buildDesignInterrogationPrompt({
      body: issue.body,
      plan,
      decisionRecordJson: decisionRecordJson(state),
      priorDispositions: priorRound ? formatPriorDispositions(priorRound) : undefined,
    });
    let result = await invokeFn(reviewerHarness, wt.path, prompt, {
      timeoutSec: cfg.review_timeout,
      model: state.reviewerIdentity?.model,
      reasoningEffort: state.reviewerIdentity?.effort,
    });
    if (isHarnessUnavailable(result)) {
      return { blocked: `reviewer harness (${reviewerHarness}) unavailable during interrogation round ${roundNum}` };
    }
    let verdict = parseDesignVerdict(result.stdout);
    if (!verdict) {
      const reaskPrompt = `${prompt}\n\nYour previous response could not be parsed into a valid verdict. Return ONLY the valid JSON object described above — no other text.`;
      result = await invokeFn(reviewerHarness, wt.path, reaskPrompt, {
        timeoutSec: cfg.review_timeout,
        model: state.reviewerIdentity?.model,
        reasoningEffort: state.reviewerIdentity?.effort,
      });
      if (isHarnessUnavailable(result)) {
        return { blocked: `reviewer harness (${reviewerHarness}) unavailable during interrogation round ${roundNum}` };
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
  ): Promise<DesignChallengeResponse[]> {
    const prompt = buildDesignResponsePrompt({
      body: issue.body,
      decisionRecordJson: decisionRecordJson(state),
      challengesText: formatChallengesForResponse(blocking),
    });
    const result = await invokeFn(implementerHarness, wt.path, prompt, {
      timeoutSec: cfg.fix_timeout,
      model: cfg.models.fix,
    });
    if (isHarnessUnavailable(result)) return [];
    const payload = parseDesignResponses(result.stdout);
    if (payload.revisedRecord) {
      const redacted = redactDesignDecisionRecord(payload.revisedRecord);
      const { record: bounded, bounding } = boundDesignDecisionRecord(redacted, cfg.design_gate.limits);
      state.decisionRecordVersions.push(bounded);
      state.bounding = bounding;
    }
    return payload.responses;
  }

  // Step 2: bounded interrogation/response loop.
  if (state.rounds.length === 0) {
    const result = await getVerdict(1, null);
    if ("blocked" in result) return blockAndReturn(result.blocked);
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
      current.responses = await getResponse(blocking);
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
    if ("blocked" in verdictResult) return blockAndReturn(verdictResult.blocked);
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
