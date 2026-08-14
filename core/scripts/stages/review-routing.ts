// Review stage orchestration: advanceReview main loop, verdict routing, gate logic,
// and GH writes (post comment, apply labels).

import {
  addIssueComment,
  createIssue,
  getGhActor,
  getIssueDetail,
  getPrDetail,
  getPrDiff,
  getPrForIssue,
  postComment,
  postPrComment,
  setBlocked,
  transition,
} from "../gh.ts";
import {
  buildNewHumanInputWarningComment,
  extractSnapshotComment,
  findUnacknowledgedComments,
} from "../issue-context-snapshot.ts";
import * as path from "node:path";
import { selfReviewBanner, type ReviewerInvocation } from "../self-review.ts";
import {
  assertNoEnsembleStageExecutorBypass,
  ensembleSelfReviewBanner,
  formatCoverageDisclosure,
  formatEnsembleIdentityLine,
  invokeReviewEnsemble,
  type EnsembleInvocation,
  type EnsembleMeta,
} from "../review-ensemble.ts";
import { coverageBlockerKind } from "../reviewer-independence.ts";
import { formatStderrExcerpt, papercutIdentityEnv } from "../harness.ts";
import { expandAutoEffort, resolveReviewerModelForHarness, reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { invokeStageExecutor, resolveStageExecutor, type ExecutorHttpDeps } from "../executors.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
} from "../prompts/index.ts";
import {
  appendTesterEvidenceSection,
  loadOrRegenerateTesterEvidenceForReview,
  testerEvidenceWithholdResult,
} from "../tester-evidence.ts";
import { runTestGate, type TestGateDeps } from "../testgate.ts";
import {
  buildPriorRoundDigest,
  settledFindings,
  type PriorRoundDigest,
} from "../review-history.ts";
import { getForIssue, getOnDiskForIssue, gitInWorktree } from "../worktree.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import {
  buildTrustedOverrideComments,
  effectiveReviewPolicy,
  extractBlockingSurfacesFromComment,
  extractNonReproducingDispositions,
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  findingPayloadFingerprint,
  overrideComment,
  partitionFindings,
  projectOverridesForPartition,
  severityRank,
  surfaceKey,
  type AlternativeReinstatementMatch,
  type PartitionResult,
  type ReversalMatch,
  type Review1Risk,
} from "../review-policy.ts";
import { makePromptRecord, recordPrompt, recordReview } from "../evidence-bundle.ts";
import {
  buildEvidenceSubject,
  buildRequiredEvidenceSetRevisionFromGates,
  buildReviewPolicyHash,
  buildEngineFingerprint,
  resolveVerifierFingerprint,
  type EvidenceSubjectV1,
} from "../evidence-subject.ts";
import { resolvePinnedEngineIdentity } from "../engine-identity.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { emitCorrectionEvent } from "../correction.ts";
import { buildStageDiagnostic } from "../stage-diagnostic.ts";
import {
  buildHarnessContractDiagnostic,
  runFormatRepairLoop,
  validateReviewVerdict,
} from "../stage-output-contract.ts";
import { sanitizeDeep } from "../artifact-sanitize.ts";
import type {
  Outcome,
  PipelineConfig,
  ReviewFinding,
  ReviewFindingRecord,
  ReviewVerdict,
  Stage,
} from "../types.ts";
import {
  classifyReview1Risk,
  computeDiffHash,
  diffFilePaths,
  extractBlockingKeysFromComment,
  extractCeilingFollowupNumber,
  extractDiffHashFromComment,
  extractReview1Risk,
  extractReviewArtifact,
  extractReviewRunId,
  extractReviewedSha,
  extractPipelineAttestation,
  isVerifiedPipelineAttestation,
  parseStrictVerdict,
  parseStructuredVerdict,
  REVIEW_MARKER_PREFIX_R1,
  REVIEW_MARKER_PREFIX_R2,
} from "./review-parsing.ts";
import {
  advisoryAdvanceComment,
  buildFollowupIssueBody,
  buildFollowupUpdateComment,
  cfgFooter,
  formatReviewComment,
  reviewCeilingDemotionComment,
} from "./review-rendering.ts";
import {
  extractPlan,
  extractReview1Summary,
  extractReview2Findings,
} from "./review-acquisition.ts";

export interface AdvanceReviewOpts {
  dryRun?: boolean;
  model?: string;
  /** Evidence-bundle run/state dir (#147). Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#155). Undefined → event appends disabled. */
  runDir?: string;
  /** GitHub audit run identity shared with stage-transition comments. */
  pipelineRunId?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events (#155). */
  runStoreDeps?: RunStoreDeps;
  /** Pre-rendered context snapshot block for prompt injection (#318). Set internally by advanceReview. */
  contextSnapshot?: string;
  /** Cross-round memory digest (#389). Set internally by advanceReview for round 2 only. */
  priorRoundsDigest?: PriorRoundDigest;
  /** Injectable HTTP deps for external stage executor dispatch (#314). Tests
   *  supply a fake `fetchImpl` so no real network call is made. */
  executorHttpDeps?: ExecutorHttpDeps;
  /**
   * Deterministic test-gate runner used to regenerate SHA-pinned Tester
   * evidence when review would otherwise fail_closed on missing/stale/malformed
   * suite evidence for this runDir (#646 regeneration before review; #882
   * mid-pipeline re-entry). Injected in unit tests; defaults to `runTestGate`.
   */
  runTestGate?: typeof runTestGate;
  /** Optional TestGateDeps for the regenerative producer (tests inject fakes). */
  testGateDeps?: TestGateDeps;
  /**
   * Trusted-surface decision for the run (#691). When set, binds review
   * evidence_subject.verifier_fingerprint. When omitted and runDir is set,
   * advanceReview loads the durable decision from the run store.
   */
  trustedSurface?: {
    outcome: string;
    effective_verifier_hash: string | null;
  } | null;
}

/**
 * External seams used by {@link advanceReview}, overridable in tests.
 * Defaults are the real implementations.
 */
export interface AdvanceReviewDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrDiff?: typeof getPrDiff;
  getPrDetail?: typeof getPrDetail;
  getIssueDetail?: typeof getIssueDetail;
  getForIssue?: typeof getForIssue;
  postComment?: typeof postComment;
  postPrComment?: typeof postPrComment;
  transition?: typeof transition;
  setBlocked?: typeof setBlocked;
  runReview?: RunReviewFn;
  getGhActor?: () => Promise<string | null>;
  createIssue?: (title: string, body: string, labels: string[]) => Promise<number>;
  addIssueComment?: (issueNumber: number, body: string) => Promise<void>;
}

export type RunReviewFn = (
  cfg: PipelineConfig,
  issueNumber: number,
  detail: { title: string; body: string },
  plan: string,
  review1Summary: string | undefined,
  priorReview2Findings: string | undefined,
  diff: string,
  round: 1 | 2,
  cwd: string,
  opts: AdvanceReviewOpts,
) => Promise<ReviewerInvocation>;

/**
 * Build the shared evidence_subject for a review round from runtime state (#692).
 * Returns null when a required identity dimension cannot be resolved (no
 * fabricated placeholders). Pure aside from the optional engine-identity read.
 * Callers that write new readiness artifacts MUST fail closed on null — never
 * emit a silent legacy_unbound review row for a new production path.
 */
export function buildReviewEvidenceSubject(args: {
  cfg: PipelineConfig;
  issueNumber: number;
  prNumber: number | null;
  runId: string | undefined;
  candidateSha: string;
  diffHash: string | null;
  reviewPolicy: {
    block_threshold: string;
    min_confidence: number;
    max_adversarial_rounds?: number;
    max_delta_rounds?: number;
    ceiling_action?: string;
    surface_recurrence_rounds?: number | null;
  };
  engineIdentity?: {
    version: string;
    templates_fingerprint: string;
    commit_sha?: string;
  } | null;
  /** Override required-evidence kinds revision when already computed. */
  requiredEvidenceSetRevision?: string;
  /**
   * Trusted-surface decision for the run (#691). When present, binds
   * verifier_fingerprint to effective_verifier_hash (or fails closed on blocked).
   * Callers should pass the run decision whenever available.
   */
  trustedSurface?: {
    outcome: string;
    effective_verifier_hash: string | null;
  } | null;
}): EvidenceSubjectV1 | null {
  const domain = (args.cfg.domain || args.cfg.repo || "").trim();
  if (!domain) return null;
  const runId = (args.runId ?? "").trim();
  if (!runId) return null;
  const engine =
    args.engineIdentity !== undefined
      ? args.engineIdentity
      : resolvePinnedEngineIdentity();
  if (!engine) return null;
  try {
    const engineFp = buildEngineFingerprint({
      version: engine.version,
      templates_fingerprint: engine.templates_fingerprint,
      commit_sha: engine.commit_sha,
    });
    const requiredRev =
      args.requiredEvidenceSetRevision ??
      buildRequiredEvidenceSetRevisionFromGates({
        testGateEnabled: args.cfg.test_gate?.enabled,
        evalGateEnabled: args.cfg.eval_gate?.enabled,
        visualGateEnabled: args.cfg.visual_gate?.enabled,
        shipcheckGateEnabled: args.cfg.shipcheck_gate?.enabled,
      });
    const verifierFp = resolveVerifierFingerprint({
      engineFingerprint: engineFp,
      trustedSurface: args.trustedSurface,
    });
    if (!verifierFp) return null;
    return buildEvidenceSubject({
      domain,
      issue: args.issueNumber,
      pr: args.prNumber,
      run_id: runId,
      candidate_sha: args.candidateSha,
      diff_hash: args.diffHash,
      policy_hash: buildReviewPolicyHash(args.reviewPolicy),
      engine_fingerprint: engineFp,
      verifier_fingerprint: verifierFp,
      required_evidence_set_revision: requiredRev,
    });
  } catch {
    return null;
  }
}

