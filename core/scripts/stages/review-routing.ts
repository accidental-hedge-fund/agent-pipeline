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
import { invokeReviewer, selfReviewBanner, type ReviewerInvocation } from "../self-review.ts";
import { formatStderrExcerpt, papercutIdentityEnv } from "../harness.ts";
import { expandAutoEffort, resolveReviewerModelForHarness, reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { invokeStageExecutor, resolveStageExecutor, type ExecutorHttpDeps } from "../executors.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
} from "../prompts/index.ts";
import {
  buildPriorRoundDigest,
  settledFindings,
  type PriorRoundDigest,
} from "../review-history.ts";
import { getForIssue, getOnDiskForIssue } from "../worktree.ts";
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
  severityRank,
  surfaceKey,
  type PartitionResult,
  type ReversalMatch,
  type Review1Risk,
} from "../review-policy.ts";
import { makePromptRecord, recordPrompt, recordReview } from "../evidence-bundle.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { emitHumanIntervention } from "../intervention.ts";
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
  reviewCeilingComment,
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
  /** Run-store deps carrying `stdoutWrite` for streaming events (#155). */
  runStoreDeps?: RunStoreDeps;
  /** Pre-rendered context snapshot block for prompt injection (#318). Set internally by advanceReview. */
  contextSnapshot?: string;
  /** Cross-round memory digest (#389). Set internally by advanceReview for round 2 only. */
  priorRoundsDigest?: PriorRoundDigest;
  /** Injectable HTTP deps for external stage executor dispatch (#314). Tests
   *  supply a fake `fetchImpl` so no real network call is made. */
  executorHttpDeps?: ExecutorHttpDeps;
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
  // Cross-round memory digest (#389): round 1 is by definition the first round
  // of a run and re-reviews the full diff from scratch, so only round 2 (and
  // its re-reviews) receives it.
  const priorRoundsDigest: PriorRoundDigest | undefined =
    round === 2
      ? buildPriorRoundDigest(detail.comments, { actor, trustedOverrideActors: cfg.trusted_override_actors })
      : undefined;
  opts = { ...opts, priorRoundsDigest };

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
  const result = invocation.result;
  reviewer = invocation.effectiveReviewer;
  const selfReview = invocation.selfReview;
  const reviewComment = (text: string) => {
    if (!selfReview) return text;
    const nl = text.indexOf("\n");
    return nl >= 0
      ? `${text.slice(0, nl)}\n\n${selfReviewBanner(configuredReviewer, reviewer)}${text.slice(nl)}`
      : `${text}\n\n${selfReviewBanner(configuredReviewer, reviewer)}`;
  };
  const reviewerLabel = selfReview ? `${reviewer} (self-review)` : reviewer;

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
    const detailMsg = selfReview
      ? `Neither the cross-harness reviewer (${configuredReviewer}) nor the implementing ` +
        `harness (${reviewer}) is installed/spawnable for a self-review fallback — ${reason}${stderrExcerpt}`
      : `Review harness (${reviewer})${modelNote} failed: ${reason}${stderrExcerpt}`;
    await setBlockedFn(cfg, issueNumber, detailMsg, stage, "harness-failure");
    return { advanced: false, status: "blocked", reason };
  }

  // A delegated `stage_executors` result must satisfy the FULL verdict schema —
  // no partial-JSON defaulting, no prose/text-verdict fallback — or it is a
  // contract violation that blocks the run (#314 review-2 finding 9e069297).
  // `executor_name` is only set on a `HarnessResult` produced by
  // `invokeStageExecutor`; a local reviewer's result never carries it.
  const isDelegatedResult = result.executor_name !== undefined;
  const strictVerdict = isDelegatedResult ? parseStrictVerdict(result.stdout, commitSha) : undefined;
  if (isDelegatedResult && strictVerdict === null) {
    const providerNote = result.executor_provider ? ` (provider "${result.executor_provider}")` : "";
    await setBlockedFn(
      cfg,
      issueNumber,
      `Delegated executor "${result.executor_name}"${providerNote} for stage "${stage}" returned a result ` +
        `that does not satisfy the review verdict contract (missing/invalid fields, or non-JSON/prose ` +
        `output). No fallback — the run is blocked.`,
      stage,
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason: "external executor verdict contract violation" };
  }
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
        ...executorEvidence,
      }).catch(() => {});
    }
    if (opts.runDir) {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      await appendEvent(opts.runDir, {
        schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
        round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
        findings: findingRecords, reviewer_harness: reviewer,
        reviewer_model: reviewerModel, self_review: selfReview,
      }, opts.runStoreDeps).catch(() => {});
    }
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, undefined, diffHash, review1RiskForComment)));
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
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, undefined, undefined, review1RiskForComment)));
    if (opts.stateDir) {
      await recordReview(opts.stateDir, issueNumber, {
        round, sha: commitSha, verdict: verdict.verdict, findingCounts,
        findings: findingRecords, harness: reviewer, model: reviewerModel, selfReview,
        ...executorEvidence,
      }).catch(() => {});
    }
    if (opts.runDir) {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      await appendEvent(opts.runDir, {
        schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
        round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
        findings: findingRecords, reviewer_harness: reviewer,
        reviewer_model: reviewerModel, self_review: selfReview,
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
  const overrides = extractOverrides(trustedComments);
  const scopes = extractScopedOverrides(trustedComments);
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
  for (const { finding, reason, reversalMatch } of partition.advisory) {
    if (reason !== "reversal-unacknowledged" || !reversalMatch) continue;
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
  }
  if (opts.stateDir) {
    await recordReview(opts.stateDir, issueNumber, {
      round, sha: commitSha, verdict: verdict.verdict, findingCounts,
      findings: findingRecords, harness: reviewer, model: reviewerModel, selfReview,
      ...executorEvidence,
    }).catch(() => {});
  }
  if (opts.runDir) {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendEvent(opts.runDir, {
      schema_version: RUN_SCHEMA_VERSION, type: "review_verdict", at,
      round, sha: commitSha, verdict: verdict.verdict, finding_counts: findingCounts,
      findings: findingRecords, reviewer_harness: reviewer,
      reviewer_model: reviewerModel, self_review: selfReview,
    }, opts.runStoreDeps).catch(() => {});
  }
  const blockingKeysSet = new Set(partition.blocking.map((f) => findingKey(f)));

  if (partition.blocking.length === 0) {
    await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash, review1RiskForComment, reversalDemotions)));
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

  await postCommentFn(cfg, issueNumber, reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash, review1RiskForComment, reversalDemotions)));

  const priorRoundComments = detail.comments.filter((c) => c.body.startsWith(roundPfx));
  const roundCap = cfg.review_policy.max_adversarial_rounds;

  // Recurrence-aware early park (#133).
  const lastPriorRound = priorRoundComments[priorRoundComments.length - 1];
  const priorKeys = lastPriorRound
    ? extractBlockingKeysFromComment(lastPriorRound.body)
    : new Set<string>();
  const recurring = partition.blocking.filter((f) => priorKeys.has(findingKey(f)));
  if (recurring.length > 0) {
    const atDemoteCeiling =
      roundCap > 0 &&
      priorRoundComments.length + 1 >= roundCap &&
      cfg.review_policy.ceiling_action === "demote_and_advance";
    if (!atDemoteCeiling) {
      await postCommentFn(
        cfg,
        issueNumber,
        reviewComment(reviewCeilingComment(cfg, round, reviewer, partition, roundCap, priorRoundComments, "recurrence")),
      );
      const recurrenceDetail = `Review ${round} re-emitted ${recurring.length} blocking finding(s) with an unchanged ` +
        `finding key after a fix round — a proven non-convergence signal`;
      const recurrenceBlocked = await safeTransitionFn(stage, "needs-human",
        `${recurrenceDetail}. Recorded as advisory; ` +
          `parked at needs-human early, without consuming the remaining round budget (will NOT ` +
          `auto-advance to ready-to-deploy).`,
      );
      await emitHumanIntervention(opts.runDir, {
        kind: "review-non-convergence",
        stage,
        issue: issueNumber,
        detail: recurrenceDetail,
      }, opts.runStoreDeps).catch(() => {});
      if (recurrenceBlocked) return recurrenceBlocked;
      return {
        advanced: true,
        from: stage,
        to: "needs-human",
        summary: `recurrence: ${recurring.length} blocking finding(s) unchanged after a fix → needs-human`,
      };
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

      if (!shouldSurfaceDemote) {
        await postCommentFn(
          cfg,
          issueNumber,
          reviewComment(reviewCeilingComment(cfg, round, reviewer, partition, roundCap, priorRoundComments, "recurrence")),
        );
        const srDetail = `Review ${round} surface-recurrence guard fired on ${firedSurfaces.size} ` +
          `surface(s) after ${surfaceRounds} consecutive rounds of new-key findings on the ` +
          `same (file + category) cluster`;
        const srBlocked = await safeTransitionFn(stage, "needs-human",
          `${srDetail}. Parked at needs-human early without consuming the remaining round budget.`,
        );
        await emitHumanIntervention(opts.runDir, {
          kind: "review-non-convergence",
          stage,
          issue: issueNumber,
          detail: srDetail,
        }, opts.runStoreDeps).catch(() => {});
        if (srBlocked) return srBlocked;
        return {
          advanced: true,
          from: stage,
          to: "needs-human",
          summary: `surface-recurrence: ${firedSurfaces.size} surface(s) hit ${surfaceRounds}-round streak → needs-human`,
        };
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

  // Bounded rounds ceiling (#233).
  if (roundCap > 0 && priorRoundComments.length + 1 >= roundCap) {
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
      await postCommentFn(
        cfg,
        issueNumber,
        reviewComment(reviewCeilingComment(cfg, round, reviewer, partition, roundCap, priorRoundComments)),
      );
      const ceilingDetail = `Review ${round} hit the ${roundCap}-round ceiling with ` +
        `${partition.blocking.length} finding(s) still blocking`;
      const ceilingBlocked = await safeTransitionFn(stage, "needs-human",
        `${ceilingDetail}. Recorded as advisory; parked at ` +
          `needs-human for a human to override or fix (will NOT auto-advance to ready-to-deploy).`,
      );
      await emitHumanIntervention(opts.runDir, {
        kind: "review-non-convergence",
        stage,
        issue: issueNumber,
        detail: ceilingDetail,
      }, opts.runStoreDeps).catch(() => {});
      if (ceilingBlocked) return ceilingBlocked;
      return {
        advanced: true,
        from: stage,
        to: "needs-human",
        summary: `review ceiling: ${partition.blocking.length} unresolved blocking → needs-human`,
      };
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
  const prompt = round === 1
    ? buildReviewStandardPrompt({ cfg, issueNumber, title, body, plan, diff, specContext, contextSnapshot })
    : buildReviewAdversarialPrompt({
        cfg, issueNumber, title, body, diff, review1Summary, priorReview2Findings, specContext, contextSnapshot,
        priorRoundsDigest: opts.priorRoundsDigest,
      });

  // External stage executor delegation (#314): a `stage_executors` assignment
  // for this round bypasses the local reviewer harness (and its #39 self-review
  // fallback) entirely — a deliberate operator choice never silently degraded.
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
  return invokeReviewer(cfg.harnesses.reviewer, cfg.harnesses.implementer, cwd, prompt, {
    timeoutSec: cfg.review_timeout,
    model: rawModel,
    modelWasAuto,
    reasoningEffort,
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
    // #492: opt-in prompt-delivery channel for a custom reviewer CLI
    // (review_harness.prompt_delivery). Ignored by invoke() for the
    // implementer's own registered adapter on a same-harness fallback (#39) —
    // that adapter declares its own channel.
    promptDelivery: cfg.harnesses.reviewerPromptDelivery,
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
