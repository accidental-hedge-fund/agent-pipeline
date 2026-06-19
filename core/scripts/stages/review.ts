// Review stages: review-1 (standard) and review-2 (adversarial).
//
//   review-1 → review-2 (approve) OR fix-1 (needs-attention)
//   review-2 → pre-merge (approve) OR fix-2 (needs-attention)
//
// Review runs in "prompt-harness" mode (the only mode): the reviewer-role
// harness CLI is invoked directly with the pipeline's own JSON-returning
// review prompt. Output is parsed from structured JSON when present; Codex's
// native prose reviews are parsed by parseProseReview; otherwise text verdict
// detection is conservative and defaults to "needs-attention".

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  findLatestCommentMatching,
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
import { invokeReviewer, selfReviewBanner, type ReviewerInvocation } from "../self-review.ts";
import { formatStderrExcerpt } from "../harness.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
} from "../prompts/index.ts";
import { getForIssue } from "../worktree.ts";
import * as openspec from "../openspec.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import {
  buildTrustedOverrideComments,
  categoryMarker,
  effectiveReviewPolicy,
  extractOverrides,
  extractScopedOverrides,
  findingKey,
  overrideComment,
  partitionFindings,
  severityRank,
  type PartitionResult,
  type Review1Risk,
} from "../review-policy.ts";
import { makePromptRecord, recordPrompt, recordReview } from "../evidence-bundle.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import type {
  BlockerKind,
  Outcome,
  PipelineConfig,
  ReviewFinding,
  ReviewVerdict,
  Stage,
} from "../types.ts";

const REVIEW_MARKER_PREFIX_R1 = "## Review 1";
const REVIEW_MARKER_PREFIX_R2 = "## Review 2";
// Machine-readable binding of a review verdict to the commit it evaluated (#16).
// Embedded as a dedicated HTML-comment sentinel on its own line so extraction
// can anchor to it without matching a SHA that happens to appear in the diff.
// Anchored to a full line; requires exactly 40 hex chars so short SHAs that
// may appear in model-authored prose or diff excerpts do not match. Global flag
// lets extractReviewedSha pick the LAST occurrence, guarding against injected
// sentinel content appearing earlier in the comment body.
const REVIEWED_SHA_RE = /^<!-- reviewed-sha: ([0-9a-fA-F]{40}) -->$/gm;
// Machine-readable blocking-keys marker emitted by formatReviewComment (#133).
// Anchored to a full line + global flag so extractBlockingKeysFromComment picks
// the LAST occurrence, guarding against injected marker content earlier in the
// comment body (reviewer-authored finding bodies can appear before the footer).
const PIPELINE_BLOCKING_KEYS_RE = /^<!-- pipeline-blocking-keys: ([0-9a-f,]*) -->$/gm;
// Machine-readable diff-hash sentinel (#228): binds the verdict to a hash of the
// exact PR diff string the reviewer evaluated. Anchored full-line + global flag
// so extractDiffHashFromComment picks the LAST occurrence, guarding against an
// injected sentinel appearing earlier in the comment body.
const VERDICT_DIFF_HASH_RE = /^<!-- verdict-diff-hash: ([0-9a-f]{16}) -->$/gm;

// Machine-readable review-1 risk tier sentinel (#232). Anchored to full line;
// global flag picks the LAST occurrence, guarding against injected sentinel
// content appearing earlier in the reviewer-authored comment body.
const REVIEW1_RISK_RE = /^<!-- pipeline-review1-risk: (low|standard) -->$/gm;

// Distinct heading prefix for pre-merge delta review comments (#228 fix-2). Must NOT
// start with "## Review 1" or "## Review 2" so delta reviews are excluded from
// ceiling/recurrence accounting in advanceReview while still carrying the reviewed-sha
// and verdict-diff-hash sentinels the SHA gate reads back.
export const DELTA_REVIEW_MARKER_PREFIX = "## Pre-merge Delta Review";

export interface AdvanceReviewOpts {
  dryRun?: boolean;
  model?: string;
  /** Evidence-bundle run/state dir (#147); when set, each round's verdict is
   *  recorded. Undefined → recording disabled (no fs side effects in tests). */
  stateDir?: string;
  /** Run directory for JSONL event log (#155). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` so events also stream to stdout under
   *  `--json-events` (#155). Undefined → events go to events.jsonl only. */
  runStoreDeps?: RunStoreDeps;
}

/**
 * External seams used by {@link advanceReview}, overridable in tests so the
 * verdict-normalization routing can be exercised without a real reviewer,
 * GitHub, or worktree. Defaults are the real implementations. Mirrors the
 * dependency-injection pattern used by `testgate.ts`'s `TestGateDeps`.
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
  /** Runs one review round and returns the harness result plus which harness
   *  actually reviewed (the same-harness fallback when the reviewer is missing, #39). */
  runReview?: RunReviewFn;
  /** Returns the authenticated GitHub username for comment-author verification (#228).
   *  Returns null when unavailable (network error / not authenticated). */
  getGhActor?: () => Promise<string | null>;
  /** Create a GitHub issue and return its number (#233). Used by the demote-and-advance
   *  path to file the single tracked follow-up issue for demoted findings. No pipeline:
   *  stage label is applied to the follow-up. Default: real `gh issue create` wrapper. */
  createIssue?: (title: string, body: string, labels: string[]) => Promise<number>;
  /** Append a comment to an existing issue (#233 finding 2). Used when the demote-and-advance
   *  path re-enters the ceiling and reuses a prior follow-up: appends current findings so
   *  no finding is lost. Default: real `gh issue comment` wrapper. */
  addIssueComment?: (issueNumber: number, body: string) => Promise<void>;
}

