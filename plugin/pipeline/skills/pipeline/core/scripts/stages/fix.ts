// Fix stages: fix-1 → review-2, fix-2 → pre-merge.
//
// Steps:
//   1. Find the latest review comment for this round (review-N) on the issue.
//   2. Run the IMPLEMENTER harness in the existing worktree with the fix prompt
//      + the verbatim review findings.
//   3. Verify new commits exist; push.
//   4. Transition fix-N → review-N+1 (or pre-merge for round 2).

import {
  findLatestCommentMatching,
  getGhActor,
  getIssueDetail,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { findUnacknowledgedComments } from "../issue-context-snapshot.ts";
import { buildTrustedOverrideComments } from "../review-policy.ts";
import { invoke } from "../harness.ts";
import { branchName, getOnDiskForIssue, gitInWorktree, reattachIfDetached } from "../worktree.ts";
import { buildFixPrompt } from "../prompts/index.ts";
import { runFormatGate, runFormatAndTestGates } from "./format-gate.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import { makePipelineRunId } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import * as openspec from "../openspec.ts";
import { openspecContextFromDiff } from "../openspec.ts";
import type { ValidateResult } from "../openspec.ts";
import { makePromptRecord, recordPrompt } from "../evidence-bundle.ts";
import { includeLockfileSideEffects, type LockfileSideEffectsDeps } from "../lockfile-side-effects.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";
import { extractBlockingKeysMarker, extractReviewedSha } from "./review.ts";
import type { RunStoreDeps } from "../run-store.ts";
import {
  computeBranchDeveloperCommits,
  enforceSpecConsistencyGuard,
  performBoundedSpecRepair,
  type FixCommit,
  type InvokeFn,
  type SpecConsistencyDeps,
  type ValidateFn,
} from "../openspec-consistency.ts";

export interface AdvanceFixOpts {
  dryRun?: boolean;
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
  /** Evidence-bundle run/state dir (#147); when set, the test gate records its
   *  command runs under this round's stage. Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log (#302). Undefined → event appends disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events (#302). */
  runStoreDeps?: RunStoreDeps;
}

/** Injectable seams for {@link advanceFix} — overridable in tests. */
export interface AdvanceFixDeps {
  /** Files changed between two SHAs (defaults to `git diff --name-only from to`). */
  gitDiffFiles?: (wtPath: string, from: string, to: string) => Promise<string[]>;
  /** Validate one OpenSpec change (defaults to `openspec.validateItem`). */
  openspecValidateItem?: (wtPath: string, id: string) => Promise<ValidateResult>;
  /** Branch commits used by the stale OpenSpec-delta guard. */
  branchDeveloperCommits?: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
  /** Format/lint gate runner (#182); defaults to runFormatGate. */
  runFormatGate?: typeof runFormatGate;
  /** Format+test gate runner (defaults to runFormatAndTestGates); injectable for tests. */
  _runFormatAndTestGates?: typeof runFormatAndTestGates;
  /**
   * Injectable harness invoker for the internal bounded-repair closure (#356).
   * Defaults to `invoke` from harness.ts. Tests inject this to exercise the
   * production-path repair closure (when `attemptBoundedRepair` is not in the
   * consistency deps and `cfg.harnesses.implementer` is set) without spawning
   * a real harness.
   */
  invokeFn?: InvokeFn;
  /**
   * GitHub login of the pipeline actor used to filter review comments to
   * trusted-authored entries before extracting spec-divergence signals (#356
   * finding 1). When absent, `advanceFix` resolves it via `getGhActor()` at
   * runtime. Tests inject a literal string to avoid a real GitHub API call.
   */
  trustedReviewAuthor?: string | null;
  /**
   * Lock-file side-effect inclusion deps (#358). Folds uncommitted lock-file
   * changes into the round's HEAD commit before the format/test gates run.
   * When absent, the real implementation is used. Tests inject fakes so no
   * real git subprocess is invoked.
   */
  lockfileSideEffects?: LockfileSideEffectsDeps;
  /**
   * Verifies that `sha` is already present on `origin/<branch>` (#349 review-1
   * finding 1). Used to confirm an external-commit advance decision was truly
   * applied outside the fix harness (pushed to the remote by a human) rather
   * than being a local-only leftover commit from a prior fix-harness run that
   * was blocked before it could push. Defaults to `isCommitOnRemote`. Tests
   * inject a fake so no real git fetch/subprocess runs.
   */
  verifyCommitOnRemote?: (wtPath: string, branch: string, sha: string) => Promise<boolean>;
}

/**
 * Blocked Outcome for a fix-harness invocation failure (#302). Carries
 * `blockerKind: "harness-failure"` so the run-artifact emitter records the
 * intervention as `reviewer-unavailable` rather than falling back to the
 * `needs-human` → `product-judgment-required` default. Shared with the unit
 * test so the propagation is verified through the real construction, not a
 * re-implementation in the test body.
 */
export function fixHarnessFailureOutcome(reason: string): Outcome {
  return { advanced: false, status: "blocked", reason, blockerKind: "harness-failure" };
}

/** Decision from {@link decideExternalCommitAdvance} — either advance to the round's next stage, or fall through to the existing no-commits block. */
export type ExternalCommitAdvanceDecision =
  | { advance: true; to: Stage; reviewSha: string }
  | { advance: false; reviewSha: string | null };

/**
 * #349: when a fix round's harness produces no new commit and salvage finds
 * nothing, decide whether to advance (a human already pushed the fix the
 * reviewer asked for) or fall through to the existing `no-commits` block.
 *
 * Filters `comments` to the trusted pipeline actor before extracting the
 * reviewed SHA, mirroring the trust pattern used by the pre-merge SHA gate
 * and the OpenSpec consistency guard — an untrusted commenter must not be
 * able to forge a stale reviewed-SHA marker to force an advance. Fails
 * closed (does not advance) when the actor cannot be resolved (`null`), when
 * no trusted review SHA is extractable, or when HEAD already equals it.
 */
export function decideExternalCommitAdvance(
  comments: { author: string; body: string }[],
  actor: string | null,
  round: 1 | 2,
  headAfter: string,
): ExternalCommitAdvanceDecision {
  const commentsToSearch = typeof actor === "string"
    ? comments.filter((c) => c.author === actor)
    : [];
  const reviewShaResult = extractReviewedSha(commentsToSearch, round);
  const reviewSha = reviewShaResult?.sha ?? null;
  if (reviewSha && headAfter && reviewSha !== headAfter) {
    return { advance: true, to: round === 1 ? "review-2" : "pre-merge", reviewSha };
  }
  return { advance: false, reviewSha };
}

/**
 * Whether HEAD moving past the reviewed SHA (#349) was proven to have been
 * applied outside the fix harness, and so may skip the harness-prescribed
 * commit-subject check (`enforceExternalCommitGate`) rather than the normal
 * fix-round gate (`enforceFixCommitGate`).
 *
 * A commit already present on `origin/<branch>` cannot be the local-only
 * leftover from a prior fix-harness run that was blocked before it pushed
 * (#349 review-1 finding 1: that path never reaches `git push`, so an
 * unpushed bad-subject commit staying in the worktree must NOT get the
 * subject exemption on a later no-op fix run). Fails closed to "harness"
 * (the stricter gate) when the remote check cannot confirm the commit is
 * already on the remote branch.
 */
export function resolveFixCommitGateMode(
  decision: ExternalCommitAdvanceDecision,
  verifiedOnRemote: boolean,
): "external" | "harness" {
  return decision.advance && verifiedOnRemote ? "external" : "harness";
}

/**
 * Default `verifyCommitOnRemote` implementation (#349 review-1 finding 1):
 * fetches `origin/<branch>` and checks whether `sha` is already an ancestor
 * of it. Fails closed (returns false) on any fetch/lookup error so an
 * unverifiable commit never gets the subject-check exemption.
 */
export async function isCommitOnRemote(wtPath: string, branch: string, sha: string): Promise<boolean> {
  const fetch = await gitInWorktree(wtPath, ["fetch", "origin", branch], { ignoreFailure: true });
  if (fetch.code !== 0) return false;
  // Check against FETCH_HEAD (the tip the fetch just retrieved), not the
  // origin/<branch> tracking ref — after a failed or partial fetch a stale
  // cached tracking ref could otherwise prove remote presence (#349 pre-merge
  // finding 0b679c48).
  const check = await gitInWorktree(
    wtPath,
    ["merge-base", "--is-ancestor", sha, "FETCH_HEAD"],
    { ignoreFailure: true },
  );
  return check.code === 0;
}

export async function advanceFix(
  cfg: PipelineConfig,
  issueNumber: number,
  round: 1 | 2,
  opts: AdvanceFixOpts = {},
  deps: AdvanceFixDeps = {},
): Promise<Outcome> {
  const stage: Stage = round === 1 ? "fix-1" : "fix-2";
  const harness = cfg.harnesses.implementer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${harness}`);

  const wt = await getOnDiskForIssue(cfg, issueNumber);
  if (!wt) {
    await setBlocked(cfg, issueNumber, "No worktree found. Cannot apply fixes.", stage, "worktree-missing");
    return { advanced: false, status: "blocked", reason: "No worktree found. Cannot apply fixes.", blockerKind: "worktree-missing" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);

  // Acknowledgement gate: block when human comments after the revised plan
  // have not been acknowledged via re-plan or override (#318 review-2 finding 3).
  // Only trusted-author scope-override comments may act as ack anchors (#318 fix c5825398).
  const fixActor = await getGhActor();
  const trustedForAck = buildTrustedOverrideComments(detail.comments, fixActor, cfg.trusted_override_actors);
  const unacknowledged = findUnacknowledgedComments(detail.comments, trustedForAck);
  if (unacknowledged.length > 0) {
    console.log(`[pipeline] #${issueNumber}: ${unacknowledged.length} unacknowledged human comment(s) detected before ${stage} — blocking`);
    // Deduplicate: only post the warning when no prior warning exists.
    const warningExists = detail.comments.some(
      (c) => c.body.trimStart().startsWith('## Pipeline: New human input detected'),
    );
    if (!warningExists) {
      const commentLines = unacknowledged
        .map((c) => `- **@${c.author}** (${c.createdAt})`)
        .join('\n');
      await postComment(
        cfg,
        issueNumber,
        `## Pipeline: New human input detected\n\n${unacknowledged.length} human comment(s) were posted after the latest plan and have not been acknowledged:\n\n${commentLines}\n\nThe pipeline will not proceed to ${stage} until these comments are acknowledged. Either trigger a re-plan or post an explicit scope-override comment.`,
      );
    }
    await setBlocked(cfg, issueNumber, `${unacknowledged.length} unacknowledged human comment(s) after the latest plan — re-plan or post a scope override to proceed.`, stage, "needs-human");
    return { advanced: false, status: "blocked", reason: "unacknowledged human input", blockerKind: "needs-human" };
  }

  const findings = extractBlockingReviewFindings(detail.comments, round);
  if (!findings) {
    // No findings → just advance.
    const next: Stage = round === 1 ? "review-2" : "pre-merge";
    await transition(
      cfg,
      issueNumber,
      stage,
      next,
      "No review findings found to address. Advancing.",
    );
    return { advanced: true, from: stage, to: next, summary: "no findings to address" };
  }

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would invoke ${harness} to fix findings`);
    return {
      advanced: true,
      from: stage,
      to: round === 1 ? "review-2" : "pre-merge",
      summary: "[dry-run]",
    };
  }

  // Ensure the worktree is on its pipeline branch before the harness commits.
  // The review stage may have checked out a specific SHA (detached HEAD); any
  // commits made while detached don't move the branch ref, so the later push
  // would silently leave the PR branch unchanged.
  const reattach = await reattachIfDetached(wt, issueNumber);
  if (!reattach.ok) {
    await setBlocked(
      cfg, issueNumber,
      `Failed to reattach detached worktree to pipeline branch: ${reattach.stderr}`,
      stage, "needs-human",
    );
    return { advanced: false, status: "blocked", reason: "reattach failed" };
  }

  // Capture HEAD before so we can detect non-commits. Mutable: the external-commit
  // advance path (#349) rebases this to the reviewed SHA so the commit/openspec/
  // format/test gates below validate the externally-applied commit(s) rather than
  // seeing a no-op diff.
  let headBefore = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();

  // Use branch-diff to identify the OpenSpec change this branch introduced rather
  // than changes[0], which may be an unrelated pre-existing change in the worktree.
  const branchDiff = await gitInWorktree(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  const diffPaths = branchDiff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const specContext = openspecContextFromDiff(cfg, wt.path, diffPaths);
  const prompt = buildFixPrompt({
    cfg,
    issueNumber,
    title: detail.title,
    reviewFindings: findings,
    priorReviewHistory: extractAllReviewFindingsHistory(detail.comments, round),
    fixRound: round,
    pipelineRunId,
    specContext,
  });
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      stage,
      makePromptRecord(`fix-${round}`, harness, prompt),
    ).catch(() => {});
  }
  const model = opts.model ?? cfg.models.fix;
  const result = await invoke(harness, wt.path, prompt, {
    timeoutSec: cfg.fix_timeout,
    model,
    reasoningEffort: cfg.effort?.fix,
    sandbox: cfg.harness_sandbox,
    accounting: opts.runDir
      ? {
          runDir: opts.runDir,
          runStoreDeps: opts.runStoreDeps,
          issue: issueNumber,
          stage,
          modelSlot: "fix",
          model,
        }
      : undefined,
  });

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlocked(cfg, issueNumber, `Fix harness (${harness}) failed: ${reason}`, stage, "harness-failure");
    return fixHarnessFailureOutcome(reason);
  }

  // Set when the no-new-commits path (#349) decides the reviewed SHA is stale
  // (fix already applied externally); carries the decided target stage through
  // to the final transition once the normal gates below have validated it.
  let externalAdvance: ExternalCommitAdvanceDecision & { advance: true } | null = null;
  // Which commit-message gate to run when externalAdvance is set (#349 review-1
  // finding 1): "external" only once verifyCommitOnRemote proves the commit(s)
  // already reached origin outside the fix harness; otherwise "harness" keeps
  // the subject-prescribed gate so an unpushed leftover commit from a prior
  // blocked fix run still blocks, exactly as before #349.
  let commitGateMode: "external" | "harness" = "harness";

  let headAfter = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();
  if (headBefore && headAfter && headBefore === headAfter) {
    // #131: the harness reported success without committing — salvage real
    // uncommitted work into a commit instead of discarding it. A clean
    // worktree (nothing salvaged) keeps the existing block path.
    const salvaged = await trySalvageUncommittedWork(
      wt.path,
      issueNumber,
      pipelineRunId,
      fixSalvageStageLabel(round, issueNumber),
    );
    if (!salvaged) {
      // #349: before blocking, check whether a human already pushed the fix the
      // reviewer asked for. When HEAD is past the SHA the reviewer last saw,
      // treat this as "fix already applied externally" and advance instead of
      // blocking — recovering otherwise requires a manual label-advance for
      // work that is already done. Fail closed (block) when no trusted review
      // SHA is extractable, or when HEAD equals it (genuinely nothing done).
      const decision = decideExternalCommitAdvance(detail.comments, fixActor, round, headAfter);
      if (decision.advance) {
        // #349 review-2: HEAD moving past the reviewed SHA only proves *some*
        // local commit exists after review — it does not prove that commit
        // ever passed the pre-push gates (e.g. an earlier fix run committed
        // locally, then blocked at the commit-message/openspec/format/test
        // gate before pushing). Do NOT push directly here. Instead, rebase
        // `headBefore` to the reviewed SHA and fall through to the normal
        // gate sequence below, so the externally-applied commit(s) are
        // validated exactly like a harness-authored commit before any push.
        headBefore = decision.reviewSha;
        externalAdvance = decision;
        // #349 review-1 finding 1: confirm the commit(s) already reached the
        // remote branch before granting the subject-check exemption below —
        // otherwise a bad-subject commit left over from a prior blocked fix
        // run (never pushed) would bypass the #68 prompt-compliance gate on
        // this no-op retry.
        const verifyOnRemote = deps.verifyCommitOnRemote ?? isCommitOnRemote;
        const verifiedOnRemote = await verifyOnRemote(
          wt.path,
          branchName(issueNumber, wt.slug),
          headAfter,
        );
        commitGateMode = resolveFixCommitGateMode(decision, verifiedOnRemote);
      } else {
        const noCommitsMsg = `${stage} reported success but produced no new commits.`;
        await setBlocked(cfg, issueNumber, noCommitsMsg, stage, "no-commits");
        return { advanced: false, status: "blocked", reason: noCommitsMsg, blockerKind: "no-commits" };
      }
    } else {
      headAfter = (await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();
    }
  }

  // ---- Verify fix-round commit message format (#68) ----
  // Externally-applied commits (#349) are exempt from the prescribed-subject
  // check: that pattern verifies fix-harness prompt compliance, and a human
  // pushing the requested fix cannot be required to use the harness's subject.
  // The exemption only applies once commitGateMode is "external", i.e. the
  // commit(s) were confirmed already on the remote (#349 review-1 finding 1) —
  // otherwise the normal fix gate runs so an unpushed leftover commit still
  // blocks. The external variant keeps the range-level safety scan; the
  // OpenSpec, lockfile, format/test, and consistency gates below still apply
  // unchanged.
  if (headBefore) {
    const commitCheck = externalAdvance && commitGateMode === "external"
      ? await enforceExternalCommitGate(wt.path, headBefore)
      : await enforceFixCommitGate(round, issueNumber, wt.path, headBefore);
    if (!commitCheck.ok) {
      await setBlocked(cfg, issueNumber, commitCheck.reason, stage, "needs-human");
      return { advanced: false, status: "blocked", reason: commitCheck.reason };
    }
  }

  // ---- OpenSpec spec-delta validation (#106): if the harness revised any spec
  //      delta files this round, validate the change before push/advance ----
  if (headBefore && headAfter && headBefore !== headAfter) {
    const specCheck = await enforceOpenspecSpecDeltaValidation(wt.path, headBefore, headAfter, {
      gitDiffFiles: deps.gitDiffFiles ?? defaultGitDiffFiles,
      openspecValidateItem: deps.openspecValidateItem ?? openspec.validateItem,
    });
    if (!specCheck.ok) {
      await setBlocked(cfg, issueNumber, specCheck.reason, stage, "openspec-invalid");
      return { advanced: false, status: "blocked", reason: specCheck.reason };
    }
  }

  // ---- Lock-file side-effect inclusion (#358) ----
  // After the harness commits source changes it may leave lock-file side-effects
  // (package-lock.json / yarn.lock / pnpm-lock.yaml) uncommitted. Fold them into
  // HEAD before the format/test gates so those gates see a clean worktree.
  if (headBefore && headAfter && headBefore !== headAfter) {
    const lockResult = await includeLockfileSideEffects(wt.path, deps.lockfileSideEffects ?? {});
    if (lockResult.included) {
      console.log(
        `[pipeline] #${issueNumber}: folded uncommitted lock file(s) into round commit: ${lockResult.paths.join(", ")}`,
      );
    }
  }

  // ---- Format + test gates to convergence (#182, #15) ----
  // The format/lint gate runs BEFORE the test gate and both re-run until neither
  // produces a new commit, so the pushed fix state is simultaneously formatted
  // and tested — no auto-format commit ships untested, no test-fix commit unformatted.
  const fmtGateFn = deps.runFormatGate ?? runFormatGate;
  const gatesRunner = deps._runFormatAndTestGates ?? runFormatAndTestGates;
  const gates = await gatesRunner(
    cfg, issueNumber, wt.path, stage, pipelineRunId, opts.stateDir,
    { runFormatGate: fmtGateFn },
    opts.runDir, opts.runStoreDeps,
  );
  if (!gates.ok) {
    await setBlocked(cfg, issueNumber, gates.reason, stage,
      gates.source === "test" ? "test-gate-exhausted" : "needs-human");
    return { advanced: false, status: "blocked", reason: gates.reason,
      blockerKind: gates.source === "test" ? "test-gate-exhausted" : "needs-human" };
  }

  const postGateDiff = await gitInWorktree(
    wt.path,
    ["diff", "--name-only", `origin/${cfg.base_branch}...HEAD`],
    { ignoreFailure: true },
  );
  const activeChangeIds = openspec
    .changeIdsFromPaths(postGateDiff.stdout.split("\n").map((s) => s.trim()).filter(Boolean))
    .filter((id) => openspec.changeDirExists(wt.path, id));
  // Resolve the trusted review-comment author for the comment-author filter (#356 finding 1).
  // When the dep is provided (including null), use it directly so tests avoid a real network call.
  // In production (dep absent), fail closed if the actor cannot be resolved: proceeding with
  // null would disable the author filter and allow untrusted commenters to forge review markers.
  let trustedReviewAuthor: string | null;
  if ("trustedReviewAuthor" in deps) {
    trustedReviewAuthor = deps.trustedReviewAuthor ?? null;
  } else {
    trustedReviewAuthor = await getGhActor();
    if (trustedReviewAuthor === null) {
      const reason =
        "cannot resolve the pipeline actor identity (gh auth may be degraded) — " +
        "trusted review-comment filtering requires a known actor; check `gh auth status`";
      await setBlocked(cfg, issueNumber, reason, stage, "needs-human");
      return { advanced: false, status: "blocked", reason, blockerKind: "needs-human" };
    }
  }
  // enforceFixOpenspecConsistency creates the bounded-repair production closure
  // internally when cfg.harnesses.implementer is set (#356 finding 1).
  const consistencyGuard = await enforceFixOpenspecConsistency(
    cfg,
    issueNumber,
    stage,
    wt.path,
    activeChangeIds,
    {
      ...deps,
      pipelineRunId,
      gitFn: gitInWorktree,
      getHeadSha: async (p) => {
        const r = await gitInWorktree(p, ["rev-parse", "HEAD"], { ignoreFailure: true });
        return r.stdout.trim() || null;
      },
      trustedReviewAuthor,
    },
  );
  if (consistencyGuard) return consistencyGuard;

  const branch = branchName(issueNumber, wt.slug);
  const push = await gitInWorktree(wt.path, ["push", "origin", branch], { ignoreFailure: true });
  if (push.code !== 0) {
    const pushFailedMsg = `Git push failed after fix: ${push.stderr.trim()}`;
    await setBlocked(cfg, issueNumber, pushFailedMsg, stage, "push-failed");
    return { advanced: false, status: "blocked", reason: pushFailedMsg, blockerKind: "push-failed" };
  }

  if (externalAdvance) {
    const msg =
      `${stage}: the fix harness produced no new commits, but HEAD (${headAfter}) ` +
      `differs from the SHA the reviewer last reviewed (${externalAdvance.reviewSha}) — the fix ` +
      `was already applied externally and has now passed the same pre-push gates as a normal ` +
      `fix commit. Advancing to ${externalAdvance.to}.`;
    await transition(cfg, issueNumber, stage, externalAdvance.to, msg);
    return { advanced: true, from: stage, to: externalAdvance.to, summary: "fix already applied externally" };
  }

  if (round === 1) {
    await transition(
      cfg,
      issueNumber,
      "fix-1",
      "review-2",
      `Fix round 1 complete. Review 1 findings addressed. Ready for adversarial review.`,
    );
    return {
      advanced: true,
      from: "fix-1",
      to: "review-2",
      summary: "fixes pushed",
    };
  } else {
    await transition(
      cfg,
      issueNumber,
      "fix-2",
      "pre-merge",
      `Fix round 2 complete. Adversarial review findings addressed. Ready for pre-merge gate.`,
    );
    return {
      advanced: true,
      from: "fix-2",
      to: "pre-merge",
      summary: "fixes pushed",
    };
  }
}

