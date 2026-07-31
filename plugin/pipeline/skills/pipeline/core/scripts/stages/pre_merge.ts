// Pre-merge gate: OpenSpec archive (once) → conflict pre-check → CI gate →
// mergeability gate → ready-to-deploy.
//
// Returns { advanced: false, status: "waiting" } when CI is still running.
// The caller (pipeline.ts loop) breaks on waiting so the user can re-invoke
// later.
//
// We deliberately do NOT auto-merge. The terminal stage is just the
// `pipeline:ready-to-deploy` label.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  addIssueComment,
  closePr,
  createIssue,
  getGhActor,
  getHeadCheckRunCount,
  getSuccessfulCheckRunCount,
  getIssueDetail,
  getPrChecks,
  getPrCommits,
  getPrDetail,
  getPrDiff,
  getPrForIssue,
  listPrHeadChangeDirs,
  parseChecksAggregate,
  clearBlocked,
  postComment,
  reopenPr,
  setBlocked,
  transition,
  rerunFailedWorkflows,
  fetchCheckLogExcerpt,
  type RerunFailedWorkflowsResult,
} from "../gh.ts";
import {
  classifyCiFailure,
  type CiFailureClass,
} from "../ci-failure-classify.ts";
import { branchName, getForIssue, getOnDiskForIssue, gitInWorktree, reattachIfDetached } from "../worktree.ts";
import { PIPELINE_INTERNAL_MARKER_FILES, trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
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
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import { buildDeltaReviewPrompt, buildFixPrompt } from "../prompts/index.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import * as openspec from "../openspec.ts";
import {
  computeBranchDeveloperCommits,
  enforceSpecConsistencyGuard,
  performBoundedSpecRepair,
  type InvokeFn,
  type SpecConsistencyDeps,
  type ValidateFn,
} from "../openspec-consistency.ts";
export {
  enforceSpecConsistencyGuard,
  specDeltaIsStale,
  type FixCommit,
  type SpecConsistencyDeps,
} from "../openspec-consistency.ts";
import { invoke } from "../harness.ts";
import { reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { VISUAL_PUBLISH_COMMIT_PREFIX } from "./visual.ts";
import type { CheckRun, Outcome, PipelineConfig, ReviewFinding, Stage } from "../types.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { BlockerKind } from "../types.ts";
import type { PreMergeOfframpPathTag } from "../pre-merge-offramp.ts";
import { readEvents } from "../run-store.ts";
import type { GateResultEvent, RunStoreDeps, StageAccountingEvent } from "../run-store.ts";
import { runTestGate } from "../testgate.ts";

/**
 * Best-effort `gate_result` append for pre-merge observability (#682). Never
 * throws; never changes gate decisions. Used so the loop progress mirror can
 * map CI / delta / auto-fix outcomes without inventing event shapes.
 */
async function recordPreMergeGateResult(
  deps: { runDir?: string; runStoreDeps?: RunStoreDeps },
  gate: string,
  result: GateResultEvent["result"],
  reason?: string,
  extra?: { mode?: string },
): Promise<void> {
  if (!deps.runDir) return;
  const event: GateResultEvent = {
    schema_version: RUN_SCHEMA_VERSION,
    type: "gate_result",
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    gate,
    result,
    ...(reason !== undefined ? { reason } : {}),
    ...(extra?.mode !== undefined ? { mode: extra.mode } : {}),
  };
  await appendEvent(deps.runDir, event, deps.runStoreDeps).catch(() => {});
}

const OPENSPEC_ARCHIVE_PREFIX = "chore: archive OpenSpec change(s) for #";

/**
 * Exact publish-commit subject pattern (#463): the full prescribed subject,
 * `VISUAL_PUBLISH_COMMIT_PREFIX` followed by an issue number and nothing
 * else. Matched in full (not as a prefix) so a developer's own code-changing
 * commit merely starting with the same words — e.g. `chore: publish
 * visual-gate evidence for #463 and tweak layout` — does NOT match and still
 * triggers the required re-review.
 */
const VISUAL_PUBLISH_COMMIT_PATTERN = new RegExp(
  `^${VISUAL_PUBLISH_COMMIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`,
);
export const REBASE_MARKER_FILE = PIPELINE_INTERNAL_MARKER_FILES[0];

/**
 * Build a pre-merge blocked Outcome with explicit kind (+ optional path tag for
 * scoreboard offramp_class mapping when kind alone is too coarse — #683).
 */
function preMergeBlocked(
  reason: string,
  kind: BlockerKind,
  pathTag?: PreMergeOfframpPathTag,
): Extract<Outcome, { status: "blocked" }> {
  return {
    advanced: false,
    status: "blocked",
    reason,
    blockerKind: kind,
    ...(pathTag !== undefined ? { offrampPathTag: pathTag } : {}),
  };
}


/**
 * Commit-subject prefix for the pre-merge bounded auto-fix round (#359).
 * Every auto-fix commit starts with this prefix so the one-attempt bound can
 * detect a prior attempt after a process restart by scanning PR commit subjects.
 * MUST NOT match `isPipelineInternalCommit` — auto-fix commits are developer
 * commits and must invalidate the review-SHA gate so the re-review runs.
 */
export const PRE_MERGE_AUTOFIX_PREFIX = "fix: pre-merge auto-fix";

/**
 * Heading + HTML-comment sentinel for a durable pre-merge auto-fix clean
 * no-op attempt (#698). There is no `PRE_MERGE_AUTOFIX_PREFIX` commit when the
 * harness leaves a clean tree, so the one-attempt bound scans trusted
 * pipeline-attested comments for this sentinel anchored to the head SHA.
 */
export const PRE_MERGE_AUTOFIX_NOOP_HEADING = "## Pipeline: Pre-merge auto-fix no-op";
/** Machine sentinel: `<!-- pipeline-pre-merge-autofix-noop: <40-hex-sha> -->`. */
export const PRE_MERGE_AUTOFIX_NOOP_RE =
  /^<!-- pipeline-pre-merge-autofix-noop: ([0-9a-fA-F]{40}) -->$/m;

/**
 * Durable attempt-started marker posted **before** the harness is invoked
 * (#698 review-2). Guarantees the one-attempt bound even when the post-noop
 * completion marker fails to persist (or the process crashes mid-harness):
 * a later pre-merge entry at the same head recognizes this sentinel and does
 * not start a second auto-fix.
 */
export const PRE_MERGE_AUTOFIX_ATTEMPT_HEADING = "## Pipeline: Pre-merge auto-fix attempt";
/** Machine sentinel: `<!-- pipeline-pre-merge-autofix-attempt: <40-hex-sha> -->`. */
export const PRE_MERGE_AUTOFIX_ATTEMPT_RE =
  /^<!-- pipeline-pre-merge-autofix-attempt: ([0-9a-fA-F]{40}) -->$/m;

/**
 * Result of a pre-merge bounded auto-fix attempt (#359 / #698).
 * "fix-committed" — harness committed a fix and pushed it to the PR head.
 *                   Caller should re-run the delta review exactly once,
 *                   evaluated against `headSha` — the authoritative post-fix
 *                   commit SHA read from local git state (#371). Callers MUST
 *                   NOT re-derive the post-fix head from a GitHub-API PR-head
 *                   read, which can still return the pre-fix head in the
 *                   window immediately after the push.
 * "noop-clean"    — harness ran, HEAD unchanged, worktree clean, nothing
 *                   salvageable (#553 disclosure in `diagnostic`). Caller
 *                   SHALL re-verify blocking findings against `headSha` (the
 *                   unchanged pre-fix head) once; MUST NOT hard-block solely
 *                   because no commit was produced (#698).
 * "error"         — harness failure with dirty/unsalvaged state, push failure,
 *                   unreadable HEAD, or pre-dirty worktree. Worktree rolled
 *                   back to pre-fix HEAD when applicable. Not eligible for the
 *                   clean-noop re-verify path.
 */
export type PreMergeAutoFixResult =
  | { status: "fix-committed"; headSha: string }
  | { status: "noop-clean"; headSha: string; diagnostic: string }
  | { status: "error"; diagnostic?: string };

/**
 * Injectable seam for the bounded pre-merge auto-fix attempt (#359, #747).
 * Parameters: the **auto-fixable** (allowlisted) ReviewFinding objects, the
 * issue title (for the fix prompt), and the delta review comment body scoped
 * to those findings. Called by `enforceReviewShaGate` only when (a) the
 * category partition yields a non-empty auto-fixable subset and (b) no prior
 * auto-fix commit / durable attempt or noop-clean marker is present.
 * Residual non-allowlisted findings are never passed into this seam.
 */
export type AttemptPreMergeAutoFixFn = (
  blockingFindings: ReviewFinding[],
  issueTitle: string,
  reviewComment: string,
) => Promise<PreMergeAutoFixResult>;

/**
 * Trusted durable audit comment recording a pre-merge auto-fix clean no-op
 * at `headSha` (#698). Survives process restart and host switch so the
 * one-attempt bound can detect the prior attempt without a fix commit.
 */
export function preMergeAutofixNoopComment(args: {
  issueNumber: number;
  headSha: string;
  diagnostic: string;
  timestamp?: string;
}): string {
  const { issueNumber, headSha, diagnostic, timestamp } = args;
  const when = timestamp ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rendered = [
    PRE_MERGE_AUTOFIX_NOOP_HEADING,
    "",
    `Pre-merge bounded auto-fix for #${issueNumber} left a clean worktree with no new commit at \`${headSha}\`.`,
    "",
    diagnostic,
    "",
    `**Recorded at**: ${when}`,
    "",
    "This is a durable one-attempt marker: a later pre-merge entry at the same head will not re-run auto-fix.",
    "The pipeline re-verifies blocking findings against this head before any needs-human escalation.",
    "",
    `<!-- pipeline-pre-merge-autofix-noop: ${headSha} -->`,
  ].join("\n");
  return attestPipelineComment("pre-merge-autofix-noop", rendered);
}

/**
 * Trusted durable attempt-started marker posted before the harness runs
 * (#698 review-2). Anchored to `headSha` so a later entry exhausts the
 * one-attempt bound even if the noop completion marker never persists.
 */
export function preMergeAutofixAttemptComment(args: {
  issueNumber: number;
  headSha: string;
  timestamp?: string;
}): string {
  const { issueNumber, headSha, timestamp } = args;
  const when = timestamp ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rendered = [
    PRE_MERGE_AUTOFIX_ATTEMPT_HEADING,
    "",
    `Pre-merge bounded auto-fix for #${issueNumber} is starting at head \`${headSha}\`.`,
    "",
    `**Recorded at**: ${when}`,
    "",
    "This is a durable one-attempt guard: once posted, a later pre-merge entry at the same head will not start another auto-fix, even if the harness or the post-noop completion marker fails to record.",
    "",
    `<!-- pipeline-pre-merge-autofix-attempt: ${headSha} -->`,
  ].join("\n");
  return attestPipelineComment("pre-merge-autofix-attempt", rendered);
}

/**
 * True when a trusted pipeline-attested comment records a pre-merge auto-fix
 * noop-clean attempt at `headSha` (#698 one-attempt bound).
 */
export function hasPreMergeAutofixNoopAtHead(
  comments: Array<{ author: string; body: string }>,
  headSha: string,
  actor: string,
): boolean {
  const want = headSha.toLowerCase();
  for (const c of comments) {
    if (c.author !== actor) continue;
    if (!isVerifiedPipelineAttestation(c.body)) continue;
    const m = PRE_MERGE_AUTOFIX_NOOP_RE.exec(c.body);
    if (m && m[1].toLowerCase() === want) return true;
  }
  return false;
}

/**
 * True when a trusted pipeline-attested comment records that a pre-merge
 * auto-fix attempt was **started** at `headSha` (#698 review-2 one-attempt
 * crash-safety). Distinct from the noop completion marker: this fires even
 * when the harness never reaches a recorded noop-clean outcome.
 */
export function hasPreMergeAutofixAttemptAtHead(
  comments: Array<{ author: string; body: string }>,
  headSha: string,
  actor: string,
): boolean {
  const want = headSha.toLowerCase();
  for (const c of comments) {
    if (c.author !== actor) continue;
    if (!isVerifiedPipelineAttestation(c.body)) continue;
    const m = PRE_MERGE_AUTOFIX_ATTEMPT_RE.exec(c.body);
    if (m && m[1].toLowerCase() === want) return true;
  }
  return false;
}

/**
 * True when either the attempt-started or noop-clean durable marker is
 * present for `headSha` — the full crash-safe one-attempt bound (#698).
 */
export function hasPreMergeAutofixBoundMarkerAtHead(
  comments: Array<{ author: string; body: string }>,
  headSha: string,
  actor: string,
): boolean {
  return (
    hasPreMergeAutofixAttemptAtHead(comments, headSha, actor) ||
    hasPreMergeAutofixNoopAtHead(comments, headSha, actor)
  );
}

/**
 * Operator-facing block reason when auto-fix ends noop-clean and re-verify
 * still reports blocking findings (#698).
 */
export function formatNoopStillBrokenReason(
  findings: ReviewFinding[],
  diagnostic?: string,
): string {
  const paths = [
    ...new Set(
      findings
        .map((f) => f.file)
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim()),
    ),
  ];
  const pathPart =
    paths.length > 0
      ? `finding still present at ${paths.map((p) => `\`${p}\``).join(", ")}`
      : "finding still present";
  const base =
    `Pre-merge delta review found blocking findings; auto-fix made no diff; ` +
    `${pathPart} — human fix required.`;
  return diagnostic ? `${base} ${diagnostic}` : base;
}

/**
 * True when a commit was authored by the pipeline itself in pre-merge (an
 * OpenSpec archive) rather than by a developer/fix step. These commits do not
 * change the code the reviewer evaluated, so they must not invalidate the
 * review verdict (#98). Matched on the exact pre-merge commit prefix — a
 * developer's own `chore:` commit with different wording does NOT match and
 * still triggers a re-review. A `docs: update documentation for #N` commit is
 * NOT pipeline-internal: the pre-merge docs harness was removed (#91, docs now
 * land inside the reviewed implementation diff), so any such commit can only
 * come from a developer. Also matches the visual-gate artifact-publish commit
 * (#463): it republishes already-reviewed evidence, does not change the code
 * the reviewer evaluated, and must not invalidate the verdict or be mistaken
 * for a visual-fix commit (distinct prefix from `visualFixCommitPattern`).
 * Exported for tests.
 */
export function isPipelineInternalCommit(messageHeadline: string): boolean {
  return (
    messageHeadline.startsWith(OPENSPEC_ARCHIVE_PREFIX) ||
    VISUAL_PUBLISH_COMMIT_PATTERN.test(messageHeadline)
  );
}

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

/**
 * Pre-merge auto-fix category allowlist (#359, expanded #680; partition #747).
 *
 * Single source of truth for `isAutoFixableFinding` /
 * `partitionBlockingForAutofix` and unit tests — keep this set aligned with
 * the living category matrix in `openspec/specs/pre-merge-fix-round/spec.md`
 * (and the active change delta while partition work is in flight).
 *
 * Allowlisted (surgical implementer fix needs no product judgment):
 *   - correctness   — mechanical code defect
 *   - missing-dep   — wiring/import/package omission
 *   - concurrency   — race / lock ownership / PID identity / ordering / probe
 *                     defects (#668 dogfood class)
 *
 * Residual / excluded from the auto-fix prompt (human disposition):
 *   - security, scope, product-judgment-required, spec-divergence, data-loss,
 *     observability, and any absent/empty/unrecognized token (fail-closed for
 *     that finding). Co-batched residual findings do **not** veto auto-fix of
 *     a non-empty allowlisted subset (#747 partition); pure residual-only
 *     batches still skip the harness.
 */
export const PRE_MERGE_AUTOFIX_CATEGORIES = [
  "correctness",
  "missing-dep",
  "concurrency",
] as const;

export type PreMergeAutofixCategory = (typeof PRE_MERGE_AUTOFIX_CATEGORIES)[number];

/** Runtime set backed by {@link PRE_MERGE_AUTOFIX_CATEGORIES}. */
export const PRE_MERGE_AUTOFIX_CATEGORY_SET: ReadonlySet<string> = new Set(
  PRE_MERGE_AUTOFIX_CATEGORIES,
);

/**
 * True iff a blocking finding's category is in the auto-fix allowlist
 * {@link PRE_MERGE_AUTOFIX_CATEGORIES} (`correctness`, `missing-dep`,
 * `concurrency`). Absent/empty/unknown category → false (fail-closed: auto-fix
 * only on positive allowlisted signal). (#359, #680)
 */
export function isAutoFixableFinding(f: ReviewFinding): boolean {
  const cat = (f.category ?? "").toLowerCase().trim();
  return PRE_MERGE_AUTOFIX_CATEGORY_SET.has(cat);
}

/**
 * Partition blocking findings into allowlisted (auto-fixable) vs residual
 * human-required subsets (#747). Eligibility for the bounded pre-merge auto-fix
 * attempt is a **non-empty** `autoFixable` subset — residual co-batch does not
 * veto. Pure residual (`autoFixable` empty) skips the harness.
 */
export function partitionBlockingForAutofix(blocking: ReviewFinding[]): {
  autoFixable: ReviewFinding[];
  residual: ReviewFinding[];
} {
  const autoFixable: ReviewFinding[] = [];
  const residual: ReviewFinding[] = [];
  for (const f of blocking) {
    if (isAutoFixableFinding(f)) autoFixable.push(f);
    else residual.push(f);
  }
  return { autoFixable, residual };
}

/**
 * True iff the blocking findings array is non-empty and every element
 * passes `isAutoFixableFinding`. Empty array → false (no findings to fix).
 * Kept for pure-all checks and tests; the attempt gate uses
 * {@link partitionBlockingForAutofix} (non-empty allowlisted subset), not
 * all-or-nothing veto. (#359, #747)
 */
export function allBlockingAutoFixable(blocking: ReviewFinding[]): boolean {
  return blocking.length > 0 && blocking.every(isAutoFixableFinding);
}

/** Compact `key (category)` label for operator-facing disposition text (#747). */
function formatFindingDispositionLabel(f: ReviewFinding): string {
  const key = findingKey(f);
  const cat = (f.category ?? "").toLowerCase().trim() || "(none)";
  return `${key} (${cat})`;
}

/**
 * Operator-facing block reason after a pre-merge delta blocking round that used
 * category partition (#747). Distinguishes residual human-required findings
 * from allowlisted findings that were (or were not) auto-fix attempted.
 *
 * When `noopStillBroken` is set (clean no-commit re-verify still blocks), the
 * lead sentence uses the #698 no-op still-broken recipe while residual /
 * allowlisted disposition labels are still appended (#747 review-2 / 826962b1).
 * Diagnostic is appended once at the end (not double-nested into the recipe).
 */
export function formatPartitionDispositionReason(args: {
  residual: ReviewFinding[];
  autoFixable: ReviewFinding[];
  /**
   * True when an auto-fix attempt is recognized for the entry: a new attempt
   * marker was posted this turn, or a prior prefix commit / durable
   * attempt|noop marker already exhausts the bound. Not only "harness invoked
   * this turn" — exhausted priors must not read as unattempted (#747).
   */
  attempted: boolean;
  diagnostic?: string;
  /**
   * Still-blocking findings after a clean no-commit re-verify. When provided,
   * lead with {@link formatNoopStillBrokenReason} (without diagnostic — see
   * `diagnostic` above) instead of the generic "fix required" lead.
   */
  noopStillBroken?: ReviewFinding[];
}): string {
  const { residual, autoFixable, attempted, diagnostic, noopStillBroken } = args;
  const residualLabels = residual.map(formatFindingDispositionLabel);
  const autoLabels = autoFixable.map(formatFindingDispositionLabel);
  const parts: string[] = [
    noopStillBroken
      ? formatNoopStillBrokenReason(noopStillBroken)
      : "Pre-merge delta review found blocking findings; fix required before merging.",
  ];
  if (residualLabels.length > 0) {
    parts.push(
      attempted
        ? `Human disposition required for residual non-allowlisted: ${residualLabels.join(", ")}.`
        : `Human disposition required for residual non-allowlisted (no auto-fix attempt): ${residualLabels.join(", ")}.`,
    );
  }
  if (autoLabels.length > 0) {
    parts.push(
      attempted
        ? `Auto-fix attempted for allowlisted: ${autoLabels.join(", ")}.`
        : `Allowlisted findings present but auto-fix not attempted (bound exhausted or marker unavailable): ${autoLabels.join(", ")}.`,
    );
  }
  const base = parts.join(" ");
  return diagnostic ? `${base} ${diagnostic}` : base;
}

/**
 * Stage label for a salvaged pre-merge auto-fix commit. The salvage commit is
 * amended to `PRE_MERGE_AUTOFIX_PREFIX` immediately afterward (see below), so
 * this label only ever surfaces if the amend itself fails and the run is
 * rolled back — kept descriptive for that diagnostic case.
 */
const PRE_MERGE_AUTOFIX_SALVAGE_LABEL = "pre-merge auto-fix";

/**
 * Perform one bounded pre-merge auto-fix attempt (#359).
 *
 * Invokes the implementer harness with the surgical-fix prompt (`buildFixPrompt`),
 * amends the resulting commit to carry the `PRE_MERGE_AUTOFIX_PREFIX` subject
 * (the durable crash-safe one-attempt marker), and pushes to the PR head.
 *
 * Pre-conditions: worktree must be clean (fail closed otherwise).
 * On dirty/unsalvaged harness failure, ambiguous partial state, or push error:
 * rolls the worktree back to the pre-fix HEAD over a clean tree and returns
 * "error". A confirmed clean no-commit (`headAfter === headBefore`, worktree
 * clean, nothing salvageable) returns **"noop-clean"** with the #553 diagnostic
 * so the caller can re-verify findings against HEAD (#698) rather than
 * hard-blocking solely because no commit was produced.
 * The surgical-fix discipline (#235) — minimal diff, destructive-operation guard,
 * pre-commit self-check — applies via `buildFixPrompt` unchanged.
 *
 * Salvage (#547): when the harness exits — whether it reported success without
 * committing, or crashed/timed out (`!result.success`) — leaving **no new
 * commit** (`headAfter === headBefore`) but genuine uncommitted work in the
 * worktree, that work is salvaged into a commit instead of discarded via
 * `git reset --hard` + `git clean -fd`. The salvaged commit is then handled
 * exactly like a harness-authored fix: amended to `PRE_MERGE_AUTOFIX_PREFIX`,
 * pushed, and re-reviewed by the pre-merge delta gate — salvage never bypasses
 * review. A commit that exists alongside *extra* leftover dirt
 * (`hasNewCommit && hasUncommitted`) stays out of scope and keeps the existing
 * fail-closed rollback.
 */
export async function performPreMergeAutoFix(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  findingsText: string,
  issueTitle: string,
  wt: { path: string; slug: string },
  gitFn: typeof gitInWorktree,
  invokeFn: InvokeFn,
  salvageFn: typeof trySalvageUncommittedWork = trySalvageUncommittedWork,
): Promise<PreMergeAutoFixResult> {
  const harness = cfg.harnesses?.implementer;
  if (!harness) return { status: "error" };

  const headBefore = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();

  // Pre-fix cleanliness check: a dirty worktree before the attempt fails closed
  // (#235). Rollback uses `git reset --hard`; running that over pre-existing dirty
  // work would irreversibly discard it.
  const preStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preStatus.code !== 0 || preStatus.stdout.trim() !== "") return { status: "error" };

  // Reattach detached HEAD before the harness commits (#359 Finding 3): commits
  // made in a detached worktree don't move the branch ref, so the later push
  // would silently leave the PR branch unchanged while returning success.
  const reattach = await reattachIfDetached(wt, issueNumber, gitFn);
  if (!reattach.ok) return { status: "error" };

  const prompt = buildFixPrompt({
    cfg,
    issueNumber,
    title: issueTitle,
    reviewFindings: findingsText,
    fixRound: 1,
    pipelineRunId,
  });

  const result = await invokeFn(harness, wt.path, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: cfg.models?.fix ?? null,
    sandbox: cfg.harness_sandbox,
  });

  // Determine whether the harness left a new commit, regardless of whether it
  // reported success or crashed/timed out (#547) — a crashed/timed-out harness
  // may still have left no commit but genuine uncommitted work worth
  // salvaging, exactly like the success-without-committing case below.
  const headAfterHarness = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const hasNewCommitHarness = Boolean(headAfterHarness && headBefore && headAfterHarness !== headBefore);
  // Confirmed-no-new-commit requires both reads to have actually succeeded and
  // matched — an unreadable/empty post-harness HEAD must NOT be treated as
  // "no new commit" (#547 review 1 finding 1), since a harness that did commit
  // could then have its commit salvaged-over. Fail closed (existing rollback)
  // when we can't prove HEAD is unchanged.
  const confirmedNoNewCommit = Boolean(headBefore && headAfterHarness && headAfterHarness === headBefore);

  // Salvage (#547): attempt only when we've confirmed the harness left no new
  // commit — whether it crashed/timed out or reported success without
  // committing. A commit that exists alongside extra leftover dirt (checked
  // below) is an ambiguous case out of scope (design decision 2) and keeps the
  // existing fail-closed rollback unchanged.
  let salvaged = false;
  let salvageFoundNothing = false;
  if (confirmedNoNewCommit) {
    const salvageResult = await salvageFn(
      wt.path, issueNumber, pipelineRunId, PRE_MERGE_AUTOFIX_SALVAGE_LABEL,
    );
    salvaged = salvageResult.salvaged;
    // "Nothing to salvage" (as opposed to an attempted-but-failed salvage,
    // signalled by `failureReason`) means the worktree was genuinely clean —
    // the #553 disclosed case below.
    salvageFoundNothing = !salvaged && !salvageResult.failureReason;
  }

  if (!salvaged) {
    // #553 / #698: the harness ran and left the inspected worktree clean with
    // no new commit — nothing for salvage to recover. Name the worktree so the
    // operator can tell this apart from a silent no-op; return **noop-clean**
    // (not a generic error) so the SHA gate re-verifies findings against HEAD
    // rather than hard-blocking solely because no commit was produced.
    const cleanNoRecoverableWork = confirmedNoNewCommit && salvageFoundNothing;
    const diagnostic = cleanNoRecoverableWork
      ? `pre-merge fix harness for #${issueNumber} ran but left worktree ${wt.path} ` +
        `clean with no new commit — no recoverable work was found there`
      : undefined;

    if (!result.success) {
      if (diagnostic) console.error(`[pipeline] ${diagnostic}`);
      if (headBefore) {
        await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
        await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
      }
      // Confirmed clean no-commit after harness failure/timeout still enters
      // the re-verify path (#698 / harness-uncommitted-salvage): the tree is
      // unambiguous and salvage found nothing. Dirty/unreadable cases remain error.
      if (diagnostic && headBefore) {
        return { status: "noop-clean", headSha: headBefore, diagnostic };
      }
      return { status: "error" };
    }

    const statusAfter = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
    // Fail closed when status exits non-zero: we cannot prove the worktree is clean (#359 R2 F4).
    const hasUncommitted = statusAfter.code !== 0 || statusAfter.stdout.trim() !== "";

    // Spec (#359 / #698): a dirty post-harness worktree (uncommitted changes remaining)
    // is a failure — roll back. A confirmed clean no-commit is **noop-clean** so the
    // caller re-verifies rather than hard-blocking. Ambiguous partial state stays error.
    if (hasUncommitted || !hasNewCommitHarness) {
      const finalDiagnostic = diagnostic && !hasUncommitted ? diagnostic : undefined;
      if (finalDiagnostic) console.error(`[pipeline] ${finalDiagnostic}`);
      if (headBefore) {
        await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
        await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
      }
      if (finalDiagnostic && headBefore) {
        return { status: "noop-clean", headSha: headBefore, diagnostic: finalDiagnostic };
      }
      return { status: "error" };
    }
  }

  // Harness committed cleanly, or its uncommitted work was salvaged into a
  // commit (#547); amend to set the canonical subject so the one-attempt
  // bound can detect this commit by subject prefix.
  const autoFixMsg = withTrailers(
    `${PRE_MERGE_AUTOFIX_PREFIX} for #${issueNumber}`,
    issueNumber,
    pipelineRunId,
  );

  const amendRes = await gitFn(
    wt.path, ["commit", "--amend", "-m", autoFixMsg], { ignoreFailure: true },
  );
  if (amendRes.code !== 0) {
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  // Capture the authoritative post-fix head from local git state (#371) — the
  // amend rewrote the commit SHA, so this is the SHA the caller's re-review must
  // evaluate. Read here (not re-derived from a GitHub-API PR-head read after the
  // push), since that API read can still lag and return the pre-fix head.
  const postFixHead = (
    await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  if (!postFixHead) {
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  // Push the fix commit to the PR head.
  const branch = branchName(issueNumber, wt.slug);
  const pushRes = await gitFn(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  if (pushRes.code !== 0) {
    // Rollback: push failed, remove the local commit so the next attempt is clean.
    await gitFn(wt.path, ["reset", "--hard", headBefore], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd"], { ignoreFailure: true });
    return { status: "error" };
  }

  return { status: "fix-committed", headSha: postFixHead };
}

/**
 * Mutable context shared across `advancePolling` iterations. `advancePolling`
 * allocates one per polling session and passes it to every `advance()` call so
 * the CI-gate grace window and the no-run recovery guard persist across polls
 * (fixing the reset-on-every-poll bug — #281 review 2).
 *
 * CI recovery markers (#679) are also persisted to `runDir/pre-merge-ci-recovery.json`
 * when a run directory is available so a process restart does not re-consume budget.
 */
export interface PreMergePollingContext {
  /** Wall-clock ms when the CI gate first observed pending checks. Set by
   *  `advance()` on first entry; never reset once set within a session. */
  ciGateEnteredAt?: number;
  /** Head SHA for which a close+reopen recovery was already attempted. Prevents
   *  repeated PR state churn when two consecutive polls both see zero check-runs. */
  noRunRecoveryAttemptedForSha?: string;
  /** PR head SHA before the OpenSpec archive commit was pushed. Used by the
   *  no-run recovery path to verify the pre-archive SHA had green CI and to
   *  compute the archive-only diff. Captured once at the start of the first
   *  poll that reaches the archive step. */
  preArchiveSha?: string;
  /**
   * True after a `gate_result` with `gate: "ci"` / `result: "partial"` was
   * written for the current CI waiting stretch (#682). Prevents per-poll
   * waiting spam on the advance event stream (and therefore on the loop
   * progress mirror).
   */
  ciWaitingGateRecorded?: boolean;
  /** Head SHA for which an automatic failed-workflow re-run was already attempted (#679). */
  ciRerunAttemptedForSha?: string;
  /** Head SHA for which archive-only failed-run close+reopen recovery was attempted (#679). */
  ciArchiveFailRecoveryAttemptedForSha?: string;
  /** Head SHA for which optional CI assertion auto-fix was attempted (#679). */
  ciAssertionFixAttemptedForSha?: string;
}

/** Durable on-disk shape for CI recovery markers (#679). */
export interface CiRecoveryMarkers {
  /**
   * PR head SHA captured before the OpenSpec archive commit. Required after
   * process restart so archive-only + prior-green recovery can still evaluate
   * `preArchiveSha..head` and surface pre-archive green evidence on escalate.
   */
  preArchiveSha?: string;
  ciRerunAttemptedForSha?: string;
  ciArchiveFailRecoveryAttemptedForSha?: string;
  ciAssertionFixAttemptedForSha?: string;
}

const CI_RECOVERY_MARKERS_FILE = "pre-merge-ci-recovery.json";

export function ciRecoveryMarkersPath(runDir: string): string {
  return path.join(runDir, CI_RECOVERY_MARKERS_FILE);
}

/** Result of attempting to persist CI recovery markers (#679 durability). */
export type SaveCiRecoveryMarkersResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Load durable CI recovery markers from the run directory (best-effort). */
export function loadCiRecoveryMarkers(runDir: string | undefined): CiRecoveryMarkers {
  if (!runDir) return {};
  try {
    const raw = fs.readFileSync(ciRecoveryMarkersPath(runDir), "utf8");
    const parsed = JSON.parse(raw) as CiRecoveryMarkers;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist CI recovery markers to the run directory.
 * Returns ok:false when runDir is missing or the write/read-back fails — callers
 * MUST NOT return `waiting` after consuming recovery budget without ok:true
 * (otherwise a restarted process can re-consume the budget; #679 / #181).
 */
export function saveCiRecoveryMarkers(
  runDir: string | undefined,
  markers: CiRecoveryMarkers,
): SaveCiRecoveryMarkersResult {
  if (!runDir) {
    return {
      ok: false,
      reason: "runDir unavailable; cannot persist CI recovery markers",
    };
  }
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const filePath = ciRecoveryMarkersPath(runDir);
    fs.writeFileSync(filePath, JSON.stringify(markers, null, 2) + "\n");
    // Read-back so a write that appears to succeed but is not durable fails closed.
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CiRecoveryMarkers;
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: "CI recovery marker read-back was not an object" };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to persist CI recovery markers: ${msg}` };
  }
}

/** Merge durable file markers into a polling context (in-memory wins only when already set). */
export function hydrateCiRecoveryMarkers(
  ctx: PreMergePollingContext,
  runDir: string | undefined,
): void {
  const disk = loadCiRecoveryMarkers(runDir);
  // Restore preArchiveSha before any capture path can overwrite it with the
  // current (post-archive) head after a process restart (#679 review 2).
  if (!ctx.preArchiveSha && disk.preArchiveSha) {
    ctx.preArchiveSha = disk.preArchiveSha;
  }
  if (!ctx.ciRerunAttemptedForSha && disk.ciRerunAttemptedForSha) {
    ctx.ciRerunAttemptedForSha = disk.ciRerunAttemptedForSha;
  }
  if (!ctx.ciArchiveFailRecoveryAttemptedForSha && disk.ciArchiveFailRecoveryAttemptedForSha) {
    ctx.ciArchiveFailRecoveryAttemptedForSha = disk.ciArchiveFailRecoveryAttemptedForSha;
  }
  if (!ctx.ciAssertionFixAttemptedForSha && disk.ciAssertionFixAttemptedForSha) {
    ctx.ciAssertionFixAttemptedForSha = disk.ciAssertionFixAttemptedForSha;
  }
}

function persistCtxCiMarkers(
  ctx: PreMergePollingContext,
  runDir: string | undefined,
): SaveCiRecoveryMarkersResult {
  return saveCiRecoveryMarkers(runDir, {
    preArchiveSha: ctx.preArchiveSha,
    ciRerunAttemptedForSha: ctx.ciRerunAttemptedForSha,
    ciArchiveFailRecoveryAttemptedForSha: ctx.ciArchiveFailRecoveryAttemptedForSha,
    ciAssertionFixAttemptedForSha: ctx.ciAssertionFixAttemptedForSha,
  });
}

export interface AdvancePreMergeOpts {
  dryRun?: boolean;
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
  /** Evidence-bundle run/state dir (#147); when set, key pre-merge operations
   *  (CI checks, OpenSpec archive push, rebase) are recorded under "pre-merge".
   *  Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#302). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events (#302). */
  runStoreDeps?: RunStoreDeps;
  /** Mutable context shared across polling iterations. When absent (single
   *  `advance()` call without a polling loop), the CI-gate grace window and the
   *  no-run recovery guard are skipped (pre-existing behaviour). */
  pollingCtx?: PreMergePollingContext;
}

/**
 * External seams for {@link advance}, overridable in tests so the gate
 * sequence (SHA gate → archive → conflict pre-check → CI → mergeability →
 * advance) can be exercised without GitHub or a worktree. Extends
 * {@link ShaGateDeps} so one bag also feeds the review-SHA gate. Mirrors the
 * DI pattern used elsewhere (review.ts, testgate.ts).
 */
export interface AdvancePreMergeDeps extends ShaGateDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrChecks?: typeof getPrChecks;
  getForIssue?: typeof getForIssue;
  setBlocked?: typeof setBlocked;
  tryRebaseAndPush?: typeof tryRebaseAndPush;
  rebaseAlreadyAttempted?: typeof rebaseAlreadyAttempted;
  markRebaseAttempted?: typeof markRebaseAttempted;
  // Seams for the OpenSpec archive step + its consistency guard (#106), so
  // maybeArchiveOpenspec is testable without a real worktree, git, openspec
  // CLI, or GitHub.
  gitInWorktree?: typeof gitInWorktree;
  openspecIsActive?: typeof openspec.isActive;
  changeDirExists?: typeof openspec.changeDirExists;
  /** Tip-tree listing of active change dirs (`openspec/changes/<id>/`, excl. archive). */
  listChangeDirs?: typeof openspec.listChangeDirs;
  /**
   * Tip-tree listing of active OpenSpec change ids on the reviewed PR head when
   * no on-disk worktree is available (#714 review 2). Production default uses the
   * GitHub Contents API at the PR head SHA. Must not use cumulative PR path
   * subtraction (archive-then-reintroduce masking).
   */
  listPrHeadChangeDirs?: typeof listPrHeadChangeDirs;
  openspecArchive?: typeof openspec.archive;
  /** Per-commit paths for all non-pipeline-internal branch commits (guard input). */
  branchDeveloperCommits?: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
  /**
   * Injectable bounded spec-delta repair attempt (#356). When provided, the
   * spec-divergence consistency guard calls this for a `spec-behind-code`
   * direction instead of blocking immediately. Production default: uses the
   * implementer harness to update only the active change's spec files.
   * Tests inject a mock to verify the dep is wired without a real harness.
   */
  attemptBoundedRepair?: SpecConsistencyDeps["attemptBoundedRepair"];
  /**
   * Injectable harness invoker for the internal bounded-repair closure (#356).
   * Defaults to `invoke` from harness.ts. Tests inject this to exercise the
   * production-path repair closure (when `attemptBoundedRepair` is not provided
   * and `cfg.harnesses.implementer` is set) without spawning a real harness.
   */
  invokeFn?: InvokeFn;
  /**
   * Injectable OpenSpec change validator for the internal bounded-repair closure
   * (#356). Defaults to `openspec.validateItem`. Tests inject this alongside
   * `invokeFn` to exercise the production-path repair closure end-to-end.
   */
  openspecValidateItem?: ValidateFn;
  /**
   * Injectable salvage-uncommitted-work seam for the pre-merge bounded
   * auto-fix path (#547). Defaults to `trySalvageUncommittedWork` from
   * salvage-harness-work.ts. Tests inject a fake to exercise the salvage
   * fallback without a real git subprocess.
   */
  trySalvageUncommittedWork?: typeof trySalvageUncommittedWork;
  /**
   * GitHub login of the pipeline actor used to filter review comments to
   * trusted-authored entries before extracting spec-divergence signals (#356
   * finding 1). When absent, `maybeArchiveOpenspec` resolves it via `getGhActor()`
   * at runtime. Tests inject a literal string (matching the review-comment author
   * they set up) to avoid a real GitHub API call.
   */
  trustedReviewAuthor?: string | null;
  // Seams for the no-run recovery path (#281).
  getHeadCheckRunCount?: typeof getHeadCheckRunCount;
  /** Counts only successful (conclusion=success) check-runs for a SHA.
   *  Used for the prior-SHA green check in auto-recovery: a pre-archive SHA
   *  with only failed/pending runs must NOT qualify as green. */
  getSuccessfulCheckRunCount?: typeof getSuccessfulCheckRunCount;
  closePr?: typeof closePr;
  reopenPr?: typeof reopenPr;
  /** Returns the diff file paths between two SHAs (used for the archive-only check).
   *  Injected seam; defaults to `git diff --name-only baseSha...headSha`. */
  getDiffFilePaths?: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>;
  /** Wall-clock timestamp in ms. Injectable for tests; defaults to Date.now(). */
  nowMs?: () => number;
  /** Sleep for the given ms. Injectable for tests to avoid real waits in
   *  `advancePolling` unit tests; defaults to setTimeout-based sleep. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Read events from the run-store JSONL log. Injected for tests; defaults to
   *  `readEvents` from run-store.ts. Used by the `ci_mode: local` gate (#350). */
  readRunEvents?: typeof readEvents;
  /** Run the local test gate inline. Injected for tests; defaults to `runTestGate`
   *  from testgate.ts. Used by the `ci_mode: local` gate when the cached result is
   *  absent or stale (#350). */
  runTestGate?: typeof runTestGate;
  /** Read the HEAD SHA of a worktree by path. Injected for tests; defaults to
   *  `git rev-parse HEAD` in the worktree. Used by the `ci_mode: local` inline gate
   *  to verify the tested commit matches the remote PR head (#350). */
  getWorktreeHead?: (worktreePath: string) => Promise<string>;
  /**
   * Re-run failed workflow jobs for definitive CI failures (#679).
   * Defaults to `rerunFailedWorkflows` from gh.ts. Tests inject fakes.
   */
  rerunFailedWorkflows?: (
    cfg: PipelineConfig,
    failedChecks: CheckRun[],
  ) => Promise<RerunFailedWorkflowsResult>;
  /**
   * Fetch a bounded log excerpt for a failed check (#679).
   * Defaults to `fetchCheckLogExcerpt` from gh.ts. Tests inject fakes.
   */
  fetchCheckLogExcerpt?: (
    cfg: PipelineConfig,
    check: CheckRun,
  ) => Promise<string | null>;
  /**
   * Optional one-shot surgical fix for assertion-classified CI failures (#679).
   * Only invoked when `cfg.pre_merge_ci_assertion_fix` is true. Production
   * default reports not-implemented (config defaults false). Tests inject fakes.
   */
  runCiAssertionFix?: (
    cfg: PipelineConfig,
    issueNumber: number,
    ctx: {
      prNumber: number;
      headSha: string;
      failedChecks: CheckRun[];
      classification: CiFailureClass;
      logExcerpt: string | null;
    },
  ) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Read the most-recent `stage_accounting` event with `harness === "test-gate"`
 * from the run's event log. Returns the outcome and the worktree HEAD SHA that
 * was recorded at test time (pr_head_sha, if present). Returns `null` when no
 * test-gate event exists (run dir absent, log unreadable, or gate never ran).
 * Used by the `ci_mode: local` pre-merge CI gate (#350).
 */
async function latestTestGateOutcome(
  runDir: string | undefined,
  readRunEventsFn: typeof readEvents,
): Promise<{ outcome: "success" | "failure"; prHeadSha: string | null } | null> {
  if (!runDir) return null;
  let events: Awaited<ReturnType<typeof readEvents>>;
  try {
    events = await readRunEventsFn(runDir);
  } catch {
    return null;
  }
  const testGateEvents = events.filter(
    (e): e is StageAccountingEvent =>
      e.type === "stage_accounting" && (e as StageAccountingEvent).harness === "test-gate",
  );
  if (testGateEvents.length === 0) return null;
  const last = testGateEvents[testGateEvents.length - 1]!;
  return {
    outcome: last.outcome === "success" ? "success" : "failure",
    prHeadSha: last.pr_head_sha ?? null,
  };
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const getPrForIssueFn = deps.getPrForIssue ?? getPrForIssue;
  const getPrChecksFn = deps.getPrChecks ?? getPrChecks;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const transitionFn = deps.transition ?? transition;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;
  const getHeadCheckRunCountFn = deps.getHeadCheckRunCount ?? getHeadCheckRunCount;
  const getSuccessfulCheckRunCountFn = deps.getSuccessfulCheckRunCount ?? getSuccessfulCheckRunCount;
  const closePrFn = deps.closePr ?? closePr;
  const reopenPrFn = deps.reopenPr ?? reopenPr;
  const getDiffFilePathsFn = deps.getDiffFilePaths ?? defaultGetDiffFilePaths;
  const nowMsFn = deps.nowMs ?? (() => Date.now());
  const rerunFailedWorkflowsFn = deps.rerunFailedWorkflows ?? rerunFailedWorkflows;
  const fetchCheckLogExcerptFn = deps.fetchCheckLogExcerpt ?? fetchCheckLogExcerpt;
  const runCiAssertionFixFn = deps.runCiAssertionFix;

  console.log(`[pipeline] #${issueNumber}: pre-merge gate`);

  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for pre-merge gate.", "pre-merge", "needs-human");
    return preMergeBlocked("no PR", "needs-human");
  }

  if (opts.dryRun) {
    // Always route through visual-gate (#395); a disabled visual-gate skips
    // itself forward to the first enabled later gate — see stages/visual.ts.
    console.log(`[pipeline] #${issueNumber}: [dry-run] would archive+CI+merge for PR #${prNumber}`);
    return { advanced: true, from: "pre-merge", to: "visual-gate", summary: "[dry-run]" };
  }

  // ---- Review-SHA gate (#16): runs before any pre-merge work ----
  // pre-merge is the only stage that acts on a prior review verdict without
  // re-running review, so it is where a stale approval would slip through. If
  // HEAD has moved past the reviewed commit via a developer/fix commit, bounce
  // back to the review round before doing any pre-merge work; pipeline-internal
  // commits (openspec archive) do not invalidate the verdict.

  // Wire the bounded pre-merge auto-fix dep (#359): when the implementer harness
  // is configured and no seam is injected by the caller, build a production closure
  // that invokes `performPreMergeAutoFix` (fix + amend + push) for the gate to call.
  const gitFnForAutoFix = deps.gitInWorktree ?? gitInWorktree;
  const invokeFnForAutoFix = deps.invokeFn ?? invoke;
  const getForIssueForAutoFix = deps.getForIssue ?? getOnDiskForIssue;
  const salvageFnForAutoFix = deps.trySalvageUncommittedWork ?? trySalvageUncommittedWork;
  const preAutoFixFn: ShaGateDeps["attemptPreMergeAutoFix"] =
    deps.attemptPreMergeAutoFix ??
    (cfg.harnesses?.implementer
      ? async (blockingFindings, issueTitle, findingsText) => {
          const wt = await getForIssueForAutoFix(cfg, issueNumber);
          if (!wt) return { status: "error" };
          return performPreMergeAutoFix(
            cfg,
            issueNumber,
            pipelineRunId,
            findingsText,
            issueTitle,
            wt,
            gitFnForAutoFix,
            invokeFnForAutoFix,
            salvageFnForAutoFix,
          );
        }
      : undefined);

  const shaGate = await enforceReviewShaGate(
    cfg,
    issueNumber,
    prNumber,
    {
      ...deps,
      runDir: opts.runDir,
      runStoreDeps: opts.runStoreDeps,
      attemptPreMergeAutoFix: preAutoFixFn,
    },
  );
  if (shaGate) return shaGate;

  // ---- Capture pre-archive SHA for the no-run / archive-only recovery path (#281, #679) ----
  // Hydrate durable markers first so a restarted process restores preArchiveSha
  // before this capture can overwrite it with the current (post-archive) head.
  // Capture runs once per session when still unset: the developer's last commit
  // before maybeArchiveOpenspec may push an archive commit that moves HEAD.
  if (opts.pollingCtx) {
    hydrateCiRecoveryMarkers(opts.pollingCtx, opts.runDir);
    if (!opts.pollingCtx.preArchiveSha) {
      try {
        const preArchiveDetail = await getPrDetailFn(cfg, prNumber);
        opts.pollingCtx.preArchiveSha = preArchiveDetail.head_sha;
        // Best-effort: flush baseline early so later recovery markers include it.
        // Budget-consuming side-effects still require a successful persist of their
        // own markers via persistCtxCiMarkers before returning waiting.
        persistCtxCiMarkers(opts.pollingCtx, opts.runDir);
      } catch {
        // Fetch failed; no-run recovery will use the non-archive fallback path.
      }
    }
  }

  // ---- Step 0: OpenSpec archive (once; folds change deltas into living specs) ----
  const archiveOutcome = await maybeArchiveOpenspec(
    cfg,
    issueNumber,
    pipelineRunId,
    { ...deps, runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
    opts.stateDir,
    prNumber,
  );
  if (archiveOutcome) return archiveOutcome;

  // ---- Step 0.6: head-side active-change guard (#467) ----
  // Worktree-independent postcondition: even if the archive step above no-opped
  // for a reason not yet enumerated, pre-merge must never advance while the PR's
  // own changed-file list still carries an unarchived `openspec/changes/<id>/`
  // path it introduced. Behaves identically on a first run, an override-resumed
  // run, a fresh process, or after the worktree has been removed. Skipped when
  // `openspec.enabled: off` explicitly disables the integration (matches
  // maybeArchiveOpenspec's own off-mode skip above).
  if (cfg.openspec?.enabled !== "off") {
    const openspecGuardOutcome = await enforceOpenspecActiveChangeGuard(cfg, issueNumber, prNumber, deps);
    if (openspecGuardOutcome) return openspecGuardOutcome;
  }

  // ---- Step 0.5: early conflict detection (#95) ----
  // GitHub cannot build the pull_request merge ref for a CONFLICTING PR, so
  // no pull_request-triggered check runs are ever created — polling for
  // checks would wait out ci_timeout for runs that cannot appear. Fetch PR
  // detail and route a conflict straight to the rebase path. UNKNOWN (GitHub
  // still computing mergeability) is NOT a conflict and falls through to the
  // CI poll.
  const prDetail = await getPrDetailFn(cfg, prNumber);
  // Narrow predicate: only CONFLICTING (mergeable === false) or an explicit DIRTY
  // merge state bypasses the CI poll. BEHIND/BLOCKED map to "conflict" in the
  // broader parseMergeable() but represent out-of-date branch or branch protection —
  // not a real merge conflict — so they must fall through to the CI poll.
  const isEarlyConflict =
    prDetail.mergeable === false ||
    (prDetail.mergeable_state ?? "").toUpperCase() === "DIRTY";
  if (isEarlyConflict) {
    console.log(`[pipeline] #${issueNumber}: PR #${prNumber} is conflicting; skipping CI poll`);
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps);
  }

  // ---- Step 1: CI ----
  // localTestedSha is set by the local-mode branch and re-checked after the
  // mergeability refetch to catch pushes that arrive during Step 2. It stays
  // null in github mode (unused).
  let localTestedSha: string | null = null;

  if ((cfg.ci_mode ?? "github") === "local") {
    // Local mode (#350): verify CI using the current run's recorded test-gate outcome
    // instead of polling GitHub Actions check-runs. The conflict pre-check, mergeability
    // gate, and OpenSpec-validation gate are unaffected and still run below.
    const readRunEventsFn = deps.readRunEvents ?? readEvents;
    const runTestGateFn = deps.runTestGate ?? runTestGate;
    const tgResult = await latestTestGateOutcome(opts.runDir, readRunEventsFn);

    const isAbsent = tgResult === null;
    // Only treat as stale when the result is a success: a failure blocks regardless
    // of which commit was tested (the developer must fix the tests). A successful
    // result from an old commit needs re-validation against the current PR head.
    const isStale = tgResult !== null &&
      tgResult.outcome === "success" &&
      (!tgResult.prHeadSha || prDetail.head_sha !== tgResult.prHeadSha);

    if (isAbsent || isStale) {
      // No usable cached result (first entry to pre-merge, or PR head moved after
      // an OpenSpec archive commit or rebase). Run the test gate inline against the
      // current worktree so recovery is deterministic rather than a re-run dead-end.
      const localWt = await getForIssueFn(cfg, issueNumber);
      if (!localWt) {
        // Operational precondition (no worktree) — not a CI/local gate failure.
        // Residual `other` (needs-human, no ci-failed path tag) so scoreboard
        // does not inflate the ci-failed rate (#683 review 2).
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — no worktree found for this issue; cannot run the local test gate " +
            "from pre-merge. Ensure the pipeline created a worktree, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked("ci_mode: local — no worktree for inline gate", "needs-human");
      }
      const inlineResult = await runTestGateFn(
        cfg,
        issueNumber,
        localWt.path,
        {},
        pipelineRunId,
        "pre-merge",
        opts.stateDir,
        opts.runDir,
      );
      if (inlineResult.skipped) {
        // Fail-closed operational/config precondition (gate disabled / no command) —
        // not an actual CI or local test failure. Residual `other` (#683 review 2).
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline local test gate was skipped (test_gate is disabled or no " +
            "test command was detected). ci_mode: local requires a verified local exit-0 result. " +
            "Enable test_gate with a test command, or switch to ci_mode: github.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked(
          "ci_mode: local — inline test gate skipped (fail-closed)",
          "needs-human",
        );
      }
      if (!inlineResult.passed) {
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline local test gate (run from pre-merge) failed. " +
            "Fix the failing tests, push a new commit, and re-run the pipeline.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked("ci_mode: local — inline test gate failed", "needs-human", "ci-failed");
      }
      if ((inlineResult.attempts ?? 0) > 0) {
        // The test gate invoked the implementer harness (test-and-fix mode) and may
        // have created commits. Those commits exist only in the local worktree and are
        // not on the remote PR head. Certifying the remote PR head would advance an
        // untested commit. Block: push the fix commits and re-run the pipeline.
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the inline test gate invoked the implementer harness to fix " +
            `failing tests (${inlineResult.attempts} attempt(s)). ` +
            "Any fix commits exist only in the local worktree. " +
            "Push the fix commits to the PR branch, then re-run the pipeline so the full " +
            "review → pre-merge path covers the updated code.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked(
          "ci_mode: local — inline gate created fix commits; push required",
          "needs-human",
          "ci-failed",
        );
      }
      // Verify the actual worktree HEAD matches the remote PR head. A prior inline
      // gate run may have created fix commits (attempts > 0) and blocked; if the user
      // retries without pushing, those commits remain in the worktree. A subsequent
      // run passes with attempts === 0 (no new harness calls needed) but tests the
      // ahead worktree, not the remote PR head. (#350 pre-merge finding)
      const gitFnForHead = deps.gitInWorktree ?? gitInWorktree;
      const getWorktreeHeadFn = deps.getWorktreeHead ??
        ((wt: string) => gitFnForHead(wt, ["rev-parse", "HEAD"]).then((r) => r.stdout.trim()));
      const worktreeHead = await getWorktreeHeadFn(localWt.path);
      if (worktreeHead !== prDetail.head_sha) {
        await setBlockedFn(
          cfg,
          issueNumber,
          "ci_mode: local — the local worktree is ahead of the remote PR head " +
            `(worktree HEAD ${worktreeHead.slice(0, 7)}, PR head ${prDetail.head_sha.slice(0, 7)}). ` +
            "Push the worktree commits to the PR branch, then re-run the pipeline.",
          "pre-merge",
          "needs-human",
        );
        return preMergeBlocked(
          "ci_mode: local — worktree ahead of PR head; push required",
          "needs-human",
          "ci-failed",
        );
      }
      localTestedSha = prDetail.head_sha;
    } else if (tgResult.outcome !== "success") {
      await setBlockedFn(
        cfg,
        issueNumber,
        "ci_mode: local is set but the most recent local test-gate result is a failure. " +
          "Fix the failing tests, push a new commit to re-run the test gate, then re-run the pipeline.",
        "pre-merge",
        "needs-human",
      );
      return preMergeBlocked("ci_mode: local — local test gate failed", "needs-human", "ci-failed");
    } else {
      localTestedSha = tgResult.prHeadSha!;
    }

    console.log(
      `[pipeline] #${issueNumber}: ci_mode: local — local test gate passed; skipping GitHub Actions wait`,
    );
    // Observability (#682): local green is a definitive CI pass for the mirror.
    await recordPreMergeGateResult(
      { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
      "ci",
      "pass",
      "ci_mode: local",
    );
    // Local test gate passed: fall through to Step 2 (mergeability) and Step 2.5 (OpenSpec).
    // Do NOT return early — the downstream gates must still run.
  } else {
    // github mode (default): poll GitHub Actions check-runs.
    let checks;
    try {
      checks = await getPrChecksFn(cfg, prNumber);
    } catch (err) {
      const e = err as Error;
      return { advanced: false, status: "waiting", reason: `gh pr checks failed: ${e.message}` };
    }

    const agg = parseChecksAggregate(checks);

    // Record CI check result evidence; skip when still pending (no result yet).
    if (opts.stateDir && !agg.pending) {
      const ciSummary = agg.failed.length > 0
        ? agg.failed.map((c) => `${c.name}: ${c.bucket}`).join(", ")
        : `all ${checks.length} check(s) passed`;
      await recordCommand(
        opts.stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(`gh pr checks #${prNumber}`, agg.failed.length > 0 ? 1 : 0, 0, ciSummary),
      ).catch(() => {});
    }

    if (agg.pending) {
      // No-run recovery (#281): when GitHub Actions never fires a run for the head
      // SHA (e.g. after an archive-only commit), `getPrChecks` returns a stale
      // pending state indefinitely. After the grace window, query the check-runs API
      // directly. Zero runs → enter recovery rather than polling out ci_timeout.
      // Only active when a polling context is present (advancePolling session).
      const ctx = opts.pollingCtx;
      if (ctx) {
        const headSha = prDetail.head_sha;
        if (ctx.ciGateEnteredAt === undefined) ctx.ciGateEnteredAt = nowMsFn();
        const elapsed = nowMsFn() - ctx.ciGateEnteredAt;
        if (elapsed >= (cfg.ci_no_run_grace_s ?? 60) * 1000) {
          let runCount: number;
          try {
            runCount = await getHeadCheckRunCountFn(cfg, headSha);
          } catch {
            runCount = -1; // API failure → treat as "runs exist" (conservative-open)
          }
          if (runCount === 0) {
            return handleZeroRunRecovery(cfg, issueNumber, prNumber, headSha, ctx,
              setBlockedFn, closePrFn, reopenPrFn, getSuccessfulCheckRunCountFn, getDiffFilePathsFn);
          }
        }
      }
      // Observability (#682): at most one ci/waiting gate_result per continuous
      // wait stretch so loop mirrors are not spammed by CI poll ticks.
      if (!ctx?.ciWaitingGateRecorded) {
        if (ctx) ctx.ciWaitingGateRecorded = true;
        await recordPreMergeGateResult(
          { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
          "ci",
          "partial",
          "CI still running",
        );
      }
      return { advanced: false, status: "waiting", reason: "CI still running" };
    }

    if (agg.failed.length > 0) {
      // Full CheckRun objects (with link/description) for classification + URLs.
      const failedChecks = checks.filter((c) => {
        const b = (c.bucket ?? "").toLowerCase();
        return b === "fail" || b === "cancel";
      });
      const recoveryOut = await handleDefinitiveCiFailure(cfg, issueNumber, prNumber, prDetail.head_sha, failedChecks, opts, {
        getForIssueFn,
        setBlockedFn,
        tryRebaseAndPushFn,
        rebaseAlreadyAttemptedFn,
        markRebaseAttemptedFn,
        getSuccessfulCheckRunCountFn,
        getDiffFilePathsFn,
        closePrFn,
        reopenPrFn,
        rerunFailedWorkflowsFn,
        fetchCheckLogExcerptFn,
        runCiAssertionFixFn,
        stateDir: opts.stateDir,
      });
      // Observability for the loop progress mirror (#682).
      if (recoveryOut.status === "blocked") {
        await recordPreMergeGateResult(
          { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
          "ci",
          "fail",
          recoveryOut.reason ?? "CI failed",
        );
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
      } else if (recoveryOut.status === "waiting") {
        // New waiting stretch after a recovery attempt: allow another ci/waiting event.
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
        await recordPreMergeGateResult(
          { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
          "ci",
          "partial",
          recoveryOut.reason ?? "CI recovery in progress",
        );
        if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = true;
      }
      return recoveryOut;
    }

    // Definitive green CI (github mode) — observability for the loop mirror (#682).
    await recordPreMergeGateResult(
      { runDir: opts.runDir, runStoreDeps: opts.runStoreDeps },
      "ci",
      "pass",
    );
    if (opts.pollingCtx) opts.pollingCtx.ciWaitingGateRecorded = false;
  }

  // ---- Step 2: mergeability ----
  // Re-fetch after CI passes to catch conflicts that developed while CI was
  // running. Reusing the pre-CI snapshot could let a PR that became
  // CONFLICTING after the early check slip through to ready-to-deploy.
  // Use a narrow true-conflict predicate (same as Step 0.5) rather than
  // parseMergeable(), which also maps BEHIND/BLOCKED to "conflict". BEHIND
  // is an out-of-date branch (code is compatible, not conflicting); BLOCKED
  // is branch-protection preventing the merge. Routing those states to
  // recoverFromMergeConflict consumes the rebase marker and then blocks on
  // the next poll with a misleading "merge conflict — manual rebase needed"
  // reason for a PR that never had a real code conflict.
  const freshPrDetail = await getPrDetailFn(cfg, prNumber);

  // Final SHA re-check for ci_mode: local: a developer push that arrives
  // between the test-gate completion and this mergeability refetch would
  // produce a freshPrDetail.head_sha that differs from the SHA we actually
  // tested. Re-verify so we never certify an untested commit. (#350 pre-merge fix)
  if (localTestedSha !== null && freshPrDetail.head_sha !== localTestedSha) {
    const testedAt = localTestedSha.slice(0, 7);
    await setBlockedFn(
      cfg,
      issueNumber,
      "ci_mode: local — PR head moved after the local test gate ran " +
        `(tested ${testedAt}, current head ${freshPrDetail.head_sha.slice(0, 7)}). ` +
        "Re-run the pipeline to run the local test gate against the current head.",
      "pre-merge",
      "needs-human",
    );
    return preMergeBlocked(
      "ci_mode: local — PR head moved after SHA re-check",
      "needs-human",
      "ci-failed",
    );
  }
  const freshState = (freshPrDetail.mergeable_state ?? "").toUpperCase();
  const isFreshConflict = freshPrDetail.mergeable === false || freshState === "DIRTY";
  if (isFreshConflict) {
    return recoverFromMergeConflict(cfg, issueNumber, opts.stateDir, deps);
  }
  if (freshState === "BEHIND") {
    // BEHIND means the branch is out-of-date but has no code conflict.
    // Attempt one auto-rebase (same marker guard as the CONFLICTING path).
    // A second poll with the marker set blocks with a behind-specific reason,
    // not a conflict reason. BLOCKED (branch protection) is not updatable
    // by a rebase and stays as passive waiting.
    const behindWt = await getForIssueFn(cfg, issueNumber);
    const behindAlreadyRebased = behindWt ? rebaseAlreadyAttemptedFn(behindWt.path) : true;
    if (!behindAlreadyRebased && behindWt) {
      const ok = await tryRebaseAndPushFn(cfg, issueNumber);
      if (opts.stateDir) {
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            ok ? 0 : 1,
            0,
            ok ? "rebase and push succeeded; CI re-running" : "rebase or push failed",
          ),
        ).catch(() => {});
      }
      if (ok) {
        markRebaseAttemptedFn(behindWt.path);
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
    }
    const mergeConflictMsg = "PR branch is behind the base branch and could not be automatically updated — manual rebase or update needed.";
    await setBlockedFn(cfg, issueNumber, mergeConflictMsg, "pre-merge", "merge-conflict");
    return preMergeBlocked(mergeConflictMsg, "merge-conflict");
  }
  if (freshState === "BLOCKED") {
    return { advanced: false, status: "waiting", reason: "GitHub mergeability: blocked" };
  }
  if (freshPrDetail.mergeable === null && freshState !== "CLEAN" && freshState !== "HAS_HOOKS") {
    return { advanced: false, status: "waiting", reason: "GitHub still computing mergeability" };
  }

  // ---- Step 2.5: OpenSpec validation gate (opt-in / auto-detected) ----
  // Only runs when the target repo has an `openspec/` workspace (or it's forced
  // on via config). Refuses ready-to-deploy if the change's specs/deltas are
  // structurally invalid. A missing `openspec` CLI is non-blocking (skipped).
  const specWt = await getForIssueFn(cfg, issueNumber);
  if (specWt && openspec.isActive(cfg, specWt.path)) {
    const spec = await openspec.validate(specWt.path);
    if (spec.unavailable) {
      console.log(
        `[pipeline] #${issueNumber}: openspec active but CLI unavailable; skipping spec validation (non-blocking)`,
      );
    } else if (!spec.valid) {
      const detail = spec.issues.length
        ? spec.issues.map((i) => `- ${i.item ? `${i.item}: ` : ""}${i.message}`).join("\n")
        : spec.raw;
      await setBlockedFn(
        cfg,
        issueNumber,
        `OpenSpec validation failed (\`openspec validate --all\`):\n${detail}`,
        "pre-merge",
        "openspec-invalid",
      );
      return preMergeBlocked("openspec validation failed", "openspec-invalid");
    } else {
      console.log(`[pipeline] #${issueNumber}: openspec validation passed`);
    }
  }

  // ---- Step 3: advance ----
  // Always route through visual-gate (#395), matching the infographic's
  // visual-gate → eval-gate order. A disabled visual-gate is not a case
  // pre-merge special-cases here — the visual-gate stage itself skips forward
  // to the first enabled later gate (mirroring eval-gate's own disabled path).
  const nextStage: Stage = "visual-gate";
  await transitionFn(
    cfg,
    issueNumber,
    "pre-merge",
    nextStage,
    `All pre-merge gates passed (CI green, no conflicts). Advancing to ${nextStage} for PR #${prNumber}.`,
  );
  return {
    advanced: true,
    from: "pre-merge",
    to: nextStage,
    summary: `PR #${prNumber} pre-merge gates passed`,
  };
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
    const overrides = extractOverrides(trustedOverrideComments);
    const unresolved = [...recorded].filter((k) => !overrides.has(k));
    if (unresolved.length === 0) return null;
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
    await setBlockedFn(
      cfg,
      issueNumber,
      `Pre-merge: the last review recorded ${unresolved.length} unresolved blocking finding(s) ` +
        `at HEAD (${unresolved.join(", ")})${via}. Fix them (push a commit) or \`--override\` each ` +
        `before pre-merge can proceed.`,
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
          await setBlockedFn(
            cfg, issueNumber,
            `Pre-merge delta review reached the ${deltaRoundCap}-round ceiling with ${outstanding.length} ` +
              `unresolved blocking finding(s).`,
            "pre-merge", "needs-human",
          );
          return preMergeBlocked(
            `pre-merge delta-round ceiling: ${outstanding.length} unresolved blocking finding(s)`,
            "needs-human",
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
      // selfReviewBanner and (self-review) label used by advanceReview.
      const deltaEffectiveReviewer = deltaResult.effectiveReviewer ?? cfg.harnesses.reviewer;
      const deltaIsSelfReview = deltaResult.selfReview ?? false;
      const deltaReviewerLabel = deltaIsSelfReview
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
      const deltaComment = deltaIsSelfReview
        ? (() => {
            const nl = deltaCommentBody.indexOf("\n");
            return nl >= 0
              ? `${deltaCommentBody.slice(0, nl)}\n\n${selfReviewBanner(cfg.harnesses.reviewer, deltaEffectiveReviewer)}${deltaCommentBody.slice(nl)}`
              : `${deltaCommentBody}\n\n${selfReviewBanner(cfg.harnesses.reviewer, deltaEffectiveReviewer)}`;
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
          // Crash-safe one-attempt guard (#698 review-2): persist attempt-started
          // BEFORE invoking the harness. If this post fails, do not run the
          // harness — fail closed so a later entry can retry the marker rather
          // than leave an unbound attempt. Once posted, a later entry at the
          // same head will not start a second auto-fix even if the noop
          // completion marker never lands.
          let attemptMarkerPosted = false;
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
          } catch (err) {
            autoFixDiagnostic =
              `failed to record durable pre-merge auto-fix attempt marker at ` +
              `${targetHead.slice(0, 7)} before harness invoke: ` +
              `${(err as Error).message ?? String(err)}`;
            console.warn(
              `[pipeline] #${issueNumber}: ${autoFixDiagnostic}; escalating without auto-fix`,
            );
            // Fall through to setBlocked below without calling the harness.
            // Do not set priorAutoFix — there is no durable marker; a later
            // entry may retry the attempt-started post (still no double harness).
          }
          const fixRes = attemptMarkerPosted
            ? await attemptAutoFixFn(
                categoryPartition.autoFixable, detail.title, blockingOnlyBody,
              )
            : null;
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

            if (rePartition.blocking.length === 0 && !reIsUnparseable) {
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
              // Compose the #698 no-op still-broken recipe with partition
              // disposition labels so residual human-required keys and the
              // allowlisted attempt scope remain visible (#747 review-2 /
              // 826962b1). Preferring formatNoopStillBrokenReason alone used
              // to discard residual-vs-attempted naming on this path.
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
          } else {
            // fixRes.status === "error" (or attempt marker failed → fixRes null).
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
      const blockReason =
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
  const prompt = buildDeltaReviewPrompt({
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
  // Not yet guarded against the effective reviewer command — invokeReviewer
  // applies resolveReviewerModelForHarness itself, per attempted harness, so a
  // same-harness fallback (#39) is guarded against the harness it actually
  // targets rather than the nominal `cfg.harnesses.reviewer` (#441 finding c0acb169).
  const rawModel = cfg.harnesses.reviewerModel ?? cfg.models.review;
  const modelWasAuto = reviewerModelSourceWasAuto(cfg, undefined);
  const invocation = await invokeReviewer(
    cfg.harnesses.reviewer,
    cfg.harnesses.implementer,
    worktreePath,
    prompt,
    {
      timeoutSec: cfg.review_timeout,
      model: rawModel,
      modelWasAuto,
      accounting: accounting?.runDir
        ? {
            runDir: accounting.runDir,
            runStoreDeps: accounting.runStoreDeps,
            issue: issueNumber,
            stage: "pre-merge",
            modelSlot: "review",
          }
        : undefined,
      // #492: opt-in prompt-delivery channel for a custom reviewer CLI.
      promptDelivery: cfg.harnesses.reviewerPromptDelivery,
    },
  );
  if (!invocation.result.success) {
    throw new Error(
      `delta review harness failed: exit ${invocation.result.exit_code}`,
    );
  }
  const parsed = parseStructuredVerdict(invocation.result.stdout, "");
  return {
    verdict: parsed.verdict,
    findings: parsed.findings,
    summary: parsed.summary,
    effectiveReviewer: invocation.effectiveReviewer,
    selfReview: invocation.selfReview,
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

// ---------------------------------------------------------------------------
// OpenSpec archive (once per PR)
// ---------------------------------------------------------------------------

/**
 * Returns true when the PR branch commit history already contains a pipeline-
 * internal archive commit for this issue (#181). Reads the committed log rather
 * than the local filesystem so it is reliable across polling iterations: the
 * guard fires on the very next poll after the archive commit is pushed.
 */
export async function archiveAlreadyDone(
  gitFn: typeof gitInWorktree,
  wtPath: string,
  baseBranch: string,
  issueNumber: number,
): Promise<boolean> {
  const log = await gitFn(
    wtPath,
    ["log", "--format=%s", `origin/${baseBranch}..HEAD`],
    { ignoreFailure: true },
  );
  const prefix = `${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`;
  return log.stdout.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) return false;
    // Require a non-digit (or end of string) after the issue number so that
    // #18 does not match a commit intended for #181 or any other prefixed number.
    const charAfter = trimmed[prefix.length];
    return charAfter === undefined || !/\d/.test(charAfter);
  });
}

/**
 * Head-side postcondition (#467 / #714): before pre-merge advances, block while
 * any OpenSpec change remains active on the reviewed PR tip.
 *
 * Prefer tip-tree membership from the on-disk worktree (`listChangeDirs`) when
 * available — same source as archive candidates after base sync — so a prior
 * archive path in the cumulative PR diff cannot mask a reintroduced active dir.
 * When no worktree is on disk, resolve tip membership via the PR-head tree
 * (`listPrHeadChangeDirs` / GitHub Contents API) — never cumulative PR path
 * subtraction, which masks archive-then-reintroduce (#714 review 2). Returns
 * `null` to continue when nothing remains active.
 */
export async function enforceOpenspecActiveChangeGuard(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome | null> {
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const listChangeDirsFn = deps.listChangeDirs ?? openspec.listChangeDirs;
  const listPrHeadChangeDirsFn = deps.listPrHeadChangeDirs ?? listPrHeadChangeDirs;

  // Tip-tree first when a worktree exists (authoritative final head state).
  // Lookup failures fall through to the remote PR-head tree probe.
  let wt: { path: string; slug: string } | null = null;
  try {
    wt = await getForIssueFn(cfg, issueNumber);
  } catch {
    wt = null;
  }
  if (wt) {
    const remaining = [...listChangeDirsFn(wt.path)].sort();
    if (remaining.length === 0) return null;
    const reason =
      `Pre-merge cannot advance: OpenSpec change(s) still active on this PR: ${remaining.join(", ")}. ` +
      `Run \`openspec archive <id>\` for each and push before pre-merge can continue.`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
    return preMergeBlocked(reason, "openspec-invalid");
  }

  // Missing-worktree: PR-head tree only — not cumulative path subtraction (#714 review 2).
  let remaining: string[];
  try {
    remaining = [...(await listPrHeadChangeDirsFn(cfg, prNumber))].sort();
  } catch (err) {
    // Fail closed (#467): cannot prove the PR carries no active OpenSpec change.
    const reason =
      `Pre-merge cannot verify the OpenSpec active-change guard — listing PR-head OpenSpec ` +
      `change dirs failed (${(err as Error).message}). Check gh auth/network and re-run.`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
    return preMergeBlocked(reason, "needs-human");
  }
  if (remaining.length === 0) return null;

  const reason =
    `Pre-merge cannot advance: OpenSpec change(s) still active on this PR: ${remaining.join(", ")}. ` +
    `Run \`openspec archive <id>\` for each and push before pre-merge can continue.`;
  await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
  return preMergeBlocked(reason, "openspec-invalid");
}

/**
 * When OpenSpec is active, archive the change(s) this PR branch introduced so
 * their spec deltas fold into the living `openspec/specs/`. Idempotent: once an
 * archive commit exists on the branch, subsequent polling iterations skip this
 * step entirely. Returns a `waiting` Outcome after pushing (CI must re-run), a
 * `blocked` Outcome on failure, or null when there is nothing to do (continue the gate).
 *
 * Fails closed (#467, #714): a candidate probe that errors, or a missing worktree
 * while the PR itself still carries an `openspec/changes/<id>/` path, blocks
 * rather than returning `null` — `null` is reserved for a positively
 * established "nothing to archive". Archive candidates and the residual
 * still-active guard share one active-change set (PR tip when available) so a
 * single evaluation cannot emit `skipped`/`no-candidates` then block on the same
 * still-active id(s). Every decision (archived / skipped / blocked) is recorded
 * as a `gate_result` run event via `deps.runDir` so a silent skip is diagnosable
 * from `events.jsonl` alone.
 */
export async function maybeArchiveOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  pipelineRunId: string,
  deps: AdvancePreMergeDeps = {},
  stateDir?: string,
  prNumber?: number,
): Promise<Outcome | null> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const isActiveFn = deps.openspecIsActive ?? openspec.isActive;
  const changeDirExistsFn = deps.changeDirExists ?? openspec.changeDirExists;
  const listChangeDirsFn = deps.listChangeDirs ?? openspec.listChangeDirs;
  const listPrHeadChangeDirsFn = deps.listPrHeadChangeDirs ?? listPrHeadChangeDirs;
  const archiveFn = deps.openspecArchive ?? openspec.archive;
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const branchDeveloperCommitsFn =
    deps.branchDeveloperCommits ?? ((wtPath, base) => computeBranchDeveloperCommits(
      gitFn,
      wtPath,
      base,
      { skipSubjectsStartingWith: [OPENSPEC_ARCHIVE_PREFIX] },
    ));

  const recordDecision = async (result: "pass" | "fail" | "skipped", reason?: string): Promise<void> => {
    if (!deps.runDir) return;
    await appendEvent(
      deps.runDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        type: "gate_result",
        at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        gate: "openspec-archive",
        result,
        reason,
      },
      deps.runStoreDeps,
    ).catch(() => {});
  };

  /** Residual still-active block — same remedy text as enforceOpenspecActiveChangeGuard. */
  const blockResidualActive = async (remaining: string[]): Promise<Outcome> => {
    const reason =
      `Pre-merge cannot advance: OpenSpec change(s) still active on this PR: ${remaining.join(", ")}. ` +
      `Run \`openspec archive <id>\` for each and push before pre-merge can continue.`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
    await recordDecision("fail", reason);
    return preMergeBlocked(reason, "openspec-invalid");
  };

  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    // Worktree missing: resolve active membership from the reviewed PR-head tree
    // (GitHub Contents API), never cumulative PR path subtraction — the latter
    // masks archive-then-reintroduce (#467 / #714 review 2). `openspec.enabled: off`
    // disables the integration outright regardless of tip contents.
    const mode = cfg.openspec?.enabled ?? "auto";
    if (mode === "off" || prNumber === undefined) {
      await recordDecision("skipped", "openspec-inactive");
      return null;
    }
    let remaining: string[];
    try {
      remaining = [...(await listPrHeadChangeDirsFn(cfg, prNumber))].sort();
    } catch (err) {
      const reason =
        `Worktree for #${issueNumber} not found on disk and listing PR-head OpenSpec change ` +
        `dirs failed (${(err as Error).message}), so it cannot be confirmed there is no active ` +
        `OpenSpec change to archive. Restore the worktree (or gh auth) and re-run.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "needs-human");
    }
    if (remaining.length > 0) {
      const reason =
        `OpenSpec worktree for #${issueNumber} not found on disk, and the pull request still ` +
        `introduces active OpenSpec change(s): ${remaining.join(", ")}. Restore the worktree ` +
        `(or re-run planning) so the archive step can run, then re-run the pipeline.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "needs-human");
    }
    await recordDecision("skipped", "no-candidates");
    return null;
  }
  if (!isActiveFn(cfg, wt.path)) {
    await recordDecision("skipped", "openspec-inactive");
    return null;
  }

  // Shared active-change set is finalized ONLY after archive-base sync below
  // (#714). Do not emit `no-candidates` from a pre-sync PR path probe — an empty
  // cumulative PR diff must not bypass the required fail-closed base sync, and
  // tip-tree membership (not archive-path subtraction) is the membership rule.

  // Pre-archive cleanliness guard: the commit-failure rollback below is destructive
  // (`git restore .` + `git clean -fd openspec/`), so it is provably lossless ONLY when
  // the worktree is fully clean before archive. Block on ANY pre-existing dirty state —
  // a path-prefix filter is unsafe two ways: a dirty tracked openspec/ file (e.g.
  // `M  openspec/specs/x.md`) would be silently discarded by the rollback, and a porcelain
  // rename/copy record (`R  openspec/a -> core/a`) has a destination outside openspec/ that
  // matching only the first path misses. All planning/fix work is committed before pre-merge,
  // so any non-empty status here is anomalous — fail safe rather than risk data loss.
  // Fail CLOSED: only proceed when `git status` SUCCEEDS and reports a clean tree. If the
  // status check itself errors (non-zero exit, often with empty stdout), we cannot prove the
  // tree is clean — treating that as clean would let the destructive rollback run over
  // unproven state, the very data-loss class this guard exists to close.
  const preArchiveStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preArchiveStatus.code !== 0 || preArchiveStatus.stdout.trim() !== "") {
    const detail =
      preArchiveStatus.code !== 0
        ? `git status --porcelain failed (exit ${preArchiveStatus.code}): ${(preArchiveStatus.stderr || preArchiveStatus.stdout || "(no output)").trim()}`
        : `pre-existing dirty paths:\n${preArchiveStatus.stdout.trim()}`;
    // Workspace/git failures — not OpenSpec structural validation. Use needs-human
    // with no finer path tag so scoreboard offramp_class maps to residual `other`
    // (#683 review 1: dirty/status must not inflate openspec-invalid).
    await setBlockedFn(
      cfg,
      issueNumber,
      `Cannot verify a clean worktree before the OpenSpec archive, so a failed archive commit's destructive rollback could discard pre-existing work — ${detail}. Commit/stash changes (or fix the git error) and re-run.`,
      "pre-merge",
      "needs-human",
    );
    const blockedReason =
      preArchiveStatus.code !== 0 ? "pre-archive git status failed" : "worktree dirty before archive";
    await recordDecision("fail", blockedReason);
    return preMergeBlocked(blockedReason, "needs-human");
  }

  // ---- Archive-base sync guard (#579) ----
  // The archive commit must be built on the reviewed/pushed PR head, never a stale
  // local worktree base — a fix pushed from a different checkout (#547) can leave
  // this worktree behind `origin/<branch>`. Fetch + fast-forward to the remote
  // branch before archiving. A non-fast-forward gap here is a block signal, never
  // a cue to force-push over the reviewed head (#579). Runs after the cleanliness
  // guard above so the fast-forward always operates on a known-clean tree.
  // Final candidate resolution (#714) happens only after this sync so a lagging
  // worktree cannot omit stacked/foreign active changes present on the reviewed head.
  const branch = branchName(issueNumber, wt.slug);
  // Fetch with an explicit refspec so `refs/remotes/origin/<branch>` itself is updated —
  // `git fetch origin <branch>` with no destination only populates FETCH_HEAD, leaving the
  // tracking ref (and the `rev-parse origin/<branch>` read below) stale (#579 review 1).
  const fetch = await gitFn(wt.path, ["fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], {
    ignoreFailure: true,
  });
  if (fetch.code !== 0) {
    // Git/network infrastructure failure — not OpenSpec structural validation.
    // Residual `other` via needs-human so scoreboard does not mis-bucket as
    // openspec-invalid (#683 review 2).
    const detail = (fetch.stderr || fetch.stdout || "(no output)").trim();
    const reason =
      `Cannot sync worktree for #${issueNumber} to origin/${branch} before archiving — ` +
      `\`git fetch origin ${branch}:refs/remotes/origin/${branch}\` failed (exit ${fetch.code}): ${detail}`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
    await recordDecision("fail", "fetch failed before archive");
    return preMergeBlocked("fetch failed before archive", "needs-human");
  }
  const localHeadBefore = await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const reviewedHeadRes = await gitFn(wt.path, ["rev-parse", `origin/${branch}`], { ignoreFailure: true });
  if (localHeadBefore.code !== 0 || reviewedHeadRes.code !== 0) {
    // Rev resolution failure is git tooling — residual other, not openspec-invalid.
    const detail = (reviewedHeadRes.stderr || localHeadBefore.stderr || "(no output)").trim();
    const reason =
      `Cannot resolve worktree HEAD or origin/${branch} before archiving OpenSpec change(s) ` +
      `for #${issueNumber}: ${detail}`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
    await recordDecision("fail", "rev-parse failed before archive");
    return preMergeBlocked("rev-parse failed before archive", "needs-human");
  }
  const reviewedHead = reviewedHeadRes.stdout.trim();
  let archiveBase = localHeadBefore.stdout.trim();
  if (archiveBase !== reviewedHead) {
    // Fast-forward only — never a merge/rebase that could rewrite history. If the
    // fast-forward is impossible (true divergence), archiveBase stays stale and the
    // equality check below blocks; the archive step never force-pushes to reconcile it.
    await gitFn(wt.path, ["merge", "--ff-only", `origin/${branch}`], { ignoreFailure: true });
    const afterFf = await gitFn(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true });
    archiveBase = afterFf.code === 0 ? afterFf.stdout.trim() : archiveBase;
  }
  if (archiveBase !== reviewedHead) {
    const reason = `archive base \`${archiveBase}\` != reviewed head \`${reviewedHead}\``;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
    await recordDecision("fail", reason);
    return preMergeBlocked(reason, "needs-human");
  }

  // ---- Final candidates after sync (#714) ----
  // Shared active-change set = active change dirs on the synchronized reviewed
  // head tree. Never subtract archive-folder ids from a cumulative PR changed-file
  // list: a branch that archived `foo` then reintroduced `openspec/changes/foo/`
  // still has both path families in the PR diff, which would mask the reintroduced
  // id (#714 review 1 / cb86b57e).
  let sharedActive = [...listChangeDirsFn(wt.path)].sort();

  // Injectable-test / empty-listing fallback: when the tip-tree listing is empty,
  // allow path hints ∩ changeDirExists so unit tests that only stub path probes
  // and changeDirExists still exercise the archive path. Path hints use
  // changeIdsFromPaths (active paths only — no archive-folder subtraction).
  if (sharedActive.length === 0) {
    let pathHints: string[] = [];
    if (prNumber !== undefined) {
      try {
        pathHints = openspec.changeIdsFromPaths(diffFilePaths(await getPrDiffFn(cfg, prNumber)));
      } catch (err) {
        const reason =
          `Cannot determine active OpenSpec change candidates — fetching the PR diff failed ` +
          `(${(err as Error).message}). Check gh auth/network and re-run.`;
        await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
        await recordDecision("fail", reason);
        return preMergeBlocked(reason, "needs-human");
      }
    } else {
      const diff = await gitFn(
        wt.path,
        ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
        { ignoreFailure: true },
      );
      if (diff.code !== 0) {
        // Fail closed (#467): a failed probe must never be read as "no candidates".
        const detail = (diff.stderr || diff.stdout || "(no output)").trim();
        const reason =
          `Cannot determine active OpenSpec change candidates — ` +
          `\`git diff --name-only origin/${cfg.base_branch}...HEAD\` failed (exit ${diff.code}): ${detail}`;
        await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
        await recordDecision("fail", reason);
        return preMergeBlocked(reason, "openspec-invalid");
      }
      pathHints = openspec.changeIdsFromPaths(
        diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
      );
    }
    sharedActive = pathHints.filter((id) => changeDirExistsFn(wt.path, id)).sort();
  }

  if (sharedActive.length === 0) {
    await recordDecision("skipped", "no-candidates");
    return null;
  }

  // Tip-tree membership already implies dirs exist; keep the filter for the
  // path-hint fallback and any concurrent dir removal.
  const candidates = sharedActive.filter((id) => changeDirExistsFn(wt.path, id));
  if (candidates.length === 0) {
    return blockResidualActive(sharedActive);
  }

  // ---- Consistency guard (#106): never archive a delta the code outgrew ----
  // OpenSpec deltas are frozen at planning; fix rounds only edit code. If a
  // material fix moved the implementation but left the change's specs/** untouched
  // AND a review finding is tagged `category: spec-divergence`, archiving would
  // fold a stale delta into the living specs (silent corruption). Runs only once
  // we have post-sync candidates so empty shared-set skips stay free of gh actor I/O.
  let repairAttempted = false;
  const attemptRepairFn: SpecConsistencyDeps["attemptBoundedRepair"] =
    deps.attemptBoundedRepair ??
    (cfg.harnesses?.implementer
      ? async (changeId, issNo, runId) => {
          if (repairAttempted) return "already-attempted";
          repairAttempted = true;
          return performBoundedSpecRepair(
            cfg,
            changeId,
            issNo,
            runId,
            wt.path,
            gitFn,
            branchDeveloperCommitsFn,
            deps.invokeFn ?? invoke,
            deps.openspecValidateItem ?? openspec.validateItem,
          );
        }
      : undefined);
  const getHeadShaFn = async (p: string): Promise<string | null> => {
    const r = await gitFn(p, ["rev-parse", "HEAD"], { ignoreFailure: true });
    return r.stdout.trim() || null;
  };
  // Resolve the trusted review-comment author for the comment-author filter (#356 finding 1).
  // When the dep is provided (including null), use it directly so tests avoid a real network call.
  // In production (dep absent), fail closed: null from getGhActor() means auth is degraded,
  // and proceeding without the filter would allow untrusted commenters to forge review markers.
  let trustedReviewAuthor: string | null;
  if ("trustedReviewAuthor" in deps) {
    trustedReviewAuthor = deps.trustedReviewAuthor ?? null;
  } else {
    const getGhActorFn = deps.getGhActor ?? getGhActor;
    trustedReviewAuthor = await getGhActorFn();
    if (trustedReviewAuthor === null) {
      const reason =
        "cannot resolve the pipeline actor identity (gh auth may be degraded) — " +
        "trusted review-comment filtering requires a known actor; check `gh auth status`";
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "needs-human");
    }
  }
  const guard = await enforceSpecConsistencyGuard(cfg, issueNumber, wt.path, candidates, {
    branchDeveloperCommits: branchDeveloperCommitsFn,
    getIssueDetail: getIssueDetailFn,
    setBlocked: setBlockedFn,
    pipelineRunId,
    attemptBoundedRepair: attemptRepairFn,
    getHeadSha: getHeadShaFn,
    trustedReviewAuthor,
  });
  if (guard) {
    await recordDecision("fail", guard.reason ?? "spec-consistency guard blocked");
    return guard;
  }

  console.log(`[pipeline] #${issueNumber}: archiving OpenSpec change(s): ${candidates.join(", ")}`);
  for (const id of candidates) {
    const res = await archiveFn(wt.path, id);
    if (res.unavailable) {
      // CLI missing is tooling/env — not structural OpenSpec validation failure.
      // Residual other via needs-human (#683 review 2).
      const reason = `openspec CLI unavailable — cannot archive change '${id}'. Install the openspec CLI and re-run.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "needs-human");
      await recordDecision("fail", `openspec CLI unavailable (${id})`);
      return preMergeBlocked(`openspec CLI unavailable (${id})`, "needs-human");
    }
    if (!res.success) {
      // Surface the CLI output verbatim (#467) — e.g. a "header not found" error from a
      // retitled `## MODIFIED Requirements` delta the living spec does not (yet) contain.
      const reason = `openspec archive ${id} failed:\n${res.output}`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "openspec-invalid");
    }
  }

  // Verify each shared-set id left the active tree before claiming success (#714 / #675).
  // Pass reason lists only verified archived ids — never the full pre-archive list when
  // residuals remain. Ids still on disk after CLI success, and PR-active ids that never
  // had a dir (so they were not archive candidates), both fail closed here.
  const residualActive = sharedActive.filter((id) => changeDirExistsFn(wt.path, id));
  const archivedIds = candidates.filter((id) => !changeDirExistsFn(wt.path, id));
  if (residualActive.length > 0) {
    return blockResidualActive(residualActive);
  }
  const unclearedShared = sharedActive.filter((id) => !archivedIds.includes(id));
  if (unclearedShared.length > 0) {
    return blockResidualActive(unclearedShared);
  }

  // Commit + push the archived specs so CI validates the finalized state.
  await gitFn(wt.path, ["add", "-A"], { ignoreFailure: true });
  const status = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (!status.stdout.trim()) {
    // Archive claimed success and dirs are gone, but nothing to commit — fail closed
    // rather than skipped/no-candidates when the pre-archive shared set was non-empty (#714).
    const reason =
      `Pre-merge cannot advance: OpenSpec archive produced no worktree changes for ` +
      `change(s): ${archivedIds.join(", ")}. Run \`openspec archive <id>\` for each and push ` +
      `before pre-merge can continue.`;
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
    await recordDecision("fail", reason);
    return preMergeBlocked(reason, "openspec-invalid");
  }
  const commit = await gitFn(
    wt.path,
    ["commit", "-m", withTrailers(`${OPENSPEC_ARCHIVE_PREFIX}${issueNumber}`, issueNumber, pipelineRunId)],
    { ignoreFailure: true },
  );
  if (commit.code !== 0) {
    const detail = commit.stderr.trim() || commit.stdout.trim() || "(no output)";
    // Restore the worktree to its pre-archive state so the next run can retry.
    // openspec archive removed openspec/changes/<id>/ and modified openspec/specs/;
    // without this, changeDirExists returns false on retry and candidates is empty,
    // letting pre-merge continue without the required archive commit.
    await gitFn(wt.path, ["restore", "--staged", "."], { ignoreFailure: true });
    await gitFn(wt.path, ["restore", "."], { ignoreFailure: true });
    await gitFn(wt.path, ["clean", "-fd", "openspec/"], { ignoreFailure: true });
    // Align outcome with setBlocked kind (push-failed → residual other, not
    // openspec-invalid) so enriched events match GitHub blocker (#683 review 2).
    await setBlockedFn(
      cfg,
      issueNumber,
      `OpenSpec archive commit failed:\n${detail}`,
      "pre-merge",
      "push-failed",
    );
    await recordDecision("fail", "archive commit failed");
    return preMergeBlocked("archive commit failed", "push-failed");
  }
  // Plain push, deliberately never `--force`/`--force-with-lease` (#579): a
  // non-fast-forward rejection here means the remote moved again since the
  // sync guard above ran, and that is a block signal, not a cue to overwrite
  // the reviewed head.
  const push = await gitFn(wt.path, ["push", "origin", branch], {
    ignoreFailure: true,
  });
  if (stateDir) {
    await recordCommand(
      stateDir,
      issueNumber,
      "pre-merge",
      makeCommandRecord(
        `git push origin ${branch}`,
        push.code,
        0,
        push.code !== 0 ? push.stderr.trim() : "OpenSpec archive pushed; CI will re-run",
      ),
    ).catch(() => {});
  }
  if (push.code !== 0) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Git push failed after OpenSpec archive: ${push.stderr.trim()}`,
      "pre-merge",
      "push-failed",
    );
    await recordDecision("fail", "push failed after archive");
    return preMergeBlocked("push failed after archive", "push-failed");
  }
  console.log(`[pipeline] #${issueNumber}: OpenSpec change(s) archived; CI will re-run`);
  // Pass reason = verified archived ids only (#714 / #675).
  await recordDecision("pass", archivedIds.join(", "));
  return { advanced: false, status: "waiting", reason: "openspec change archived; CI re-running" };
}

// ---------------------------------------------------------------------------
// Definitive CI failure recovery ladder (#679)
// ---------------------------------------------------------------------------

interface DefinitiveCiFailureFns {
  getForIssueFn: typeof getOnDiskForIssue;
  setBlockedFn: typeof setBlocked;
  tryRebaseAndPushFn: typeof tryRebaseAndPush;
  rebaseAlreadyAttemptedFn: typeof rebaseAlreadyAttempted;
  markRebaseAttemptedFn: typeof markRebaseAttempted;
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount;
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>;
  closePrFn: typeof closePr;
  reopenPrFn: typeof reopenPr;
  rerunFailedWorkflowsFn: (
    cfg: PipelineConfig,
    failedChecks: CheckRun[],
  ) => Promise<RerunFailedWorkflowsResult>;
  fetchCheckLogExcerptFn: (
    cfg: PipelineConfig,
    check: CheckRun,
  ) => Promise<string | null>;
  runCiAssertionFixFn?: AdvancePreMergeDeps["runCiAssertionFix"];
  stateDir?: string;
}

/**
 * Recovery ladder for definitive red CI (not pending):
 *   1. one-shot rebase (existing)
 *   2. classify failures
 *   3. infra/unknown → one re-run (when enabled + not yet attempted for head SHA)
 *   4. archive-only + prior green + infra/unknown → one close+reopen after re-run exhausted
 *   5. assertion + config opt-in → one assertion-fix attempt
 *   6. escalate with `ci-exhausted` + rich block reason
 *
 * Budget is durable per head SHA via pollingCtx + runDir markers (#679).
 * Does NOT reintroduce #181 infinite wait/archive spin.
 */
async function handleDefinitiveCiFailure(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  failedChecks: CheckRun[],
  opts: AdvancePreMergeOpts,
  fns: DefinitiveCiFailureFns,
): Promise<Outcome> {
  // Ensure a recovery context even on single-shot advance() (no polling loop).
  const ctx: PreMergePollingContext = opts.pollingCtx ?? {};
  if (opts.pollingCtx === undefined) {
    // Local ephemeral ctx still hydrates from disk for process-restart durability.
  }
  hydrateCiRecoveryMarkers(ctx, opts.runDir);

  // 1. One-shot rebase (existing guard).
  const wt = await fns.getForIssueFn(cfg, issueNumber);
  const alreadyRebased = wt ? fns.rebaseAlreadyAttemptedFn(wt.path) : true;
  if (!alreadyRebased && wt) {
    const ok = await fns.tryRebaseAndPushFn(cfg, issueNumber);
    if (fns.stateDir) {
      await recordCommand(
        fns.stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(
          `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
          ok ? 0 : 1,
          0,
          ok ? "rebase and push succeeded; CI re-running" : "rebase or push failed",
        ),
      ).catch(() => {});
    }
    if (ok) {
      fns.markRebaseAttemptedFn(wt.path);
      return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
    }
    // Rebase failed → continue ladder (do not hard-block solely on rebase failure).
  }

  // Best-effort log excerpt from the first failed check that has a link.
  let logExcerpt: string | null = null;
  for (const check of failedChecks) {
    try {
      logExcerpt = await fns.fetchCheckLogExcerptFn(cfg, check);
    } catch {
      logExcerpt = null;
    }
    if (logExcerpt) break;
  }

  // 2. Classify.
  const classification = classifyCiFailure({ failed: failedChecks, logExcerpt });
  if (opts.stateDir) {
    await recordCommand(
      opts.stateDir,
      issueNumber,
      "pre-merge",
      makeCommandRecord(
        `ci-classify head=${headSha.slice(0, 7)}`,
        0,
        0,
        `classification=${classification}; failed=${failedChecks.map((c) => c.name).join(",")}`,
      ),
    ).catch(() => {});
  }

  const rerunEnabled = cfg.pre_merge_ci_rerun_enabled !== false;
  const assertionFixEnabled = cfg.pre_merge_ci_assertion_fix === true;
  let rerunAttempted = ctx.ciRerunAttemptedForSha === headSha;
  let archiveFailRecoveryAttempted = ctx.ciArchiveFailRecoveryAttemptedForSha === headSha;
  let assertionFixAttempted = ctx.ciAssertionFixAttemptedForSha === headSha;
  /** Set when a recovery side-effect could not be paired with durable markers. */
  let durablePersistFailure: string | undefined;
  /** Set when archive close succeeded but reopen did not — operator must reopen. */
  let prLeftClosed: { prNumber: number } | undefined;
  let closeReopenError: string | undefined;

  // 3. Infra / unknown → one automatic re-run.
  // Persist the per-head marker BEFORE the re-run side-effect so a restart cannot
  // re-consume the budget when the write fails (#679 durability / #181).
  if (
    (classification === "infra" || classification === "unknown") &&
    rerunEnabled &&
    !rerunAttempted
  ) {
    const prevRerunSha = ctx.ciRerunAttemptedForSha;
    ctx.ciRerunAttemptedForSha = headSha;
    const persist = persistCtxCiMarkers(ctx, opts.runDir);
    if (!persist.ok) {
      // Roll back in-memory so a later run can retry once durability is restored.
      ctx.ciRerunAttemptedForSha = prevRerunSha;
      durablePersistFailure = persist.reason;
      console.log(
        `[pipeline] #${issueNumber}: refusing CI re-run for ${headSha.slice(0, 7)} — ${persist.reason}`,
      );
    } else {
      rerunAttempted = true;
      if (opts.pollingCtx) {
        opts.pollingCtx.ciRerunAttemptedForSha = headSha;
      }
      let result: RerunFailedWorkflowsResult;
      try {
        result = await fns.rerunFailedWorkflowsFn(cfg, failedChecks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { attempted: false, runIds: [], reason: msg };
      }
      if (result.attempted) {
        console.log(
          `[pipeline] #${issueNumber}: CI ${classification} failure; re-ran workflow(s) ${result.runIds.join(", ")} for head ${headSha.slice(0, 7)}`,
        );
        return {
          advanced: false,
          status: "waiting",
          reason: `CI re-triggered (${classification}); waiting for checks`,
        };
      }
      // Re-run unavailable → fall through to remaining budget steps.
      console.log(
        `[pipeline] #${issueNumber}: CI re-run unavailable for ${headSha.slice(0, 7)}: ${result.reason ?? "unknown"}`,
      );
    }
  }

  // 4. Archive-only + prior green + infra/unknown → one close+reopen after re-run exhausted/unavailable.
  if (
    (classification === "infra" || classification === "unknown") &&
    !archiveFailRecoveryAttempted
  ) {
    const archiveInfo = await evaluateArchiveOnlyPriorGreen(
      cfg,
      headSha,
      ctx,
      fns.getSuccessfulCheckRunCountFn,
      fns.getDiffFilePathsFn,
    );
    if (archiveInfo.isArchiveOnly && archiveInfo.priorGreen) {
      // Prefer re-run first: only close+reopen when re-run budget is already consumed
      // (or re-run disabled). When re-run just marked attempted but was unavailable,
      // this path still applies on the same tick.
      if (rerunAttempted || !rerunEnabled) {
        // Persist one-shot marker before close so restart cannot re-close thrash.
        // If persist fails, skip the side-effect and escalate (do not leave PR closed).
        const prevArchiveSha = ctx.ciArchiveFailRecoveryAttemptedForSha;
        ctx.ciArchiveFailRecoveryAttemptedForSha = headSha;
        const persistBefore = persistCtxCiMarkers(ctx, opts.runDir);
        if (!persistBefore.ok) {
          ctx.ciArchiveFailRecoveryAttemptedForSha = prevArchiveSha;
          durablePersistFailure = durablePersistFailure ?? persistBefore.reason;
          console.log(
            `[pipeline] #${issueNumber}: refusing archive close+reopen for ${headSha.slice(0, 7)} — ${persistBefore.reason}`,
          );
        } else {
          archiveFailRecoveryAttempted = true;
          if (opts.pollingCtx) {
            opts.pollingCtx.ciArchiveFailRecoveryAttemptedForSha = headSha;
          }

          let closed = false;
          let reopened = false;
          try {
            await fns.closePrFn(cfg, prNumber);
            closed = true;
            await fns.reopenPrFn(cfg, prNumber);
            reopened = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            closeReopenError = msg;
            // If close succeeded but reopen failed, retry reopen once so we do not
            // strand the PR closed (#679 close+reopen safety).
            if (closed && !reopened) {
              try {
                await fns.reopenPrFn(cfg, prNumber);
                reopened = true;
                closeReopenError = undefined;
                console.log(
                  `[pipeline] #${issueNumber}: archive-only reopen recovered on retry for PR #${prNumber}`,
                );
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                closeReopenError = `close succeeded; reopen failed (initial: ${msg}; retry: ${retryMsg})`;
                prLeftClosed = { prNumber };
                console.log(
                  `[pipeline] #${issueNumber}: archive-only close+reopen left PR #${prNumber} CLOSED: ${closeReopenError}`,
                );
              }
            } else {
              console.log(
                `[pipeline] #${issueNumber}: archive-only close+reopen failed: ${msg}`,
              );
            }
          }

          if (reopened) {
            console.log(
              `[pipeline] #${issueNumber}: archive-only CI ${classification} failure; closed+reopened PR #${prNumber} for head ${headSha.slice(0, 7)}`,
            );
            return {
              advanced: false,
              status: "waiting",
              reason: "archive-only CI red; closed and reopened PR to re-fire CI",
            };
          }
          // Partial or total failure → fall through to escalate with evidence.
        }
      }
    }
  }

  // 5. Optional assertion auto-fix (config-capped, one shot).
  // Persist marker before dispatch so restart cannot re-invoke the fix loop.
  if (classification === "assertion" && assertionFixEnabled && !assertionFixAttempted) {
    const prevFixSha = ctx.ciAssertionFixAttemptedForSha;
    ctx.ciAssertionFixAttemptedForSha = headSha;
    const persist = persistCtxCiMarkers(ctx, opts.runDir);
    if (!persist.ok) {
      ctx.ciAssertionFixAttemptedForSha = prevFixSha;
      durablePersistFailure = durablePersistFailure ?? persist.reason;
      console.log(
        `[pipeline] #${issueNumber}: refusing CI assertion auto-fix for ${headSha.slice(0, 7)} — ${persist.reason}`,
      );
    } else {
      assertionFixAttempted = true;
      if (opts.pollingCtx) {
        opts.pollingCtx.ciAssertionFixAttemptedForSha = headSha;
      }
      if (fns.runCiAssertionFixFn) {
        let fixResult: { ok: boolean; reason?: string };
        try {
          fixResult = await fns.runCiAssertionFixFn(cfg, issueNumber, {
            prNumber,
            headSha,
            failedChecks,
            classification,
            logExcerpt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fixResult = { ok: false, reason: msg };
        }
        if (fixResult.ok) {
          console.log(
            `[pipeline] #${issueNumber}: CI assertion auto-fix dispatched for head ${headSha.slice(0, 7)}`,
          );
          return {
            advanced: false,
            status: "waiting",
            reason: "CI assertion auto-fix attempted; waiting for checks",
          };
        }
        console.log(
          `[pipeline] #${issueNumber}: CI assertion auto-fix failed: ${fixResult.reason ?? "unknown"}`,
        );
        // Fall through to escalate on same tick when dispatch failed.
      }
    }
  }

  // 6. Budget exhausted → escalate with ci-exhausted + rich reason.
  const archiveInfo = await evaluateArchiveOnlyPriorGreen(
    cfg,
    headSha,
    ctx,
    fns.getSuccessfulCheckRunCountFn,
    fns.getDiffFilePathsFn,
  );
  const reason = buildCiExhaustedBlockReason({
    failedChecks,
    headSha,
    classification,
    logExcerpt,
    preArchiveGreenSha:
      archiveInfo.isArchiveOnly && archiveInfo.priorGreen ? ctx.preArchiveSha : undefined,
    rerunAttempted,
    archiveFailRecoveryAttempted,
    assertionFixAttempted,
    assertionFixEnabled,
    rerunEnabled,
    prLeftClosed,
    closeReopenError,
    durablePersistFailure,
  });
  await fns.setBlockedFn(cfg, issueNumber, reason, "pre-merge", "ci-exhausted");
  // #683: attach offramp path tag so scoreboard maps permanent CI failure to ci-failed
  // (blockerKind alone is the durable label; pathTag is the finer metric class).
  return preMergeBlocked("CI failed", "ci-exhausted", "ci-failed");
}

async function evaluateArchiveOnlyPriorGreen(
  cfg: PipelineConfig,
  headSha: string,
  ctx: PreMergePollingContext,
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount,
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>,
): Promise<{ isArchiveOnly: boolean; priorGreen: boolean }> {
  const preArchiveSha = ctx.preArchiveSha;
  if (!preArchiveSha || preArchiveSha === headSha) {
    return { isArchiveOnly: false, priorGreen: false };
  }
  try {
    const diffPaths = await getDiffFilePathsFn(cfg, preArchiveSha, headSha);
    const isArchiveOnly =
      diffPaths.length > 0 && diffPaths.every((p) => p.startsWith("openspec/"));
    if (!isArchiveOnly) return { isArchiveOnly: false, priorGreen: false };
    const successCount = await getSuccessfulCheckRunCountFn(cfg, preArchiveSha);
    return { isArchiveOnly: true, priorGreen: successCount > 0 };
  } catch {
    return { isArchiveOnly: false, priorGreen: false };
  }
}

/** Build operator-facing block reason for CI budget exhaustion (#679). */
export function buildCiExhaustedBlockReason(input: {
  failedChecks: CheckRun[];
  headSha: string;
  classification: CiFailureClass;
  logExcerpt: string | null;
  preArchiveGreenSha?: string;
  rerunAttempted: boolean;
  archiveFailRecoveryAttempted: boolean;
  assertionFixAttempted: boolean;
  assertionFixEnabled: boolean;
  rerunEnabled: boolean;
  /** When archive close+reopen left the PR closed after reopen failure. */
  prLeftClosed?: { prNumber: number };
  /** Detail from close+reopen failure (including reopen retry). */
  closeReopenError?: string;
  /** When durable marker persistence blocked or failed recovery. */
  durablePersistFailure?: string;
}): string {
  const lines: string[] = [
    `CI checks failed after recovery budget exhausted (classification: ${input.classification}).`,
    "",
    `Head SHA: ${input.headSha}`,
  ];
  if (input.preArchiveGreenSha) {
    lines.push(`Pre-archive green SHA: ${input.preArchiveGreenSha}`);
  }
  lines.push("", "Failing checks:");
  for (const c of input.failedChecks) {
    const bucket = c.bucket || c.state || "fail";
    lines.push(`- ${c.name}: ${bucket}`);
    if (c.link) lines.push(`  ${c.link}`);
  }
  if (input.logExcerpt) {
    lines.push("", "Log excerpt:", "```", input.logExcerpt, "```");
  }
  if (input.prLeftClosed) {
    lines.push(
      "",
      `CRITICAL: PR #${input.prLeftClosed.prNumber} is still CLOSED after archive close+reopen recovery failed.`,
      `Reopen it first: \`gh pr reopen ${input.prLeftClosed.prNumber}\` (or the GitHub UI), then re-fire CI if needed.`,
    );
    if (input.closeReopenError) {
      lines.push(`Close+reopen error: ${input.closeReopenError}`);
    }
  } else if (input.closeReopenError) {
    lines.push("", `Archive close+reopen error: ${input.closeReopenError}`);
  }
  if (input.durablePersistFailure) {
    lines.push(
      "",
      `Durable recovery marker persistence failed: ${input.durablePersistFailure}`,
      "Automatic recovery was not safely consumable without durable state; fix run-store writability if this persists.",
    );
  }
  lines.push(
    "",
    "Recovery already attempted:",
    `- automatic re-run: ${input.rerunEnabled ? (input.rerunAttempted ? "yes" : "no") : "disabled"}`,
    `- archive failed-run close+reopen: ${input.archiveFailRecoveryAttempted ? "yes" : "no"}`,
    `- assertion auto-fix: ${input.assertionFixEnabled ? (input.assertionFixAttempted ? "yes" : "no") : "disabled"}`,
    "",
    "Next steps: " +
      (input.prLeftClosed
        ? `reopen PR #${input.prLeftClosed.prNumber}; `
        : "") +
      "inspect the check URL(s) and classification above; fix product " +
      "test/build failures or remaining infrastructure issues; push any code fix " +
      "to the PR head; remove the `blocked` label; re-run the pipeline. " +
      (input.rerunAttempted
        ? "Automatic re-run budget for this head was already consumed."
        : "If this looks like a flake, re-run the failed workflow manually once before re-running the pipeline."),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// No-run recovery (#281)
// ---------------------------------------------------------------------------

/**
 * Called when `getPrChecks` shows pending CI but the check-runs API reports
 * zero runs for the head SHA — GitHub Actions never fired, typically after an
 * archive-only commit that did not re-trigger the `pull_request` event.
 *
 * Decision tree:
 *  1. Already attempted recovery for this SHA → block (needs-human).
 *  2. Diff from preArchiveSha to headSha is openspec-only AND preArchiveSha had
 *     ≥1 successful check-run (prior green) → close+reopen PR to re-fire CI → waiting.
 *  3. close+reopen throws → block (needs-human).
 *  4. Non-archive diff or preArchiveSha unavailable → block (needs-human) with
 *     actionable manual close+reopen suggestion.
 */
async function handleZeroRunRecovery(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  ctx: PreMergePollingContext,
  setBlockedFn: typeof setBlocked,
  closePrFn: typeof closePr,
  reopenPrFn: typeof reopenPr,
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount,
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>,
): Promise<Outcome> {
  // One-shot-per-SHA guard: prevents repeated PR state churn on consecutive polls.
  if (ctx.noRunRecoveryAttemptedForSha === headSha) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery was already attempted for this SHA. ` +
        `Investigate why GitHub Actions is not triggering and manually re-fire CI, then remove the \`blocked\` label and re-run the pipeline.`,
      "pre-merge",
      "needs-human",
    );
    return preMergeBlocked(`no CI run after recovery for ${headSha.slice(0, 7)}`, "needs-human", "ci-failed");
  }

  const preArchiveSha = ctx.preArchiveSha;
  let isArchiveOnly = false;
  let priorGreen = false;

  if (preArchiveSha && preArchiveSha !== headSha) {
    try {
      const diffPaths = await getDiffFilePathsFn(cfg, preArchiveSha, headSha);
      isArchiveOnly = diffPaths.length > 0 && diffPaths.every((p) => p.startsWith("openspec/"));
      if (isArchiveOnly) {
        const successCount = await getSuccessfulCheckRunCountFn(cfg, preArchiveSha);
        priorGreen = successCount > 0;
      }
    } catch {
      // Treat as non-archive-only on error (conservative-open: no auto-recover).
    }
  }

  if (isArchiveOnly && priorGreen) {
    try {
      await closePrFn(cfg, prNumber);
      await reopenPrFn(cfg, prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setBlockedFn(
        cfg,
        issueNumber,
        `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery failed: ${msg}`,
        "pre-merge",
        "needs-human",
      );
      return preMergeBlocked(`no CI run; close+reopen failed: ${msg}`, "needs-human", "ci-failed");
    }
    ctx.noRunRecoveryAttemptedForSha = headSha;
    console.log(
      `[pipeline] #${issueNumber}: no CI run for SHA ${headSha.slice(0, 7)}; closed and reopened PR #${prNumber} to re-fire CI`,
    );
    return {
      advanced: false,
      status: "waiting",
      reason: "no CI run detected; closed and reopened PR to re-fire CI",
    };
  }

  // Non-archive diff or pre-archive SHA unavailable or prior SHA had no runs.
  await setBlockedFn(
    cfg,
    issueNumber,
    `No CI run detected for head SHA ${headSha.slice(0, 7)}; try closing and reopening the PR to re-fire GitHub Actions.`,
    "pre-merge",
    "needs-human",
  );
  return preMergeBlocked(`no CI run detected for head SHA ${headSha.slice(0, 7)}`, "needs-human", "ci-failed");
}

/** Default implementation of the `getDiffFilePaths` seam. */
async function defaultGetDiffFilePaths(
  cfg: PipelineConfig,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const result = await gitInWorktree(
    cfg.repo_dir,
    ["diff", "--name-only", `${baseSha}...${headSha}`],
    { ignoreFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(`git diff --name-only ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Rebase tracking
// ---------------------------------------------------------------------------

/**
 * Conflict recovery shared by the early-conflict check (#95) and the Step 2
 * mergeability gate: attempt one auto-rebase, bounded by the per-worktree
 * rebase marker so an unresolvable conflict cannot retry a rebase on every
 * poll iteration. When the rebase cannot resolve the conflict (or was already
 * attempted), blocks with a conflict-specific reason rather than a generic
 * CI-timeout or CI-failure message.
 */
async function recoverFromMergeConflict(
  cfg: PipelineConfig,
  issueNumber: number,
  stateDir?: string,
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;

  const wt = await getForIssueFn(cfg, issueNumber);
  const alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
  if (!alreadyRebased && wt) {
    const ok = await tryRebaseAndPushFn(cfg, issueNumber);
    if (stateDir) {
      await recordCommand(
        stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(
          `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
          ok ? 0 : 1,
          0,
          ok ? "conflict-recovery rebase succeeded; CI re-running" : "conflict-recovery rebase failed",
        ),
      ).catch(() => {});
    }
    if (ok) {
      markRebaseAttemptedFn(wt.path);
      return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
    }
  }
  await setBlockedFn(
    cfg,
    issueNumber,
    "PR has a merge conflict with the base branch that could not be automatically rebased — manual rebase needed.",
    "pre-merge",
    "merge-conflict",
  );
  return preMergeBlocked("merge conflict", "merge-conflict");
}

function rebaseAlreadyAttempted(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, REBASE_MARKER_FILE));
}

function markRebaseAttempted(wtPath: string): void {
  fs.writeFileSync(path.join(wtPath, REBASE_MARKER_FILE), "1");
}

async function tryRebaseAndPush(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<boolean> {
  const wt = await getOnDiskForIssue(cfg, issueNumber);
  if (!wt) return false;
  const branch = branchName(issueNumber, wt.slug);

  const fetch = await gitInWorktree(wt.path, ["fetch", "origin", cfg.base_branch], {
    ignoreFailure: true,
  });
  if (fetch.code !== 0) return false;

  const rebase = await gitInWorktree(wt.path, ["rebase", `origin/${cfg.base_branch}`], {
    ignoreFailure: true,
  });
  if (rebase.code !== 0) {
    await gitInWorktree(wt.path, ["rebase", "--abort"], { ignoreFailure: true });
    return false;
  }

  const push = await gitInWorktree(
    wt.path,
    ["push", "--force-with-lease", "origin", branch],
    { ignoreFailure: true },
  );
  return push.code === 0;
}

/**
 * Polling loop: invoke `advance` repeatedly until it advances, blocks, or
 * exhausts the CI timeout. Used by the top-level orchestrator. Returns the
 * last outcome. `opts.stateDir` is forwarded to each `advance` call so
 * evidence recording works across all polling iterations.
 *
 * `deps` is optional and forwarded to every `advance` call; injectable seams
 * (nowMs, sleepMs, getHeadCheckRunCount, …) enable unit-testing the polling
 * loop without real network calls or wall-clock waits.
 */
export async function advancePolling(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvancePreMergeOpts = {},
  deps: AdvancePreMergeDeps = {},
): Promise<Outcome> {
  const nowMsFn = deps.nowMs ?? (() => Date.now());
  const sleepMsFn = deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = nowMsFn() + cfg.ci_timeout * 1000;
  let last: Outcome | null = null;
  // Allocate a shared polling context so grace-window timing and no-run recovery
  // state persist across advance() iterations (#281). Reuses an existing context
  // when one was passed in opts (e.g. from a resumed polling session).
  const pollingCtx: PreMergePollingContext = opts.pollingCtx ?? {};
  while (nowMsFn() < deadline) {
    last = await advance(cfg, issueNumber, { ...opts, pollingCtx }, deps);
    if (last.advanced) return last;
    if (!last.advanced && last.status !== "waiting") return last;
    // waiting → sleep and try again
    await sleepMsFn(cfg.ci_poll_interval * 1000);
  }
  return last ?? { advanced: false, status: "waiting", reason: "timed out polling pre-merge" };
}