type RunReviewFn = (
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
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const postCommentFn = deps.postComment ?? postComment;
  const postPrCommentFn = deps.postPrComment ?? postPrComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const runReviewFn = deps.runReview ?? defaultRunReview;
  // Fetch the authenticated actor once for the whole function. Used both to
  // verify cache-comment provenance (#228) and to restrict scoped override
  // extraction to pipeline-authored comments (#229 Finding 1). Fail-closed:
  // null means actor is unknown — no trusted comments, scoped overrides ignored.
  const getGhActorFn = deps.getGhActor ?? getGhActor;
  const actor = await getGhActorFn();

  const stage: Stage = round === 1 ? "review-1" : "review-2";
  // The configured cross-harness reviewer (the one we attempt first). After the
  // review runs, `reviewer` is reassigned to the harness that ACTUALLY reviewed,
  // which differs from `configuredReviewer` only on the same-harness fallback (#39).
  const configuredReviewer = cfg.harnesses.reviewer;
  let reviewer = configuredReviewer;

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${reviewer}`);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for this issue.", stage, "no-pull-request");
    return { advanced: false, status: "blocked", reason: "no PR found" };
  }

  // (#16) Capture HEAD SHA before fetching the diff so the stamped SHA matches
  // the diff being reviewed. SHA resolution is mandatory — a missing or invalid
  // SHA would produce an unverifiable verdict that the pre-merge gate can never
  // clear.
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

  // Verify HEAD didn't move between SHA capture and diff fetch. If it did,
  // the diff and the stamped SHA describe different states (#16).
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
    // If the post-diff check fails we cannot confirm the diff/SHA binding is
    // correct. A stale SHA would let a legacy hashless Review 1 sentinel relax
    // review-2's threshold for a different diff — fail closed instead of
    // continuing with an unverified artifact (#232 delta).
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
  // Convergence ratchet: when review-2 is RE-running after a fix, hand the prior
  // round's findings to the reviewer so it verifies resolution + only escalates,
  // instead of re-hunting the whole diff for fresh lower-grade tangents (the drip).
  const priorReview2Findings = round === 2 ? extractReview2Findings(detail.comments) : undefined;

  // Diff-hash cache check (#228): compute the hash ONCE from the already-fetched
  // diff so the sentinel embedded in the comment matches the exact string reviewed.
  const diffHash = computeDiffHash(diff);
  const roundPfx = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;

  // Re-entering review-N on an unchanged diff? Reuse the cached verdict without
  // invoking the reviewer (avoids non-deterministic re-reviews of frozen code).
  // Skipped in dry-run so testing harnesses don't see unexpected early returns.
  if (!opts.dryRun) {
    // Require BOTH the pipeline footer AND the pipeline author to reject forged review
    // comments (#228 Finding 6 + 8): any commenter can copy the footer and diff hash;
    // only the authenticated gh user who runs the pipeline can have authored a real review.
    // Fail-closed: actor was fetched above; null → empty trusted set → cache bypassed,
    // reviewer runs fresh (#228 Finding 8).
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
      const cachedHash = extractDiffHashFromComment(latestPriorComment.body);
      if (cachedHash !== null && cachedHash === diffHash) {
        console.log(`[pipeline] #${issueNumber}: Diff hash unchanged; reusing cached verdict for round ${round}`);
        const cachedVerdict = extractVerdictFromComment(latestPriorComment.body);
        const cachedBlockingKeys = extractBlockingKeysFromComment(latestPriorComment.body);
        // Apply current overrides: a human may have recorded an override after the
        // last review on an unchanged diff. Filter out overridden keys before
        // deciding whether to route to fix (#228 fix-1).
        // Trust overrides from the current actor + configured allowlist (#229 Findings 1, 4, 5, 6).
        const trustedForScopes = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);
        const currentOverrides = extractOverrides(trustedForScopes);
        const remainingBlockers = [...cachedBlockingKeys].filter((k) => !currentOverrides.has(k));
        // If scoped overrides are active and key-only blockers remain, the scope may cover
        // them — but we can't verify without the actual finding objects. Bypass the cache
        // and run a fresh review so partitionFindings can be called with live findings (#229).
        const activeScopes = extractScopedOverrides(trustedForScopes);
        if (remainingBlockers.length > 0 && activeScopes.length > 0) {
          console.log(
            `[pipeline] #${issueNumber}: Scoped overrides active with cached blockers; ` +
            `bypassing cache to run fresh review`,
          );
          // Fall through to the full review path below — do NOT return.
        } else {
          const isBlocking = cachedVerdict === "needs-attention" && remainingBlockers.length > 0;
          // (#233 delta) Ceiling demotion re-entry guard: if a prior run posted the
          // blocking verdict at/over the round cap but failed before completing demotion
          // (follow-up issue, demotion comment, override comments), the cache would route
          // back to fix instead of re-running the demotion. Bypass the cache so the
          // demotion path can complete atomically on re-entry.
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
            // Fall through to the full review path — reviewer re-runs on the same diff
            // and the demotion logic completes atomically this time.
          } else {
            const toStage: Stage = isBlocking
              ? (round === 1 ? "fix-1" : "fix-2")
              : (round === 1 ? "review-2" : "pre-merge");
            const verb = isBlocking ? "blocking findings" : "advance";
            await transitionFn(
              cfg,
              issueNumber,
              stage,
              toStage,
              `Diff hash unchanged; reusing cached verdict for round ${round} (${verb}).`,
            );
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

  // Run in worktree if available, otherwise repo root.
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
  // From here on `reviewer` is the harness that actually reviewed. On the #39
  // same-harness fallback that is the implementer, and `selfReview` is true.
  reviewer = invocation.effectiveReviewer;
  const selfReview = invocation.selfReview;
  // Inject the same-harness disclosure into every review comment this round posts
  // (verdict, advisory, ceiling) so a self-review is never mistaken for an
  // independent one. The banner is placed AFTER the first line (the ## heading)
  // so the comment still starts with the heading — required for the diff-hash
  // cache lookup (startsWith(roundPfx)) to recognize a self-review comment on
  // the next re-entry (#228 Finding 7). A no-op on a normal cross-harness review.
  const reviewComment = (text: string) => {
    if (!selfReview) return text;
    const nl = text.indexOf("\n");
    return nl >= 0
      ? `${text.slice(0, nl)}\n\n${selfReviewBanner(configuredReviewer, reviewer)}${text.slice(nl)}`
      : `${text}\n\n${selfReviewBanner(configuredReviewer, reviewer)}`;
  };
  // Visibly distinct stage-transition label for a self-review.
  const reviewerLabel = selfReview ? `${reviewer} (self-review)` : reviewer;

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    // Include a bounded stderr excerpt so blocked items surface the actionable CLI
    // error (e.g. "reviewer CLI 'my-reviewer' not found…" from harness.ts, or auth
    // failure output) rather than just an exit code. Single-sourced via
    // formatStderrExcerpt so plan-review failures share the same format (#40).
    const stderrExcerpt = formatStderrExcerpt(result.stderr);
    // selfReview here means the reviewer was unspawnable AND the implementing
    // harness fallback also failed — there is no harness left to review with (#39).
    const detailMsg = selfReview
      ? `Neither the cross-harness reviewer (${configuredReviewer}) nor the implementing ` +
        `harness (${reviewer}) is installed/spawnable for a self-review fallback — ${reason}${stderrExcerpt}`
      : `Review harness (${reviewer}) failed: ${reason}${stderrExcerpt}`;
    await setBlockedFn(cfg, issueNumber, detailMsg, stage, "harness-failure");
    return { advanced: false, status: "blocked", reason };
  }

  const verdict = parseStructuredVerdict(result.stdout, commitSha);
  console.log(
    `[pipeline] #${issueNumber}: verdict=${verdict.verdict} findings=${verdict.findings.length}`,
  );

  // Risk-proportional adversarial blocking (#232).
  // For round-1: classify the risk tier from the verdict so we can emit the
  // sentinel on the review comment and review-2 can recover it.
  // For round-2: read the sentinel back and compute the effective policy.
  const review1RiskFromVerdict: Review1Risk | undefined =
    round === 1 ? classifyReview1Risk(verdict) : undefined;
  const review1Risk: Review1Risk =
    round === 2 ? extractReview1Risk(detail.comments, actor, cfgFooter(cfg), { diffHash, sha: commitSha }) : (review1RiskFromVerdict ?? "standard");
  const effectivePol = effectiveReviewPolicy(cfg.review_policy, { round, review1Risk });

  // Append `<!-- pipeline-review1-risk: ... -->` to every review-1 comment so
  // review-2 can recover the tier without parsing reviewer prose.
  const withR1Sentinel = (body: string): string =>
    round === 1 && review1RiskFromVerdict !== undefined
      ? `${body}\n<!-- pipeline-review1-risk: ${review1RiskFromVerdict} -->`
      : body;

  // Evidence bundle (#147): record this round's verdict summary (round, reviewed
  // SHA, verdict, per-severity finding counts) — no raw reviewer prose. Best-effort
  // + gated on opts.stateDir, so unit tests have no filesystem side effects.
  const findingCounts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of verdict.findings) {
    findingCounts[f.severity] = (findingCounts[f.severity] ?? 0) + 1;
  }
  if (opts.stateDir) {
    await recordReview(opts.stateDir, issueNumber, {
      round,
      sha: commitSha,
      verdict: verdict.verdict,
      findingCounts,
    }).catch(() => {});
  }
  // JSONL event log (#155): emit review_verdict for Pipeline Desk stage timeline.
  if (opts.runDir) {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendEvent(opts.runDir, {
      schema_version: RUN_SCHEMA_VERSION,
      type: "review_verdict",
      at,
      round,
      sha: commitSha,
      verdict: verdict.verdict,
      finding_counts: findingCounts,
    }, opts.runStoreDeps).catch(() => {});
  }

  if (verdict.verdict === "approve") {
    await postCommentFn(cfg, issueNumber, withR1Sentinel(reviewComment(formatReviewComment(cfg, verdict, round, reviewer, undefined, diffHash))));
    if (round === 1) {
      await transitionFn(
        cfg,
        issueNumber,
        "review-1",
        "review-2",
        `Standard review by ${reviewerLabel} — approved (${verdict.findings.length} findings).`,
      );
      return {
        advanced: true,
        from: "review-1",
        to: "review-2",
        summary: `approved (${verdict.findings.length} findings)`,
      };
    } else {
      await transitionFn(
        cfg,
        issueNumber,
        "review-2",
        "pre-merge",
        `Adversarial review by ${reviewerLabel} — approved (${verdict.findings.length} findings).`,
      );
      return {
        advanced: true,
        from: "review-2",
        to: "pre-merge",
        summary: `adversarial approved (${verdict.findings.length} findings)`,
      };
    }
  }

  // Verdict normalization (#45): a `needs-attention` verdict carrying zero
  // enumerated findings has nothing concrete for a fix round to act on. Routing
  // it to fix burns a harness invocation on nothing and produces a misleading
  // "fixes pushed" comment (observed live in #34 → PR #44). It almost always
  // means the reviewer output couldn't be parsed into a structured verdict and
  // degraded to the conservative text default. Re-review once; if it still can't
  // produce findings, BLOCK and surface the raw output — do not auto-approve
  // (the text fallback can silently drop prose findings) and do not fix nothing.
  if (verdict.verdict === "needs-attention" && verdict.findings.length === 0) {
    if (retryCount === 0) {
      console.log(
        `[pipeline] #${issueNumber}: needs-attention+0-findings — triggering re-review (attempt ${retryCount + 1})`,
      );
      return advanceReview(cfg, issueNumber, round, opts, retryCount + 1, deps);
    }
    await postCommentFn(cfg, issueNumber, withR1Sentinel(reviewComment(formatReviewComment(cfg, verdict, round, reviewer))));
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
    return {
      advanced: false,
      status: "blocked",
      reason: "needs-attention with 0 findings on re-review",
    };
  }

  // needs-attention with findings → apply the severity policy (#17). Partition
  // findings into blocking (at/above threshold + confidence, not overridden),
  // advisory (below threshold/confidence), and operator-overridden. Only
  // blocking findings route to a fix round. When none remain, the review still
  // ran and its findings are on the record — the item advances as if approved.
  // Trust override/scope sentinels from current actor + configured allowlist (#229 Findings 1, 4, 5, 6).
  const trustedComments = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);
  const overrides = extractOverrides(trustedComments);
  const scopes = extractScopedOverrides(trustedComments);
  // Use the effective policy (risk-scaled for round-2 low-risk changes, #232).
  const partition = partitionFindings(verdict.findings, effectivePol, overrides, scopes);
  // Blocking keys set: derived here after policy partitioning so the review
  // comment can embed the pipeline-blocking-keys marker (#133 fix). Only
  // computed once; shared by all blocking-path branches below.
  const blockingKeysSet = new Set(partition.blocking.map((f) => findingKey(f)));

  if (partition.blocking.length === 0) {
    // Pass the empty blockingKeysSet so formatReviewComment emits an authoritative
    // empty marker (#133 fix 2): prevents extractBlockingKeysFromComment from
    // falling back to all override-key tokens on a re-review where an advisory
    // finding later crosses the policy threshold.
    await postCommentFn(cfg, issueNumber, withR1Sentinel(reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash))));
    const advisory = reviewComment(advisoryAdvanceComment(cfg, round, reviewer, partition));
    await postCommentFn(cfg, issueNumber, advisory);
    // Also surface on the PR: review bookkeeping lives on the issue, but a human
    // merges the PR — advisory findings recorded only on the issue can slip the
    // merge button. Best-effort (the issue record is authoritative).
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
    await transitionFn(
      cfg,
      issueNumber,
      stage,
      toStage,
      `Review ${round} by ${reviewerLabel}: ${verdict.findings.length} finding(s), none above policy ` +
        `(${partition.advisory.length} advisory, ${partition.overridden.length} overridden) — advancing.`,
    );
    return {
      advanced: true,
      from: stage,
      to: toStage,
      summary: `${verdict.findings.length} findings below policy — advanced`,
    };
  }

  // Post the verdict comment WITH the pipeline-blocking-keys marker so future
  // recurrence checks can distinguish prior blocking findings from advisory ones.
  await postCommentFn(cfg, issueNumber, withR1Sentinel(reviewComment(formatReviewComment(cfg, verdict, round, reviewer, blockingKeysSet, diffHash))));

  // Prior verdict comments for THIS round, oldest → newest. `detail.comments`
  // was snapshotted before the current verdict was posted, so the last entry is
  // the round that ran immediately before this one. Drives the recurrence check
  // and the RECURRING/NEW punch-list tags (#133), and the bounded-rounds ceiling.
  // `roundPfx` was computed above (before the cache check) from the same constants.
  const priorRoundComments = detail.comments.filter((c) => c.body.startsWith(roundPfx));
  const roundCap = cfg.review_policy.max_adversarial_rounds;

  // Recurrence-aware early park (#133): a blocking finding whose stable key
  // (`findingKey`: severity|file|line-band, title-stable per #144) already
  // appeared in the immediately-prior round survived a fix attempt unchanged — a
  // proven non-convergence signal that a human is needed NOW, not after the
  // remaining round budget. Pure set-comparison of controlled strings the pipeline
  // itself emits; a finding that changes severity, file, or line band carries a
  // different key and is treated as new (no early park), but a title rewording
  // alone keeps the same key and is correctly seen as recurring (#144). Parks at
  // the same safe `needs-human` terminal as the ceiling — this can only END the
  // loop earlier, never advance or override.
  const lastPriorRound = priorRoundComments[priorRoundComments.length - 1];
  const priorKeys = lastPriorRound
    ? extractBlockingKeysFromComment(lastPriorRound.body)
    : new Set<string>();
  const recurring = partition.blocking.filter((f) => priorKeys.has(findingKey(f)));
  if (recurring.length > 0) {
    await postCommentFn(
      cfg,
      issueNumber,
      reviewComment(reviewCeilingComment(cfg, round, reviewer, partition, roundCap, priorRoundComments, "recurrence")),
    );
    await transitionFn(
      cfg,
      issueNumber,
      stage,
      "needs-human",
      `Review ${round} re-emitted ${recurring.length} blocking finding(s) with an unchanged ` +
        `finding key after a fix round — a proven non-convergence signal. Recorded as advisory; ` +
        `parked at needs-human early, without consuming the remaining round budget (will NOT ` +
        `auto-advance to ready-to-deploy).`,
    );
    return {
      advanced: true,
      from: stage,
      to: "needs-human",
      summary: `recurrence: ${recurring.length} blocking finding(s) unchanged after a fix → needs-human`,
    };
  }

  // Bounded rounds: cap how many times this review round may re-run before we
  // stop looping. After `max_adversarial_rounds` passes still produce blocking
  // findings, record them as advisory and route to the `needs-human` terminal —
  // a human owns the residual call — instead of burning another fix→re-review
  // cycle to the iteration cap. `detail.comments` excludes the current round's
  // verdict (posted after the snapshot was fetched), so prior+1 = this round's number.
  if (roundCap > 0 && priorRoundComments.length + 1 >= roundCap) {
    // (#233) Split blocking findings into high/critical vs. below-high. High/critical
    // always park at needs-human regardless of ceiling_action. Below-high may be
    // demoted and the item advanced when ceiling_action is demote_and_advance.
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
      // Hard-park: any high/critical present, or ceiling_action is park (default).
      await postCommentFn(
        cfg,
        issueNumber,
        reviewComment(reviewCeilingComment(cfg, round, reviewer, partition, roundCap, priorRoundComments)),
      );
      await transitionFn(
        cfg,
        issueNumber,
        stage,
        "needs-human",
        `Review ${round} hit the ${roundCap}-round ceiling with ` +
          `${partition.blocking.length} finding(s) still blocking. Recorded as advisory; parked at ` +
          `needs-human for a human to override or fix (will NOT auto-advance to ready-to-deploy).`,
      );
      return {
        advanced: true,
        from: stage,
        to: "needs-human",
        summary: `review ceiling: ${partition.blocking.length} unresolved blocking → needs-human`,
      };
    }

    // Demote-and-advance path (#233): all blocking findings are below high/critical,
    // ceiling_action is demote_and_advance. Auto-demote, file a follow-up issue, and
    // advance to pre-merge without human intervention.
    const createIssueFn = deps.createIssue ?? defaultCreateIssue(cfg);
    const addIssueCommentFn = deps.addIssueComment ?? defaultAddIssueComment(cfg);

    // Idempotency: check existing comments for a prior follow-up marker. Re-use
    // the recorded follow-up number instead of creating a second issue. Author is
    // verified inside extractCeilingFollowupNumber (#233 finding 1): only markers
    // from the pipeline actor are trusted.
    const existingFollowup = extractCeilingFollowupNumber(detail.comments, actor);
    let followupNumber: number;
    if (existingFollowup !== null) {
      followupNumber = existingFollowup;
      // Append the current findings to the existing follow-up so no finding is
      // lost on re-entry (#233 finding 2).
      const updateBody = buildFollowupUpdateComment(issueNumber, priorRoundComments.length + 1, belowHigh);
      await addIssueCommentFn(followupNumber, updateBody);
    } else {
      // Build and create the single tracked follow-up issue.
      const followupBody = buildFollowupIssueBody(issueNumber, belowHigh);
      followupNumber = await createIssueFn(
        `[Deferred] Review ceiling findings from #${issueNumber}`,
        followupBody,
        [],
      );
    }

    // Post the audited demotion comment with the follow-up marker for idempotency.
    const demotionBody = reviewCeilingDemotionComment(
      cfg,
      round,
      reviewer,
      partition,
      roundCap,
      priorRoundComments,
      followupNumber,
    );
    const demotionComment = reviewComment(demotionBody);
    await postCommentFn(cfg, issueNumber, demotionComment);
    // Mirror to the PR: the demotion advances the item to pre-merge while demoting
    // findings the human will see at the merge button. Best-effort (issue is authoritative).
    try {
      await postPrCommentFn(cfg, prNumber, demotionComment);
    } catch (err) {
      console.warn(
        `[pipeline] #${issueNumber}: could not mirror demotion comment to PR #${prNumber}: ${(err as Error).message}`,
      );
    }

    // Record an audited override disposition for each demoted finding so the
    // pre-merge review-SHA gate's unresolved = recorded − overrides yields ∅
    // for the demoted keys and the item advances through pre-merge.
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
    await transitionFn(
      cfg,
      issueNumber,
      stage,
      toStage,
      `Review ${round} hit the ${roundCap}-round ceiling; ${belowHigh.length} below-high finding(s) ` +
        `auto-demoted to advisory and deferred to #${followupNumber}. Advancing to pre-merge.`,
    );
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
  await transitionFn(
    cfg,
    issueNumber,
    stage,
    fixStage,
    `Review ${round} by ${reviewerLabel} requested changes (${partition.blocking.length} blocking ` +
      `of ${verdict.findings.length} findings${advisoryNote}).`,
  );
  return {
    advanced: true,
    from: stage,
    to: fixStage,
    summary: `${partition.blocking.length} blocking findings`,
  };
}