// ---------------------------------------------------------------------------
// Salvage stage label (#131) — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Stage label for a salvaged fix-round commit. Includes the round's prescribed
 * commit subject so the salvage commit body satisfies `enforceFixCommitGate`'s
 * message pattern (matched against subject + body) and the salvaged run
 * proceeds to the test gate. Exported so tests can pin the label against the
 * gate's actual pattern (drift between the two fails the contract test).
 */
export function fixSalvageStageLabel(round: 1 | 2, issueNumber: number): string {
  return `fix-${round} (prescribed commit: "fix: address review ${round} findings (#${issueNumber})")`;
}

// ---------------------------------------------------------------------------
// Fix-commit format gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Returns the `VerifyDeps`-compatible config for a fix-round commit check and
 * exposes the gate as a standalone injectable function so tests can exercise
 * it without mocking the entire `advanceFix` call chain.
 */
export async function enforceFixCommitGate(
  round: 1 | 2,
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: new RegExp(
          `fix:\\s+address review ${round} findings \\(#${issueNumber}\\)`,
          "i",
        ),
        description: `Fix round ${round} commit message does not match prescribed format`,
      },
    },
    deps,
  );
}

/**
 * External-commit variant of the fix-round commit gate (#349). Commits applied
 * outside the fix harness (a human pushing the fix the reviewer asked for) are
 * not required to carry the harness-prescribed `fix: address review N findings`
 * subject — that check verifies prompt compliance, not code quality. The empty
 * config still runs verifyHarnessCommits' range-level safety scan (node_modules
 * inclusion) over reviewSha..HEAD.
 */
