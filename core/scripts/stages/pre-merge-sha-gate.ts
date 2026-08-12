// Pre-merge review-SHA gate domain (#628).
// Owns enforceReviewShaGate, ShaGateDeps, currency, delta helpers, notices.

import * as path from "node:path";
import {
  addIssueComment,
  createIssue,
  getGhActor,
  getIssueDetail,
  getPrCommits,
  getPrDetail,
  getPrDiff,
  clearBlocked,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import {
  ensureManagedWorktree,
  getForIssue,
  getOnDiskForIssue,
  gitInWorktree,
  type EnsureManagedWorktreeDeps,
  type EnsureManagedWorktreeResult,
} from "../worktree.ts";
import {
  attestPipelineComment,
  buildDeltaFollowupIssueBody,
  buildDeltaFollowupUpdateComment,
  computeDiffHash,
  DELTA_REVIEW_MARKER_PREFIX,
  deltaRoundCeilingComment,
  deltaRoundCeilingDemotionComment,
  diffFilePaths,
  extractBlockingKeysFromComment,
  extractBlockingKeysMarker,
  extractCeilingFollowupNumber,
  extractDiffHashFromComment,
  extractReviewArtifact,
  findLatestReviewCommentBody,
  formatDeltaReviewComment,
  extractReviewedSha,
  isVerifiedPipelineAttestation,
  parseStructuredVerdict,
  type DeltaCeilingFinding,
} from "./review.ts";
import {
  applyAdvisoryCarryForwardRule,
  applyNoopHeadClassificationEvidenceRule,
  HEAD_ALREADY_IMPLEMENTS_RECOMMENDATION,
  applySettledSurfaceEvidenceRule,
  buildTrustedOverrideComments,
  extractOverrides,
  extractScopedOverrides,
  extractSpecDivergenceDirection,
  findingKey,
  normalizeFile,
  overrideComment,
  partitionFindings,
  severityRank,
  surfaceKey,
  type AdvisoryCarryForwardMatch,
  type AlternativeReinstatementMatch,
  type ReversalMatch,
  type UnverifiedSettledSurfaceMatch,
} from "../review-policy.ts";
import {
  buildPriorRoundDigest,
  countDeltaRounds,
  detectSuspectedChurn,
  priorAdvisoryFindings,
  priorAdvisorySurfaceFiles,
  settledFindings,
  settledFindingsSurfaceFiles,
  settledFindingsVerification,
  type HeadFileState,
  type PriorRoundDigest,
  type SettledFindingVerification,
} from "../review-history.ts";
import { appendEvent, RUN_SCHEMA_VERSION } from "../run-store.ts";
import type { RunStoreDeps } from "../run-store.ts";
import { selfReviewBanner } from "../self-review.ts";
import {
  ensembleSelfReviewBanner,
  formatEnsembleIdentityLine,
  invokeReviewEnsemble,
} from "../review-ensemble.ts";
import { buildDeltaReviewPrompt } from "../prompts/index.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import { reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { isPipelineInternalCommit } from "../pipeline-commits.ts";
import {
  appendTesterEvidenceSection,
  loadOrRegenerateTesterEvidenceForReview,
  testerEvidenceWithholdResult,
} from "../tester-evidence.ts";
import { runTestGate } from "../testgate.ts";
import type { Outcome, PipelineConfig, ReviewFinding, Stage } from "../types.ts";
import {
  appendDualShaEscalationDisclosure,
  preMergeBlocked,
  recordedShaIsCurrentForLiveHead,
  recordPreMergeGateResult,
} from "./pre-merge-shared.ts";
import {
  evaluatePreMergeNoopCleanDisposition,
  formatNoopAdvanceEvidenceNote,
  formatNoopStillBrokenReason,
  formatPartitionDispositionReason,
  hasPreMergeAutofixBoundMarkerAtHead,
  hasPreMergeAutofixAttemptAtHead,
  hasPreMergeAutofixNoopAtHead,
  partitionBlockingForAutofix,
  PRE_MERGE_AUTOFIX_PREFIX,
  preMergeAutofixAttemptComment,
  preMergeAutofixNoopComment,
  reconstructFindingsForResidualAutofix,
  type AttemptPreMergeAutoFixFn,
  type PreMergeAutoFixResult,
  type PreMergeAutofixRematerializeBlockerKind,
} from "./pre-merge-autofix.ts";
import {
  reconcileReviewCurrency,
  type ReviewCurrencyObservedState,
  type ReviewCurrencyReconcileResult,
} from "../reconcile-and-converge.ts";
import {
  claimAndPersistStageAttempt,
  hasAttempted,
  hydrateStageAttemptLedger,
  type StageAttemptLedgerDeps,
} from "../stage-attempt-ledger.ts";
import {
  integrityBlocksReviewReuse,
  type IntegrityInvalidationRecord,
} from "../candidate-integrity.ts";

/**
 * Tri-state result of {@link resolveReviewedShaCurrency}: whether a SHA a
 * delta review ran against (or a verdict was recorded against) is still the
 * PR branch head at the moment of recording (#481).
 * - `current`     — `candidateSha` is still the head, or every commit since
 *   it is pipeline-internal (#98 exemption preserved).
 * - `superseded`  — a newer developer/fix commit landed; `headSha` is the
 *   current head. The verdict must be discarded, not recorded as blocking.
 * - `unknown`     — the head or commit list could not be read/classified
 *   (network failure, or `candidateSha`/the current head is absent from the
 *   commit list — e.g. rebase/squash, or a stale commit-list read). Callers
 *   MUST fail closed: never record a blocking verdict on `unknown`.
 */
export type ReviewedShaCurrency =
  | { status: "current" }
  | { status: "superseded"; headSha: string }
  | { status: "unknown" };

/**
 * Seams needed to resolve whether `candidateSha` — the SHA a delta review
 * ran against — is still the PR branch head (#481). Re-reads the PR head and,
 * on mismatch, classifies the commits between `candidateSha` and the new head
 * using the same `isPipelineInternalCommit` rule as the existing SHA gate
 * reuse checks, so pipeline-internal-only commits (OpenSpec archive) still
 * count as current.
 */
export async function resolveReviewedShaCurrency(
  cfg: PipelineConfig,
  prNumber: number,
  candidateSha: string,
  deps: {
    getPrDetail: typeof getPrDetail;
    getPrCommits: typeof getPrCommits;
  },
): Promise<ReviewedShaCurrency> {
  try {
    const newHead = (await deps.getPrDetail(cfg, prNumber)).head_sha;
    if (newHead === candidateSha) return { status: "current" };
    const commits = await deps.getPrCommits(cfg, prNumber);
    const candidateIdx = commits.findIndex((c) => c.oid === candidateSha);
    const newHeadIdx = commits.findIndex((c) => c.oid === newHead);
    // Both SHAs must be present, and in order, to trust the fetched commit
    // list as spanning the full range — otherwise the list may be stale
    // (fetched before the newer push landed) or the history was rebased.
    if (candidateIdx === -1 || newHeadIdx === -1 || newHeadIdx <= candidateIdx) {
      return { status: "unknown" };
    }
    const landedSince = commits.slice(candidateIdx + 1, newHeadIdx + 1);
    if (landedSince.every((c) => isPipelineInternalCommit(c.messageHeadline))) {
      return { status: "current" };
    }
    return { status: "superseded", headSha: newHead };
  } catch {
    return { status: "unknown" };
  }
}

/** Bound on additional delta-review attempts after a supersession within one
 *  pre-merge entry (#481). Exceeding it falls back to the conservative full
 *  re-review path rather than looping. */
export const MAX_DELTA_SUPERSESSION_RETRIES = 1;

/**
 * Domain reconcile surface for review-SHA currency (#759 / #628): pure
 * reuse / re-review / hold dispositions from observed evidence. Recurrence and
 * ceiling counts are inputs for recovery routing — they do not independently
 * authorize `pipeline:needs-human` without current human-decision-required
 * authority.
 */
export function reconcileReviewShaGateState(
  observed: ReviewCurrencyObservedState,
): ReviewCurrencyReconcileResult {
  return reconcileReviewCurrency(observed);
}

/**
 * Claim pre-merge autofix on the stage-attempt ledger before implementer side
 * effects (#759). GH attempt comments remain attestation; ledger is authority.
 * Returns false when the action was already claimed or persist fails.
 */
export async function claimPreMergeAutofixOnLedger(input: {
  runDir: string | undefined;
  headSha: string;
  issueNumber?: number;
  ledgerDeps?: StageAttemptLedgerDeps;
}): Promise<boolean> {
  if (!input.runDir || !input.headSha) return true; // no durable store → caller uses comment attestation
  const hydrated = hydrateStageAttemptLedger(input.runDir, input.ledgerDeps);
  if (!hydrated.ok) {
    // Host-local ledger unusable: GH attestation remains the claim path.
    // Fail closed only when we can prove a prior charged attempt.
    return true;
  }
  if (hasAttempted(hydrated.ledger, input.headSha, "pre_merge_autofix")) {
    return false;
  }
  const claimed = claimAndPersistStageAttempt(
    input.runDir,
    hydrated.ledger,
    {
      headSha: input.headSha,
      action: "pre_merge_autofix",
      itemId: input.issueNumber !== undefined ? String(input.issueNumber) : undefined,
      typedReason: "pre_merge_autofix_claim",
    },
    input.ledgerDeps,
  );
  if (!claimed.ok) {
    // Persist failed (e.g. synthetic runDir used only for event append). Allow
    // the GH comment claim path rather than blocking autofix on host-local I/O.
    return true;
  }
  // Only a freshly created claim authorizes the implementer. Existing started/
  // completed attempts must not free-replay after restart (#759).
  return claimed.created;
}

/**
 * Notice posted when a pre-merge delta verdict is discarded because the PR
 * head moved past the SHA it was run against (#481). Carries no
 * `pipeline-blocking-keys` marker and does not claim the new head as its
 * reviewed commit — review history must not misrepresent a superseded
 * verdict as describing the current head.
 */
export function supersededDeltaReviewNotice(reviewedSha: string, headSha: string): string {
  return attestPipelineComment(
    "pre-merge-delta-superseded",
    [
      `${DELTA_REVIEW_MARKER_PREFIX} — superseded`,
      "",
      `This delta review ran against \`${reviewedSha.slice(0, 7)}\`, but the PR branch head ` +
        `had already moved to \`${headSha.slice(0, 7)}\` by the time the verdict was ready.`,
      "The verdict is discarded — it carries no blocking authority — and the delta review " +
        "re-runs against the current head.",
    ].join("\n"),
  );
}


// ---------------------------------------------------------------------------
// Review-SHA gate (#16): never advance on a stale approval
// ---------------------------------------------------------------------------

/**
 * Result of a pre-merge delta review invocation (#228). The caller formats the
 * comment and routes based on whether there are blocking findings after policy.
 */
export interface DeltaReviewResult {
  verdict: "approve" | "needs-attention";
  findings: ReviewFinding[];
  summary: string;
  /** The harness that actually performed the review (may differ from cfg.harnesses.reviewer
   *  on the #39 same-harness fallback). Undefined when the caller is a test stub. */
  effectiveReviewer?: string;
  /** True when the implementing harness reviewed its own work (same-harness fallback). */
  selfReview?: boolean;
  /** Ensemble meta when review_ensemble ran for this delta review (#645). */
  ensemble?: import("../review-ensemble.ts").EnsembleMeta;
}

/**
 * Injectable seam for the pre-merge delta review (#228). The real implementation
 * calls `invokeReviewer` with the delta-review prompt and returns the parsed
 * verdict; fakes in tests return a controlled verdict without any I/O.
 */
export type RunDeltaReviewFn = (
  cfg: PipelineConfig,
  issueNumber: number,
  issueDetail: { title: string; body: string },
  deltaDiff: string,
  worktreePath: string,
  specContext: string,
  accounting?: {
    runDir?: string;
    runStoreDeps?: RunStoreDeps;
    priorRoundsDigest?: PriorRoundDigest;
    /** Resolved-finding verification entries (#496); see {@link ReadHeadFilesFn}. */
    settledFindingsVerification?: SettledFindingVerification[];
    /** HEAD content of the files those entries' surfaces name (#496). */
    headFiles?: HeadFileState[];
  },
) => Promise<DeltaReviewResult>;

/**
 * Injectable seam (#496 task 2.1) for reading a set of files' content at the
 * reviewed head from the delta reviewer's worktree — the resolved-finding
 * verification context's evidence surface. Returns one entry per requested
 * `path`, in the same order, so unit tests can assert deterministically.
 */
export type ReadHeadFilesFn = (worktreePath: string, treeSha: string, paths: string[]) => Promise<HeadFileState[]>;

/** Per-file byte cap for the HEAD file-state injection (#496 design.md
 *  Decision 3), next to the existing 50KB diff cap so the total prompt
 *  budget is reviewable in one place. */
export const HEAD_FILE_PER_FILE_CAP = 8_000;
/** Total byte cap across all injected HEAD files (#496 design.md Decision 3). */
export const HEAD_FILE_TOTAL_CAP = 24_000;

/** Default implementation of the `readHeadFiles` seam (#496): reads each
 *  requested path from the IMMUTABLE reviewed Git tree (`git show
 *  <treeSha>:<path>`), never from the mutable worktree filesystem — so no
 *  concurrent writer, symlink swap, or validation-to-read race can inject
 *  external content or fake deletion evidence (#496 delta finding 8f981a57);
 *  the object store is the security boundary. Bounded by
 *  {@link HEAD_FILE_PER_FILE_CAP} and {@link HEAD_FILE_TOTAL_CAP}. A path
 *  absent from the tree yields `present: false` with `"not-found"` — citable
 *  deletion evidence (design.md Decision 3). A traversal-shaped path is
 *  `"rejected"` without ever reaching git (#496 finding cdd406db); symlinks
 *  in the tree are blobs of link text, not followed (#496 finding 702a99fc).
 */
export async function defaultReadHeadFiles(
  worktreePath: string,
  treeSha: string,
  paths: string[],
  gitFn: typeof gitInWorktree = gitInWorktree,
): Promise<HeadFileState[]> {
  const results: HeadFileState[] = [];
  let totalUsed = 0;
  for (const p of paths) {
    // Runtime string guard (#496 delta finding cdd406db round 2, refined for
    // 49da0f1a7403d6f4): surfaces originate in untrusted prior-review history
    // and types are stripped at runtime — a non-string value must render as
    // rejected, never throw. String(p) is unsafe here: a malformed value like
    // { toString: null } throws TypeError during coercion instead of
    // rejecting cleanly, so a fixed marker is used instead of coercing.
    if (typeof p !== "string") {
      results.push({ path: "<non-string surface>", content: "", truncated: false, present: false, absenceReason: "rejected" });
      continue;
    }
    const rel = path.posix.normalize(p.split(path.sep).join(path.posix.sep));
    if (rel === "" || rel === "." || rel.startsWith("..") || path.posix.isAbsolute(rel)) {
      results.push({ path: p, content: "", truncated: false, present: false, absenceReason: "rejected" });
      continue;
    }
    const shown = await gitFn(worktreePath, ["show", `${treeSha}:${rel}`], { ignoreFailure: true });
    if (shown.code !== 0) {
      const absenceReason =
        /does not exist|exists on disk, but not in|invalid object name|not a valid object name/i.test(shown.stderr)
          ? "not-found"
          : "unreadable";
      results.push({ path: p, content: "", truncated: false, present: false, absenceReason });
      continue;
    }
    let content = shown.stdout;
    let truncated = false;
    if (content.length > HEAD_FILE_PER_FILE_CAP) {
      content = content.slice(0, HEAD_FILE_PER_FILE_CAP);
      truncated = true;
    }
    const remaining = HEAD_FILE_TOTAL_CAP - totalUsed;
    if (content.length > remaining) {
      content = content.slice(0, Math.max(remaining, 0));
      truncated = true;
    }
    totalUsed += content.length;
    results.push({ path: p, content, truncated, present: true });
  }
  return results;
}

/**
 * External seams for {@link enforceReviewShaGate}, overridable in tests.
 * Mirrors the DI pattern used elsewhere (testgate.ts, review.ts).
 */
export interface ShaGateDeps {
  getIssueDetail?: typeof getIssueDetail;
  getPrDetail?: typeof getPrDetail;
  getPrCommits?: typeof getPrCommits;
  /** Fetches the full PR diff (#228 diff-hash check). */
  getPrDiff?: typeof getPrDiff;
  /**
   * Fetches the diff between two commits on the PR for the delta review (#228).
   * Injectable seam; real implementation uses `git diff baseSha...headSha`.
   * Optional `worktreePath` (#371): the source directory to diff from. Defaults
   * to `cfg.repo_dir`, which is not fetched mid-run and can lack a commit object
   * pushed earlier in this same run (e.g. the pre-merge auto-fix commit) — pass
   * the issue worktree path, which authored that commit, to guarantee it's present.
   */
  getCommitDeltaDiff?: (
    cfg: PipelineConfig,
    prNumber: number,
    baseSha: string,
    headSha: string,
    worktreePath?: string,
  ) => Promise<string>;
  /** Runs the pre-merge delta review (#228) and returns the parsed verdict. */
  runDeltaReview?: RunDeltaReviewFn;
  /** Reads settled findings' surface files at the reviewed head from the
   *  delta worktree (#496). Default: {@link defaultReadHeadFiles}. */
  readHeadFiles?: ReadHeadFilesFn;
  postComment?: typeof postComment;
  transition?: typeof transition;
  setBlocked?: typeof setBlocked;
  /** Clears the blocked label when a post-write HEAD verify finds the blocking
   *  verdict was superseded while the block was being persisted (#481 delta
   *  finding 6eadb958 — self-heal instead of stranding a stale block). */
  clearBlocked?: typeof clearBlocked;
  /** Looks up the issue worktree path and slug for the delta reviewer's CWD and OpenSpec context (#228). */
  getForIssue?: typeof getForIssue;
  /** Returns the authenticated GitHub username so the SHA gate only trusts
   *  pipeline-authored review comments (#228 Finding 9). */
  getGhActor?: () => Promise<string | null>;
  runDir?: string;
  runStoreDeps?: RunStoreDeps;
  /**
   * Injectable seam for the bounded pre-merge auto-fix round (#359, #747).
   * When provided, called when (a) category partition yields a non-empty
   * allowlisted subset (`partitionBlockingForAutofix`) and (b) no prior
   * auto-fix commit / durable attempt marker is present since the reviewed
   * SHA. Residual non-allowlisted findings do not veto the call; the seam
   * receives only the allowlisted subset. Production default: wired in
   * `advance()` as a closure over the implementer harness and worktree.
   * Tests inject this directly to exercise the blocking-branch routing without
   * a real harness, git, or network.
   */
  attemptPreMergeAutoFix?: AttemptPreMergeAutoFixFn;
  /**
   * Authoritative remote-ref read for the post-fix head revalidation (#371
   * pre-merge delta review, key 8ad8b7f0). Returns the SHA `refs/heads/<branch>`
   * currently points at on origin, or null when the ref cannot be read. Used
   * only when the GitHub-API PR-head read still echoes the known pre-fix head
   * after an approving post-fix re-review — that read is indistinguishable
   * from a stale read masking a genuinely newer concurrent push, so the guard
   * must consult `git ls-remote` (which reads the live ref, not a cached API
   * view) before proceeding. Production default: `defaultGetRemoteHead`.
   */
  getRemoteHead?: (cwd: string, branch: string) => Promise<string | null>;
  /** Files the single tracked follow-up issue at the pre-merge delta-round
   *  ceiling under `ceiling_action: demote_and_advance` (#483). Mirrors the
   *  review-2 ceiling's seam. */
  createIssue?: (title: string, body: string, labels: string[]) => Promise<number>;
  /** Appends to an existing delta-round-ceiling follow-up issue on re-entry (#483). */
  addIssueComment?: (issueNumber: number, body: string) => Promise<void>;
}

/** `git ls-remote origin refs/heads/<branch>` from `cwd`; null on any failure. */
async function defaultGetRemoteHead(cwd: string, branch: string): Promise<string | null> {
  const res = await gitInWorktree(
    cwd, ["ls-remote", "origin", `refs/heads/${branch}`], { ignoreFailure: true },
  );
  if (res.code !== 0) return null;
  const sha = res.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Before pre-merge acts on the prior review verdict, verify the most recent
 * review comment still covers HEAD. Returns `null` to proceed (verdict fresh,
 * or nothing to validate), or an `advanced` Outcome that bounces the item back
 * to its review round when the verdict is stale (HEAD moved past the reviewed
 * commit) or unverifiable (no SHA sentinel). The orchestrator loop then re-runs
 * that review stage, which records the new SHA.
 */
export async function enforceReviewShaGate(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  deps: ShaGateDeps = {},
): Promise<Outcome | null> {
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getPrCommitsFn = deps.getPrCommits ?? getPrCommits;
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const getCommitDeltaDiffFn = deps.getCommitDeltaDiff ?? defaultGetCommitDeltaDiff;
  const runDeltaReviewFn = deps.runDeltaReview ?? defaultRunDeltaReview;
  const readHeadFilesFn = deps.readHeadFiles ?? defaultReadHeadFiles;
  const getRemoteHeadFn = deps.getRemoteHead ?? defaultGetRemoteHead;
  const createIssueFn = deps.createIssue ?? ((title: string, body: string, labels: string[]) => createIssue(cfg, title, body, labels));
  const addIssueCommentFn = deps.addIssueComment ?? ((issueNum: number, body: string) => addIssueComment(cfg, issueNum, body));
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const clearBlockedFn = deps.clearBlocked ?? clearBlocked;
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const getGhActorFn = deps.getGhActor ?? getGhActor;

  const detail = await getIssueDetailFn(cfg, issueNumber);

  // Only trust review comments authored by the authenticated pipeline actor (#228
  // Findings 8 & 9). Any commenter can post a forged `## Review 2 — approve` body;
  // filtering to the gh user makes forged verdicts invisible to all reuse checks.
  // Fail-closed (#228 Finding 8): if the actor cannot be determined (network error,
  // expired token), block rather than silently proceeding — a transient auth failure
  // must not disable stale-verdict or unresolved-blocker enforcement.
  const actor = await getGhActorFn();
  if (actor === null) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Pre-merge: cannot verify review-comment provenance — authenticated gh actor ` +
        `unavailable (\`getGhActor\` returned null). This is typically an expired gh ` +
        `token or a transient network error. Restore gh authentication (\`gh auth ` +
        `status\`) and re-run the pipeline to resume.`,
      "pre-merge",
      "needs-human",
    );
    return preMergeBlocked(
      "pre-merge: actor lookup failed — cannot verify review provenance",
      "needs-human",
    );
  }
  // SHA extraction uses actor-only trust: allowlisted actors must NOT be trusted
  // for review verdict comments as any allowlisted identity could otherwise post a
  // forged approval header and bypass the SHA gate (#229 Finding 8).
  const trustedComments = detail.comments.filter((c) => c.author === actor);
  // Override/scope extraction uses the broader allowlist set (#229 Findings 4, 5, 6).
  const trustedOverrideComments = buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors);

  const reviewed = extractReviewedSha(trustedComments);
  // No prior review from the current actor found. Three sub-cases:
  // (a) No review comments at all (review disabled, first run) → proceed normally.
  // (b) Review comments from arbitrary commenters (e.g. forged headers) → proceed; do
  //     not trigger re-review on arbitrary non-actor comments (DoS risk: any commenter
  //     could post a review-headed comment to cause endless re-reviews).
  // (c) Review comments from an explicitly trusted prior runner (in trusted_override_actors)
  //     — DO NOT silently proceed, that skips blocker enforcement (#229 Finding 7).
  //     Route to re-review so the current actor establishes its own verified baseline.
  if (!reviewed) {
    const allowlist = cfg.trusted_override_actors ?? [];
    if (allowlist.length > 0) {
      const hasAllowlistedReview = detail.comments.some(
        (c) =>
          c.author != null &&
          c.author !== actor &&
          allowlist.includes(c.author) &&
          (c.body.startsWith("## Review 1") ||
            c.body.startsWith("## Review 2") ||
            c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX)),
      );
      if (hasAllowlistedReview) {
        // Select the highest-enabled review stage to re-run. If all review steps are
        // disabled, do not route to a review stage that will be immediately skipped back
        // to pre-merge (livelock — #229 Finding 9). In that case just proceed.
        const reviewStage: Stage | null = cfg.steps.adversarial_review
          ? "review-2"
          : cfg.steps.standard_review
            ? "review-1"
            : null;
        if (reviewStage === null) {
          // Reviews are fully disabled — cannot re-run review. If the prior allowlisted
          // runner's comment carried unresolved blocking keys, block rather than silently
          // skip blocker enforcement (#229 Finding 10). Only proceed when the prior review
          // was approve/advisory-only or all keys are explicitly overridden.
          const priorReviewComment = detail.comments
            .filter(
              (c) =>
                c.author != null &&
                c.author !== actor &&
                allowlist.includes(c.author as string) &&
                (c.body.startsWith("## Review 1") ||
                  c.body.startsWith("## Review 2") ||
                  c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX)),
            )
            .at(-1);
          if (priorReviewComment) {
            // Primary: prefer artifact for blocking-keys read (#264); fall back to legacy
            // extractor (scrapes override-key tokens) for comments without an artifact.
            // An explicit empty marker / empty artifact.blockingKeys is "no blockers".
            const _priorArtifact = extractReviewArtifact(priorReviewComment.body);
            const recorded = _priorArtifact !== null
              ? new Set(_priorArtifact.blockingKeys)
              : extractBlockingKeysFromComment(priorReviewComment.body);
            if (recorded.size > 0) {
              const overrides = extractOverrides(trustedOverrideComments);
              const unresolved = [...recorded].filter((k) => !overrides.has(k));
              if (unresolved.length > 0) {
                await setBlockedFn(
                  cfg,
                  issueNumber,
                  `Pre-merge: prior runner recorded ${unresolved.length} unresolved blocking ` +
                    `finding(s) (${unresolved.join(", ")}). Reviews are disabled, so ` +
                    `\`--override\` each key before pre-merge can proceed.`,
                  "pre-merge",
                  "needs-human",
                );
                return preMergeBlocked(
                  `pre-merge: ${unresolved.length} unresolved blocking finding(s) from prior allowlisted runner (reviews disabled)`,
                  "needs-human",
                  "delta-review",
                );
              }
            }
          }
          // Prior review was approve/advisory-only or all keys overridden — fall through.
        } else {
          await postCommentFn(cfg, issueNumber, preMergeRerunIdentityNotice(actor));
          await transitionFn(cfg, issueNumber, "pre-merge", reviewStage);
          return { advanced: true, to: reviewStage };
        }
      }
    }
    return null;
  }

  const head = (await getPrDetailFn(cfg, prNumber)).head_sha;

  // #857 candidate-integrity: scope_expansion / unverified / expected_scoped_change
  // invalidations block prior review as readiness authority for the post-mutation
  // head — even when residual SHA / internal-commit heuristics might otherwise
  // look reusable. Store authority is the runDir integrity store.
  if (deps.runDir && reviewed.sha && head && reviewed.sha !== head) {
    let integrityBlock: IntegrityInvalidationRecord | null = null;
    try {
      integrityBlock = await integrityBlocksReviewReuse(
        deps.runDir,
        head,
        reviewed.sha,
      );
    } catch (err) {
      console.warn(
        `[pipeline] #${issueNumber}: candidate-integrity invalidation check failed (non-fatal to gate, fail-closed to re-review): ${(err as Error).message}`,
      );
      // Fail closed: cannot confirm integrity → do not reuse prior review.
      integrityBlock = {
        from_sha: reviewed.sha,
        to_sha: head,
        mutation_id: "unknown",
        classification: "unverified",
        invalidated_review: true,
        invalidated_readiness: true,
        requires_fresh_review: true,
        reason: "integrity store unreadable",
        mutation_method: "rebase",
        at: new Date().toISOString(),
      };
    }
    if (integrityBlock) {
      const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
      await postCommentFn(
        cfg,
        issueNumber,
        staleReviewNotice(reviewed.sha, head) +
          `\n\n_candidate-integrity: \`${integrityBlock.classification}\` — ` +
          `${integrityBlock.reason}_`,
      );
      await transitionFn(
        cfg,
        issueNumber,
        "pre-merge",
        reviewStage,
        `Re-running review ${reviewed.round}: candidate-integrity ` +
          `${integrityBlock.classification} invalidated prior review for ` +
          `\`${head.slice(0, 7)}\` (was \`${reviewed.sha.slice(0, 7)}\`).`,
      );
      return {
        advanced: true,
        from: "pre-merge",
        to: reviewStage,
        summary: `re-review: candidate-integrity ${integrityBlock.classification}`,
      };
    }
  }

  // Shared guard for the verdict-REUSE short-circuits below (exact-SHA match,
  // pipeline-internal-only commits, diff-hash unchanged). A recorded verdict may
  // only be REUSED as an approval if it left no unresolved blocking findings.
  // A blocking pre-merge delta review (#228) records `reviewed-sha`/`verdict-diff-hash`
  // and `setBlocked`s at `pipeline:pre-merge`, so EVERY reuse path must re-check the
  // recorded `pipeline-blocking-keys` marker against current overrides — otherwise
  // clearing the blocked label (optionally plus a no-op commit that preserves the
  // diff hash, or an OpenSpec archive commit) would advance pre-merge with
  // unresolved blocking findings (a review-gate bypass — #228 review-2 findings).
  // Marker-only lookup: an approve / advisory-only verdict has no marker or an empty
  // one → "no blockers" → returns null (caller proceeds), preserving prior behavior.
  const reuseBlockedBy = async (
    commentBody: string | null,
    via: string,
  ): Promise<Outcome | null> => {
    // Primary: prefer artifact for blocking-keys read (#264); marker-only fallback
    // for pre-artifact comments. Null artifact + null marker = approve/advisory → no blockers.
    const _bodyArtifact = commentBody ? extractReviewArtifact(commentBody) : null;
    const recorded = _bodyArtifact !== null
      ? new Set(_bodyArtifact.blockingKeys)
      : (commentBody ? extractBlockingKeysMarker(commentBody) : null);
    if (!recorded || recorded.size === 0) return null;
    // Trust overrides from any authorized runner identity (#229 Findings 1, 4, 5).
    // Apply before SHA-scope so a full override still clears residual authority
    // even when keys were recorded against a prior head (#1010 + #228).
    const overrides = extractOverrides(trustedOverrideComments);
    const unresolved = [...recorded].filter((k) => !overrides.has(k));
    if (unresolved.length === 0) return null;
    // SHA-scope residual keys at gate start (#1010): keys recorded against a
    // prior reviewed SHA lack blocking authority for a different live head —
    // including pipeline-internal-only head advances. Approval reuse for
    // pipeline-internal commits still holds when there are no residual keys
    // (return null below); residual authority requires live-head re-evaluation
    // so a prior-head key set cannot strand a green tip without re-check.
    // Diff-unchanged with a prior-head key set likewise re-evaluates rather
    // than auto-block. reviewedSha lives on the artifact; legacy comments use
    // the sentinel via extractReviewedSha (comment-array API). Fall back to
    // the gate's reviewed pin when neither is present.
    const keysRecordedSha =
      _bodyArtifact?.reviewedSha ??
      (commentBody
        ? extractReviewedSha([{ body: commentBody }])?.sha ?? null
        : null) ??
      reviewed.sha;
    const keysAreCurrentForLiveHead = recordedShaIsCurrentForLiveHead(
      keysRecordedSha,
      head,
    );
    if (!keysAreCurrentForLiveHead) {
      console.log(
        `[pipeline] #${issueNumber}: withholding residual block from prior-head ` +
          `keys (recorded ${keysRecordedSha ? keysRecordedSha.slice(0, 7) : "unknown"} ≠ ` +
          `live ${head.slice(0, 7)}${via}); re-evaluate at live head`,
      );
      // Force re-evaluation at the live head — never silent-approve prior-head
      // keys, and never setBlocked solely from them (#1010).
      const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
      await postCommentFn(
        cfg,
        issueNumber,
        `**Pre-merge**: residual blocking keys were recorded against ` +
          `\`${keysRecordedSha ? keysRecordedSha.slice(0, 7) : "unknown"}\` but live head is ` +
          `\`${head.slice(0, 7)}\`. Withholding prior-head residual authority; ` +
          `re-running review ${reviewed.round} at the live head (#1010).\n` +
          `<!-- pipeline-stale-blocking-keys: ${keysRecordedSha ?? "none"} ${head} -->`,
      );
      await transitionFn(
        cfg,
        issueNumber,
        "pre-merge",
        reviewStage,
        `Re-running review ${reviewed.round}: residual blocking keys are SHA-scoped to a ` +
          `prior head; re-evaluate at live head \`${head.slice(0, 7)}\`.`,
      );
      return {
        advanced: true,
        from: "pre-merge",
        to: reviewStage,
        summary: `re-review: prior-head residual keys lack live-head authority`,
      };
    }
    // Scoped overrides may cover the remaining key-only blockers, but we can't verify
    // without the actual finding objects. Force a fresh review so partitionFindings
    // can be called with live findings and scopes (#229).
    const activeScopes = extractScopedOverrides(trustedOverrideComments);
    if (activeScopes.length > 0) {
      const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
      await postCommentFn(cfg, issueNumber, preMergeRerunScopeNotice(unresolved.length));
      await transitionFn(
        cfg,
        issueNumber,
        "pre-merge",
        reviewStage,
        `Scoped overrides active; re-running review ${reviewed.round} to apply scoped dispositions to live findings.`,
      );
      return {
        advanced: true,
        from: "pre-merge",
        to: reviewStage,
        summary: `re-review: scoped overrides may cover cached blockers`,
      };
    }

    // Factory dogfood (#768 re-entry): clearing `blocked` and re-running pre-merge
    // with the same HEAD used to park immediately via this reuse guard, even when
    // the durable residual was never auto-fixed (pure residual first-hop, or
    // allowlist expanded after the park). If the recorded verdict still has an
    // auto-fixable subset and no bound autofix attempt exists at this head,
    // attempt one implementer auto-fix before escalating to needs-human.
    const attemptAutoFixFn = deps.attemptPreMergeAutoFix;
    if (attemptAutoFixFn && commentBody) {
      const reconstructed = reconstructFindingsForResidualAutofix(commentBody);
      const { autoFixable } = partitionBlockingForAutofix(reconstructed);
      if (autoFixable.length > 0) {
        let priorAutoFix = false;
        try {
          const prCommits = await getPrCommitsFn(cfg, prNumber);
          const revIdx = reviewed.sha
            ? prCommits.findIndex((c) => c.oid === reviewed.sha)
            : -1;
          const since = revIdx !== -1 ? prCommits.slice(revIdx + 1) : prCommits;
          priorAutoFix = since.some((c) =>
            c.messageHeadline.startsWith(PRE_MERGE_AUTOFIX_PREFIX),
          );
          if (!priorAutoFix) {
            priorAutoFix = hasPreMergeAutofixBoundMarkerAtHead(
              trustedComments, head, actor,
            );
          }
        } catch {
          priorAutoFix = true; // fail closed: cannot prove no prior attempt
        }
        if (!priorAutoFix) {
          // Preflight-before-claim (#787, spec pre-merge-fix-round): the
          // durable attempt-started marker is posted by this closure, which
          // the seam invokes only after worktree lookup, rematerialization,
          // and the clean-tree preflight succeed — immediately before the
          // implementer. A preflight failure (e.g. rematerialize-failed)
          // therefore parks without consuming the one-attempt bound.
          const claimAttempt = async (): Promise<boolean> => {
            // Ledger claim first (#759); GH comment is cross-host attestation only.
            const ledgerOk = await claimPreMergeAutofixOnLedger({
              runDir: deps.runDir,
              headSha: head,
              issueNumber,
            });
            if (!ledgerOk && deps.runDir) {
              console.warn(
                `[pipeline] #${issueNumber}: residual re-entry autofix ledger claim failed or already charged; escalating`,
              );
              return false;
            }
            try {
              await postCommentFn(
                cfg,
                issueNumber,
                preMergeAutofixAttemptComment({ issueNumber, headSha: head }),
              );
              return true;
            } catch (err) {
              console.warn(
                `[pipeline] #${issueNumber}: residual re-entry autofix marker post failed: ` +
                  `${(err as Error).message ?? String(err)}; escalating`,
              );
              return false;
            }
          };
          {
            const fixRes = await attemptAutoFixFn(
              autoFixable,
              detail.title ?? `issue #${issueNumber}`,
              commentBody,
              claimAttempt,
            );
            if (fixRes.status === "fix-committed" || fixRes.status === "noop-clean") {
              // HEAD may have moved (or re-verify is required). Bounce pre-merge
              // so the SHA gate / delta path re-runs against the post-fix state.
              console.log(
                `[pipeline] #${issueNumber}: residual re-entry auto-fix ${fixRes.status} ` +
                  `at ${fixRes.headSha.slice(0, 7)}; re-entering pre-merge`,
              );
              await recordPreMergeGateResult(
                { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
                "pre-merge-autofix",
                fixRes.status === "fix-committed" ? "pass" : "partial",
                `residual-reentry:${fixRes.status}`,
              );
              return {
                advanced: true,
                from: "pre-merge",
                to: "pre-merge",
                summary: `residual re-entry auto-fix ${fixRes.status}; re-enter SHA gate`,
              };
            }
            // Typed worktree/rematerialize failure (#769): park as the seam's
            // blocker kind — not product needs-human residual judgment.
            if (fixRes.status === "rematerialize-failed") {
              console.warn(
                `[pipeline] #${issueNumber}: residual re-entry auto-fix rematerialize-failed ` +
                  `(${fixRes.blockerKind}): ${fixRes.diagnostic}`,
              );
              await recordPreMergeGateResult(
                { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
                "pre-merge-autofix",
                "fail",
                `residual-reentry:rematerialize-failed:${fixRes.blockerKind}`,
              );
              const rematKind = fixRes.blockerKind;
              const rematReason = fixRes.diagnostic;
              if (rematKind === "worktree-capacity") {
                await setBlockedFn(cfg, issueNumber, rematReason, "pre-merge", "worktree-capacity");
                return preMergeBlocked(rematReason, "worktree-capacity");
              }
              if (rematKind === "worktree-creation-failed") {
                await setBlockedFn(
                  cfg, issueNumber, rematReason, "pre-merge", "worktree-creation-failed",
                );
                return preMergeBlocked(rematReason, "worktree-creation-failed");
              }
              await setBlockedFn(cfg, issueNumber, rematReason, "pre-merge", "worktree-missing");
              return preMergeBlocked(rematReason, "worktree-missing");
            }
            console.warn(
              `[pipeline] #${issueNumber}: residual re-entry auto-fix ${fixRes.status}` +
                (fixRes.status === "error" && fixRes.diagnostic
                  ? ` (${fixRes.diagnostic})`
                  : "") +
                "; escalating remaining blockers",
            );
            await recordPreMergeGateResult(
              { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
              "pre-merge-autofix",
              "fail",
              `residual-reentry:${fixRes.status}`,
            );
          }
        }
      }
    }

    const residualReason = appendDualShaEscalationDisclosure(
      `Pre-merge: the last review recorded ${unresolved.length} unresolved blocking finding(s) ` +
        `at HEAD (${unresolved.join(", ")})${via}. Fix them (push a commit) or \`--override\` each ` +
        `before pre-merge can proceed.`,
      head,
      keysRecordedSha && !recordedShaIsCurrentForLiveHead(keysRecordedSha, head)
        ? keysRecordedSha
        : null,
      true,
    );
    await setBlockedFn(
      cfg,
      issueNumber,
      residualReason,
      "pre-merge",
      "needs-human",
    );
    return preMergeBlocked(
      `pre-merge: ${unresolved.length} unresolved blocking finding(s) at reviewed HEAD${via}`,
      "needs-human",
      "delta-review",
    );
  };

  // Exact match → the verdict still covers HEAD, but only as an approval when no
  // recorded blockers remain unresolved (a blocking delta review leaves
  // reviewed-sha == HEAD; see reuseBlockedBy). `head` above was read once at
  // function entry, so a push can land between that read and the moment this
  // branch acts on it (including while `reuseBlockedBy` itself awaits
  // `setBlockedFn`) — re-resolve currency right before reusing recorded
  // blocking keys (#481 Finding 1) rather than trusting the frozen `head`.
  // `unknown` fails closed to the conservative full re-review path at the
  // bottom of this function instead of reusing the recorded verdict.
  if (reviewed.sha && reviewed.sha === head) {
    try {
      const currency = await resolveReviewedShaCurrency(cfg, prNumber, reviewed.sha, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (currency.status === "current") {
        return (
          (await reuseBlockedBy(findLatestReviewCommentBody(trustedComments, reviewed.round), "")) ??
          null
        );
      }
      if (currency.status === "unknown") {
        throw new Error(
          `cannot confirm reviewed SHA ${reviewed.sha.slice(0, 7)} is still the PR head; ` +
            `falling back to conservative re-review`,
        );
      }
      // superseded: a push landed between the initial `head` read and this
      // check — fall through to the pipeline-internal-commits / diff-hash
      // checks below rather than reusing recorded blocking keys.
    } catch (err) {
      if (err instanceof Error && err.message.includes("cannot confirm reviewed SHA")) {
        console.warn(`[pipeline] #${issueNumber}: ${err.message}`);
        const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
        await postCommentFn(cfg, issueNumber, staleReviewNotice(reviewed.sha, head));
        await transitionFn(
          cfg,
          issueNumber,
          "pre-merge",
          reviewStage,
          `Re-running review ${reviewed.round}: cannot confirm reviewed SHA ` +
            `\`${reviewed.sha.slice(0, 7)}\` is still the PR head; falling back to conservative re-review.`,
        );
        return {
          advanced: true,
          from: "pre-merge",
          to: reviewStage,
          summary: `re-review: cannot confirm reviewed SHA currency`,
        };
      }
      throw err;
    }
  }

  // HEAD moved past the reviewed commit. Re-review ONLY when a developer/fix
  // commit landed since the verdict — the pipeline's own pre-merge commits
  // (OpenSpec archive) do not change the reviewed code and must not
  // invalidate the verdict. Re-reviewing them re-ran the adversarial
  // reviewer on the pipeline's own commits every run, which (with a thorough
  // reviewer) turned each run into a non-converging cascade (#98). #16's value
  // is preserved: any non-internal commit in the range still bounces.
  if (reviewed.sha) {
    try {
      const commits = await getPrCommitsFn(cfg, prNumber);
      const reviewedIdx = commits.findIndex((c) => c.oid === reviewed.sha);
      if (reviewedIdx !== -1) {
        const landedSince = commits.slice(reviewedIdx + 1);
        if (
          landedSince.length > 0 &&
          landedSince.every((c) => isPipelineInternalCommit(c.messageHeadline))
        ) {
          // Task 5.8: Only archive commits landed since the review → verdict valid.
          // No diff-hash check needed: the pipeline-internal exemption takes precedence.
          // Reuse guard: a recorded verdict with unresolved blockers is not a valid
          // approval even across pipeline-internal commits (#228).
          return (
            (await reuseBlockedBy(
              findLatestReviewCommentBody(trustedComments, reviewed.round),
              " (verdict reused across pipeline-internal commits)",
            )) ?? null
          );
        }
      }
      // reviewed.sha absent from history (rebased/squashed) or a developer
      // commit landed → fall through to the diff-hash check (#228).
    } catch {
      // If commit classification fails, fall through to diff-hash check (conservative).
    }

    // Diff-hash check (#228): before routing back to a full review round, compare
    // the current PR diff hash to the one recorded in the prior review comment.
    // If the diff is identical, the verdict is still valid even though SHA changed.
    // On a hash mismatch, run a focused delta review of only the unreviewed commits.
    try {
      const currentDiff = await getPrDiffFn(cfg, prNumber);
      const currentHash = computeDiffHash(currentDiff);
      const priorCommentBody = findLatestReviewCommentBody(trustedComments, reviewed.round);
      // Primary: prefer artifact for diff-hash read (#264); sentinel fallback for pre-artifact.
      const _priorArtifact2 = priorCommentBody ? extractReviewArtifact(priorCommentBody) : null;
      const cachedHash = _priorArtifact2?.diffHash ?? (priorCommentBody ? extractDiffHashFromComment(priorCommentBody) : null);

      if (cachedHash !== null && cachedHash === currentHash) {
        // Diff unchanged despite SHA mismatch: verdict still covers the code. Reuse
        // guard (#228 review-2): a no-op commit moves HEAD while leaving the diff hash
        // identical, so this reuse path must also re-check recorded blockers — else
        // clearing the blocked label + a no-op commit would advance with unresolved
        // blocking findings.
        const blocked = await reuseBlockedBy(priorCommentBody, " (diff unchanged)");
        if (blocked) return blocked;
        // Diff unchanged and no unresolved blockers: verdict is still valid.
        await postCommentFn(cfg, issueNumber, diffUnchangedNotice(reviewed.sha, head));
        console.log(
          `[pipeline] #${issueNumber}: diff hash unchanged (${currentHash}); verdict reused (SHA ${reviewed.sha?.slice(0, 7)} → ${head.slice(0, 7)})`,
        );
        return null;
      }

      // Pre-merge delta-round ceiling (#483): the diff changed and the prior
      // verdict is stale, so a delta review would normally run — but bound how
      // many times that can happen per item. Computed BEFORE invoking the
      // reviewer, purely from the durable delta-review comment thread, so this
      // check never depends on run-local state.
      const deltaRoundCount = countDeltaRounds(detail.comments, {
        actor, trustedOverrideActors: cfg.trusted_override_actors,
      });
      const deltaRoundCap = cfg.review_policy.max_delta_rounds;
      if (deltaRoundCap > 0 && deltaRoundCount >= deltaRoundCap) {
        if (deps.runDir) {
          const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await appendEvent(deps.runDir, {
            schema_version: RUN_SCHEMA_VERSION, type: "delta_round_ceiling", at,
            observed: deltaRoundCount, cap: deltaRoundCap, ceiling_action: cfg.review_policy.ceiling_action,
          }, deps.runStoreDeps).catch(() => {});
        }

        // Reconstruct the outstanding blocking delta findings from the last
        // trusted delta-review comment — no reviewer invocation happens at the
        // ceiling, so there is no fresh ReviewFinding to partition. Filter out
        // any key since overridden by a trusted operator disposition.
        const lastDeltaComment = trustedComments
          .filter((c) => c.body.startsWith(DELTA_REVIEW_MARKER_PREFIX))
          .at(-1);
        const lastDeltaArtifact = lastDeltaComment ? extractReviewArtifact(lastDeltaComment.body) : null;
        const rawOutstanding: DeltaCeilingFinding[] = lastDeltaArtifact?.blockingFindings
          ? lastDeltaArtifact.blockingFindings.map((f) => ({
              key: f.key, surface: f.surface, severity: f.severity, title: f.title,
            }))
          : [...(lastDeltaComment ? (extractBlockingKeysMarker(lastDeltaComment.body) ?? new Set<string>()) : new Set<string>())]
              .map((key) => ({ key, surface: null, severity: "unknown", title: "(title unavailable)" }));
        const currentOverrides = extractOverrides(trustedOverrideComments);
        const outstanding = rawOutstanding.filter((f) => !currentOverrides.has(f.key));

        if (outstanding.length === 0) {
          // Every previously-recorded blocking key is now overridden (or the
          // last delta round left nothing blocking) — nothing to disposition;
          // proceed as if the gate passed.
          console.log(
            `[pipeline] #${issueNumber}: pre-merge delta-round ceiling reached (${deltaRoundCount}/${deltaRoundCap}) ` +
            `with no outstanding blocking findings; proceeding`,
          );
          return null;
        }

        const highOrCritical = outstanding.filter((f) => severityRank(f.severity) >= severityRank("high"));
        const belowHigh = outstanding.filter((f) => severityRank(f.severity) < severityRank("high"));
        const shouldDemote =
          cfg.review_policy.ceiling_action === "demote_and_advance" &&
          highOrCritical.length === 0 &&
          belowHigh.length > 0;

        if (!shouldDemote) {
          await postCommentFn(
            cfg, issueNumber,
            deltaRoundCeilingComment(cfg, deltaRoundCount, deltaRoundCap, cfg.review_policy.ceiling_action, outstanding),
          );
          // Round-ceiling exhaustion is engine-owned review recovery (#814 / #760):
          // unresolved findings remain blocking under review-findings; they do not
          // mint human authority by default.
          await setBlockedFn(
            cfg, issueNumber,
            `Pre-merge delta review reached the ${deltaRoundCap}-round ceiling with ${outstanding.length} ` +
              `unresolved blocking finding(s).`,
            "pre-merge", "review-findings",
          );
          return preMergeBlocked(
            `pre-merge delta-round ceiling: ${outstanding.length} unresolved blocking finding(s)`,
            "review-findings",
            "delta-review",
          );
        }

        const existingFollowup = extractCeilingFollowupNumber(detail.comments, actor);
        let followupNumber: number;
        if (existingFollowup !== null) {
          followupNumber = existingFollowup;
          await addIssueCommentFn(followupNumber, buildDeltaFollowupUpdateComment(issueNumber, deltaRoundCount, belowHigh));
        } else {
          followupNumber = await createIssueFn(
            `[Deferred] Pre-merge delta review ceiling findings from #${issueNumber}`,
            buildDeltaFollowupIssueBody(issueNumber, belowHigh),
            [],
          );
        }

        await postCommentFn(
          cfg, issueNumber,
          deltaRoundCeilingDemotionComment(cfg, deltaRoundCount, deltaRoundCap, belowHigh, followupNumber),
        );

        const ceilingTimestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        for (const f of belowHigh) {
          const disposition = `deferred-#${followupNumber}`;
          const body = overrideComment({
            key: f.key,
            disposition,
            reason: `auto-demoted at pre-merge delta-round ceiling (round ${deltaRoundCount}/${deltaRoundCap}); deferred to #${followupNumber}`,
            stage: "pre-merge",
            timestamp: ceilingTimestamp,
            footer: cfg.marker_footer,
          });
          await postCommentFn(cfg, issueNumber, body);
        }

        console.log(
          `[pipeline] #${issueNumber}: pre-merge delta-round ceiling (${deltaRoundCount}/${deltaRoundCap}); ` +
          `${belowHigh.length} below-high finding(s) demoted, advancing (follow-up #${followupNumber})`,
        );
        return null;
      }

      // Resolve worktree and spec context for the delta reviewer (Finding 3): the
      // delta reviewer must run from the issue worktree (not cfg.repo_dir) so it
      // can inspect PR-branch files, and must receive OpenSpec context for any
      // change dirs touched by the unreviewed commits. Resolved before the diff
      // call (#371) so the delta diff itself also reads from the worktree — the
      // source that authored any commit pushed earlier in this same run (e.g. a
      // pre-merge auto-fix commit); `cfg.repo_dir` is not fetched mid-run and can
      // lack that object immediately after the push.
      const deltaWt = await getForIssueFn(cfg, issueNumber);
      const deltaWorktreePath = deltaWt?.path ?? cfg.repo_dir;

      // Diff changed: run a focused adversarial delta review of only the unreviewed
      // commits instead of routing back to a full review-2 round. The delta review
      // does NOT count against the max_adversarial_rounds ceiling.
      //
      // The SHA a delta review targets can be superseded by a further fix push
      // landing while the (slow) reviewer invocation is in flight (#481). Before
      // recording anything for `targetHead`, re-validate it against the PR head:
      // on supersession, discard the verdict — no blocking authority, no
      // reviewed-sha claim on the new head — and re-run the delta review against
      // it instead, bounded by MAX_DELTA_SUPERSESSION_RETRIES so a branch under
      // continuous pushes degrades to the conservative full re-review path below
      // rather than looping.
      let targetHead = head;
      let deltaDiff = reviewed.sha
        ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, targetHead, deltaWorktreePath)
        : currentDiff; // reviewed SHA missing → review the full diff as the delta
      let deltaSpecContext = deltaWt
        ? openspecContextFromDiff(cfg, deltaWt.path, diffFilePaths(deltaDiff))
        : "";

      if (deps.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(deps.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "delta_round", at,
          round: deltaRoundCount + 1, cap: deltaRoundCap,
        }, deps.runStoreDeps).catch(() => {});
      }

      let deltaResult: DeltaReviewResult;
      let priorRoundsDigest: PriorRoundDigest;
      let settledVerification: SettledFindingVerification[] = [];
      let headFiles: HeadFileState[] = [];
      let supersessionAttempts = 0;
      for (;;) {
        // Cross-round memory digest (#389): the pre-merge delta review is one of
        // the rounds that can see prior-round history.
        priorRoundsDigest = buildPriorRoundDigest(detail.comments, {
          actor, trustedOverrideActors: cfg.trusted_override_actors,
        });
        // Resolved-finding verification context (#496) + prior-round advisory
        // surfaces for carry-forward evidence (#680): the settled findings from
        // the digest, plus HEAD content for settled and prior-advisory surfaces,
        // so the delta reviewer (and post-partition demotion) can verify a
        // claimed resolution / re-raise. Absent both histories => no read, no
        // context (design.md Decision 5 for #496; fail-closed for #680).
        settledVerification = settledFindingsVerification(priorRoundsDigest);
        const priorAdvisoriesForRead = priorAdvisoryFindings(priorRoundsDigest);
        const headFilePaths = [
          ...new Set([
            ...settledFindingsSurfaceFiles(settledVerification),
            ...priorAdvisorySurfaceFiles(priorAdvisoriesForRead),
          ]),
        ].sort();
        headFiles = headFilePaths.length > 0
          ? await readHeadFilesFn(deltaWorktreePath, targetHead, headFilePaths)
          : [];
        deltaResult = await runDeltaReviewFn(
          cfg, issueNumber, detail, deltaDiff, deltaWorktreePath, deltaSpecContext,
          deps.runDir
            ? { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps, priorRoundsDigest, settledFindingsVerification: settledVerification, headFiles }
            : { priorRoundsDigest, settledFindingsVerification: settledVerification, headFiles },
        );
        // Guard: needs-attention with zero findings indicates unparseable reviewer output
        // (#228 fix-1). Mirror advanceReview's zero-findings handling: throw to the
        // conservative catch path (full re-review) rather than treating zero findings as
        // an implicit approval.
        if (deltaResult.verdict === "needs-attention" && deltaResult.findings.length === 0) {
          throw new Error(
            `delta review returned needs-attention with zero findings (likely unparseable output); ` +
            `summary: ${deltaResult.summary || "(none)"}`,
          );
        }

        const currency = await resolveReviewedShaCurrency(cfg, prNumber, targetHead, {
          getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
        });
        if (currency.status === "current") break;
        if (currency.status === "unknown" || supersessionAttempts >= MAX_DELTA_SUPERSESSION_RETRIES) {
          throw new Error(
            currency.status === "unknown"
              ? `cannot confirm reviewed SHA ${targetHead.slice(0, 7)} is still the PR head; ` +
                `falling back to conservative re-review`
              : `delta review superseded again after ${supersessionAttempts} retry attempt(s); ` +
                `falling back to conservative re-review`,
          );
        }
        // Superseded: discard this verdict — post a superseded notice carrying no
        // blocking-key marker and no claim on the new head — then re-run the
        // delta review against it.
        await postCommentFn(cfg, issueNumber, supersededDeltaReviewNotice(targetHead, currency.headSha));
        supersessionAttempts++;
        targetHead = currency.headSha;
        deltaDiff = reviewed.sha
          ? await getCommitDeltaDiffFn(cfg, prNumber, reviewed.sha, targetHead, deltaWorktreePath)
          : await getPrDiffFn(cfg, prNumber);
        deltaSpecContext = deltaWt
          ? openspecContextFromDiff(cfg, deltaWt.path, diffFilePaths(deltaDiff))
          : "";
      }

      // Trust overrides from any authorized runner identity (#229 Findings 1, 4, 5).
      const overrides = extractOverrides(trustedOverrideComments);
      const scopes = extractScopedOverrides(trustedOverrideComments);
      const settled = settledFindings(priorRoundsDigest);
      const partition = partitionFindings(deltaResult.findings, cfg.review_policy, overrides, scopes, new Map(), null, settled);
      const reversalDemotions = new Map<string, ReversalMatch>();
      const alternativeDemotions = new Map<string, AlternativeReinstatementMatch>();
      for (const { finding, reason, reversalMatch, alternativeMatch } of partition.advisory) {
        if (reason === "reversal-unacknowledged" && reversalMatch) {
          reversalDemotions.set(findingKey(finding), reversalMatch);
          if (deps.runDir) {
            const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            await appendEvent(deps.runDir, {
              schema_version: RUN_SCHEMA_VERSION, type: "reversal_unacknowledged", at,
              finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
              settled_finding_key: reversalMatch.settledKey, settling_round: reversalMatch.settledRound,
              matched_by: reversalMatch.matchedBy,
            }, deps.runStoreDeps).catch(() => {});
          }
          continue;
        }
        if (reason === "settled-alternative-reinstated" && alternativeMatch) {
          alternativeDemotions.set(findingKey(finding), alternativeMatch);
          if (deps.runDir) {
            const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
            await appendEvent(deps.runDir, {
              schema_version: RUN_SCHEMA_VERSION, type: "settled_alternative_reinstated", at,
              finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
              settled_finding_key: alternativeMatch.settledKey, settling_round: alternativeMatch.settledRound,
              matched_alternative: alternativeMatch.matchedAlternative,
            }, deps.runStoreDeps).catch(() => {});
          }
        }
      }

      // Resolved-finding evidence rule (#496): a still-blocking finding whose
      // surface matches a settled finding's surface, and which cites no
      // evidence drawn from the supplied HEAD file state, is demoted to
      // advisory — the same routing the #389 reversal machinery uses, with a
      // distinct reason so it is not double-reported as an unacknowledged
      // reversal. A no-op when there is no settled history (design.md
      // Decision 5). Runs AFTER the reversal/alternative guards above so a
      // finding already demoted there is not reconsidered here.
      const unverifiedSurfaceDemotions = new Map<string, UnverifiedSettledSurfaceMatch>();
      const evidenceResult = applySettledSurfaceEvidenceRule(partition.blocking, settledVerification, headFiles);
      partition.blocking = evidenceResult.blocking;
      for (const { finding, match } of evidenceResult.demoted) {
        partition.advisory.push({ finding, reason: "settled-surface-unverified", unverifiedSurfaceMatch: match });
        unverifiedSurfaceDemotions.set(findingKey(finding), match);
        if (deps.runDir) {
          const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await appendEvent(deps.runDir, {
            schema_version: RUN_SCHEMA_VERSION, type: "settled_surface_unverified", at,
            finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
            settled_finding_key: match.settledKey, settling_round: match.settledRound,
          }, deps.runStoreDeps).catch(() => {});
        }
      }

      // Prior-round advisory carry-forward (#680): a still-blocking finding that
      // re-raises a prior-round advisory (same surface or stable key) without
      // citing HEAD-state evidence is demoted rather than fully re-litigated.
      // Runs AFTER settled-surface demotion so the same unverified re-assertion
      // is not double-blocked; verified regressions (body cites head) stay
      // blocking and follow the auto-fix allowlist path.
      const advisoryCarryForwardDemotions = new Map<string, AdvisoryCarryForwardMatch>();
      const priorAdvisories = priorAdvisoryFindings(priorRoundsDigest);
      const carryForwardResult = applyAdvisoryCarryForwardRule(partition.blocking, priorAdvisories, headFiles);
      partition.blocking = carryForwardResult.blocking;
      for (const { finding, match } of carryForwardResult.demoted) {
        partition.advisory.push({ finding, reason: "advisory-carry-forward", advisoryCarryForwardMatch: match });
        advisoryCarryForwardDemotions.set(findingKey(finding), match);
        if (deps.runDir) {
          const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          await appendEvent(deps.runDir, {
            schema_version: RUN_SCHEMA_VERSION, type: "advisory_carry_forward", at,
            finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
            prior_advisory_key: match.priorKey, prior_round: match.priorRound,
            matched_by: match.matchedBy,
          }, deps.runStoreDeps).catch(() => {});
        }
      }

      // Confidence-trend churn detector (#483): audit-only — labels the posted
      // comment and emits one event, never alters the blocking partition above.
      const churn = detectSuspectedChurn(partition.blocking, priorRoundsDigest);
      if (churn.suspected && deps.runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(deps.runDir, {
          schema_version: RUN_SCHEMA_VERSION, type: "delta_churn_suspected", at,
          round: deltaRoundCount + 1,
          axes: churn.axes.map((a) => ({
            surface: a.surface, prior_max_confidence: a.priorMaxConfidence, new_confidence: a.newConfidence,
          })),
        }, deps.runStoreDeps).catch(() => {});
      }

      const newHash = computeDiffHash(currentDiff);
      const deltaCommentVerdict = {
        verdict: deltaResult.verdict,
        summary: deltaResult.summary,
        findings: deltaResult.findings,
        next_steps: [] as string[],
        commitSha: targetHead,
      };
      const blockingKeysSet = new Set(partition.blocking.map((f) => findingKey(f)));

      // Apply same-harness self-review disclosure (Finding 4): when invokeReviewer
      // falls back to the implementer, the delta comment must carry the same
      // selfReviewBanner and (self-review) label used by advanceReview. Ensemble
      // identity (#645) is also disclosed when multi-agent review ran.
      const deltaEffectiveReviewer = deltaResult.effectiveReviewer ?? cfg.harnesses.reviewer;
      const deltaIsSelfReview = deltaResult.selfReview ?? false;
      const deltaEnsemble = deltaResult.ensemble;
      const deltaReviewerLabel = deltaEnsemble
        ? `ensemble(${deltaEnsemble.usable}/${deltaEnsemble.size})`
        : deltaIsSelfReview
          ? `${deltaEffectiveReviewer} (self-review)`
          : deltaEffectiveReviewer;
      const deltaCommentBody = formatDeltaReviewComment(
        cfg,
        deltaCommentVerdict,
        `pre-merge delta review by ${deltaReviewerLabel}`,
        blockingKeysSet.size > 0 ? blockingKeysSet : undefined,
        newHash,
        reversalDemotions,
        alternativeDemotions,
        churn,
        unverifiedSurfaceDemotions,
        advisoryCarryForwardDemotions,
      );
      // Place the banner AFTER the heading so isDeltaReviewComment (startsWith check)
      // still recognizes the comment on the next pre-merge re-entry (#228 Finding 5).
      const deltaBanners: string[] = [];
      if (deltaEnsemble) {
        deltaBanners.push(formatEnsembleIdentityLine(deltaEnsemble));
        if (deltaIsSelfReview) {
          const b = ensembleSelfReviewBanner(deltaEnsemble.agents);
          if (b) deltaBanners.push(b);
        }
      } else if (deltaIsSelfReview) {
        deltaBanners.push(selfReviewBanner(cfg.harnesses.reviewer, deltaEffectiveReviewer));
      }
      const deltaComment = deltaBanners.length
        ? (() => {
            const nl = deltaCommentBody.indexOf("\n");
            const block = deltaBanners.join("\n\n");
            return nl >= 0
              ? `${deltaCommentBody.slice(0, nl)}\n\n${block}${deltaCommentBody.slice(nl)}`
              : `${deltaCommentBody}\n\n${block}`;
          })()
        : deltaCommentBody;
      await postCommentFn(cfg, issueNumber, deltaComment);

      if (partition.blocking.length === 0) {
        // Re-validate HEAD (#481 Finding 2): the currency check above ran
        // BEFORE `postCommentFn` — itself a network call a fix-round push can
        // land during — so it does not cover a push landing while the comment
        // was being posted. Re-read HEAD now; if it moved past `targetHead`,
        // the approval covers a commit that is no longer HEAD. Rather than
        // proceeding on a stale approval, fall back to the conservative full
        // re-review path. We throw so the catch block handles the fallthrough.
        const postDeltaHead = (await getPrDetailFn(cfg, prNumber)).head_sha;
        if (postDeltaHead !== targetHead) {
          throw new Error(
            `PR HEAD moved from ${targetHead.slice(0, 7)} to ${postDeltaHead.slice(0, 7)} ` +
            `during delta review; delta approval is stale — re-entering SHA gate`,
          );
        }
        // Delta review approves (or findings all below policy): pre-merge proceeds.
        console.log(`[pipeline] #${issueNumber}: pre-merge delta review approved; proceeding`);
        await recordPreMergeGateResult(
          { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
          "delta-review",
          "pass",
        );
        return null;
      }

      // Delta review found blocking findings. Partition by category allowlist
      // (#359 / #747): attempt one bounded auto-fix when the allowlisted subset
      // is non-empty — residual non-allowlisted findings do not veto the attempt
      // but are excluded from the fix prompt and still need human disposition.
      // Tracks the head the verdict that will ultimately gate `setBlockedFn`
      // below was produced against — `targetHead` unless an auto-fix re-review
      // supersedes it (#481 review 2 finding 1).
      let finalBlockingHead = targetHead;
      // #553 / #698: diagnostic or still-broken recipe for the block reason.
      // When set to a full block reason (noop still-broken recipe / partition
      // disposition), used as-is; otherwise appended to the generic message.
      let autoFixDiagnostic: string | undefined;
      let autoFixBlockReason: string | undefined;
      const categoryPartition = partitionBlockingForAutofix(partition.blocking);
      // Operator-facing disposition (#747): residual labels track the final
      // blocking set used for setBlocked; autoFixable labels retain the initial
      // allowlisted subset when an attempt was recognized (original auto-fix scope).
      let dispositionResidual = categoryPartition.residual;
      let dispositionAutoFixable = categoryPartition.autoFixable;
      // True when a prior prefix commit / durable attempt|noop marker was found
      // or this invocation posted a new attempt marker — distinct from "this
      // turn invoked the harness", so exhausted priors are not reported as
      // unattempted (review finding 5f4a751f).
      let autoFixAttemptRecognized = false;
      // Observability (#682): needs-attention with blocking count for the loop mirror.
      await recordPreMergeGateResult(
        { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
        "delta-review",
        "fail",
        `blocking_count=${partition.blocking.length}`,
      );
      const attemptAutoFixFn = deps.attemptPreMergeAutoFix;
      if (attemptAutoFixFn && categoryPartition.autoFixable.length > 0) {
        // One-attempt bound (crash-safe): detect a prior auto-fix commit by
        // scanning PR commits since the reviewed SHA for the PREFIX subject,
        // OR a durable attempt-started / noop-clean marker at the current head
        // (#698, review-2: attempt-started is posted before the harness so a
        // failed post-noop completion marker cannot allow a second attempt).
        let priorAutoFix = false;
        try {
          const prCommits = await getPrCommitsFn(cfg, prNumber);
          const revIdx = reviewed.sha
            ? prCommits.findIndex((c) => c.oid === reviewed.sha)
            : -1;
          const since = revIdx !== -1 ? prCommits.slice(revIdx + 1) : prCommits;
          priorAutoFix = since.some((c) =>
            c.messageHeadline.startsWith(PRE_MERGE_AUTOFIX_PREFIX),
          );
          if (!priorAutoFix) {
            // Re-read comments so a marker posted earlier in this process (or by
            // another host) is visible; fall back to the issue detail we already have.
            let commentsForMarker = trustedComments;
            try {
              const latest = await getIssueDetailFn(cfg, issueNumber);
              commentsForMarker = latest.comments.filter((c) => c.author === actor);
            } catch {
              // Use the in-memory trusted comments from gate entry.
            }
            priorAutoFix = hasPreMergeAutofixBoundMarkerAtHead(
              commentsForMarker, targetHead, actor,
            );
          }
          // Stage-attempt ledger authority (#759): prefer ledger over comment-only.
          if (!priorAutoFix && deps.runDir) {
            const hydrated = hydrateStageAttemptLedger(deps.runDir);
            if (hydrated.ok && hasAttempted(hydrated.ledger, targetHead, "pre_merge_autofix")) {
              priorAutoFix = true;
            }
          }
        } catch {
          // Cannot determine prior attempt — fail closed (#359): skipping the
          // auto-fix is safer than risking a second attempt when the durable
          // marker cannot be read (crash-safe at-most-one requirement).
          priorAutoFix = true;
        }
        if (priorAutoFix) autoFixAttemptRecognized = true;

        if (!priorAutoFix) {
          await recordPreMergeGateResult(
            { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
            "pre-merge-autofix",
            "partial",
            "attempted",
          );
          // Scope the fix prompt to the allowlisted subset only — not residual
          // non-allowlisted findings (#747) and not advisory/non-blocking
          // findings (#359 R2 F3).
          const autoFixableKeys = new Set(
            categoryPartition.autoFixable.map((f) => findingKey(f)),
          );
          const blockingOnlyBody = formatDeltaReviewComment(
            cfg,
            { ...deltaCommentVerdict, findings: categoryPartition.autoFixable },
            `pre-merge delta review by ${deltaReviewerLabel}`,
            autoFixableKeys.size > 0 ? autoFixableKeys : undefined,
            newHash,
          );
          // Crash-safe one-attempt guard (#698 review-2 / #759): claim the
          // stage-attempt ledger first; GH attempt comment is attestation.
          // The seam invokes this only after worktree preflight succeeds.
          let attemptMarkerPosted = false;
          const claimAttempt = async (): Promise<boolean> => {
            const ledgerOk = await claimPreMergeAutofixOnLedger({
              runDir: deps.runDir,
              headSha: targetHead,
              issueNumber,
            });
            if (!ledgerOk && deps.runDir) {
              autoFixDiagnostic =
                `failed to claim pre-merge auto-fix on stage-attempt ledger at ` +
                `${targetHead.slice(0, 7)} before harness invoke`;
              console.warn(`[pipeline] #${issueNumber}: ${autoFixDiagnostic}`);
              return false;
            }
            try {
              await postCommentFn(
                cfg,
                issueNumber,
                preMergeAutofixAttemptComment({
                  issueNumber,
                  headSha: targetHead,
                }),
              );
              attemptMarkerPosted = true;
              return true;
            } catch (err) {
              autoFixDiagnostic =
                `failed to record durable pre-merge auto-fix attempt marker at ` +
                `${targetHead.slice(0, 7)} before harness invoke: ` +
                `${(err as Error).message ?? String(err)}`;
              console.warn(
                `[pipeline] #${issueNumber}: ${autoFixDiagnostic}; escalating without auto-fix`,
              );
              // Caller falls through to setBlocked without running the harness.
              // Do not set priorAutoFix — there is no durable marker; a later
              // entry may retry the attempt-started post (still no double harness).
              return false;
            }
          };
          const fixRes = await attemptAutoFixFn(
            categoryPartition.autoFixable, detail.title, blockingOnlyBody, claimAttempt,
          );
          if (attemptMarkerPosted) autoFixAttemptRecognized = true;
          // fix-committed → re-review at new head; noop-clean → re-verify at
          // unchanged head (#698). Both share the single re-review path; neither
          // counts as a second auto-fix attempt.
          if (fixRes && (fixRes.status === "fix-committed" || fixRes.status === "noop-clean")) {
            const wasNoopClean = fixRes.status === "noop-clean";
            if (wasNoopClean) {
              // Completion evidence marker (in addition to attempt-started).
              // Failure here must not allow a second harness invoke: the
              // attempt-started marker already exhausts the bound. Continue to
              // re-verify rather than treating a marker-post failure as
              // approval or as an unbound retry path.
              try {
                await postCommentFn(
                  cfg,
                  issueNumber,
                  preMergeAutofixNoopComment({
                    issueNumber,
                    headSha: fixRes.headSha,
                    diagnostic: fixRes.diagnostic,
                  }),
                );
              } catch (err) {
                console.warn(
                  `[pipeline] #${issueNumber}: failed to post noop-clean completion ` +
                    `marker at ${fixRes.headSha.slice(0, 7)} ` +
                    `(${(err as Error).message ?? String(err)}); ` +
                    `attempt-started marker already holds the one-attempt bound — continuing re-verify`,
                );
              }
              autoFixDiagnostic = fixRes.diagnostic;
              console.log(
                `[pipeline] #${issueNumber}: pre-merge auto-fix noop-clean at ` +
                  `${fixRes.headSha.slice(0, 7)}; re-verifying findings against HEAD`,
              );
            }
            // Re-run the delta review exactly once (does NOT consume a review-2
            // ceiling slot, consistent with the delta-review budget rule, #359).
            // Anchor to the auto-fix's authoritative head from local git state
            // (#371 / #698) — for fix-committed this is the post-fix SHA; for
            // noop-clean it is the unchanged pre-fix head. NOT a GitHub-API
            // PR-head read, which can lag after a push.
            const newPrHead = fixRes.headSha;
            // Do NOT fall back to the pre-fix `currentDiff` if the post-fix diff
            // cannot be obtained (#359 R2 F1), including when `reviewed.sha` itself
            // is missing (#371 review 1 finding 1): a fallback would let the
            // reviewer approve a stale diff while recording `newPrHead` as
            // reviewed. Let the exception propagate to the outer catch, which
            // routes to the conservative full re-review without recording the new
            // head. Diff from `deltaWorktreePath` (#371) — the worktree that
            // authored the auto-fix commit — since `cfg.repo_dir` is not fetched
            // mid-run and may not yet contain that commit object.
            if (!reviewed.sha) {
              throw new Error(
                "no reviewed-sha recorded to diff the auto-fix commit " +
                  `${newPrHead.slice(0, 7)} against; cannot anchor post-fix re-review`,
              );
            }
            const reReviewDiff = await getCommitDeltaDiffFn(
              cfg, prNumber, reviewed.sha, newPrHead, deltaWorktreePath,
            );
            // Rebuild the digest from freshly fetched issue comments (review finding
            // #389 R1 F3): the just-posted delta-review comment (line ~1406 above)
            // is prior-round history for this re-review, and the digest captured
            // before that comment existed cannot demote a reversal against it.
            const reReviewIssueDetail = await getIssueDetailFn(cfg, issueNumber);
            const reReviewDigest = buildPriorRoundDigest(reReviewIssueDetail.comments, {
              actor, trustedOverrideActors: cfg.trusted_override_actors,
            });
            const reSettled = settledFindings(reReviewDigest);
            const reSettledVerification = settledFindingsVerification(reReviewDigest);
            const rePriorAdvisories = priorAdvisoryFindings(reReviewDigest);
            const reHeadFilePaths = [
              ...new Set([
                ...settledFindingsSurfaceFiles(reSettledVerification),
                ...priorAdvisorySurfaceFiles(rePriorAdvisories),
              ]),
            ].sort();
            const reHeadFiles = reHeadFilePaths.length > 0
              ? await readHeadFilesFn(deltaWorktreePath, newPrHead, reHeadFilePaths)
              : [];
            const reResult = await runDeltaReviewFn(
              cfg, issueNumber, detail, reReviewDiff, deltaWorktreePath, deltaSpecContext,
              deps.runDir
                ? { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps, priorRoundsDigest: reReviewDigest, settledFindingsVerification: reSettledVerification, headFiles: reHeadFiles }
                : { priorRoundsDigest: reReviewDigest, settledFindingsVerification: reSettledVerification, headFiles: reHeadFiles },
            );
            const rePartition = partitionFindings(
              reResult.findings, cfg.review_policy, overrides, scopes, new Map(), null, reSettled,
            );
            // Resolved-finding evidence rule (#496), mirroring the primary
            // delta-review application above.
            const reUnverifiedSurfaceDemotions = new Map<string, UnverifiedSettledSurfaceMatch>();
            const reEvidenceResult = applySettledSurfaceEvidenceRule(rePartition.blocking, reSettledVerification, reHeadFiles);
            rePartition.blocking = reEvidenceResult.blocking;
            for (const { finding, match } of reEvidenceResult.demoted) {
              rePartition.advisory.push({ finding, reason: "settled-surface-unverified", unverifiedSurfaceMatch: match });
              reUnverifiedSurfaceDemotions.set(findingKey(finding), match);
              if (deps.runDir) {
                const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                await appendEvent(deps.runDir, {
                  schema_version: RUN_SCHEMA_VERSION, type: "settled_surface_unverified", at,
                  finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
                  settled_finding_key: match.settledKey, settling_round: match.settledRound,
                }, deps.runStoreDeps).catch(() => {});
              }
            }
            // Prior-round advisory carry-forward (#680), mirroring the primary path.
            const reAdvisoryCarryForwardDemotions = new Map<string, AdvisoryCarryForwardMatch>();
            const reCarryForwardResult = applyAdvisoryCarryForwardRule(
              rePartition.blocking, rePriorAdvisories, reHeadFiles,
            );
            rePartition.blocking = reCarryForwardResult.blocking;
            for (const { finding, match } of reCarryForwardResult.demoted) {
              rePartition.advisory.push({ finding, reason: "advisory-carry-forward", advisoryCarryForwardMatch: match });
              reAdvisoryCarryForwardDemotions.set(findingKey(finding), match);
              if (deps.runDir) {
                const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                await appendEvent(deps.runDir, {
                  schema_version: RUN_SCHEMA_VERSION, type: "advisory_carry_forward", at,
                  finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
                  prior_advisory_key: match.priorKey, prior_round: match.priorRound,
                  matched_by: match.matchedBy,
                }, deps.runStoreDeps).catch(() => {});
              }
            }

// Post-noop re-verify: demote pure classification/control-flow claims
            // when HEAD already implements the recommended behavior and the
            // finding cites no contradictory current-file or executable evidence
            // (#698 / dogfood #683). Settled-surface demotion alone does not
            // cover first-time delta findings with empty settled history.
            if (wasNoopClean && rePartition.blocking.length > 0) {
              const classifFiles = [
                ...new Set(
                  rePartition.blocking
                    .map((f) => f.file)
                    .filter((p): p is string => typeof p === "string" && p.length > 0),
                ),
              ];
              const alreadyRead = new Map(
                reHeadFiles.map((h) => [normalizeFile(h.path), h] as const),
              );
              const missing = classifFiles.filter((p) => !alreadyRead.has(normalizeFile(p)));
              let headForClassif = reHeadFiles;
              if (missing.length > 0) {
                const extra = await readHeadFilesFn(deltaWorktreePath, newPrHead, missing);
                headForClassif = [...reHeadFiles, ...extra];
              }
              const classResult = applyNoopHeadClassificationEvidenceRule(
                rePartition.blocking,
                headForClassif,
              );
              rePartition.blocking = classResult.blocking;
              for (const { finding, reason } of classResult.demoted) {
                rePartition.advisory.push({ finding, reason });
              }
              if (classResult.demoted.length > 0) {
                console.log(
                  `[pipeline] #${issueNumber}: noop re-verify demoted ` +
                    `${classResult.demoted.length} classification finding(s) — ` +
                    `HEAD already implements recommended behavior (${HEAD_ALREADY_IMPLEMENTS_RECOMMENDATION})`,
                );
              }
            }
            // Mirror the initial delta review guard (#228): needs-attention with zero
            // findings is likely unparseable reviewer output — block conservatively.
            // Detect BEFORE formatting/posting the comment so we do not write a
            // clean reviewed-sha artifact for unparseable output (#359 R2 F2).
            const reIsUnparseable =
              reResult.verdict === "needs-attention" && reResult.findings.length === 0;
            // Post the re-review delta comment with updated sentinels.
            // Use the post-fix diff hash (reReviewDiff), not the pre-fix currentDiff (#359 R2 F1).
            // Suppress commitSha for unparseable output so the reuse path cannot
            // treat the artifact as a clean approval (#359 R2 F2).
            const reNewHash = computeDiffHash(reReviewDiff);
            const reBlockingKeys = new Set(rePartition.blocking.map((f) => findingKey(f)));
            const reEffective = reResult.effectiveReviewer ?? cfg.harnesses.reviewer;
            const reSelfReview = reResult.selfReview ?? false;
            const reLabel = reSelfReview ? `${reEffective} (self-review)` : reEffective;
            const reReversalDemotions = new Map<string, ReversalMatch>();
            for (const { finding, reason, reversalMatch } of rePartition.advisory) {
              if (reason !== "reversal-unacknowledged" || !reversalMatch) continue;
              reReversalDemotions.set(findingKey(finding), reversalMatch);
              if (deps.runDir) {
                const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
                await appendEvent(deps.runDir, {
                  schema_version: RUN_SCHEMA_VERSION, type: "reversal_unacknowledged", at,
                  finding_key: findingKey(finding), surface: surfaceKey(finding) ?? "",
                  settled_finding_key: reversalMatch.settledKey, settling_round: reversalMatch.settledRound,
                  matched_by: reversalMatch.matchedBy,
                }, deps.runStoreDeps).catch(() => {});
              }
            }
            const reCommentBody = formatDeltaReviewComment(
              cfg,
              {
                verdict: reResult.verdict,
                summary: reResult.summary,
                findings: reResult.findings,
                next_steps: [],
                commitSha: reIsUnparseable ? undefined : newPrHead,
              },
              `pre-merge delta review by ${reLabel}`,
              reBlockingKeys.size > 0 ? reBlockingKeys : undefined,
              reNewHash,
              reReversalDemotions,
              undefined,
              undefined,
              reUnverifiedSurfaceDemotions,
              reAdvisoryCarryForwardDemotions,
            );
            const reComment = reSelfReview
              ? (() => {
                  const nl = reCommentBody.indexOf("\n");
                  return nl >= 0
                    ? `${reCommentBody.slice(0, nl)}\n\n${selfReviewBanner(cfg.harnesses.reviewer, reEffective)}${reCommentBody.slice(nl)}`
                    : `${reCommentBody}\n\n${selfReviewBanner(cfg.harnesses.reviewer, reEffective)}`;
                })()
              : reCommentBody;

            // A blocking post-auto-fix re-review verdict is subject to the same
            // supersession re-validation as the initial delta review (#481): the
            // approve branch below already re-confirms the head via its own
            // ls-remote disambiguation, but a blocking outcome previously went
            // straight to `setBlockedFn` on `newPrHead` with no currency check at
            // all. Bound to a single conservative fallback (no further retry
            // loop here) rather than blocking on a verdict the head has already
            // moved past.
            if (rePartition.blocking.length > 0 || reIsUnparseable) {
              const reCurrency = await resolveReviewedShaCurrency(cfg, prNumber, newPrHead, {
                getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
              });
              if (reCurrency.status === "superseded") {
                await postCommentFn(
                  cfg, issueNumber,
                  supersededDeltaReviewNotice(newPrHead, reCurrency.headSha),
                );
                throw new Error(
                  `post-auto-fix re-review superseded: PR head moved from ${newPrHead.slice(0, 7)} ` +
                  `to ${reCurrency.headSha.slice(0, 7)}; falling back to conservative re-review`,
                );
              }
              if (reCurrency.status === "unknown") {
                throw new Error(
                  `cannot confirm post-auto-fix reviewed SHA ${newPrHead.slice(0, 7)} is still ` +
                  `the PR head; falling back to conservative re-review`,
                );
              }
              // Re-review's verdict (still blocking) now supersedes the initial
              // delta verdict as the one that will gate `setBlockedFn` below.
              finalBlockingHead = newPrHead;
            }
            await postCommentFn(cfg, issueNumber, reComment);

            // #698 / #758: for noop-clean, terminal proceed vs escalate is
            // decided via the shared noop-advance contract (findings-clear).
            // Fix-committed re-approve keeps the existing direct path.
            const noopDisposition = wasNoopClean
              ? await evaluatePreMergeNoopCleanDisposition({
                  headSha: newPrHead,
                  reverifyBlockingCount: rePartition.blocking.length,
                  reverifyUnparseable: reIsUnparseable,
                  issueNumber,
                })
              : null;

            if (
              (wasNoopClean && noopDisposition?.decision === "advance") ||
              (!wasNoopClean && rePartition.blocking.length === 0 && !reIsUnparseable)
            ) {
              // Re-validate HEAD, but do not let a single stale GitHub-API
              // PR-head read veto an approving post-fix re-review (#371 review
              // 2). `newPrHead` is the authoritative head we already confirmed
              // (post-fix after push, or unchanged head on noop-clean); the
              // GitHub API's PR-head field can still echo the pre-fix `head`,
              // or even echo `newPrHead` itself, for a short window after a
              // *further* concurrent push lands. Neither a read matching the
              // pre-fix `head` nor one matching `newPrHead` is proof of mere
              // staleness (#371 delta review, keys 8ad8b7f0 and 9943b2af): both
              // can mask a concurrent push that landed during the re-review.
              // Disambiguate via the live remote ref (`git ls-remote`) whenever
              // the API read is consistent with either of those two known SHAs,
              // and fail closed to the SHA gate when it does not confirm the
              // re-review head. A read reporting some THIRD, different SHA is an
              // unambiguous signal of a newer concurrent push on its own.
              const postFixPr = await getPrDetailFn(cfg, prNumber);
              const postFixHead = postFixPr.head_sha;
              if (postFixHead !== newPrHead && postFixHead !== targetHead) {
                throw new Error(
                  `PR HEAD moved from ${newPrHead.slice(0, 7)} to ${postFixHead.slice(0, 7)} ` +
                  `during pre-merge auto-fix re-review; re-entering SHA gate`,
                );
              }
              const remoteHead = await getRemoteHeadFn(
                deltaWorktreePath, postFixPr.head_ref,
              );
              if (remoteHead !== newPrHead) {
                throw new Error(
                  `GitHub API reports head ${postFixHead.slice(0, 7)} and ls-remote reports ` +
                  `${remoteHead ? remoteHead.slice(0, 7) : "(unreadable)"} — cannot confirm ` +
                  `auto-fix head ${newPrHead.slice(0, 7)} is the current PR head; ` +
                  `re-entering SHA gate`,
                );
              }
              console.log(
                wasNoopClean
                  ? `[pipeline] #${issueNumber}: pre-merge auto-fix noop re-verify approved ` +
                    `(already fixed / false positive); proceeding`
                  : `[pipeline] #${issueNumber}: pre-merge auto-fix re-review approved; proceeding`,
              );
              if (wasNoopClean && noopDisposition?.decision === "advance") {
                // Attested shared-contract evidence (best-effort durable comment).
                await postCommentFn(
                  cfg,
                  issueNumber,
                  formatNoopAdvanceEvidenceNote(noopDisposition.evidence),
                ).catch(() => {});
              }
              await recordPreMergeGateResult(
                { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
                "pre-merge-autofix",
                "pass",
              );
              // Mirror the initial-approval path: the post-fix re-review is the
              // approving delta-review verdict that completed the gate (#682 9b5d8c51).
              // Without this, the loop stream shows needs-attention + autofix
              // success but never the delta-review approve outcome.
              await recordPreMergeGateResult(
                { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
                "delta-review",
                "pass",
              );
              return null;
            }
            // Re-review still blocks or returned unparseable output.
            // Partition the *final* blocking set for residual-human labels so
            // operators see the findings that still block after re-delta, not
            // only the initial partition (review finding 3d396927 / #747).
            // Keep the initial allowlisted subset for "auto-fix attempted" scope.
            if (rePartition.blocking.length > 0 && !reIsUnparseable) {
              const finalCategoryPartition = partitionBlockingForAutofix(
                rePartition.blocking,
              );
              dispositionResidual = finalCategoryPartition.residual;
              // Attempt scope stays the original allowlisted subset when recognized.
              dispositionAutoFixable = categoryPartition.autoFixable;
            }
            if (wasNoopClean && rePartition.blocking.length > 0 && !reIsUnparseable) {
              // Shared contract escalated (or residual findings remain). Compose
              // the #698 no-op still-broken recipe with partition disposition
              // labels so residual human-required keys and the allowlisted
              // attempt scope remain visible (#747 review-2 / 826962b1).
              autoFixBlockReason = formatPartitionDispositionReason({
                residual: dispositionResidual,
                autoFixable: dispositionAutoFixable,
                attempted: autoFixAttemptRecognized,
                diagnostic:
                  fixRes.status === "noop-clean" ? fixRes.diagnostic : autoFixDiagnostic,
                noopStillBroken: rePartition.blocking,
              });
            }
            await recordPreMergeGateResult(
              { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
              "pre-merge-autofix",
              "fail",
              "exhausted",
            );
          } else if (fixRes?.status === "rematerialize-failed") {
            // Typed worktree/rematerialize failure from the shared production
            // autofix seam (#769): park with the seam's blocker kind before the
            // product needs-human residual disposition path.
            await recordPreMergeGateResult(
              { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
              "pre-merge-autofix",
              "fail",
              `rematerialize-failed:${fixRes.blockerKind}`,
            );
            const rematKind = fixRes.blockerKind;
            const rematReason = fixRes.diagnostic;
            if (rematKind === "worktree-capacity") {
              await setBlockedFn(cfg, issueNumber, rematReason, "pre-merge", "worktree-capacity");
              return preMergeBlocked(rematReason, "worktree-capacity");
            }
            if (rematKind === "worktree-creation-failed") {
              await setBlockedFn(
                cfg, issueNumber, rematReason, "pre-merge", "worktree-creation-failed",
              );
              return preMergeBlocked(rematReason, "worktree-creation-failed");
            }
            await setBlockedFn(cfg, issueNumber, rematReason, "pre-merge", "worktree-missing");
            return preMergeBlocked(rematReason, "worktree-missing");
          } else {
            // fixRes.status === "error", or "claim-failed" (attempt marker
            // post failed after preflight — harness not run, attempt unconsumed).
            await recordPreMergeGateResult(
              { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
              "pre-merge-autofix",
              "fail",
              "exhausted",
            );
          }
          if (fixRes?.status === "error" && fixRes.diagnostic) {
            autoFixDiagnostic = fixRes.diagnostic;
          }
        } else {
          // Prior auto-fix attempt detected: bound exhausted.
          await recordPreMergeGateResult(
            { runDir: deps.runDir, runStoreDeps: deps.runStoreDeps },
            "pre-merge-autofix",
            "fail",
            "exhausted",
          );
        }
      }

      // Re-validate HEAD one last time before granting blocking authority (#481
      // review 2 finding 1): the currency checks above only cover the window up
      // to their own `postCommentFn` call, not the time since spent posting that
      // comment, running an auto-fix attempt, or posting the re-review comment.
      // A push landing in any of those windows must not leave a stale verdict
      // blocking the issue — fail closed to the conservative full re-review.
      const finalCurrency = await resolveReviewedShaCurrency(cfg, prNumber, finalBlockingHead, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (finalCurrency.status !== "current") {
        throw new Error(
          finalCurrency.status === "superseded"
            ? `PR HEAD moved from ${finalBlockingHead.slice(0, 7)} to ` +
              `${finalCurrency.headSha.slice(0, 7)} after the blocking verdict was recorded; ` +
              `falling back to conservative re-review`
            : `cannot confirm blocking verdict head ${finalBlockingHead.slice(0, 7)} is still ` +
              `the PR head; falling back to conservative re-review`,
        );
      }

      // Empty allowlisted subset, no seam, residual human-required, or fix
      // round exhausted: block pre-merge without routing to review-2.
      // Prefer partition disposition naming when residual or a mixed batch was
      // involved (#747); pure allowlisted exhausted paths keep the simpler
      // diagnostic-appended message (or noop still-broken recipe).
      // Residual labels come from the final disposition partition (post re-delta
      // when an attempt ran); auto-fixable labels report attempt scope.
      const rawBlockReason =
        autoFixBlockReason ??
        (dispositionResidual.length > 0 ||
        (dispositionAutoFixable.length > 0 && autoFixAttemptRecognized)
          ? formatPartitionDispositionReason({
              residual: dispositionResidual,
              autoFixable: dispositionAutoFixable,
              attempted: autoFixAttemptRecognized,
              diagnostic: autoFixDiagnostic,
            })
          : autoFixDiagnostic
            ? `Pre-merge delta review found blocking findings; fix required before merging. ${autoFixDiagnostic}`
            : "Pre-merge delta review found blocking findings; fix required before merging.");
      // #1010: when residual still blocks at the live head after autofix
      // exhaustion, disclose live head (and prior reviewed SHA when distinct)
      // plus whether override is required — never auto-override.
      const blockReason = appendDualShaEscalationDisclosure(
        rawBlockReason,
        finalBlockingHead,
        reviewed.sha && !recordedShaIsCurrentForLiveHead(reviewed.sha, finalBlockingHead)
          ? reviewed.sha
          : null,
        true,
      );
      await setBlockedFn(
        cfg,
        issueNumber,
        blockReason,
        "pre-merge",
        "needs-human",
      );
      // Post-write HEAD verify (#481 delta finding 6eadb958): a check before a
      // separate write can never be airtight — a push can land between the
      // finalCurrency read above and setBlockedFn persisting the block. GitHub
      // offers no compare-and-swap, so instead of shrinking that window make
      // losing the race SELF-HEALING: if the head moved while the block was
      // being written, clear the block and fall back to the conservative full
      // re-review rather than stranding a stale block for manual recovery.
      const postWriteCurrency = await resolveReviewedShaCurrency(cfg, prNumber, finalBlockingHead, {
        getPrDetail: getPrDetailFn, getPrCommits: getPrCommitsFn,
      });
      if (postWriteCurrency.status === "superseded") {
        console.warn(
          `[pipeline] #${issueNumber}: PR HEAD moved to ` +
          `${postWriteCurrency.headSha.slice(0, 7)} while the blocking state was being ` +
          `persisted; clearing the stale block and falling back to conservative re-review`,
        );
        await clearBlockedFn(cfg, issueNumber);
        throw new Error(
          `blocking verdict head ${finalBlockingHead.slice(0, 7)} was superseded by ` +
          `${postWriteCurrency.headSha.slice(0, 7)} during block persistence; ` +
          `stale block cleared — falling back to conservative re-review`,
        );
      }
      return preMergeBlocked(
        "pre-merge delta review: blocking findings",
        "needs-human",
        "delta-review",
      );
    } catch (err) {
      // Diff fetch or delta review failed → fall through to full re-review (conservative).
      console.warn(
        `[pipeline] #${issueNumber}: diff-hash check or delta review failed (${(err as Error).message}); falling back to full re-review`,
      );
    }
  }

  // reviewed.sha is null (no sentinel) OR diff-hash/delta-review path errored:
  // treat as stale and run the full review stage again.
  const reviewStage: Stage = reviewed.round === 1 ? "review-1" : "review-2";
  await postCommentFn(cfg, issueNumber, staleReviewNotice(reviewed.sha, head));
  await transitionFn(
    cfg,
    issueNumber,
    "pre-merge",
    reviewStage,
    `Re-running review ${reviewed.round}: HEAD moved past the reviewed commit ` +
      `${reviewed.sha ? `\`${reviewed.sha.slice(0, 7)}\`` : "(unrecorded)"} → \`${head.slice(0, 7)}\`.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: reviewStage,
    summary: `re-review: HEAD moved to ${head.slice(0, 7)}`,
  };
}

/** Notice posted when review comments exist from an allowlisted prior runner identity. */
export function preMergeRerunIdentityNotice(actor: string): string {
  return attestPipelineComment(
    "pre-merge-rerun-identity",
    `## Pipeline: Re-running review — prior runner identity differs\n\n` +
      `Review comments exist from an allowlisted prior runner (not \`${actor}\`). ` +
      `Re-running review under the current identity to establish a verified baseline ` +
      `before proceeding to pre-merge.`,
  );
}

/** Notice posted when active scoped overrides may cover cached blocking findings. */
export function preMergeRerunScopeNotice(unresolvedCount: number): string {
  return attestPipelineComment(
    "pre-merge-rerun-scope",
    `## Pipeline: Re-running review — scoped override active\n\n` +
      `Active scoped override(s) may cover the ${unresolvedCount} cached blocking ` +
      `finding(s). Re-running review with live findings to apply scoped dispositions.`,
  );
}

/** Notice posted when the pre-merge diff-hash check finds the diff unchanged (#228). */
export function diffUnchangedNotice(reviewedSha: string | null, headSha: string): string {
  const from = reviewedSha ? ` from \`${reviewedSha.slice(0, 7)}\`` : "";
  return attestPipelineComment(
    "pre-merge-diff-unchanged",
    [
      "## Pipeline: Diff unchanged since last review; verdict reused",
      "",
      `HEAD has moved${from} to \`${headSha.slice(0, 7)}\`, but the PR diff hash is identical to the one the last review evaluated.`,
      "The prior review verdict is still valid; pre-merge proceeds without a re-review.",
    ].join("\n"),
  );
}

/** Default implementation of the `getCommitDeltaDiff` seam (#228). */
async function defaultGetCommitDeltaDiff(
  cfg: PipelineConfig,
  _prNumber: number,
  baseSha: string,
  headSha: string,
  worktreePath?: string,
): Promise<string> {
  const label = `${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`;
  const cwd = worktreePath ?? cfg.repo_dir;
  const result = await gitInWorktree(cwd, ["diff", `${baseSha}...${headSha}`], {
    ignoreFailure: true,
  });
  if (result.code !== 0) {
    throw new Error(
      `git diff ${label} failed (exit ${result.code}): ` +
      `${result.stderr.trim() || "no error output — objects may not be present locally"}`,
    );
  }
  if (!result.stdout.trim()) {
    throw new Error(
      `git diff ${label} produced empty output despite a diff-hash mismatch; ` +
      `refusing to delta-review an empty range`,
    );
  }
  return result.stdout;
}

/** Default implementation of the `runDeltaReview` seam (#228). */
async function defaultRunDeltaReview(
  cfg: PipelineConfig,
  issueNumber: number,
  issueDetail: { title: string; body: string },
  deltaDiff: string,
  worktreePath: string,
  specContext: string,
  accounting?: {
    runDir?: string;
    runStoreDeps?: RunStoreDeps;
    priorRoundsDigest?: PriorRoundDigest;
    settledFindingsVerification?: SettledFindingVerification[];
    headFiles?: HeadFileState[];
  },
): Promise<DeltaReviewResult> {
  let prompt = buildDeltaReviewPrompt({
    cfg,
    issueNumber,
    title: issueDetail.title,
    body: issueDetail.body,
    deltaDiff,
    specContext,
    priorRoundsDigest: accounting?.priorRoundsDigest,
    settledFindingsVerification: accounting?.settledFindingsVerification,
    headFiles: accounting?.headFiles,
  });
  // #646: same Tester acquisition helper as review-1/2 — regenerate once when
  // fail_closed would withhold on missing/stale/malformed for this runDir.
  let candidateSha = "";
  try {
    const head = await gitInWorktree(worktreePath, ["rev-parse", "HEAD"], { ignoreFailure: true });
    candidateSha = head.stdout.trim();
  } catch {
    candidateSha = "";
  }
  const shaForReview = candidateSha || "0".repeat(40);
  const runDir = accounting?.runDir;
  const testerAcq = await loadOrRegenerateTesterEvidenceForReview(
    runDir,
    shaForReview,
    cfg,
    runDir
      ? async () => {
          await runTestGate(
            { ...cfg, test_gate: { ...cfg.test_gate, max_attempts: 0 } },
            issueNumber,
            worktreePath,
            {},
            path.basename(runDir),
            "pre-merge",
            undefined,
            runDir,
            accounting?.runStoreDeps,
          );
        }
      : undefined,
  );
  prompt = appendTesterEvidenceSection(prompt, testerAcq);
  if (testerAcq.withholdInvoke) {
    throw new Error(
      testerEvidenceWithholdResult(testerAcq.reason).stderr,
    );
  }
  // Not yet guarded against the effective reviewer command — invokeReviewer
  // (via the ensemble seam) applies resolveReviewerModelForHarness itself, per
  // attempted harness, so a same-harness fallback (#39) is guarded against the
  // harness it actually targets rather than the nominal `cfg.harnesses.reviewer`
  // (#441 finding c0acb169). Ensemble (#645) inherits when enabled.
  const rawModel = cfg.harnesses.reviewerModel ?? cfg.models.review;
  const modelWasAuto = reviewerModelSourceWasAuto(cfg, undefined);
  const invocation = await invokeReviewEnsemble(cfg, {
    worktreeDir: worktreePath,
    prompt,
    implementer: cfg.harnesses.implementer,
    kind: "structured",
    timeoutSec: cfg.review_timeout,
    model: rawModel,
    modelWasAuto,
    promptDelivery: cfg.harnesses.reviewerPromptDelivery,
    invokeOpts: {
      accounting: accounting?.runDir
        ? {
            runDir: accounting.runDir,
            runStoreDeps: accounting.runStoreDeps,
            issue: issueNumber,
            stage: "pre-merge",
            modelSlot: "review",
          }
        : undefined,
    },
  });
  if (!invocation.result.success) {
    const ens = invocation.ensemble?.summary ? ` ${invocation.ensemble.summary}` : "";
    throw new Error(
      `delta review harness failed: exit ${invocation.result.exit_code}.${ens}`,
    );
  }
  const parsed = parseStructuredVerdict(invocation.result.stdout, "");
  return {
    verdict: parsed.verdict,
    findings: parsed.findings,
    summary: parsed.summary,
    effectiveReviewer: invocation.effectiveReviewer,
    selfReview: invocation.selfReview,
    ensemble: invocation.ensemble,
  };
}

/** The notice posted before a SHA-mismatch re-review. Pure; exported for tests. */
export function staleReviewNotice(reviewedSha: string | null, headSha: string): string {
  const newShort = headSha.slice(0, 7);
  const body = reviewedSha
    ? `Re-running review: HEAD has moved from \`${reviewedSha.slice(0, 7)}\` to \`${newShort}\` since the last review.`
    : `Re-running review: the last review did not record the commit it evaluated, ` +
      `so its verdict cannot be verified against current HEAD (\`${newShort}\`).`;
  return attestPipelineComment(
    "pre-merge-stale-review",
    [
      "## Pipeline: Re-running review",
      "",
      body,
      "",
      "The prior review verdict is discarded; review re-runs against the current commit before this item can advance.",
    ].join("\n"),
  );
}