/**
 * Audited comment posted when a review produced findings but none block under
 * the active policy — the item advances, with the advisory/overridden findings
 * recorded so the decision is visible later (#17).
 *
 * Scope-overridden findings (#229) are itemized under the scope that swept them
 * (not just "a scope was active"), so the audit trail shows exactly what each
 * scope dispositioned.
 */
function advisoryAdvanceComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
): string {
  const lines = [
    `## Pipeline: Review ${round} advanced under severity policy`,
    "",
    `**Reviewer**: ${reviewer}`,
    `Findings were produced but none meet the repo's \`review_policy.block_threshold\` ` +
      `(\`${cfg.review_policy.block_threshold}\`, min_confidence ${cfg.review_policy.min_confidence}), ` +
      `so this item advances instead of routing to a fix round.`,
  ];
  if (partition.advisory.length) {
    lines.push("", "### Advisory (below policy — not blocking)");
    for (const { finding, reason } of partition.advisory) {
      lines.push(`- \`${findingKey(finding)}\` **[${(finding.severity ?? "medium").toUpperCase()}]** ${finding.title} — ${reason}`);
    }
  }
  if (partition.overridden.length) {
    lines.push("", "### Overridden (operator-dispositioned — not blocking)");
    for (const entry of partition.overridden) {
      const sev = `**[${(entry.finding.severity ?? "medium").toUpperCase()}]**`;
      if (entry.kind === "scope") {
        // Itemize under the scope that swept this finding (#229 task 5.1). Display the
        // operator-supplied reason so the audit trail shows why the finding was overridden.
        lines.push(
          `- [${entry.scopeType}:${entry.scopeValue}] ${sev} ${entry.finding.title} — ${entry.reason}`,
        );
      } else {
        lines.push(`- \`${entry.key}\` ${sev} ${entry.finding.title} — ${entry.disposition}`);
      }
    }
  }
  if (partition.advisory.length) {
    lines.push(
      "",
      "⚠️ The advisory findings above were **not fixed** — review them before merging this PR.",
    );
  }
  lines.push("", (cfg.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim());
  return lines.join("\n");
}

/**
 * Punch-list comment posted when the fix↔review loop stops converging: a review
 * round hit the `max_adversarial_rounds` ceiling, or a blocking finding
 * re-emerged with an unchanged key right after a fix round (#133 — `trigger:
 * "recurrence"`, same comment shape, posted before the round budget is
 * exhausted; the `--status` punch-list keys on the shared header). The
 * still-blocking findings are recorded as advisory and the item is parked at
 * `needs-human`. Each finding is tagged `RECURRING (n rounds)` / `NEW` by
 * set-membership of its content-addressed key against the prior same-round
 * verdict comments, and listed with its override-key so a human can accept it
 * (`--override`) or fix it, then relabel to resume. Never auto-advances.
 * Exported for tests.
 */
export function reviewCeilingComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
  cap: number,
  priorReviewComments: { body: string }[],
  trigger: "ceiling" | "recurrence" = "ceiling",
): string {
  const priorKeySets = priorReviewComments.map((c) => extractAllKeysFromComment(c.body));
  const explanation =
    trigger === "recurrence"
      ? `Review ${round} re-emitted blocking finding(s) with an unchanged finding key after a ` +
        `fix round — a proven non-convergence signal. To stop looping, they are recorded as ` +
        `**advisory** and this item is parked at \`needs-human\` — it will NOT auto-advance to ` +
        `ready-to-deploy.`
      : `Review ${round} re-ran ${cap} times and still has ${partition.blocking.length} blocking ` +
        `finding(s). To stop looping, they are recorded as **advisory** and this item is parked at ` +
        `\`needs-human\` — it will NOT auto-advance to ready-to-deploy.`;
  const lines = [
    `## Pipeline: Review ceiling reached — human decision required`,
    "",
    `**Reviewer**: ${reviewer}`,
    explanation,
    "",
    "### Unresolved blocking findings",
  ];
  for (const f of partition.blocking) {
    const key = findingKey(f);
    const loc = f.file ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\`` : "";
    lines.push(
      `- **${recurrenceTag(key, priorKeySets)}** \`${key}\` ` +
        `**[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${loc}`,
    );
  }
  lines.push(
    "",
    "### To resume",
    `- Accept a finding: \`--override "<key>: <reason>"\` (audited) — records the decision and auto-resumes.`,
    `- Or fix the finding(s) by hand and relabel \`pipeline:needs-human\` → \`pipeline:review-${round}\`.`,
    "",
    (cfg.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
  );
  return lines.join("\n");
}

/** Default {@link RunReviewFn}: runs the prompt-harness reviewer. */
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

/**
 * Extract repo-relative file paths from a unified diff string.
 * Parses `diff --git a/<path> b/<path>` header lines produced by `gh pr diff`.
 * Exported for unit tests.
 */
export function diffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

async function invokePromptHarnessReview(
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
  const prompt = round === 1
    ? buildReviewStandardPrompt({ cfg, issueNumber, title, body, plan, diff, specContext })
    : buildReviewAdversarialPrompt({ cfg, issueNumber, title, body, diff, review1Summary, priorReview2Findings, specContext });
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      `review-${round}`,
      makePromptRecord(round === 1 ? "review-standard" : "review-adversarial", cfg.harnesses.reviewer, prompt),
    ).catch(() => {});
  }
  // #39: invoke through the same-harness fallback seam — if the configured
  // reviewer CLI is not spawnable, the implementing harness reviews instead.
  return invokeReviewer(cfg.harnesses.reviewer, cfg.harnesses.implementer, cwd, prompt, {
    timeoutSec: cfg.review_timeout,
    model: opts.model ?? cfg.models.review,
  });
}

