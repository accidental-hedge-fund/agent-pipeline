// Pre-merge auto-fix domain (#628).
// Owns performPreMergeAutoFix and pure autofix helpers/markers.

import {
  attestPipelineComment,
  extractReviewArtifact,
  isVerifiedPipelineAttestation,
} from "./review.ts";
import {
  extractSpecDivergenceDirection,
  findingKey,
} from "../review-policy.ts";
import { runHarnessRound } from "../harness-round.ts";
import {
  evaluatePostHarnessNoNewCommit,
  formatNoopAdvanceEvidenceNote,
  preMergeFindingsClearGoalCheck,
  type NoopAdvanceResult,
} from "../noop-advance.ts";
import { withTrailers } from "../traceability.ts";
import {
  isOnlyPipelineInternalMarkerDirt,
  stripPipelineInternalMarkers,
  trySalvageUncommittedWork,
} from "../salvage-harness-work.ts";
import { branchName, gitInWorktree, reattachIfDetached } from "../worktree.ts";
import { buildFixPrompt } from "../prompts/index.ts";
import type { InvokeFn } from "../openspec-consistency.ts";
import type { PipelineConfig, ReviewFinding } from "../types.ts";
import {
  declaredScopeFromFindingPaths,
  runCoveredCandidateMutation,
  type DeclaredRepairScope,
  type IntegritySubject,
  type IntegrityStoreDeps,
  type CandidateIntegrityEventPayload,
  type MutationMethod,
} from "../candidate-integrity.ts";

/** Optional #857 integrity wrapper context for head-moving auto-fix. */
export interface PreMergeAutoFixIntegrityOpts {
  storeRoot: string;
  subject: IntegritySubject;
  base_ref: string;
  resolveBaseSha: () => Promise<string | null>;
  resolveCandidateSha: () => Promise<string | null>;
  /** When omitted, empty scope → any content change is scope_expansion. */
  declared_scope?: DeclaredRepairScope;
  /** Convenience: build scope from finding file paths. */
  finding_paths?: string[];
  emitEvent?: (event: CandidateIntegrityEventPayload) => Promise<void>;
  storeDeps?: IntegrityStoreDeps;
  mutation_id?: string;
  engine_version?: string;
  /**
   * Defaults to `pre_merge_autofix`. Recovery mechanical repair passes
   * `recovery_repair`; conflict surgical repair may pass `conflict_repair`.
   */
  mutation_method?: MutationMethod;
}

/**
 * #698 / #758: terminal disposition for a confirmed clean auto-fix no-op
 * (`noop-clean`) after re-verify. Routes through the shared noop-advance
 * contract so stages do not reimplement "clean no-commit → proceed or
 * escalate" privately.
 *
 * Preconditions are already satisfied by the caller (noop-clean head); this
 * adapter re-validates via shared evaluation with headBefore === headAfter.
 */
export async function evaluatePreMergeNoopCleanDisposition(opts: {
  headSha: string;
  reverifyBlockingCount: number;
  reverifyUnparseable: boolean;
  issueNumber?: number;
}): Promise<NoopAdvanceResult> {
  return evaluatePostHarnessNoNewCommit({
    headBefore: opts.headSha,
    headAfter: opts.headSha,
    salvaged: false,
    // Caller already confirmed noop-clean (HEAD unchanged + clean salvage).
    salvageFoundNothing: true,
    stage: "pre-merge",
    issueNumber: opts.issueNumber,
    goalCheck: () =>
      preMergeFindingsClearGoalCheck({
        reverifyBlockingCount: opts.reverifyBlockingCount,
        reverifyUnparseable: opts.reverifyUnparseable,
        headSha: opts.headSha,
      }),
  });
}