export async function enforceExternalCommitGate(
  wtPath: string,
  reviewSha: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(wtPath, reviewSha, {}, deps);
}

// ---- pure helpers ----

export function extractReviewFindings(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const marker = `## Review ${round}`;
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) =>
      b.startsWith(marker) &&
      (b.includes("needs-attention") ||
        b.includes("### Findings") ||
        b.toUpperCase().includes("REQUEST_CHANGES") ||
        b.toUpperCase().includes("REQUEST CHANGES")),
  );
  return m?.body ?? "";
}

/**
 * All prior review-{round} finding comments on the issue (oldest-first, excluding
 * the most recent, which is already supplied verbatim as the current findings),
 * joined with dividers. Gives the fix harness the full cross-round history so it
 * does not revert an earlier fix and re-trigger a finding that was already
 * resolved (the #275 publicly_accessible oscillation). Returns "" when there is
 * at most one such comment (nothing prior to show).
 */
export function extractAllReviewFindingsHistory(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const marker = `## Review ${round}`;
  const matches = comments.filter(
    (c) =>
      c.body.startsWith(marker) &&
      (c.body.includes("needs-attention") ||
        c.body.includes("### Findings") ||
        c.body.toUpperCase().includes("REQUEST_CHANGES") ||
        c.body.toUpperCase().includes("REQUEST CHANGES")),
  );
  if (matches.length <= 1) return "";
  return matches
    .slice(0, -1)
    .map((c, i) => `--- Prior review ${round} attempt ${i + 1} ---\n${c.body}`)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Mixed-verdict filtering: strip advisory findings from the fix prompt (#236)
// ---------------------------------------------------------------------------

/**
 * Removes non-blocking (advisory) findings from a review comment body so the
 * fix prompt's "Address EACH finding" instruction applies only to genuine
 * blockers. Advisory findings are identified via the formatter-controlled
 * `<!-- pipeline-advisory-ordinals: N,M -->` footer marker, which records the
 * 1-indexed positions of findings with blocking:false. This is fully
 * formatter-owned — no reviewer-controlled text can inject into it.
 *
 * Falls back to key-set membership (`blockingKeys`) for legacy comments that
 * pre-date the ordinals marker.
 *
 * Findings that carry no `override-key` token pass through unchanged (safety).
 * Returns the body unchanged when no advisory findings are present.
 * Exported for direct unit testing.
 */
export function filterToBlockingFindings(body: string, blockingKeys: Set<string>): string {
  const FINDINGS_HEADER = "\n### Findings";
  const OVERRIDE_KEY_RE = /`override-key: ([0-9a-f]{8})`/;
  // The pipeline-blocking-keys comment is a reliable footer boundary marker —
  // it is always emitted when blockingKeys is supplied to formatReviewComment,
  // and the footer text line immediately precedes it (separated by a single \n,
  // not \n\n, so the \n\n-based section-end detection below would miss it).
  const PK_MARKER = "\n<!-- pipeline-blocking-keys:";

  const findingsIdx = body.indexOf(FINDINGS_HEADER);
  if (findingsIdx === -1) return body;

  const beforeFindings = body.slice(0, findingsIdx);
  const afterFindingsLine = body.slice(findingsIdx + FINDINGS_HEADER.length);

  // Separate findings content from the footer. The cfgFooter text is preceded
  // by only a single \n (not \n\n) so it ends up attached to the last finding's
  // block when splitting by blank lines. To avoid discarding the footer along
  // with an advisory finding, locate the pipeline-blocking-keys comment and
  // back up one line to find the footer boundary.
  let findingsContent: string;
  let footer: string;

  const pkIdx = afterFindingsLine.indexOf(PK_MARKER);
  if (pkIdx !== -1) {
    // footerLineStart: one \n back from the \n that starts the PK comment.
    const footerLineStart = afterFindingsLine.lastIndexOf("\n", pkIdx - 1);
    const splitAt = footerLineStart !== -1 ? footerLineStart + 1 : pkIdx;
    findingsContent = afterFindingsLine.slice(0, splitAt);
    footer = afterFindingsLine.slice(splitAt);
  } else {
    // No PK marker (should not happen when called via extractBlockingReviewFindings
    // but handled as a safe fallback).
    const nextIdx = afterFindingsLine.search(/\n\n###|\n\n\*/);
    findingsContent = nextIdx !== -1 ? afterFindingsLine.slice(0, nextIdx) : afterFindingsLine;
    footer = nextIdx !== -1 ? afterFindingsLine.slice(nextIdx) : "";
  }

  // Split on blank-line + "**N." (finding boundary) OR blank-line + "##"
  // (section boundary like "### Raw Review Output" or "### Next Steps"), so
  // those optional sections are not accidentally discarded with an advisory block.
  const blocks = findingsContent.split(/\n\n(?=\*\*\d+\.|\#\#)/);

  // Parse the formatter-controlled advisory-ordinals footer (#236 delta fix).
  // Search only the footer (after the PK_MARKER boundary) so reviewer body text
  // containing this string cannot spoof the advisory classification.
  const ordinalMatch = footer.match(/<!-- pipeline-advisory-ordinals: ([\d,]+) -->/);
  const advisoryOrdinals = ordinalMatch
    ? new Set(ordinalMatch[1].split(",").map(Number).filter((n) => n > 0))
    : new Set<number>();

  const blocking: string[] = [];
  let advisoryCount = 0;

  for (const block of blocks) {
    if (!block.trim()) continue;
    // Extract the 1-indexed ordinal from the finding title (**N. ...).
    const ordinalInBlock = /^\*\*(\d+)\./.exec(block.trimStart())?.[1];
    const ordinal = ordinalInBlock !== undefined ? parseInt(ordinalInBlock, 10) : null;
    // Ordinal-based check: advisory ordinals are stored in a formatter-controlled
    // footer, completely separate from reviewer body/recommendation text.
    if (ordinal !== null && advisoryOrdinals.has(ordinal)) {
      advisoryCount++;
      continue;
    }
    // Key-set fallback: covers legacy comments (pre-ordinals marker) where advisory
    // findings can only be identified by their key not being in blockingKeys.
    const keyMatch = block.match(OVERRIDE_KEY_RE);
    const key = keyMatch?.[1];
    if (!key || blockingKeys.has(key)) {
      blocking.push(block);
    } else {
      advisoryCount++;
    }
  }

  if (advisoryCount === 0) return body;

  const note = advisoryCount === 1
    ? "Note: 1 advisory finding was omitted (marked non-blocking by the reviewer — not required work for this fix round)."
    : `Note: ${advisoryCount} advisory findings were omitted (marked non-blocking by the reviewer — not required work for this fix round).`;

  return [
    beforeFindings,
    FINDINGS_HEADER,
    ...blocking.map(b => "\n\n" + b),
    "\n\n" + note + "\n",
    footer,
  ].join("");
}

/**
 * Like {@link extractReviewFindings} but filters advisory (non-blocking) findings
 * out of the returned body so the fix harness only sees blocking findings (#236).
 * Relies on the `pipeline-blocking-keys` marker in the review comment. Returns
 * the body unchanged when no marker is present (legacy comments) or when all
 * findings are blocking.
 */
export function extractBlockingReviewFindings(
  comments: { body: string }[],
  round: 1 | 2,
): string {
  const body = extractReviewFindings(comments, round);
  if (!body) return body;

  const blockingKeys = extractBlockingKeysMarker(body);
  if (!blockingKeys || blockingKeys.size === 0) return body;

  return filterToBlockingFindings(body, blockingKeys);
}

// ---------------------------------------------------------------------------
// OpenSpec spec-delta validation (#106) — exported for direct unit testing
// ---------------------------------------------------------------------------

async function defaultGitDiffFiles(wtPath: string, from: string, to: string): Promise<string[]> {
  const r = await gitInWorktree(wtPath, ["diff", "--name-only", from, to], { ignoreFailure: true });
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * After a fix harness runs, check whether it revised any OpenSpec spec delta
 * files (`openspec/changes/<id>/specs/**`). When it did, validate that change
 * before push. A structural validation failure blocks the fix round so the LLM
 * cannot silently commit a broken spec delta. Returns `{ ok: true }` when no
 * spec files were touched or all touched changes pass validation. Exported for
 * direct unit testing; called from `advanceFix` with injectable deps.
 */
export async function enforceOpenspecSpecDeltaValidation(
  wtPath: string,
  headBefore: string,
  headAfter: string,
  deps: {
    gitDiffFiles: (wtPath: string, from: string, to: string) => Promise<string[]>;
    openspecValidateItem: (wtPath: string, id: string) => Promise<ValidateResult>;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (headBefore === headAfter) return { ok: true };
  const changed = await deps.gitDiffFiles(wtPath, headBefore, headAfter);
  const specDeltaIds = new Set<string>();
  for (const f of changed) {
    const m = f.replace(/\\/g, "/").match(/^openspec\/changes\/([^/]+)\/specs\//);
    if (m) specDeltaIds.add(m[1]);
  }
  if (specDeltaIds.size === 0) return { ok: true };
  for (const id of specDeltaIds) {
    const vr = await deps.openspecValidateItem(wtPath, id);
    if (!vr.valid && !vr.unavailable) {
      const detail =
        vr.issues.map((i) => i.message).filter(Boolean).join("; ") || vr.raw.slice(0, 400);
      return {
        ok: false,
        reason:
          `OpenSpec change '${id}' spec delta is structurally invalid after fix-round revision: ` +
          `${detail}. Resolve the validation error before advancing.`,
      };
    }
  }
  return { ok: true };
}

export async function enforceFixOpenspecConsistency(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: Stage,
  wtPath: string,
  changeIds: string[],
  deps: Pick<AdvanceFixDeps, "branchDeveloperCommits"> & {
    getIssueDetail?: typeof getIssueDetail;
    setBlocked?: typeof setBlocked;
    /**
     * When provided, passed directly to the guard. When absent and
     * cfg.harnesses.implementer is set, an internal production closure is
     * created using invokeFn, openspecValidateItem, and gitFn. This mirrors
     * maybeArchiveOpenspec's repair wiring so enforceFixOpenspecConsistency
     * can be tested end-to-end with an injected invokeFn without going through
     * the full advanceFix call chain (#356 finding 1).
     */
    attemptBoundedRepair?: SpecConsistencyDeps["attemptBoundedRepair"];
    pipelineRunId?: string;
    /** Correlates the review verdict with the current post-fix HEAD (#356 finding 2). */
    getHeadSha?: (wtPath: string) => Promise<string | null>;
    /**
     * Injectable harness invoker for the internal production repair closure (#356).
     * Defaults to `invoke`. Tests inject this to exercise the closure end-to-end
     * without spawning a real harness (when attemptBoundedRepair is NOT provided).
     */
    invokeFn?: InvokeFn;
    /**
     * Injectable OpenSpec change validator for the internal repair closure (#356).
     * Defaults to `openspec.validateItem`.
     */
    openspecValidateItem?: ValidateFn;
    /**
     * Injectable git function for the internal repair closure and for
     * computeBranchDeveloperCommits when branchDeveloperCommits is absent (#356).
     * Defaults to gitInWorktree.
     */
    gitFn?: typeof gitInWorktree;
    /**
     * GitHub login of the pipeline actor for the review-comment author filter
     * (#356 finding 1). When absent, no author filter is applied (test compat).
     * `advanceFix` resolves this via `getGhActor()` and passes it here; tests
     * inject a literal to match the author they set on review comments.
     */
    trustedReviewAuthor?: string | null;
  } = {},
): Promise<Outcome | null> {
  if (changeIds.length === 0) return null;

  // Create the production repair closure when cfg.harnesses.implementer is set
  // and deps.attemptBoundedRepair is not provided (to avoid shadowing a test fake).
  // This mirrors the wiring in maybeArchiveOpenspec so the fix-stage repair path
  // is exercisable in unit tests via injected invokeFn without the full advanceFix
  // call chain (#356 finding 1).
  const gitFn = deps.gitFn ?? gitInWorktree;
  const branchDevCommits =
    deps.branchDeveloperCommits ?? ((p: string, b: string) => computeBranchDeveloperCommits(gitFn, p, b));
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
            wtPath,
            gitFn,
            branchDevCommits,
            deps.invokeFn ?? invoke,
            deps.openspecValidateItem ?? openspec.validateItem,
          );
        }
      : undefined);

  return enforceSpecConsistencyGuard(cfg, issueNumber, wtPath, changeIds, {
    branchDeveloperCommits: branchDevCommits,
    getIssueDetail: deps.getIssueDetail ?? getIssueDetail,
    setBlocked: deps.setBlocked ?? setBlocked,
    blockStage: stage,
    attemptBoundedRepair: attemptRepairFn,
    pipelineRunId: deps.pipelineRunId,
    getHeadSha: deps.getHeadSha,
    trustedReviewAuthor: deps.trustedReviewAuthor,
  });
}