// ---------------------------------------------------------------------------
// Pure parsers — exported for testability
// ---------------------------------------------------------------------------

export function parseStructuredVerdict(
  output: string,
  commitSha = "",
): ReviewVerdict & { _raw?: string } {
  // Try fenced JSON first.
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  // Then any JSON-looking block containing "verdict".
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Partial<ReviewVerdict>;
      if (data.verdict === "approve" || data.verdict === "needs-attention") {
        return {
          verdict: data.verdict,
          summary: data.summary ?? "",
          findings: Array.isArray(data.findings) ? (data.findings as ReviewFinding[]) : [],
          next_steps: Array.isArray(data.next_steps) ? data.next_steps as string[] : [],
          commitSha,
        };
      }
    } catch {
      // try the next candidate
    }
  }

  // Codex's standard review (`/codex:review`) returns Markdown prose, not JSON.
  // Parse it so real findings route to a fix instead of being silently dropped
  // (#50 — observed live on #48: a real [P2] finding was lost → needs-attention/0
  // → blocked run). The commit SHA is stamped here, not parsed from prose (#16).
  const prose = parseProseReview(output);
  if (prose) return { ...prose, commitSha };

  // Fall back to text-based verdict (conservative). This path produces no
  // structured findings, so log it: a fallback `needs-attention` is
  // indistinguishable from a genuine one at the routing site, and silent
  // degradation is exactly what burned a fix round on nothing in #45. `_raw`
  // carries the unparsed output forward so the routing layer can surface it.
  console.warn(
    "[pipeline] warning: verdict fallback — no structured JSON found in reviewer output; raw attached",
  );
  return {
    verdict: parseTextVerdict(output),
    summary: output.slice(0, 500),
    findings: [],
    next_steps: [],
    commitSha,
    _raw: output.slice(0, 4000),
  };
}