export { formatNoopAdvanceEvidenceNote };

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
 * (#698 review-2) but only **after** preflight (worktree lookup,
 * rematerialization, clean-tree check) succeeds (#787), so preflight failures
 * do not consume the one-attempt bound. Guarantees the bound even when the
 * post-noop completion marker fails to persist (or the process crashes
 * mid-harness): a later pre-merge entry at the same head recognizes this
 * sentinel and does not start a second auto-fix.
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
 * "rematerialize-failed" — managed worktree was missing and ensureManagedWorktree
 *                   failed before implementer work (#769). Carries the seam's
 *                   typed blockerKind so residual re-entry / delta SHA-gate
 *                   paths park as worktree-* rather than product needs-human.
 * "claim-failed"  — every preflight succeeded but the durable attempt claim
 *                   (the caller's `claimAttempt` callback) could not be
 *                   recorded (#787). The implementer was NOT invoked and no
 *                   attempt was consumed; a later entry at the same head may
 *                   retry the claim.
 */
export type PreMergeAutofixRematerializeBlockerKind =
  | "worktree-missing"
  | "worktree-creation-failed"
  | "worktree-capacity";

export type PreMergeAutoFixResult =
  | { status: "fix-committed"; headSha: string }
  | { status: "noop-clean"; headSha: string; diagnostic: string }
  | { status: "error"; diagnostic?: string }
  | {
      status: "rematerialize-failed";
      blockerKind: PreMergeAutofixRematerializeBlockerKind;
      diagnostic: string;
    }
  | { status: "claim-failed"; diagnostic: string };

/**
 * Injectable seam for the bounded pre-merge auto-fix attempt (#359, #747).
 * Parameters: the **auto-fixable** (allowlisted) ReviewFinding objects, the
 * issue title (for the fix prompt), and the delta review comment body scoped
 * to those findings. Called by `enforceReviewShaGate` only when (a) the
 * category partition yields a non-empty auto-fixable subset and (b) no prior
 * auto-fix commit / durable attempt or noop-clean marker is present.
 * Residual non-allowlisted findings are never passed into this seam.
 *
 * `claimAttempt` (#787, spec pre-merge-fix-round): the caller's durable
 * attempt-charge callback (posts the attempt-started marker). The seam MUST
 * invoke and await it only after every preflight step — worktree lookup,
 * rematerialization, and the clean-tree check — has succeeded, immediately
 * before invoking the implementer, so a preflight failure never consumes the
 * one-attempt bound. A false/throwing claim MUST NOT invoke the implementer
 * ("claim-failed").
 */
export type AttemptPreMergeAutoFixFn = (
  blockingFindings: ReviewFinding[],
  issueTitle: string,
  reviewComment: string,
  claimAttempt?: () => Promise<boolean>,
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
 *   - security, scope, product-judgment-required, data-loss, observability,
 *     `spec-divergence` without `code-behind-spec` direction (or with
 *     `spec-behind-code` — that is a delta/spec repair path, not implementer
 *     autofix), and any absent/empty/unrecognized token (fail-closed for that
 *     finding). Co-batched residual findings do **not** veto auto-fix of a
 *     non-empty allowlisted subset (#747 partition); pure residual-only batches
 *     still skip the harness.
 *
 * Directional exception (#factory dogfood 2026-07-31):
 *   - `spec-divergence` + `spec_divergence_direction: code-behind-spec` is
 *     **auto-fixable**. The active acceptance criteria already require the
 *     behavior; the implementer must change code — parking for human
 *     disposition is a factory defect, not product judgment.
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
 * True iff a blocking finding is eligible for the bounded pre-merge auto-fix:
 * - category in {@link PRE_MERGE_AUTOFIX_CATEGORIES} (`correctness`,
 *   `missing-dep`, `concurrency`), or
 * - `spec-divergence` with structured direction `code-behind-spec` (code must
 *   catch the already-authoritative acceptance criteria).
 *
 * Absent/empty/unknown category → false (fail-closed: auto-fix only on positive
 * allowlisted signal). `spec-behind-code` and direction-less `spec-divergence`
 * remain residual. (#359, #680, factory dogfood)
 */
export function isAutoFixableFinding(f: ReviewFinding): boolean {
  const cat = (f.category ?? "").toLowerCase().trim();
  if (PRE_MERGE_AUTOFIX_CATEGORY_SET.has(cat)) return true;
  if (cat === "spec-divergence") {
    return f.spec_divergence_direction === "code-behind-spec";
  }
  return false;
}

/**
 * Reconstruct minimal {@link ReviewFinding} objects from a durable review /
 * delta comment so residual re-entry can partition for auto-fix without a
 * fresh reviewer invocation (#768). Uses the ReviewArtifact `blockingFindings`
 * extension (surface = `path|category`) plus body-level direction markers.
 * Does not invent severity below high when missing.
 */
export function reconstructFindingsForResidualAutofix(
  commentBody: string,
): ReviewFinding[] {
  const artifact = extractReviewArtifact(commentBody);
  if (!artifact?.blockingFindings?.length) return [];
  const bodyDirection = extractSpecDivergenceDirection(commentBody);
  return artifact.blockingFindings.map((bf) => {
    const surface = bf.surface ?? "";
    const pipe = surface.lastIndexOf("|");
    const file = pipe >= 0 ? surface.slice(0, pipe) : surface || undefined;
    const category = pipe >= 0 ? surface.slice(pipe + 1) : undefined;
    const sevRaw = (bf.severity ?? "high").toLowerCase();
    const severity =
      sevRaw === "critical" || sevRaw === "high" || sevRaw === "medium" || sevRaw === "low"
        ? sevRaw
        : "high";
    const f: ReviewFinding = {
      severity,
      title: bf.title || `Finding ${bf.key}`,
      body:
        `Reconstructed from durable pre-merge residual (key ${bf.key}) for ` +
        `auto-fix re-entry. Original review comment is the source of truth.`,
      confidence: typeof bf.confidence === "number" ? bf.confidence : 0.9,
      recommendation: "Resolve per the recorded review finding.",
      category,
      file: file || undefined,
    };
    if (category === "spec-divergence" && bodyDirection) {
      f.spec_divergence_direction = bodyDirection;
    }
    return f;
  });
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
 * `claimAttempt` (#787): optional durable attempt-charge callback, awaited
 * only after the clean-tree/reattach preflight, immediately before the
 * harness — false/throw returns "claim-failed" without invoking the harness.
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
  repairIdentity: { commitSubjectPrefix?: string; salvageLabel?: string } = {},
  claimAttempt?: () => Promise<boolean>,
  /** #857: when set, head-moving auto-fix runs under candidate-integrity. */
  integrity?: PreMergeAutoFixIntegrityOpts,
): Promise<PreMergeAutoFixResult> {
  const harness = cfg.harnesses?.implementer;
  if (!harness) return { status: "error" };

  // Pre-fix cleanliness check: a dirty worktree before the attempt fails closed
  // (#235). Rollback uses `git reset --hard`; running that over pre-existing dirty
  // work would irreversibly discard it.
  const preStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preStatus.code !== 0 || preStatus.stdout.trim() !== "") return { status: "error" };

  const prompt = buildFixPrompt({
    cfg,
    issueNumber,
    title: issueTitle,
    reviewFindings: findingsText,
    fixRound: 1,
    pipelineRunId,
  });

  const runBody = () =>
    // Shared implementer-round skeleton (#629): reattach → headBefore → invoke →
    // salvage on confirmed no-new-commit → stage-owned amend/push/noop-clean.
    runHarnessRound({
    wtPath: wt.path,
    issueNumber,
    pipelineRunId,
    salvageLabel: repairIdentity.salvageLabel ?? PRE_MERGE_AUTOFIX_SALVAGE_LABEL,
    // Reattach detached HEAD before the harness commits (#359 Finding 3): commits
    // made in a detached worktree don't move the branch ref, so the later push
    // would silently leave the PR branch unchanged while returning success.
    reattach: { wt, issueNumber },
    // Durable one-attempt claim (#787): charge the attempt only after every
    // preflight above (clean tree, reattach) has succeeded, immediately before
    // the implementer runs — a preflight failure must not consume the single
    // repair unit. A failed claim must not invoke the harness: fail closed so a
    // later entry at the same head can retry the claim (no unbound attempt).
    beforeInvoke: async () => {
      if (!claimAttempt) return;
      let claimed = false;
      try {
        claimed = await claimAttempt();
      } catch {
        claimed = false;
      }
      if (!claimed) {
        return {
          abort: {
            status: "claim-failed" as const,
            diagnostic:
              "durable pre-merge auto-fix attempt marker could not be recorded; implementer not invoked",
          },
        };
      }
    },
    // Salvage (#547): attempt only when we've confirmed the harness left no new
    // commit — whether it crashed/timed out or reported success without
    // committing. A commit that exists alongside extra leftover dirt (checked
    // below) is an ambiguous case out of scope (design decision 2) and keeps the
    // existing fail-closed rollback unchanged.
    shouldAttemptSalvage: ({ confirmedNoNewCommit }) => confirmedNoNewCommit,
    invoke: () =>
      invokeFn(harness, wt.path, prompt, {
        timeoutSec: cfg.fix_timeout,
        model: cfg.models?.fix ?? null,
        sandbox: cfg.harness_sandbox,
      }),
    onReattachFailed: () => ({ status: "error" as const }),
    deps: {
      gitHead: async (cwd) =>
        (await gitFn(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim(),
      reattach: async (worktree, issue) => reattachIfDetached(worktree, issue, gitFn),
      salvage: salvageFn,
    },
    afterRound: async (ctx) => {
      const result = ctx.invokeResult;
      const headBefore = ctx.headBefore;
      // hasNewCommitHarness uses pre-salvage equality: when salvage ran, either
      // it created a commit (salvaged) or confirmed no-new-commit. When salvage
      // did not run, confirmedNoNewCommit is false only if HEAD advanced.
      const hasNewCommitHarness = Boolean(
        ctx.headAfter && headBefore && (ctx.salvaged || !ctx.confirmedNoNewCommit),
      );

      if (!ctx.salvaged) {
        // #553 / #698: the harness ran and left the inspected worktree clean with
        // no new commit — nothing for salvage to recover. Name the worktree so the
        // operator can tell this apart from a silent no-op; return **noop-clean**
        // (not a generic error) so the SHA gate re-verifies findings against HEAD
        // rather than hard-blocking solely because no commit was produced.
        const cleanNoRecoverableWork = ctx.confirmedNoNewCommit && ctx.salvageFoundNothing;
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
        `${repairIdentity.commitSubjectPrefix ?? PRE_MERGE_AUTOFIX_PREFIX} for #${issueNumber}`,
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
    },
  });

  if (!integrity) {
    return runBody();
  }

  const scope =
    integrity.declared_scope ??
    (integrity.finding_paths
      ? declaredScopeFromFindingPaths(integrity.finding_paths, "pre-merge autofix findings")
      : { paths: [], directories: [], reason: "pre-merge autofix empty scope" });

  const integrityResult = await runCoveredCandidateMutation(
    {
      storeRoot: integrity.storeRoot,
      subject: integrity.subject,
      mutation_method: integrity.mutation_method ?? "pre_merge_autofix",
      declared_scope: scope,
      base_ref: integrity.base_ref,
      worktreePath: wt.path,
      gitInWorktree: gitFn,
      resolveBaseSha: integrity.resolveBaseSha,
      resolveCandidateSha: integrity.resolveCandidateSha,
      emitEvent: integrity.emitEvent,
      storeDeps: integrity.storeDeps,
      mutation_id: integrity.mutation_id,
      engine_version: integrity.engine_version,
    },
    runBody,
  );

  if (integrityResult.aborted) {
    return {
      status: "error",
      diagnostic: `candidate-integrity pre-persist aborted auto-fix: ${integrityResult.abort_reason ?? "unknown"}`,
    };
  }

  const body = integrityResult.mutation_result;
  if (!body) {
    return {
      status: "error",
      diagnostic: integrityResult.mutation_error ?? "auto-fix incomplete under integrity",
    };
  }

  // Scope expansion / unverified: force error so readiness cannot carry forward.
  if (
    integrityResult.classification === "scope_expansion" ||
    integrityResult.classification === "unverified"
  ) {
    return {
      status: "error",
      diagnostic:
        `candidate-integrity ${integrityResult.classification}: ` +
        `${integrityResult.disposition.invalidation_reason ?? integrityResult.classification}`,
    };
  }

  // expected_scoped_change / semantically_equivalent: return body; SHA gate
  // requires fresh review via integrity invalidation records for scoped change.
  return body;
}