export async function advanceReview(
  cfg: PipelineConfig,
  issueNumber: number,
  round: 1 | 2,
  opts: AdvanceReviewOpts = {},
  retryCount = 0,
  deps: AdvanceReviewDeps = {},
): Promise<Outcome> {
  const getPrForIssueFn = deps.getPrForIssue ?? getPrForIssue;
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const postCommentFn = deps.postComment ?? postComment;
  const postPrCommentFn = deps.postPrComment ?? postPrComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const runReviewFn = deps.runReview ?? defaultRunReview;
  const getGhActorFn = deps.getGhActor ?? getGhActor;
  const actor = await getGhActorFn();

  const stage: Stage = round === 1 ? "review-1" : "review-2";
  const currentReviewRunId = opts.pipelineRunId;

  async function safeTransitionFn(fromStage: Stage, toStage: Stage, message: string): Promise<Outcome | null> {
    try {
      await transitionFn(cfg, issueNumber, fromStage, toStage, message);
      return null;
    } catch (err) {
      const errMsg = (err as Error).message;
      await setBlockedFn(cfg, issueNumber, `Label transition failed: ${errMsg}`, stage, "harness-failure");
      return { advanced: false, status: "blocked", reason: errMsg };
    }
  }

  const configuredReviewer = cfg.harnesses.reviewer;
  let reviewer = configuredReviewer;

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${reviewer}`);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for this issue.", stage, "no-pull-request");
    return { advanced: false, status: "blocked", reason: "no PR found" };
  }

  // (#16) Capture HEAD SHA before fetching the diff.
  let commitSha: string;
  try {
    const sha = (await getPrDetailFn(cfg, prNumber)).head_sha ?? "";
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      await setBlockedFn(cfg, issueNumber, `PR head SHA is missing or invalid: "${sha}"`, stage, "harness-failure");
      return { advanced: false, status: "blocked", reason: "invalid SHA" };
    }
    commitSha = sha;
  } catch (err) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Could not resolve PR head SHA: ${(err as Error).message}`,
      stage,
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: "SHA resolution failed" };
  }

  let diff: string;
  try {
    diff = await getPrDiffFn(cfg, prNumber);
  } catch (err) {
    const e = err as Error;
    await setBlockedFn(cfg, issueNumber, `Could not retrieve PR diff: ${e.message}`, stage, "harness-failure");
    return { advanced: false, status: "blocked", reason: e.message };
  }
  if (!diff.trim()) {
    await setBlockedFn(cfg, issueNumber, "PR has an empty diff.", stage, "harness-failure");
    return { advanced: false, status: "blocked", reason: "empty diff" };
  }

  // Verify HEAD didn't move between SHA capture and diff fetch (#16).
  try {
    const postDiffSha = (await getPrDetailFn(cfg, prNumber)).head_sha ?? "";
    if (postDiffSha !== commitSha) {
      await setBlockedFn(
        cfg,
        issueNumber,
        `PR HEAD moved while fetching diff (${commitSha.slice(0, 7)} → ${postDiffSha.slice(0, 7)}). ` +
          `Re-run the review stage to evaluate a stable HEAD.`,
        stage,
        "harness-failure",
      );
      return { advanced: false, status: "blocked", reason: "HEAD moved during diff fetch" };
    }
  } catch (postDiffErr) {
    const e = postDiffErr as Error;
    await setBlockedFn(
      cfg,
      issueNumber,
      `Could not verify PR HEAD after diff fetch (${e.message}). Re-run the review stage to evaluate a stable HEAD.`,
      stage,
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: "post-diff SHA verification failed" };
  }

  const detail = await getIssueDetailFn(cfg, issueNumber);
  const plan = extractPlan(detail.comments);
  const review1Summary = round === 2 ? extractReview1Summary(detail.comments) : undefined;
  const priorReview2Findings = round === 2 ? extractReview2Findings(detail.comments) : undefined;
  // Extract pre-planning context snapshot (#318). Use exact header match to
  // avoid picking up the last30days brief (## Pre-Planning Context — last30days).
  const prePlanningCtxComment = extractSnapshotComment(detail.comments);
  if (prePlanningCtxComment && !opts.contextSnapshot) {
    const trimmedBody = prePlanningCtxComment.body.trimStart();
    const stripped = trimmedBody
      .slice(trimmedBody.indexOf('\n'))
      .trimStart()
      // Strip the pipeline footer (--- marker) from the end.
      .replace(/\n\n---\n.*$/s, '')
      .trimEnd();
    opts = { ...opts, contextSnapshot: stripped };
  }

  // Acknowledgement gate: block when human comments after the revised plan
  // have not been acknowledged via re-plan or override (#318 review-2 finding 3).
  // Only trusted-author scope-override comments may act as ack anchors (#318 fix c5825398).
  const trustedForAck = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);
  const unacknowledged = findUnacknowledgedComments(detail.comments, trustedForAck);
  if (unacknowledged.length > 0) {
    console.log(`[pipeline] #${issueNumber}: ${unacknowledged.length} unacknowledged human comment(s) detected before ${stage} — blocking`);
    // Dry-run: log only — no GitHub writes (#318 fix 937b9d25).
    if (opts.dryRun) {
      console.log(`[pipeline] #${issueNumber}: [dry-run] would post warning and set blocked for ${unacknowledged.length} unacknowledged human comment(s)`);
      return { advanced: false, status: "blocked", reason: "unacknowledged human input" };
    }
    // Deduplicate: only post the warning when no prior warning exists.
    const warningExists = detail.comments.some(
      (c) => c.body.trimStart().startsWith('## Pipeline: New human input detected'),
    );
    if (!warningExists) {
      await postCommentFn(
        cfg,
        issueNumber,
        buildNewHumanInputWarningComment(unacknowledged, stage, cfgFooter(cfg)),
      );
    }
    await setBlockedFn(cfg, issueNumber, `${unacknowledged.length} unacknowledged human comment(s) after the latest plan — re-plan or post a scope override to proceed.`, stage, "needs-human");
    return { advanced: false, status: "blocked", reason: "unacknowledged human input" };
  }

  // Diff-hash cache check (#228).
  const diffHash = computeDiffHash(diff);
  const roundPfx = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;

  // #499 repair detection: the set of finding keys the LAST round of this same
  // review track recorded as blocking. Computed once, up front, so both the
  // "approve" (zero findings block) and "needs-attention with residual
  // findings" paths below can detect which of those keys are no longer
  // blocking — a durably-landed repair, not a bare detection.
  const currentRunReviewHistory = currentReviewRunId === undefined
    ? detail.comments
    : detail.comments.filter((comment) =>
      actor !== null &&
      comment.author === actor &&
      extractReviewRunId(comment.body) === currentReviewRunId
    );
  // Cross-round memory is a policy decision, so stale reviews from prior runs
  // must not silently demote a fresh finding on the current candidate.
  const priorRoundsDigest: PriorRoundDigest | undefined =
    round === 2
      ? buildPriorRoundDigest(currentRunReviewHistory, {
        actor,
        trustedOverrideActors: cfg.trusted_override_actors,
      })
      : undefined;
  opts = { ...opts, priorRoundsDigest };

  // A prior verdict counts toward recurrence/ceiling only after production's
  // real repair path completed for that exact review run. Durable redispatch
  // intentionally creates a new child run id, so the current review run is
  // not expected to match the prior cycle. The trusted sequence is:
  //   review-N verdict -> review-N/fix-N -> fix-N/actual-next-stage
  // and the reviewed candidate must have changed. Duplicate verdict comments,
  // legacy unmarked output, and fabricated fix-N/review-N transitions cannot
  // consume a round.
  const matchingFixStage = round === 1 ? "fix-1" : "fix-2";
  const postFixStage = round === 1 ? "review-2" : "pre-merge";
  const isRunTransition = (
    comment: (typeof detail.comments)[number],
    fromStage: Stage,
    toStage: Stage,
    runId: string,
  ): boolean => {
    const attestation = extractPipelineAttestation(comment.body);
    return actor !== null &&
      comment.author === actor &&
      attestation?.kind === "stage-transition" &&
      isVerifiedPipelineAttestation(comment.body) &&
      comment.body.includes(`**Transition**: \`${fromStage}\` → \`${toStage}\``) &&
      comment.body.includes(`<!-- pipeline-audit: run=${runId} state=${toStage} -->`);
  };
  const priorRoundCommentsForRecovery: typeof detail.comments = [];
  for (let i = 0; i < detail.comments.length; i++) {
    const comment = detail.comments[i];
    if (actor === null || comment.author !== actor || !comment.body.startsWith(roundPfx)) continue;
    const priorRunId = extractReviewRunId(comment.body);
    const priorSha = extractReviewedSha([comment])?.sha ?? null;
    if (priorRunId === null || priorSha === null) continue;

    let enteredFix = false;
    let completedFix = false;
    let nextCandidateSha = commitSha;
    for (let j = i + 1; j < detail.comments.length; j++) {
      const later = detail.comments[j];
      // A later verdict starts another candidate cycle. Do not let its
      // transitions retroactively validate this one.
      if (
        later.body.startsWith(roundPfx) &&
        actor !== null &&
        later.author === actor &&
        extractReviewRunId(later.body) !== null
      ) {
        nextCandidateSha = extractReviewedSha([later])?.sha ?? priorSha;
        break;
      }
      if (!enteredFix && isRunTransition(later, stage, matchingFixStage, priorRunId)) {
        enteredFix = true;
        continue;
      }
      if (enteredFix && isRunTransition(later, matchingFixStage, postFixStage, priorRunId)) {
        completedFix = true;
      }
    }
    if (completedFix && nextCandidateSha !== priorSha) priorRoundCommentsForRecovery.push(comment);
  }
  const priorRoundCommentsForCorrection = detail.comments.filter((comment) => comment.body.startsWith(roundPfx));
  const lastPriorRoundForCorrection = priorRoundCommentsForCorrection[priorRoundCommentsForCorrection.length - 1];
  const priorKeysForCorrection = lastPriorRoundForCorrection
    ? extractBlockingKeysFromComment(lastPriorRoundForCorrection.body)
    : new Set<string>();

  // #499 finding 7971a697: the reviewed SHA a repaired finding is lineage-
  // stamped against must be the SHA the finding was actually raised at — the
  // same prior round's comment that `priorKeysForRepair` was read from above
  // — not the current head, or a stale finding would read as current.
  // `head_sha` is separately the current head (`commitSha`), so a consumer
  // can still compute staleness/currency from the pair. Reuses
  // `extractReviewedSha`'s existing artifact-then-legacy-sentinel fallback
  // rather than reimplementing it.
  const priorRoundReviewedSha = lastPriorRoundForCorrection
    ? extractReviewedSha([lastPriorRoundForCorrection])?.sha ?? null
    : null;

  // #499 review-2 finding c89694f9: a prior finding that is still returned by
  // the reviewer but merely demoted to advisory (lower confidence, an
  // override, a settled-reversal demotion, etc.) is a policy disposition, not
  // a landed repair — it must stay absent from the reviewer's own findings
  // AND the head must have actually moved since the round that raised it, or
  // no code change could have repaired anything.
  async function emitRepairedKeys(currentFindingKeys: Set<string>): Promise<void> {
    const headChanged = priorRoundReviewedSha !== null && priorRoundReviewedSha !== commitSha;
    const repairedKeys = headChanged
      ? [...priorKeysForCorrection].filter((k) => !currentFindingKeys.has(k))
      : [];
    if (!opts.runDir || repairedKeys.length === 0) return;
    const runId = path.basename(opts.runDir);
    for (const key of repairedKeys) {
      await emitCorrectionEvent(opts.runDir, {
        issue: issueNumber,
        repo: cfg.repo,
        run_id: runId,
        stage,
        source_kind: "repair",
        failure_class: "review-finding",
        reviewed_sha: priorRoundReviewedSha,
        head_sha: commitSha,
        evidence_ref: { kind: "finding", id: key },
        correction: `finding ${key} no longer raised at round ${round} — cleared on re-check`,
        reusable: "unknown",
      }, opts.runStoreDeps).catch(() => {});
    }
  }

  if (!opts.dryRun) {
    const footer = cfgFooter(cfg);
    const priorRoundCommentsForCache = detail.comments.filter(
      (c) =>
        c.body.startsWith(roundPfx) &&
        c.body.includes(footer) &&
        actor !== null &&
        c.author === actor
    );
    const latestPriorComment = priorRoundCommentsForCache[priorRoundCommentsForCache.length - 1];
    if (latestPriorComment) {
      // Primary: prefer artifact for diff-hash read (task 4.4 — #264).
      const priorArtifact = extractReviewArtifact(latestPriorComment.body);
      const cachedHash = priorArtifact?.diffHash ?? extractDiffHashFromComment(latestPriorComment.body);
      if (cachedHash !== null && cachedHash === diffHash) {
        console.log(`[pipeline] #${issueNumber}: Diff hash unchanged; reusing cached verdict for round ${round}`);
        const cachedVerdict = extractVerdictFromComment(latestPriorComment.body);
        // Primary: prefer artifact for blocking-keys read (task 4.5 — #264).
        const cachedBlockingKeys = priorArtifact !== null
          ? new Set(priorArtifact.blockingKeys)
          : extractBlockingKeysFromComment(latestPriorComment.body);
        const trustedForScopes = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);
        const currentOverrides = extractOverrides(trustedForScopes);
        const remainingBlockers = [...cachedBlockingKeys].filter((k) => !currentOverrides.has(k));
        const activeScopes = extractScopedOverrides(trustedForScopes);
        if (remainingBlockers.length > 0 && activeScopes.length > 0) {
          console.log(
            `[pipeline] #${issueNumber}: Scoped overrides active with cached blockers; ` +
            `bypassing cache to run fresh review`,
          );
          // Fall through to the full review path below — do NOT return.
        } else {
          const isBlocking = cachedVerdict === "needs-attention" && remainingBlockers.length > 0;
          const roundCapForCache = cfg.review_policy.max_adversarial_rounds;
          const atCeilingDemote =
            isBlocking &&
            roundCapForCache > 0 &&
            priorRoundCommentsForCache.length >= roundCapForCache &&
            cfg.review_policy.ceiling_action === "demote_and_advance";
          if (atCeilingDemote) {
            console.log(
              `[pipeline] #${issueNumber}: At ceiling with demote_and_advance; ` +
              `bypassing cache to complete demotion path`,
            );
            // Fall through to the full review path.
          } else {
            const toStage: Stage = isBlocking
              ? (round === 1 ? "fix-1" : "fix-2")
              : (round === 1 ? "review-2" : "pre-merge");
            const verb = isBlocking ? "blocking findings" : "advance";
            const cachedBlocked = await safeTransitionFn(stage, toStage, `Diff hash unchanged; reusing cached verdict for round ${round} (${verb}).`);
            if (cachedBlocked) return cachedBlocked;
            return { advanced: true, from: stage, to: toStage, summary: `cached verdict: ${verb}` };
          }
        }
      }
    }
  }

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would invoke ${reviewer} for ${stage}`);
    return { advanced: true, from: stage, to: round === 1 ? "review-2" : "pre-merge", summary: "[dry-run]" };
  }

  const wt = await getForIssueFn(cfg, issueNumber);
  const cwd = wt?.path ?? cfg.repo_dir;

  const invocation = await runReviewFn(
    cfg,
    issueNumber,
    detail,
    plan,
    review1Summary,
    priorReview2Findings,
    diff,
    round,
    cwd,
    opts,
  );
  let result = invocation.result;
  reviewer = invocation.effectiveReviewer;
  let selfReview = invocation.selfReview;
  // Ensemble meta when review_ensemble ran (#645); undefined on single-agent path.
  let ensembleMeta: EnsembleMeta | undefined =
    (invocation as EnsembleInvocation).ensemble;

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    const stderrExcerpt = formatStderrExcerpt(result.stderr);
    // Name the configured reviewer model in blocked-item evidence (#441) — e.g.
    // an unavailable codex model exits nonzero, and the operator needs to see
    // which model id they configured, not just codex's own error text.
    const configuredModel = opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review;
    const modelNote = configuredModel ? ` (configured model: "${configuredModel}")` : "";
    // #694: map fail-closed ensemble coverage outcomes to typed blocker kinds.
    // Single-agent harness failures keep harness-failure (ensembleMeta absent).
    const covOutcome =
      ensembleMeta?.aggregation_outcome ??
      (invocation as EnsembleInvocation).coverage?.aggregation_outcome;
    const coverageKind =
      ensembleMeta && covOutcome ? coverageBlockerKind(covOutcome) : null;
    if (coverageKind === "review-independent-quorum-unmet") {
      const cov = (invocation as EnsembleInvocation).coverage ?? ensembleMeta;
      const counts = cov && "counts" in cov ? cov.counts : ensembleMeta?.coverage;
      const detailMsg =
        `Independent reviewer quorum unmet for review-${round}` +
        (counts
          ? ` (independent=${counts.independent}, required=${counts.required}, usable=${counts.usable}/${counts.configured})`
          : "") +
        `. ${reason}${stderrExcerpt}`;
      await setBlockedFn(cfg, issueNumber, detailMsg, stage, "review-independent-quorum-unmet");
      return {
        advanced: false,
        status: "blocked",
        reason: detailMsg,
        blockerKind: "review-independent-quorum-unmet",
      };
    }
    if (coverageKind === "review-no-usable-reviewers") {
      const detailMsg =
        `No usable reviewers for review-${round}: ${reason}${stderrExcerpt}`;
      await setBlockedFn(cfg, issueNumber, detailMsg, stage, "review-no-usable-reviewers");
      return {
        advanced: false,
        status: "blocked",
        reason: detailMsg,
        blockerKind: "review-no-usable-reviewers",
      };
    }
    const detailMsg = selfReview
      ? `Neither the cross-harness reviewer (${configuredReviewer}) nor the implementing ` +
        `harness (${reviewer}) is installed/spawnable for a self-review fallback — ${reason}${stderrExcerpt}`
      : `Review harness (${reviewer})${modelNote} failed: ${reason}${stderrExcerpt}`;
    await setBlockedFn(cfg, issueNumber, detailMsg, stage, "harness-failure");
    // Must thread blockerKind on the Outcome: emitBlockedOutcomeEvents defaults
    // missing kind to needs-human → workflow-state, which misroutes durable
    // recovery for tester-evidence-gate / harness exits as a generic workflow
    // park instead of harness-failure (#882 recovery diagnostic).
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind: "harness-failure",
    };
  }

  // A delegated `stage_executors` result must satisfy the FULL verdict schema —
  // no partial-JSON defaulting, no prose/text-verdict fallback — or it is a
  // contract violation (#314 review-2 finding 9e069297). #777 routes pure shape
  // failures through review.verdict@1 + the shared format-repair policy (one
  // re-prompt) before terminal harness-contract.
  // `executor_name` is only set on a `HarnessResult` produced by
  // `invokeStageExecutor`; a local reviewer's result never carries it.
  const isDelegatedResult = result.executor_name !== undefined;
  let strictVerdict = isDelegatedResult
    ? parseStrictVerdict(result.stdout, commitSha)
    : undefined;
  if (isDelegatedResult && strictVerdict === null) {
    const providerNote = result.executor_provider
      ? ` (provider "${result.executor_provider}")`
      : "";
    const executorName = result.executor_name;
    const shapeRepair = await runFormatRepairLoop({
      validate: (stdout) => {
        const shape = validateReviewVerdict(stdout);
        if (!shape.ok) return shape;
        // Delegated path still requires full strict fields after shape gate.
        if (parseStrictVerdict(stdout, commitSha) === null) {
          return {
            ok: false,
            reason:
              "Review output is JSON-shaped but does not satisfy the full strict verdict schema",
          };
        }
        return { ok: true };
      },
      initialOutput: result.stdout,
      repairInvoke: async () => {
        console.warn(
          `[pipeline] #${issueNumber}: review.verdict@1 failed for delegated executor; attempting one format-repair re-prompt`,
        );
        const repairInvocation = await runReviewFn(
          cfg,
          issueNumber,
          detail,
          plan,
          review1Summary,
          priorReview2Findings,
          diff,
          round,
          cwd,
          opts,
        );
        if (!repairInvocation.result.success) {
          const reason = repairInvocation.result.timed_out
            ? `Review format-repair timed out after ${repairInvocation.result.duration.toFixed(0)}s`
            : `Review format-repair failed (exit ${repairInvocation.result.exit_code})`;
          return { success: false, reason };
        }
        result = repairInvocation.result;
        reviewer = repairInvocation.effectiveReviewer;
        selfReview = repairInvocation.selfReview;
        ensembleMeta = (repairInvocation as EnsembleInvocation).ensemble;
        return { success: true, output: repairInvocation.result.stdout };
      },
    });
    if (shapeRepair.status === "invoke-failed") {
      await setBlockedFn(
        cfg,
        issueNumber,
        `Delegated executor "${executorName}"${providerNote} for stage "${stage}" format-repair failed: ${shapeRepair.reason}`,
        stage,
        "harness-failure",
      );
      return {
        advanced: false,
        status: "blocked",
        reason: shapeRepair.reason,
        blockerKind: "harness-failure",
      };
    }
    if (shapeRepair.status === "contract-exhausted") {
      const reason =
        `Delegated executor "${executorName}"${providerNote} for stage "${stage}" returned a result ` +
        `that does not satisfy the review verdict contract (missing/invalid fields, or non-JSON/prose ` +
        `output) after shared format-repair. No fallback — the run is blocked.`;
      const diagnostic = buildHarnessContractDiagnostic({
        reason,
        stage,
        evidenceKey: `review.verdict@1#${issueNumber}#${stage}`,
      });
      await setBlockedFn(cfg, issueNumber, reason, stage, "harness-failure");
      return {
        advanced: false,
        status: "blocked",
        reason: "external executor verdict contract violation",
        blockerKind: "harness-failure",
        diagnostic,
      };
    }
    strictVerdict = parseStrictVerdict(shapeRepair.output, commitSha) ?? undefined;
  }

  const reviewComment = (text: string) => {
    const banners: string[] = [];
    if (ensembleMeta) {
      banners.push(formatEnsembleIdentityLine(ensembleMeta));
      const covLine = formatCoverageDisclosure(ensembleMeta);
      if (covLine) banners.push(covLine);
      if (selfReview) {
        const ensBanner = ensembleSelfReviewBanner(ensembleMeta.agents);
        if (ensBanner) banners.push(ensBanner);
      }
    } else {
      const invCov = (invocation as EnsembleInvocation).coverage;
      const covLine = formatCoverageDisclosure(invCov);
      if (covLine) banners.push(covLine);
      if (selfReview) {
        banners.push(selfReviewBanner(configuredReviewer, reviewer));
      }
    }
    if (banners.length === 0) return text;
    const bannerBlock = banners.join("\n\n");
    const nl = text.indexOf("\n");
    return nl >= 0
      ? `${text.slice(0, nl)}\n\n${bannerBlock}${text.slice(nl)}`
      : `${text}\n\n${bannerBlock}`;
  };
  const reviewerLabel = ensembleMeta
    ? `ensemble(${ensembleMeta.usable}/${ensembleMeta.size})`
    : selfReview
      ? `${reviewer} (self-review)`
      : reviewer;
  const invCoverage = (invocation as EnsembleInvocation).coverage;
  const ensembleEvidence = ensembleMeta
    ? {
        ensemble: {
          size: ensembleMeta.size,
          usable: ensembleMeta.usable,
          failed: ensembleMeta.failed,
          merge: ensembleMeta.merge,
          agents: ensembleMeta.agents.map((a) => ({
            role: a.role,
            harness: a.harness,
            effectiveHarness: a.effectiveHarness,
            model: a.model,
            selfReview: a.selfReview,
            status: a.status,
            failureClass: a.failureClass,
            costUsd: a.costUsd,
            providerFamily: a.providerFamily,
            modelFamily: a.modelFamily,
            latencyMs: a.latencyMs,
            costClass: a.costClass,
            failureOrFallbackReason: a.failureOrFallbackReason,
            independentlyEligible: a.independentlyEligible,
          })),
          summary: ensembleMeta.summary,
          coverage: ensembleMeta.coverage,
          aggregation_outcome: ensembleMeta.aggregation_outcome,
          aggregation_reason: ensembleMeta.aggregation_reason,
          cost: ensembleMeta.cost,
          risk_class: ensembleMeta.risk_class,
        },
      }
    : invCoverage
      ? {
          ensemble: {
            size: invCoverage.counts.configured,
            usable: invCoverage.counts.usable,
            failed: Math.max(0, invCoverage.counts.attempted - invCoverage.counts.usable),
            merge: "union_blocking" as const,
            agents: [] as Array<Record<string, unknown>>,
            summary: invCoverage.aggregation_reason,
            coverage: invCoverage.counts,
            aggregation_outcome: invCoverage.aggregation_outcome,
            aggregation_reason: invCoverage.aggregation_reason,
            cost: invCoverage.cost,
            risk_class: invCoverage.risk_class,
          },
        }
      : {};

  // Local (non-delegated) path keeps parseStructuredVerdict product tolerances;
  // review.verdict@1 is the pure schema gate used for delegated repair + fixtures.
  const verdict = strictVerdict ?? parseStructuredVerdict(result.stdout, commitSha);
  console.log(
    `[pipeline] #${issueNumber}: verdict=${verdict.verdict} findings=${verdict.findings.length}`,
  );

  // Risk-proportional adversarial blocking (#232).
  const review1RiskFromVerdict: Review1Risk | undefined =
    round === 1 ? classifyReview1Risk(verdict) : undefined;
  // Primary: artifact is preferred within extractReview1Risk for each comment's risk tier (task 4.6 — #264).
  const review1Risk: Review1Risk =
    round === 2 ? extractReview1Risk(detail.comments, actor, cfgFooter(cfg), { diffHash, sha: commitSha }) : (review1RiskFromVerdict ?? "standard");
  const effectivePol = effectiveReviewPolicy(cfg.review_policy, { round, review1Risk });

  // review1Risk passed to rendering so it embeds the sentinel in the right position.
  const review1RiskForComment: Review1Risk | undefined = round === 1 ? review1RiskFromVerdict : undefined;

  // evidence_subject for ReviewArtifact + bundle review rows (#692). Built only
  // from runtime state (cfg, SHA, diff hash, engine identity) — never from
  // reviewer prose. Missing required inputs fail closed: new readiness artifacts
  // MUST NOT be written without a subject (would be silent legacy_unbound).
  //
  // Subject run_id prefers pipelineRunId, then runDir basename. When neither is
  // set (unit tests / non-run invocations), use an explicit unscoped id so
  // subject emission still succeeds without inventing a production run id that
  // would also filter prior-round history (currentReviewRunId stays undefined).
  //
  // Trusted-surface (#691): bind verifier_fingerprint to the run decision when
  // present. Blocked / unusable decisions fail closed (null subject).
  const subjectRunId =
    (typeof currentReviewRunId === "string" && currentReviewRunId.trim()) ||
    (opts.runDir ? path.basename(opts.runDir) : "") ||
    `issue-${issueNumber}/unscoped-run`;
  let trustedSurfaceForSubject:
    | { outcome: string; effective_verifier_hash: string | null }
    | null
    | undefined = opts.trustedSurface;
  if (trustedSurfaceForSubject === undefined && opts.runDir) {
    try {
      const { readTrustedSurfaceDecision, defaultRunStoreDeps } = await import(
        "../run-store.ts"
      );
      trustedSurfaceForSubject = await readTrustedSurfaceDecision(
        opts.runDir,
        opts.runStoreDeps ?? defaultRunStoreDeps,
      );
    } catch {
      trustedSurfaceForSubject = null;
    }
  }
  const reviewEvidenceSubject: EvidenceSubjectV1 | null = buildReviewEvidenceSubject({
    cfg,
    issueNumber,
    prNumber,
    runId: subjectRunId,
    candidateSha: commitSha,
    diffHash,
    reviewPolicy: effectivePol,
    trustedSurface: trustedSurfaceForSubject,
  });
  if (!reviewEvidenceSubject) {
    const reason =
      "Review evidence_subject could not be built from runtime state " +
      "(missing domain, engine identity, or other required identity " +
      "inputs). New readiness review artifacts must not omit the subject.";
    console.error(`[pipeline] #${issueNumber}: ${reason}`);
    await setBlockedFn(cfg, issueNumber, reason, stage, "harness-failure");
    return {
      advanced: false,
      status: "blocked",
      reason: "evidence_subject production failed for review artifact",
    };
  }

  const findingCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of verdict.findings) {
    findingCounts[f.severity] = (findingCounts[f.severity] ?? 0) + 1;
  }
  const findingRecords: ReviewFindingRecord[] = sanitizeDeep(
    verdict.findings.map((f): ReviewFindingRecord => {
      const rec: ReviewFindingRecord = {
        key: findingKey(f),
        severity: f.severity,
        title: f.title,
        body: f.body,
        confidence: f.confidence,
        recommendation: f.recommendation,
        effective_blocking: false,
      };
      if (f.file !== undefined) rec.file = f.file;
      if (f.line_start !== undefined) rec.line_start = f.line_start;
      if (f.line_end !== undefined) rec.line_end = f.line_end;
      if (f.category !== undefined) rec.category = f.category;
      if (f.blocking !== undefined) rec.blocking = f.blocking;
      return rec;
    }),
  );
  for (let i = 0; i < findingRecords.length; i++) {
    findingRecords[i].key = findingKey(findingRecords[i] as ReviewFinding);
    findingRecords[i].payload_fingerprint = findingPayloadFingerprint(findingRecords[i] as ReviewFinding);
  }
  const fpCount = new Map<string, number>();
  for (const rec of findingRecords) {
    const composite = `${rec.key}\0${rec.payload_fingerprint}`;
    fpCount.set(composite, (fpCount.get(composite) ?? 0) + 1);
  }
  for (const rec of findingRecords) {
    const composite = `${rec.key}\0${rec.payload_fingerprint}`;
    if ((fpCount.get(composite) ?? 0) > 1) rec.payload_fingerprint_ambiguous = true;
  }
  // `reviewer` is the effective reviewer (reassigned from `invocation.effectiveReviewer`
  // above) — guard against it, not the nominal `cfg.harnesses.reviewer`, so a
  // same-harness fallback (#39) records the model it actually received (#441).
  const reviewerModel =
    result.executor_model ??
    resolveReviewerModelForHarness(
      opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review,
      reviewer,
      reviewerModelSourceWasAuto(cfg, opts.model),
    );
  const executorEvidence = result.executor_name
    ? { executorProvider: result.executor_provider, executorModel: result.executor_model }
    : {};

  if (verdict.verdict === "approve") {
    if (opts.stateDir) {
      await recordReview(opts.stateDir, issueNumber, {
        round, sha: commitSha, verdict: verdict.verdict, findingCounts,
        findings: findingRecords, harness: reviewer, model: reviewerModel, selfReview,
        ...(reviewEvidenceSubject ? { evidence_subject: reviewEvidenceSubject } : {}),
        ...executorEvidence,
        ...ensembleEvidence,
      }).catch(() => {});
    }
    if (opts.runDir) {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      await appendEvent(opts.runDir, {
        schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
        round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
        findings: findingRecords, reviewer_harness: reviewer,
        reviewer_model: reviewerModel, self_review: selfReview,
        ...ensembleEvidence,
      }, opts.runStoreDeps).catch(() => {});
    }
    // #499 repair detection: an approve verdict still needs to check the
    // reviewer's own findings (which may carry non-blocking advisory
    // findings) — not assume every prior blocking key is gone.
    await emitRepairedKeys(new Set(verdict.findings.map((f) => findingKey(f))));
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, undefined, diffHash, review1RiskForComment, undefined, undefined, currentReviewRunId, reviewEvidenceSubject)));
    if (round === 1) {
      const r1Blocked = await safeTransitionFn("review-1", "review-2",
        `Standard review by ${reviewerLabel} — approved (${verdict.findings.length} findings).`);
      if (r1Blocked) return r1Blocked;
      return { advanced: true, from: "review-1", to: "review-2", summary: `approved (${verdict.findings.length} findings)` };
    } else {
      const r2Blocked = await safeTransitionFn("review-2", "pre-merge",
        `Adversarial review by ${reviewerLabel} — approved (${verdict.findings.length} findings).`);
      if (r2Blocked) return r2Blocked;
      return { advanced: true, from: "review-2", to: "pre-merge", summary: `adversarial approved (${verdict.findings.length} findings)` };
    }
  }

  // needs-attention + zero findings: re-review once, then block.
  if (verdict.verdict === "needs-attention" && verdict.findings.length === 0) {
    if (retryCount === 0) {
      console.log(
        `[pipeline] #${issueNumber}: needs-attention+0-findings — triggering re-review (attempt ${retryCount + 1})`,
      );
      return advanceReview(cfg, issueNumber, round, opts, retryCount + 1, deps);
    }
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, undefined, undefined, review1RiskForComment, undefined, undefined, currentReviewRunId, reviewEvidenceSubject)));
    if (opts.stateDir) {
      await recordReview(opts.stateDir, issueNumber, {
        round, sha: commitSha, verdict: verdict.verdict, findingCounts,
        findings: findingRecords, harness: reviewer, model: reviewerModel, selfReview,
        ...(reviewEvidenceSubject ? { evidence_subject: reviewEvidenceSubject } : {}),
        ...executorEvidence,
        ...ensembleEvidence,
      }).catch(() => {});
    }
    if (opts.runDir) {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      await appendEvent(opts.runDir, {
        schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
        round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
        findings: findingRecords, reviewer_harness: reviewer,
        reviewer_model: reviewerModel, self_review: selfReview,
        ...ensembleEvidence,
      }, opts.runStoreDeps).catch(() => {});
    }
    const raw = result.stdout.slice(0, 4000).trim() || "(no reviewer output captured)";
    await setBlockedFn(
      cfg,
      issueNumber,
      `Review ${round} returned \`needs-attention\` with zero enumerated findings on re-review, ` +
        `so there is nothing concrete to fix. The reviewer output likely could not be parsed into ` +
        `a structured verdict. Raw reviewer output:\n\n${raw}`,
      stage,
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: "needs-attention with 0 findings on re-review" };
  }

  // needs-attention with findings → apply the severity policy (#17).
  const trustedComments = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);
  // #693: validity-gated active projection (expiry / subject / supersession).
  const projected = projectOverridesForPartition({
    comments: trustedComments,
    governance: cfg.override_governance,
    findings: verdict.findings,
  });
  const overrides = projected.overrides;
  const scopes = projected.scopes;
  // #391 review-2 finding 7b965502: a prior fix round's SHA-anchored
  // non-reproducing disposition must also be consulted on review entry — not
  // just fix entry — so a re-review at the same reviewed SHA does not re-block
  // the same already-declared tooling artifact.
  const nonReproducing = extractNonReproducingDispositions(trustedComments);
  const settled = priorRoundsDigest ? settledFindings(priorRoundsDigest) : [];
  const partition = partitionFindings(verdict.findings, effectivePol, overrides, scopes, nonReproducing, commitSha, settled);
  const blockingFindingSet = new Set<ReviewFinding>(partition.blocking);
  for (let i = 0; i < findingRecords.length; i++) {
    findingRecords[i].effective_blocking = blockingFindingSet.has(verdict.findings[i]);
  }

  // Settled-finding reversal guard demotions (#389, finding-level matching
  // #464): tag the finding in the posted comment and emit one audit event
  // per demotion, naming which specific settled finding it re-raises.
  const reversalDemotions = new Map<string, ReversalMatch>();
  const alternativeDemotions = new Map<string, AlternativeReinstatementMatch>();
  for (const { finding, reason, reversalMatch, alternativeMatch } of partition.advisory) {
    if (reason === "reversal-unacknowledged" && reversalMatch) {
      reversalDemotions.set(findingKey(finding), reversalMatch);
      if (opts.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(opts.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "reversal_unacknowledged", at,
          finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
          settled_finding_key: reversalMatch.settledKey, settling_round: reversalMatch.settledRound,
          matched_by: reversalMatch.matchedBy,
        }, opts.runStoreDeps).catch(() => {});
      }
      continue;
    }
    // Settled-alternative reinstatement demotions (#483): tag the finding in
    // the posted comment and emit one audit event per demotion, naming the
    // settled finding whose rejected alternative it reinstates.
    if (reason === "settled-alternative-reinstated" && alternativeMatch) {
      alternativeDemotions.set(findingKey(finding), alternativeMatch);
      if (opts.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(opts.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "settled_alternative_reinstated", at,
          finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
          settled_finding_key: alternativeMatch.settledKey, settling_round: alternativeMatch.settledRound,
          matched_alternative: alternativeMatch.matchedAlternative,
        }, opts.runStoreDeps).catch(() => {});
      }
    }
  }
  if (opts.stateDir) {
    await recordReview(opts.stateDir, issueNumber, {
      round, sha: commitSha, verdict: verdict.verdict, findingCounts,
      findings: findingRecords, harness: reviewer, model: reviewerModel, selfReview,
      ...(reviewEvidenceSubject ? { evidence_subject: reviewEvidenceSubject } : {}),
      ...executorEvidence,
      ...ensembleEvidence,
    }).catch(() => {});
  }
  if (opts.runDir) {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendEvent(opts.runDir, {
      schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
      round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
      findings: findingRecords, reviewer_harness: reviewer,
      reviewer_model: reviewerModel, self_review: selfReview,
      ...ensembleEvidence,
    }, opts.runStoreDeps).catch(() => {});
  }
  const blockingKeysSet = new Set(partition.blocking.map((f) => findingKey(f)));

  // #499 repair detection: a finding that blocked the prior round and no
  // longer appears among this round's reviewer findings at all — not merely
  // non-blocking — was cleared on re-check — a durably-landed repair, not a
  // bare detection or a policy demotion. Computed here (before the early
  // "all clear" return below) so both the fully-resolved and the
  // still-partially-blocking paths detect a repair.
  await emitRepairedKeys(new Set(verdict.findings.map((f) => findingKey(f))));

  if (partition.blocking.length === 0) {
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash, review1RiskForComment, reversalDemotions, alternativeDemotions, currentReviewRunId, reviewEvidenceSubject)));
    const advisory = reviewComment(advisoryAdvanceComment(cfg, round, reviewer, partition));
    await postCommentFn(cfg, issueNumber, advisory);
    if (partition.advisory.length || partition.overridden.length) {
      try {
        await postPrCommentFn(cfg, prNumber, advisory);
      } catch (err) {
        console.warn(
          `[pipeline] #${issueNumber}: could not mirror advisory findings to PR #${prNumber}: ${(err as Error).message}`,
        );
      }
    }
    const toStage: Stage = round === 1 ? "review-2" : "pre-merge";
    const advBlocked = await safeTransitionFn(stage, toStage,
      `Review ${round} by ${reviewerLabel}: ${verdict.findings.length} finding(s), none above policy ` +
        `(${partition.advisory.length} advisory, ${partition.overridden.length} overridden) — advancing.`,
    );
    if (advBlocked) return advBlocked;
    return {
      advanced: true,
      from: stage,
      to: toStage,
      summary: `${verdict.findings.length} findings below policy — advanced`,
    };
  }

  await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash, review1RiskForComment, reversalDemotions, alternativeDemotions, currentReviewRunId, reviewEvidenceSubject)));

  const priorRoundComments = priorRoundCommentsForRecovery;
  const roundCap = cfg.review_policy.max_adversarial_rounds;

  const blockForMechanicalReviewRecovery = async (detailText: string): Promise<Outcome> => {
    const findings = partition.blocking.map((finding) => {
      const location = finding.file
        ? `${finding.file}${finding.line_start ? `:${finding.line_start}` : ""}`
        : "unknown location";
      return `${findingKey(finding)}/${findingPayloadFingerprint(finding)} ` +
        `[${(finding.severity ?? "medium").toUpperCase()}] ${finding.title} at ${location}; ` +
        `remediation: ${finding.recommendation || "address the blocking review finding"}`;
    }).join(" | ");
    const reason = `${detailText} at reviewed SHA ${commitSha}. The unresolved findings remain blocking and require bounded automated remediation followed by a fresh review; they do not grant human authority. Findings: ${findings}`;
    const blockerKind = "review-findings" as const;
    const diagnostic = buildStageDiagnostic({
      blockerKind,
      reason,
      stage,
    });
    await setBlockedFn(cfg, issueNumber, reason, stage, blockerKind);
    return {
      advanced: false,
      status: "blocked",
      reason,
      blockerKind,
      diagnostic,
    };
  };

  // Recurrence-aware early park (#133).
  const lastPriorRoundForRecovery = priorRoundCommentsForRecovery[priorRoundCommentsForRecovery.length - 1];
  const priorKeys = lastPriorRoundForRecovery
    ? extractBlockingKeysFromComment(lastPriorRoundForRecovery.body)
    : new Set<string>();
  const recurring = partition.blocking.filter((f) => priorKeys.has(findingKey(f)));
  const newBlocking = partition.blocking.filter((f) => !priorKeys.has(findingKey(f)));
  if (recurring.length > 0 && newBlocking.length === 0) {
    const atDemoteCeiling =
      roundCap > 0 &&
      priorRoundComments.length + 1 >= roundCap &&
      cfg.review_policy.ceiling_action === "demote_and_advance";
    if (!atDemoteCeiling) {
      const recurrenceDetail = `Review ${round} re-emitted ${recurring.length} blocking finding(s) with an unchanged ` +
        `finding key after a fix round — a proven non-convergence signal`;
      return blockForMechanicalReviewRecovery(recurrenceDetail);
    }
    // At ceiling with demote_and_advance: fall through.
  }

  // Surface-recurrence guard (#234).
  const surfaceRounds = cfg.review_policy.surface_recurrence_rounds ?? 3;
  if (surfaceRounds > 0 && partition.blocking.length > 0) {
    const currentSurfaceToKeys = new Map<string, Set<string>>();
    for (const f of partition.blocking) {
      const sk = surfaceKey(f);
      if (sk === null) continue;
      const fk = findingKey(f);
      if (!currentSurfaceToKeys.has(sk)) currentSurfaceToKeys.set(sk, new Set());
      currentSurfaceToKeys.get(sk)!.add(fk);
    }

    const trustedPriorRoundForSurface = actor !== null
      ? priorRoundComments.filter((c) => c.body.includes(cfgFooter(cfg)) && c.author === actor)
      : [];

    const lastTrustedPriorRound = trustedPriorRoundForSurface[trustedPriorRoundForSurface.length - 1];
    const lastPriorSurfaceMap = lastTrustedPriorRound
      ? extractBlockingSurfacesFromComment(lastTrustedPriorRound.body)
      : new Map<string, string>();

    const firedSurfaces = new Set<string>();
    for (const [sk, currentKeys] of currentSurfaceToKeys) {
      let streak = 1;
      for (let i = trustedPriorRoundForSurface.length - 1; i >= 0; i--) {
        const priorMap = extractBlockingSurfacesFromComment(trustedPriorRoundForSurface[i].body);
        const inPrior = [...priorMap.values()].some((s) => s === sk);
        if (inPrior) {
          streak++;
        } else {
          break;
        }
      }
      if (streak < surfaceRounds) continue;

      const priorKeysForSurface = new Set<string>(
        [...lastPriorSurfaceMap.entries()]
          .filter(([, sv]) => sv === sk)
          .map(([fk]) => fk),
      );
      const hasNewKey = [...currentKeys].some((fk) => !priorKeysForSurface.has(fk));
      if (hasNewKey) firedSurfaces.add(sk);
    }

    if (firedSurfaces.size > 0) {
      const firedFindings = partition.blocking.filter((f) => {
        const sk = surfaceKey(f);
        return sk !== null && firedSurfaces.has(sk);
      });
      const nonFiredBlockers = partition.blocking.filter((f) => {
        const sk = surfaceKey(f);
        return sk === null || !firedSurfaces.has(sk);
      });
      const highOrCriticalInFired = firedFindings.filter(
        (f) => severityRank(f.severity) >= severityRank("high"),
      );
      const belowHighInFired = firedFindings.filter(
        (f) => severityRank(f.severity) < severityRank("high"),
      );

      const shouldSurfaceDemote =
        cfg.review_policy.ceiling_action === "demote_and_advance" &&
        highOrCriticalInFired.length === 0 &&
        nonFiredBlockers.length === 0 &&
        belowHighInFired.length > 0;

      if (nonFiredBlockers.length > 0) {
        // A mixed verdict contains a new blocker that has not consumed a repair
        // attempt. Route the complete finding set through the normal fix path.
      } else {
        if (!shouldSurfaceDemote) {
          const srDetail = `Review ${round} surface-recurrence guard fired on ${firedSurfaces.size} ` +
            `surface(s) after ${surfaceRounds} consecutive rounds of new-key findings on the ` +
            `same (file + category) cluster`;
          return blockForMechanicalReviewRecovery(srDetail);
        }

        const createIssueFn = deps.createIssue ?? defaultCreateIssue(cfg);
        const addIssueCommentFn = deps.addIssueComment ?? defaultAddIssueComment(cfg);

        const existingFollowup = extractCeilingFollowupNumber(detail.comments, actor);
        let surfaceFollowupNumber: number;
        if (existingFollowup !== null) {
          surfaceFollowupNumber = existingFollowup;
          const updateBody = buildFollowupUpdateComment(issueNumber, priorRoundComments.length + 1, belowHighInFired);
          await addIssueCommentFn(surfaceFollowupNumber, updateBody);
        } else {
          const followupBody = buildFollowupIssueBody(issueNumber, belowHighInFired);
          surfaceFollowupNumber = await createIssueFn(
            `[Deferred] Review ceiling findings from #${issueNumber}`,
            followupBody,
            [],
          );
        }

        const surfaceDemotionBody = reviewCeilingDemotionComment(
          cfg, round, reviewer,
          { ...partition, blocking: belowHighInFired },
          surfaceRounds, priorRoundComments, surfaceFollowupNumber,
        );
        const surfaceDemotionComment = reviewComment(surfaceDemotionBody);
        await postCommentFn(cfg, issueNumber, surfaceDemotionComment);
        try {
          await postPrCommentFn(cfg, prNumber, surfaceDemotionComment);
        } catch (err) {
          console.warn(
            `[pipeline] #${issueNumber}: could not mirror surface-recurrence demotion comment to PR #${prNumber}: ${(err as Error).message}`,
          );
        }

        const surfaceTimestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        for (const f of belowHighInFired) {
          const key = findingKey(f);
          const disposition = `deferred-#${surfaceFollowupNumber}`;
          const body = overrideComment({
            key,
            disposition,
            reason: `auto-demoted at surface-recurrence guard (${surfaceRounds} consecutive rounds on same (file+category) surface); deferred to #${surfaceFollowupNumber}`,
            stage,
            timestamp: surfaceTimestamp,
            footer: cfg.marker_footer,
          });
          await postCommentFn(cfg, issueNumber, body);
        }

        const surfaceNextStage: Stage = round === 1 ? "review-2" : "pre-merge";
        const srdBlocked = await safeTransitionFn(stage, surfaceNextStage,
          `Surface-recurrence guard fired: ${belowHighInFired.length} below-high finding(s) ` +
            `auto-demoted to advisory and deferred to #${surfaceFollowupNumber}. Advancing to ${surfaceNextStage}.`,
        );
        if (srdBlocked) return srdBlocked;
        return {
          advanced: true,
          from: stage,
          to: surfaceNextStage,
          summary: `surface-recurrence: ${belowHighInFired.length} below-high findings demoted → ${surfaceNextStage} (follow-up #${surfaceFollowupNumber})`,
        };
      }
    }
  }

  // Bounded rounds ceiling (#233).
  if (roundCap > 0 && newBlocking.length === 0 && priorRoundComments.length + 1 >= roundCap) {
    const highOrCritical = partition.blocking.filter(
      (f) => severityRank(f.severity) >= severityRank("high"),
    );
    const belowHigh = partition.blocking.filter(
      (f) => severityRank(f.severity) < severityRank("high"),
    );

    const shouldDemote =
      highOrCritical.length === 0 &&
      belowHigh.length > 0 &&
      cfg.review_policy.ceiling_action === "demote_and_advance";

    if (!shouldDemote) {
      const ceilingDetail = `Review ${round} hit the ${roundCap}-round ceiling with ` +
        `${partition.blocking.length} finding(s) still blocking`;
      return blockForMechanicalReviewRecovery(ceilingDetail);
    }

    const createIssueFn = deps.createIssue ?? defaultCreateIssue(cfg);
    const addIssueCommentFn = deps.addIssueComment ?? defaultAddIssueComment(cfg);

    const existingFollowup = extractCeilingFollowupNumber(detail.comments, actor);
    let followupNumber: number;
    if (existingFollowup !== null) {
      followupNumber = existingFollowup;
      const updateBody = buildFollowupUpdateComment(issueNumber, priorRoundComments.length + 1, belowHigh);
      await addIssueCommentFn(followupNumber, updateBody);
    } else {
      const followupBody = buildFollowupIssueBody(issueNumber, belowHigh);
      followupNumber = await createIssueFn(
        `[Deferred] Review ceiling findings from #${issueNumber}`,
        followupBody,
        [],
      );
    }

    const demotionBody = reviewCeilingDemotionComment(
      cfg, round, reviewer, partition, roundCap, priorRoundComments, followupNumber,
    );
    const demotionComment = reviewComment(demotionBody);
    await postCommentFn(cfg, issueNumber, demotionComment);
    try {
      await postPrCommentFn(cfg, prNumber, demotionComment);
    } catch (err) {
      console.warn(
        `[pipeline] #${issueNumber}: could not mirror demotion comment to PR #${prNumber}: ${(err as Error).message}`,
      );
    }

    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    for (const f of belowHigh) {
      const key = findingKey(f);
      const disposition = `deferred-#${followupNumber}`;
      const body = overrideComment({
        key,
        disposition,
        reason: `auto-demoted at review ceiling (round ${priorRoundComments.length + 1}/${roundCap}); deferred to #${followupNumber}`,
        stage: stage,
        timestamp,
        footer: cfg.marker_footer,
      });
      await postCommentFn(cfg, issueNumber, body);
    }

    const toStage: Stage = "pre-merge";
    const ceilingDemoteBlocked = await safeTransitionFn(stage, toStage,
      `Review ${round} hit the ${roundCap}-round ceiling; ${belowHigh.length} below-high finding(s) ` +
        `auto-demoted to advisory and deferred to #${followupNumber}. Advancing to pre-merge.`,
    );
    if (ceilingDemoteBlocked) return ceilingDemoteBlocked;
    return {
      advanced: true,
      from: stage,
      to: toStage,
      summary: `review ceiling: ${belowHigh.length} below-high findings demoted → pre-merge (follow-up #${followupNumber})`,
    };
  }

  const fixStage: Stage = round === 1 ? "fix-1" : "fix-2";
  const advisoryNote =
    partition.advisory.length || partition.overridden.length
      ? ` (${partition.advisory.length} advisory + ${partition.overridden.length} overridden not blocking)`
      : "";
  const fixBlocked = await safeTransitionFn(stage, fixStage,
    `Review ${round} by ${reviewerLabel} requested changes (${partition.blocking.length} blocking ` +
      `of ${verdict.findings.length} findings${advisoryNote}).`,
  );
  if (fixBlocked) return fixBlocked;
  return {
    advanced: true,
    from: stage,
    to: fixStage,
    summary: `${partition.blocking.length} blocking findings`,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function extractVerdictFromComment(body: string): "approve" | "needs-attention" | null {
  const m = body.match(/^## Review \d+ \([^)]+\) — (approve|needs-attention)/m);
  if (!m) return null;
  return m[1] as "approve" | "needs-attention";
}

const defaultRunReview: RunReviewFn = (
  cfg,
  issueNumber,
  detail,
  plan,
  review1Summary,
  priorReview2Findings,
  diff,
  round,
  cwd,
  opts,
) =>
  invokePromptHarnessReview(cfg, issueNumber, detail.title, detail.body, plan, review1Summary, priorReview2Findings, diff, round, cwd, opts);

/** Exported for direct unit testing (#366) of the reviewer model/effort
 *  resolution — the round-aware "auto" expansion for cfg.harnesses.reviewerModel/
 *  reviewerEffort and cfg.models.review/effort.review. */
export async function invokePromptHarnessReview(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  body: string,
  plan: string,
  review1Summary: string | undefined,
  priorReview2Findings: string | undefined,
  diff: string,
  round: 1 | 2,
  cwd: string,
  opts: AdvanceReviewOpts,
): Promise<ReviewerInvocation> {
  const specContext = openspecContextFromDiff(cfg, cwd, diffFilePaths(diff));
  const contextSnapshot = opts.contextSnapshot;
  const stageName: "review-1" | "review-2" = round === 1 ? "review-1" : "review-2";
  let prompt = round === 1
    ? buildReviewStandardPrompt({ cfg, issueNumber, title, body, plan, diff, specContext, contextSnapshot })
    : buildReviewAdversarialPrompt({
        cfg, issueNumber, title, body, diff, review1Summary, priorReview2Findings, specContext, contextSnapshot,
        priorRoundsDigest: opts.priorRoundsDigest,
      });

  // #646: load SHA-matched Tester evidence once and append before ensemble so
  // every agent shares identical authoritative suite bytes. When fail_closed
  // would withhold solely because this runDir has no current artifact (fresh
  // advance after design-gate, or HEAD moved without re-running the implement
  // gate), re-run the deterministic producer once (no fix-harness loop) and
  // re-acquire — never invent a pass (#882 workflow-state recovery).
  let candidateSha = "";
  try {
    const head = await gitInWorktree(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true });
    candidateSha = head.stdout.trim();
  } catch {
    candidateSha = "";
  }
  const shaForReview = candidateSha || "0".repeat(40);
  const gateRunner = opts.runTestGate ?? runTestGate;
  const testerAcq = await loadOrRegenerateTesterEvidenceForReview(
    opts.runDir,
    shaForReview,
    cfg,
    opts.runDir
      ? async () => {
          const pipelineRunId =
            opts.pipelineRunId ?? path.basename(opts.runDir!);
          // max_attempts: 0 → measure/produce only; no implementer fix loop.
          await gateRunner(
            { ...cfg, test_gate: { ...cfg.test_gate, max_attempts: 0 } },
            issueNumber,
            cwd,
            opts.testGateDeps ?? {},
            pipelineRunId,
            stageName,
            opts.stateDir,
            opts.runDir,
            opts.runStoreDeps,
          );
        }
      : undefined,
  );
  prompt = appendTesterEvidenceSection(prompt, testerAcq);
  if (testerAcq.withholdInvoke) {
    return {
      result: testerEvidenceWithholdResult(testerAcq.reason),
      effectiveReviewer: "tester-evidence-gate",
      selfReview: false,
    };
  }

  // External stage executor delegation (#314): a `stage_executors` assignment
  // for this round bypasses the local reviewer harness (and its #39 self-review
  // fallback) entirely — a deliberate operator choice never silently degraded.
  // #645: ensemble + stage_executors for review-1/review-2 is rejected so we
  // never silently run one executor instead of multi-agent fan-out.
  assertNoEnsembleStageExecutorBypass(cfg, stageName);
  const assignment = resolveStageExecutor(cfg, stageName);
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      `review-${round}`,
      makePromptRecord(round === 1 ? "review-standard" : "review-adversarial", assignment?.name ?? cfg.harnesses.reviewer, prompt),
    ).catch(() => {});
  }
  // Not yet guarded against the effective reviewer command — invokeReviewer
  // applies resolveReviewerModelForHarness itself, per attempted harness,
  // since a same-harness fallback (#39) may target a different harness than
  // `cfg.harnesses.reviewer` (#441 finding c0acb169).
  const rawModel = opts.model ?? cfg.harnesses.reviewerModel ?? cfg.models.review;
  const modelWasAuto = reviewerModelSourceWasAuto(cfg, opts.model);
  if (assignment) {
    const result = await invokeStageExecutor(
      stageName,
      cfg,
      prompt,
      {
        timeoutSec: cfg.review_timeout,
        accounting: opts.runDir
          ? { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps, issue: issueNumber, stage: `review-${round}`, modelSlot: "review" }
          : undefined,
      },
      opts.executorHttpDeps,
    );
    // `result` is non-null: `assignment` is only set when resolveStageExecutor
    // found a `stage_executors` entry, which is exactly invokeStageExecutor's
    // "have an assignment" precondition for returning non-null.
    return { result: result!, effectiveReviewer: assignment.name, selfReview: false };
  }
  // effort.review (and a structured review_harness.effort override) are left
  // as-authored through config resolution because they back both review
  // rounds with different classifications — expand "auto" here, round-aware.
  const reasoningEffort = expandAutoEffort(
    cfg.harnesses.reviewerEffort ?? cfg.effort?.review,
    round === 1 ? "review-1" : "review-2",
    "claude",
  );
  // #645: shared ensemble seam — no-ops to single invokeReviewer when ensemble
  // is disabled/absent; fans out and union-merges when enabled.
  return invokeReviewEnsemble(cfg, {
    worktreeDir: cwd,
    prompt,
    implementer: cfg.harnesses.implementer,
    kind: "structured",
    timeoutSec: cfg.review_timeout,
    model: rawModel,
    modelWasAuto,
    reasoningEffort,
    promptDelivery: cfg.harnesses.reviewerPromptDelivery,
    invokeOpts: {
      accounting: opts.runDir
        ? {
            runDir: opts.runDir,
            runStoreDeps: opts.runStoreDeps,
            issue: issueNumber,
            stage: `review-${round}`,
            modelSlot: "review",
          }
        : undefined,
      env: papercutIdentityEnv(cfg, {
        runId: opts.runDir ? path.basename(opts.runDir) : null,
        issue: issueNumber,
        stage: `review-${round}`,
        harness: cfg.harnesses.reviewer,
        model: rawModel ?? null,
      }),
    },
  });
}

function defaultCreateIssue(
  cfg: PipelineConfig,
): (title: string, body: string, labels: string[]) => Promise<number> {
  return (title: string, body: string, labels: string[]) =>
    createIssue(cfg, title, body, labels);
}

function defaultAddIssueComment(
  cfg: PipelineConfig,
): (issueNumber: number, body: string) => Promise<void> {
  return (issueNumber: number, body: string) =>
    addIssueComment(cfg, issueNumber, body);
}