export function parseTextVerdict(output: string): "approve" | "needs-attention" {
  const upper = output.toUpperCase();
  // First-line scan for explicit signal.
  const firstLines = output.split("\n", 15).map((l) => l.trim().toUpperCase());
  for (const line of firstLines) {
    if (line.includes("NEEDS-ATTENTION") || line.includes("NEEDS_ATTENTION")) {
      return "needs-attention";
    }
    if (line.includes("REQUEST_CHANGES") || line.includes("REQUEST CHANGES")) {
      return "needs-attention";
    }
    if (line.includes("APPROVE") && !line.includes("NEEDS") && !line.includes("REQUEST")) {
      return "approve";
    }
  }
  if (upper.includes("NEEDS-ATTENTION") || upper.includes("REQUEST_CHANGES") || upper.includes("REQUEST CHANGES")) {
    return "needs-attention";
  }
  if (
    upper.includes("NO MATERIAL FINDINGS") ||
    upper.includes("NO FINDINGS") ||
    upper.includes("NO ISSUES FOUND") ||
    upper.includes("LOOKS SAFE")
  ) {
    return "approve";
  }
  if (upper.includes('"VERDICT": "APPROVE"') || upper.includes("**APPROVE**")) {
    return "approve";
  }
  return "needs-attention";
}

const SEVERITY_BY_PRIORITY: Record<string, ReviewFinding["severity"]> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
};
const WORD_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * Parse Codex's native review (Markdown prose) into a structured verdict.
 * Codex reviews are NOT JSON, and the two review types use different shapes:
 *
 *   Standard (`/codex:review`):    "# Codex Review" … "Review comment:"
 *     - [P2] <title> — <file>:<start>-<end>       (em-dash location)
 *   Adversarial (`/codex:adversarial-review`):   "# Codex Adversarial Review" …
 *     "Verdict: …" … "Findings:"
 *     - [high] <title> (<file>:<start>-<end>)      (parenthesized location)
 *
 * `parseStructuredVerdict` only understood JSON, so these findings were silently
 * dropped (→ needs-attention/0 → blocked run). See #50. Returns `null` when the
 * output is not a recognizable Codex review, so callers fall through to the
 * conservative fallback — never a silent approve of unparsed content (#45).
 *
 * Returns a verdict without `commitSha`; the caller stamps it (#16).
 */
export function parseProseReview(output: string): Omit<ReviewVerdict, "commitSha"> | null {
  const text = output ?? "";
  if (
    !/^#{1,6}\s*Codex\b.*\bReview\b/im.test(text) &&
    !/^\s*(?:Review comment|Findings)\s*:/im.test(text) &&
    !/^\s*Verdict\s*:/im.test(text)
  ) {
    return null;
  }

  const headerRe = /^\s*[-*]\s*\[\s*(P[0-3]|critical|high|medium|low)\s*\]\s*(.+?)\s*$/i;
  // Two Codex location styles: "title — file:line" (standard, em-dash) and
  // "title (file:line)" (adversarial, parens); both may carry a line range.
  const locDash = /^(.*\S)\s+[—–-]\s+(\S.*?):(\d+)(?:\s*-\s*(\d+))?\s*$/;
  const locParen = /^(.*\S)\s+\((\S.*?):(\d+)(?:\s*-\s*(\d+))?\)\s*$/;

  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      findings.push(current);
      current = null;
    }
  };

  for (const line of text.split("\n")) {
    const h = line.match(headerRe);
    if (h) {
      flush();
      const tag = h[1].toLowerCase();
      const severity: ReviewFinding["severity"] =
        SEVERITY_BY_PRIORITY[tag] ??
        (WORD_SEVERITIES.has(tag) ? (tag as ReviewFinding["severity"]) : "medium");
      let title = h[2].trim();
      let file: string | undefined;
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      const loc = title.match(locDash) ?? title.match(locParen);
      if (loc) {
        title = loc[1].trim();
        file = loc[2].trim();
        lineStart = Number(loc[3]);
        lineEnd = loc[4] ? Number(loc[4]) : lineStart;
      }
      current = {
        severity,
        title,
        body: "",
        file,
        line_start: lineStart,
        line_end: lineEnd,
        confidence: 0.7,
        recommendation: "",
      };
      continue;
    }
    if (current) {
      const trimmed = line.trim();
      // Blank lines don't end a finding; indented lines continue its body; a
      // non-indented non-blank line ("Findings:", "Verdict:", "Next steps:", a
      // markdown header, or the next finding) ends it.
      if (trimmed === "") continue;
      if (/^\s/.test(line)) {
        current.body += (current.body ? "\n" : "") + trimmed;
      } else {
        flush();
      }
    }
  }
  flush();

  const summary = extractProseSummary(text);
  if (findings.length > 0) {
    return { verdict: "needs-attention", summary, findings, next_steps: [] };
  }

  // Recognized as a Codex review but with no parseable findings: only call it an
  // approve when the text positively says so. Otherwise return null so the
  // conservative fallback (re-review → block) applies — never silently approve.
  if (
    /^\s*Verdict\s*:\s*approve\b/im.test(text) ||
    /\bno (?:material )?(?:issues|findings|concerns|blocking)\b/i.test(text) ||
    /\b(?:looks good|lgtm|approved?|no problems found)\b/i.test(text)
  ) {
    return { verdict: "approve", summary, findings: [], next_steps: [] };
  }
  return null;
}

/** Pull a short summary from the prose preceding the findings list. */
function extractProseSummary(text: string): string {
  const head = text.split(/^\s*(?:Review comment|Findings)\s*:/im)[0] ?? text;
  const cleaned = head
    .replace(/^#{1,6}\s*Codex\b.*Review\s*$/im, "")
    .replace(/^\s*Target:.*$/im, "")
    .replace(/^\s*Verdict\s*:.*$/im, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return (cleaned || "Codex review").slice(0, 500);
}

export function formatReviewComment(
  cfgOrVerdict: PipelineConfig | (ReviewVerdict & { _raw?: string }),
  verdictOrRound: (ReviewVerdict & { _raw?: string }) | 1 | 2,
  roundOrReviewer: 1 | 2 | string,
  maybeReviewer?: string,
  blockingKeys?: Set<string>,
  diffHash?: string,
): string {
  const cfg = maybeReviewer === undefined ? undefined : cfgOrVerdict as PipelineConfig;
  const verdict = maybeReviewer === undefined
    ? cfgOrVerdict as ReviewVerdict & { _raw?: string }
    : verdictOrRound as ReviewVerdict & { _raw?: string };
  const round = maybeReviewer === undefined ? verdictOrRound as 1 | 2 : roundOrReviewer as 1 | 2;
  const reviewer = maybeReviewer === undefined ? roundOrReviewer as string : maybeReviewer;
  const reviewType = round === 1 ? "Standard" : "Adversarial";
  // Surface the reviewed commit in the header so it is visible which commit this
  // verdict covers (#16); the machine-readable sentinel is appended last.
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `## Review ${round} (${reviewType}) — ${verdict.verdict} (commit ${shortSha})`
    : `## Review ${round} (${reviewType}) — ${verdict.verdict}`;
  const lines = [
    heading,
    `**Reviewer**: ${reviewer}`,
    "",
    verdict.summary,
  ];
  const advisoryOrdinals: number[] = [];
  if (verdict.findings.length > 0) {
    lines.push("", "### Findings");
    verdict.findings.forEach((f, i) => {
      const sev = (f.severity ?? "medium").toUpperCase();
      const loc = f.line_start
        ? `${f.file ?? ""}:${f.line_start}-${f.line_end ?? f.line_start}`
        : f.file ?? "";
      const conf = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : "";
      // Emit the structured `category` as a controlled marker so deterministic
      // gates (e.g. the #106 spec-drift guard) can read it without parsing prose.
      const cat = f.category ? ` ${categoryMarker(f.category)}` : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}`);
      if (loc) lines.push(`Location: \`${loc}\``);
      if (f.body) lines.push(f.body);
      if (f.recommendation) lines.push(`**Recommendation**: ${f.recommendation}`);
      if (f.blocking === false) advisoryOrdinals.push(i + 1);
    });
  }
  if (verdict._raw) {
    lines.push("", "### Raw Review Output", verdict._raw);
  }
  if (verdict.next_steps?.length) {
    lines.push("", "### Next Steps");
    for (const step of verdict.next_steps) lines.push(`- ${step}`);
  }
  lines.push(cfgFooter(cfg));
  // Machine-readable blocking-keys marker (#133): records which findings were
  // above the severity policy at post time so future rounds can distinguish
  // prior blocking from advisory findings when checking for recurrence.
  // Emitted when `blockingKeys` is supplied — including as an empty list for
  // advisory-only rounds (no blocking findings). An empty marker is authoritative:
  // extractBlockingKeysFromComment will NOT fall back to all override-key tokens.
  // Omitted when no `blockingKeys` arg is provided (approve and 0-findings paths).
  if (blockingKeys !== undefined) {
    lines.push(`<!-- pipeline-blocking-keys: ${[...blockingKeys].sort().join(",")} -->`);
  }
  // Advisory-ordinals marker (#236): records 1-indexed positions of advisory
  // (blocking:false) findings in a formatter-controlled footer so filterToBlockingFindings
  // can identify them without touching reviewer-controlled body/recommendation text.
  if (advisoryOrdinals.length > 0) {
    lines.push(`<!-- pipeline-advisory-ordinals: ${advisoryOrdinals.join(",")} -->`);
  }
  // Sentinel last (#16): a dedicated, anchorable line the gate reads back to
  // verify the verdict still covers HEAD. Omitted when no SHA was resolved.
  if (verdict.commitSha) {
    lines.push("", `<!-- reviewed-sha: ${verdict.commitSha} -->`);
  }
  // Diff-hash sentinel (#228): records the hash of the diff the reviewer saw so
  // re-entry on an unchanged diff can skip the reviewer (deterministic). Co-located
  // with the reviewed-sha sentinel. Omitted when no hash is supplied (e.g. tests,
  // 0-findings blocked path where caching would produce incorrect advance routing).
  if (diffHash) {
    lines.push(`<!-- verdict-diff-hash: ${diffHash} -->`);
  }
  return lines.join("\n");
}

/**
 * Format a pre-merge delta review comment (#228). Uses a distinct heading prefix
 * (DELTA_REVIEW_MARKER_PREFIX) so the comment is NOT counted as a full review-2
 * round by advanceReview's ceiling and recurrence accounting. Still carries the
 * reviewed-sha and verdict-diff-hash sentinels so the SHA gate can pick up the
 * updated SHA and hash on the next pre-merge iteration.
 */
export function formatDeltaReviewComment(
  cfg: PipelineConfig,
  verdict: ReviewVerdict & { _raw?: string },
  reviewer: string,
  blockingKeys?: Set<string>,
  diffHash?: string,
): string {
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict} (commit ${shortSha})`
    : `${DELTA_REVIEW_MARKER_PREFIX} — ${verdict.verdict}`;
  const lines: string[] = [heading, `**Reviewer**: ${reviewer}`, "", verdict.summary];
  const advisoryOrdinals: number[] = [];
  if (verdict.findings.length > 0) {
    lines.push("", "### Findings");
    for (let i = 0; i < verdict.findings.length; i++) {
      const f = verdict.findings[i];
      const sev = (f.severity ?? "medium").toUpperCase();
      const loc = f.line_start
        ? `${f.file ?? ""}:${f.line_start}-${f.line_end ?? f.line_start}`
        : f.file ?? "";
      const conf = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : "";
      const cat = f.category ? ` ${categoryMarker(f.category)}` : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\`${cat}`);
      if (loc) lines.push(`Location: \`${loc}\``);
      if (f.body) lines.push(f.body);
      if (f.recommendation) lines.push(`**Recommendation**: ${f.recommendation}`);
      if (f.blocking === false) advisoryOrdinals.push(i + 1);
    }
  }
  if (verdict.next_steps?.length) {
    lines.push("", "### Next Steps");
    for (const step of verdict.next_steps) lines.push(`- ${step}`);
  }
  lines.push(cfgFooter(cfg));
  if (blockingKeys !== undefined) {
    lines.push(`<!-- pipeline-blocking-keys: ${[...blockingKeys].sort().join(",")} -->`);
  }
  if (advisoryOrdinals.length > 0) {
    lines.push(`<!-- pipeline-advisory-ordinals: ${advisoryOrdinals.join(",")} -->`);
  }
  if (verdict.commitSha) {
    lines.push("", `<!-- reviewed-sha: ${verdict.commitSha} -->`);
  }
  if (diffHash) {
    lines.push(`<!-- verdict-diff-hash: ${diffHash} -->`);
  }
  return lines.join("\n");
}

function cfgFooter(cfg: PipelineConfig | undefined): string {
  return (cfg?.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim();
}

function extractPlan(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith("## Implementation Plan"),
  );
  return m?.body ?? "(plan not found in comments)";
}

function extractReview1Summary(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(REVIEW_MARKER_PREFIX_R1),
  );
  return (m?.body ?? "").slice(0, 2000);
}

/** Latest prior `## Review 2` comment, for the convergence ratchet — fed back to
 * the reviewer on a re-run so it verifies resolution + only escalates instead of
 * re-hunting the whole diff. `undefined` when review-2 has not run before. */
function extractReview2Findings(comments: { body: string }[]): string | undefined {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(REVIEW_MARKER_PREFIX_R2),
  );
  return m?.body ? m.body.slice(0, 2000) : undefined;
}

/** How many prior `## Review {round}` verdict comments already exist on the issue.
 * Excludes the current round's comment, which is posted to the PR only after the
 * in-memory `detail` snapshot was fetched. Drives the bounded-rounds ceiling.
 * Exported for tests. */
export function countPriorRounds(comments: { body: string }[], round: 1 | 2): number {
  const prefix = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;
  return comments.filter((c) => c.body.startsWith(prefix)).length;
}

/**
 * Collect every content-addressed finding key a review verdict comment carries
 * by scanning all `` `override-key: <8-hex>` `` tokens. This includes advisory
 * findings as well as blocking ones — used for RECURRING/NEW punch-list tagging
 * where the count should reflect every prior appearance, not just blocking ones.
 * Pure and total: any string yields a Set without throwing.
 */
function extractAllKeysFromComment(body: string): Set<string> {
  const keys = new Set<string>();
  const re = /`override-key: ([0-9a-f]{8})`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) keys.add(m[1]);
  return keys;
}

/**
 * Collect the BLOCKING finding keys from a review verdict comment for the
 * recurrence early-park check (#133). Prefers the `pipeline-blocking-keys`
 * machine-readable marker that `formatReviewComment` embeds after policy
 * partitioning (which distinguishes blocking from advisory findings). Falls
 * back to all `override-key` tokens only for comments without the marker (legacy
 * comments predating #133). Two hardening properties (#133 fix 2):
 * - Anchored full-line regex: rejects any marker embedded mid-line in reviewer prose.
 * - Last-occurrence selection: mitigates a reviewer body that places a spoofed
 *   full-line marker before the real pipeline-emitted footer marker.
 * - Empty marker is authoritative: an advisory-only round emits an empty list and
 *   extractBlockingKeysFromComment returns an empty Set (no fallback to all keys).
 * Pure and total: no network, git, or subprocess calls.
 */
export function extractBlockingKeysFromComment(body: string): Set<string> {
  const marker = extractBlockingKeysMarker(body);
  if (marker !== null) return marker;
  return extractAllKeysFromComment(body);
}

/**
 * Marker-only variant of {@link extractBlockingKeysFromComment}: returns the keys
 * from the authoritative `pipeline-blocking-keys` marker, or `null` when the
 * comment carries NO marker at all. Unlike {@link extractBlockingKeysFromComment}
 * it never falls back to scraping all `override-key` tokens — so an approve or
 * advisory-only comment (which lists advisory findings' keys but emits no marker,
 * or an empty marker) is reported as "no blockers" rather than mis-read as blocking.
 *
 * Used by the pre-merge SHA gate to decide, on an exact reviewed-SHA match, whether
 * the recorded review still has UNRESOLVED blockers at HEAD (#228 review-2 finding):
 * a blocking pre-merge delta review leaves `reviewed-sha == HEAD`, so a matching SHA
 * must not be treated as a valid approval without re-checking its blocking keys.
 * An empty marker returns an empty Set (advisory-only round, no blockers).
 */
export function extractBlockingKeysMarker(body: string): Set<string> | null {
  PIPELINE_BLOCKING_KEYS_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = PIPELINE_BLOCKING_KEYS_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  PIPELINE_BLOCKING_KEYS_RE.lastIndex = 0;
  if (lastMatch === null) return null;
  const keys = new Set<string>();
  for (const k of lastMatch[1].split(",")) {
    if (/^[0-9a-f]{8}$/.test(k)) keys.add(k);
  }
  return keys;
}

/**
 * The punch-list tag for a finding key (#133): `RECURRING (n rounds)` where `n`
 * counts the prior same-round verdict comments that carried the key, or `NEW`
 * when none did (or the key is unparseable). Single-sourced so the posted
 * punch-list comment and the `--status` re-derivation cannot drift.
 */
export function recurrenceTag(key: string | undefined, priorKeySets: Set<string>[]): string {
  const n = key === undefined ? 0 : priorKeySets.filter((s) => s.has(key)).length;
  return n > 0 ? `RECURRING (${n} rounds)` : "NEW";
}

// A punch-list finding line's already-rendered tag prefix, stripped before
// re-deriving so tags are never doubled when `--status` re-reads a comment
// this code emitted.
const PUNCHLIST_TAG_RE = /^\*\*(?:NEW|RECURRING \(\d+ rounds?\))\*\*\s+/;
// The finding's key within a punch-list line: the first backticked token that is
// exactly 8 lowercase hex chars (the same shape `--override` accepts).
const PUNCHLIST_KEY_RE = /`([0-9a-f]{8})`/;

/**
 * Re-derive the RECURRING/NEW tag for each punch-list finding line when the
 * ceiling comment is read back (the `--status` needs-human surface, #133).
 * `ceilingIdx` is the ceiling comment's index within `comments`. "Prior" rounds
 * exclude the verdict comment that triggered the park — the nearest `## Review N`
 * comment before the ceiling comment — because its keys ARE the punch-list:
 * counting it would tag every finding RECURRING. This reproduces exactly the
 * comment set the tags were derived from when the punch-list was posted. Lines
 * with no parseable key are tagged NEW. Pure string work over controlled
 * pipeline-emitted comments; total on malformed input.
 */
export function tagCeilingFindingLines(
  findingLines: string[],
  comments: { body: string }[],
  ceilingIdx: number,
): string[] {
  let triggerIdx = -1;
  for (let i = ceilingIdx - 1; i >= 0; i--) {
    if (reviewRoundOf(comments[i].body) !== null) {
      triggerIdx = i;
      break;
    }
  }
  const priorKeySets: Set<string>[] = [];
  if (triggerIdx !== -1) {
    const triggerRound = reviewRoundOf(comments[triggerIdx].body);
    for (let i = 0; i < triggerIdx; i++) {
      if (reviewRoundOf(comments[i].body) === triggerRound) {
        priorKeySets.push(extractAllKeysFromComment(comments[i].body));
      }
    }
  }
  return findingLines.map((line) => {
    const rest = line.replace(/^- /, "").replace(PUNCHLIST_TAG_RE, "");
    const key = rest.match(PUNCHLIST_KEY_RE)?.[1];
    return `- ${recurrenceTag(key, priorKeySets)} ${rest}`;
  });
}

function isDeltaReviewComment(body: string): boolean {
  return body.startsWith(DELTA_REVIEW_MARKER_PREFIX);
}

/** Which review round a comment body belongs to, or null if it isn't one. */
function reviewRoundOf(body: string, only?: 1 | 2): 1 | 2 | null {
  const isR1 = body.startsWith(REVIEW_MARKER_PREFIX_R1);
  const isR2 = body.startsWith(REVIEW_MARKER_PREFIX_R2);
  if (only === 1) return isR1 ? 1 : null;
  if (only === 2) return isR2 ? 2 : null;
  if (isR2) return 2;
  if (isR1) return 1;
  return null;
}

/**
 * Read the commit a prior review verdict evaluated (#16) from the most recent
 * review comment. With `round`, only that round's comments are considered;
 * without it, the latest review comment of either round is used and its round
 * reported (so a gate can re-run the right review stage).
 *
 * Returns `null` when no review comment exists at all. Returns `{ sha: null }`
 * when a review comment exists but carries no `reviewed-sha` sentinel (a legacy
 * comment predating this change) — the gate treats that as unverifiable.
 */
export function extractReviewedSha(
  comments: { body: string }[],
  round?: 1 | 2,
): { sha: string | null; round: 1 | 2 } | null {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => reviewRoundOf(b, round) !== null || (round !== 1 && isDeltaReviewComment(b)),
  );
  if (!m) return null;
  // Reset lastIndex before each exec so the global regex is stateless across calls.
  REVIEWED_SHA_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEWED_SHA_RE.exec(m.body)) !== null) {
    lastMatch = cur;
  }
  REVIEWED_SHA_RE.lastIndex = 0;
  return {
    sha: lastMatch?.[1] ?? null,
    round: reviewRoundOf(m.body, round) ?? 2,
  };
}

/**
 * SHA-256 of the raw diff string, truncated to 16 hex characters. Used as the
 * `verdict-diff-hash` sentinel value to detect whether the PR diff has changed
 * since the last recorded verdict (#228).
 */
export function computeDiffHash(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, 16);
}

/**
 * Extract the `verdict-diff-hash` sentinel from a review comment body (#228).
 * Last-occurrence-wins (same guard as `extractBlockingKeysFromComment`): rejects
 * a spoofed sentinel appearing before the pipeline-emitted footer.
 * Returns null when absent or structurally malformed.
 */
export function extractDiffHashFromComment(body: string): string | null {
  VERDICT_DIFF_HASH_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = VERDICT_DIFF_HASH_RE.exec(body)) !== null) {
    lastMatch = cur;
  }
  VERDICT_DIFF_HASH_RE.lastIndex = 0;
  return lastMatch?.[1] ?? null;
}

/**
 * Return the body of the most recent review comment for the given round, or
 * null when none exists. Used by the pre-merge SHA gate to check the cached
 * diff-hash sentinel without duplicating the prefix constants (#228).
 */
export function findLatestReviewCommentBody(
  comments: { body: string }[],
  round: 1 | 2,
): string | null {
  const prefix = round === 1 ? REVIEW_MARKER_PREFIX_R1 : REVIEW_MARKER_PREFIX_R2;
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(prefix) || (round === 2 && isDeltaReviewComment(b)),
  );
  return m?.body ?? null;
}

/**
 * Extract the verdict string (`"approve"` or `"needs-attention"`) from the
 * heading line of a review comment produced by `formatReviewComment`. Returns
 * null when the heading is absent or does not match the expected format. Used
 * by the diff-hash cache path to reproduce routing without re-invoking the reviewer.
 */
function extractVerdictFromComment(body: string): "approve" | "needs-attention" | null {
  const m = body.match(/^## Review \d+ \([^)]+\) — (approve|needs-attention)/m);
  if (!m) return null;
  return m[1] as "approve" | "needs-attention";
}

/**
 * Classify the review-1 risk tier from its structured verdict (#232).
 * Returns `"low"` when the verdict is `approve` with zero findings (the exact
 * signal the adversarial round's blocking is disproportionate to); `"standard"`
 * otherwise. Derived purely from the structured `ReviewVerdict` — never from
 * the reviewer's free-text `summary` or any prose field.
 */
export function classifyReview1Risk(verdict: Pick<ReviewVerdict, "verdict" | "findings">): Review1Risk {
  return verdict.verdict === "approve" && verdict.findings.length === 0 ? "low" : "standard";
}

/**
 * Extract the review-1 risk tier from issue comments (#232). Reads the last
 * `<!-- pipeline-review1-risk: low|standard -->` sentinel from trusted
 * pipeline-authored Review 1 comments only. A comment is trusted when it starts
 * with the Review 1 marker, was authored by `actor`, and contains the configured
 * footer — matching the same triple-gate used for the diff-hash cache (#228).
 * Defaults to `"standard"` when absent, unrecognized, or `actor` is null
 * (unknown pipeline identity) — conservative fail-closed.
 *
 * When `currentArtifact` is supplied the recovered sentinel is validated against
 * the current PR artifact: prefers `verdict-diff-hash` (content-based); falls
 * back to `reviewed-sha` when no diff-hash is present. A mismatch on either
 * means the sentinel is stale (new commits landed after review-1 ran) and the
 * function returns `"standard"` — fail-closed (#232 finding 1).
 */
export function extractReview1Risk(
  comments: { author: string; body: string }[],
  actor: string | null,
  footer: string,
  currentArtifact?: { diffHash: string; sha: string },
): Review1Risk {
  if (actor === null) return "standard";
  let lastRisk: Review1Risk | null = null;
  let lastRiskBody: string | null = null;
  for (const c of comments) {
    if (!c.body.startsWith(REVIEW_MARKER_PREFIX_R1)) continue;
    if (c.author !== actor) continue;
    if (!c.body.includes(footer)) continue;
    REVIEW1_RISK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let found: Review1Risk | null = null;
    while ((m = REVIEW1_RISK_RE.exec(c.body)) !== null) {
      found = m[1] as Review1Risk;
    }
    REVIEW1_RISK_RE.lastIndex = 0;
    if (found !== null) {
      lastRisk = found;
      lastRiskBody = c.body;
    }
  }
  if (lastRisk === null || lastRiskBody === null) return "standard";
  // Staleness check: the recovered sentinel must describe the artifact review-2
  // is currently evaluating. Prefer the content-based diff-hash; fall back to
  // the commit SHA. Either mismatch → the sentinel is stale → fail-closed.
  if (currentArtifact !== undefined) {
    const commentDiffHash = extractDiffHashFromComment(lastRiskBody);
    if (commentDiffHash !== null) {
      if (commentDiffHash !== currentArtifact.diffHash) return "standard";
    } else {
      REVIEWED_SHA_RE.lastIndex = 0;
      let shaCur: RegExpExecArray | null;
      let lastSha: string | null = null;
      while ((shaCur = REVIEWED_SHA_RE.exec(lastRiskBody)) !== null) {
        lastSha = shaCur[1];
      }
      REVIEWED_SHA_RE.lastIndex = 0;
      if (lastSha !== currentArtifact.sha) return "standard";
    }
  }
  return lastRisk;
}

// ---------------------------------------------------------------------------
// Demote-and-advance helpers (#233)
// ---------------------------------------------------------------------------

// Controlled heading that every pipeline-authored demotion comment starts with.
// Used to restrict follow-up marker extraction to trusted comments only.
const CEILING_DEMOTION_HEADING = "## Pipeline: Review ceiling — findings demoted and deferred";

// Machine-readable follow-up marker anchored to a full line.
const CEILING_FOLLOWUP_LINE_RE = /^<!-- pipeline-ceiling-followup: #(\d+) -->$/;

/**
 * Scan issue comments for an existing `<!-- pipeline-ceiling-followup: #N -->`
 * marker, returning the recorded follow-up issue number or null when absent.
 * Only reads markers from pipeline-authored demotion comments (starting with
 * CEILING_DEMOTION_HEADING, authored by the authenticated pipeline actor) where
 * the marker is the last non-empty line — the exact placement used by
 * reviewCeilingDemotionComment. Fail-closed: null actor → no trusted comments.
 * Last-occurrence-wins. Exported for tests.
 */
export function extractCeilingFollowupNumber(
  comments: { author: string; body: string }[],
  actor: string | null,
): number | null {
  let last: number | null = null;
  for (const c of comments) {
    // Fail-closed: unknown actor means no trusted comments (#233 finding 1).
    if (actor === null || c.author !== actor) continue;
    // Trust only pipeline-authored demotion comments.
    if (!c.body.startsWith(CEILING_DEMOTION_HEADING)) continue;
    // Accept the marker only when it is the last non-empty line of the comment.
    const lastLine =
      c.body
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)
        .at(-1) ?? "";
    const m = CEILING_FOLLOWUP_LINE_RE.exec(lastLine);
    if (m) last = Number(m[1]);
  }
  return last;
}

/**
 * Build the body of the single tracked follow-up issue filed when findings are
 * demoted at the review ceiling (#233). Lists every demoted finding with its
 * title, severity, category, override-key, and location, and back-links the
 * original issue.
 */
function buildFollowupIssueBody(
  originalIssue: number,
  demotedFindings: ReviewFinding[],
): string {
  const lines = [
    `Deferred review findings from #${originalIssue}`,
    "",
    `These findings were demoted to advisory at the adversarial review ceiling ` +
      `(\`review_policy.max_adversarial_rounds\`) because they are all below high severity ` +
      `and the pipeline is configured with \`ceiling_action: demote_and_advance\`. ` +
      `They should be reviewed and addressed in a follow-up change.`,
    "",
    "## Deferred findings",
  ];
  for (const f of demotedFindings) {
    const key = findingKey(f);
    const loc = f.file
      ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\``
      : "";
    const cat = f.category ? ` (category: ${f.category})` : "";
    lines.push(
      `- \`${key}\` **[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${cat}${loc}`,
    );
  }
  lines.push(
    "",
    `> Deferred from #${originalIssue} at review ceiling. Do not add a \`pipeline:\` label — ` +
      `this issue tracks follow-up work, not an in-progress pipeline run.`,
  );
  return lines.join("\n");
}

/**
 * Build the body of a follow-up issue update comment posted when demote-and-advance
 * re-enters the ceiling and reuses an existing follow-up (#233 finding 2). Lists every
 * current demoted finding so no finding is omitted from the tracked work item.
 */
function buildFollowupUpdateComment(
  originalIssue: number,
  roundNumber: number,
  demotedFindings: ReviewFinding[],
): string {
  const lines = [
    `Additional deferred findings from #${originalIssue} (re-entry at ceiling round ${roundNumber})`,
    "",
    "The item re-entered the review ceiling. The following below-high findings were demoted to advisory in this run:",
    "",
    "## Additional deferred findings",
  ];
  for (const f of demotedFindings) {
    const key = findingKey(f);
    const loc = f.file
      ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\``
      : "";
    const cat = f.category ? ` (category: ${f.category})` : "";
    lines.push(
      `- \`${key}\` **[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${cat}${loc}`,
    );
  }
  lines.push(
    "",
    `> Re-entered from #${originalIssue} at round ${roundNumber} ceiling. Do not add a \`pipeline:\` label.`,
  );
  return lines.join("\n");
}

/**
 * Audited demotion comment posted at the review ceiling when ceiling_action is
 * demote_and_advance and all remaining blocking findings are below high severity.
 * Embeds the `<!-- pipeline-ceiling-followup: #N -->` marker for idempotency.
 * Exported for tests.
 */
export function reviewCeilingDemotionComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
  cap: number,
  priorReviewComments: { body: string }[],
  followupNumber: number,
): string {
  const priorKeySets = priorReviewComments.map((c) => extractAllKeysFromComment(c.body));
  const lines = [
    `## Pipeline: Review ceiling — findings demoted and deferred`,
    "",
    `**Reviewer**: ${reviewer}`,
    `Review ${round} re-ran ${cap} times and still has ${partition.blocking.length} blocking ` +
      `finding(s), all below **high** severity. Per \`review_policy.ceiling_action: demote_and_advance\`, ` +
      `these findings are demoted to **advisory** and captured in follow-up issue #${followupNumber}. ` +
      `This item advances to pre-merge without human intervention.`,
    "",
    "### Demoted findings (advisory — tracked in follow-up)",
  ];
  for (const f of partition.blocking) {
    const key = findingKey(f);
    const loc = f.file ? ` — \`${f.file}${f.line_start ? `:${f.line_start}` : ""}\`` : "";
    lines.push(
      `- **${recurrenceTag(key, priorKeySets)}** \`${key}\` ` +
        `**[${(f.severity ?? "medium").toUpperCase()}]** ${f.title}${loc}`,
    );
  }
  lines.push(
    "",
    `See #${followupNumber} for the complete deferred finding list.`,
    "",
    "⚠️ The demoted findings were **not fixed** — review them before merging this PR.",
    "",
    (cfg.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim(),
    "",
    `<!-- pipeline-ceiling-followup: #${followupNumber} -->`,
  );
  return lines.join("\n");
}

/**
 * Default `createIssue` dep for {@link advanceReview}. Uses `gh issue create`
 * in the repo's directory, matching the pattern from intake.ts's real dep.
 */
function defaultCreateIssue(
  cfg: PipelineConfig,
): (title: string, body: string, labels: string[]) => Promise<number> {
  return async (title: string, body: string, labels: string[]): Promise<number> => {
    const args = ["issue", "create", "--title", title, "--body", body, "-R", cfg.repo];
    for (const label of labels) {
      args.push("--label", label);
    }
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      stdio: "pipe",
      cwd: cfg.repo_dir,
    });
    if (result.status !== 0) {
      throw new Error(
        `[pipeline review] gh issue create failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    }
    const url = result.stdout.trim();
    const m = url.match(/\/(\d+)$/);
    if (!m) {
      throw new Error(`[pipeline review] could not parse issue number from gh output: ${url}`);
    }
    return Number(m[1]);
  };
}

/**
 * Default `addIssueComment` dep for {@link advanceReview}. Posts a comment on an
 * existing issue via `gh issue comment`. Used to append re-entry findings to the
 * existing follow-up issue (#233 finding 2).
 */
function defaultAddIssueComment(
  cfg: PipelineConfig,
): (issueNumber: number, body: string) => Promise<void> {
  return async (issueNumber: number, body: string): Promise<void> => {
    const args = ["issue", "comment", String(issueNumber), "--body", body, "-R", cfg.repo];
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      stdio: "pipe",
      cwd: cfg.repo_dir,
    });
    if (result.status !== 0) {
      throw new Error(
        `[pipeline review] gh issue comment failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
      );
    }
  };
}

// Internal export for tests, so review.test isn't needed.
export const _internals = { extractPlan, extractReview1Summary };
