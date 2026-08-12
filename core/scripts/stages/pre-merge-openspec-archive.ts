// Pre-merge OpenSpec archive domain (#628).
// Owns active-change guard, archive-already-done, and maybeArchiveOpenspec.

import {
  getGhActor,
  getIssueDetail,
  getPrDiff,
  listPrHeadChangeDirs,
  setBlocked,
} from "../gh.ts";
import {
  ensureManagedWorktree,
  getOnDiskForIssue,
  gitInWorktree,
  branchName,
} from "../worktree.ts";
import {
  PIPELINE_INTERNAL_MARKER_FILES,
  stripPipelineInternalMarkers,
} from "../salvage-harness-work.ts";
import {
  classifyWorktreeDirt,
  parsePorcelainPaths,
} from "../worktree-dirt.ts";
import { withTrailers } from "../traceability.ts";
import {
  buildTrustedOverrideComments,
  extractSpecDivergenceDirection,
} from "../review-policy.ts";
import { appendEvent, RUN_SCHEMA_VERSION } from "../run-store.ts";
import * as openspec from "../openspec.ts";
import {
  computeBranchDeveloperCommits,
  enforceSpecConsistencyGuard,
  performBoundedSpecRepair,
  type InvokeFn,
  type SpecConsistencyDeps,
  type ValidateFn,
  type FixCommit,
} from "../openspec-consistency.ts";
import { invoke } from "../harness.ts";
import {
  DEFAULT_GIT_PUSH_AUTH,
  formatPushAuthFailure,
  gitExecForwardingEnv,
  runConfiguredGitPush,
} from "../git-push-auth.ts";
import {
  OPENSPEC_ARCHIVE_PREFIX,
} from "../pipeline-commits.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig } from "../types.ts";
import { buildStageDiagnostic } from "../stage-diagnostic.ts";
import { preMergeBlocked } from "./pre-merge-shared.ts";
import type { AdvancePreMergeDeps } from "./pre-merge-routing.ts";
import { diffFilePaths, findLatestReviewCommentBody, extractReviewArtifact } from "./review.ts";
import {
  claimAndPersistStageAttempt,
  hasAttempted,
  hydrateStageAttemptLedger,
} from "../stage-attempt-ledger.ts";
import {
  evaluatePostHarnessNoNewCommit,
  preMergeArchiveCoherentGoalCheck,
} from "../noop-advance.ts";

// ---------------------------------------------------------------------------
// OpenSpec archive (once per PR)
// ---------------------------------------------------------------------------

/**
 * Classify pre-archive porcelain into blocking product dirt vs untracked
 * (waivable) scratch (#1017 review 1).
 *
 * Only pure untracked (`??`) engine-known scratch is waivable: `git clean` can
 * remove it, and it is not in the index for archive commit. Tracked/staged/
 * modified/renamed scratch is treated as product for this guard — `git clean`
 * cannot clear it, `git add -A` would stage it into the archive commit, and
 * archive-failure rollback (`git restore .`) would discard it.
 */
export function classifyPreArchiveDirt(porcelain: string): {
  product: string[];
  untrackedScratch: string[];
} {
  const product: string[] = [];
  const untrackedScratch: string[] = [];
  const seenProduct = new Set<string>();
  const seenScratch = new Set<string>();

  for (const line of porcelain.split("\n")) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    const paths = parsePorcelainPaths(line);
    if (paths.length === 0) continue;
    const { product: lineProduct, scratch: lineScratch } = classifyWorktreeDirt(paths);
    for (const p of lineProduct) {
      if (!seenProduct.has(p)) {
        seenProduct.add(p);
        product.push(p);
      }
    }
    for (const p of lineScratch) {
      if (xy === "??") {
        if (!seenScratch.has(p) && !seenProduct.has(p)) {
          seenScratch.add(p);
          untrackedScratch.push(p);
        }
      } else if (!seenProduct.has(p)) {
        // Tracked/staged/renamed scratch blocks like product.
        seenProduct.add(p);
        product.push(p);
      }
    }
  }
  return { product, untrackedScratch };
}

/**
 * Engine-known scratch paths still staged in the index (porcelain X column is
 * neither space nor `?`). Pure — post-archive safeguard uses this so a failed
 * or incomplete `git restore --staged` cannot leave challenge-response JSON in
 * the index for the archive commit (#1017 review 2). Untracked (`??`) and
 * worktree-only (` M`) scratch are excluded: they do not enter `git commit`
 * without pathspecs/`-a`.
 */
export function stagedScratchPaths(porcelain: string): string[] {
  const staged: string[] = [];
  const seen = new Set<string>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 3) continue;
    const x = line[0];
    // Index-clean or untracked: not staged for a pathspec-free commit.
    if (x === " " || x === "?") continue;
    const paths = parsePorcelainPaths(line);
    if (paths.length === 0) continue;
    const { scratch } = classifyWorktreeDirt(paths);
    for (const p of scratch) {
      if (!seen.has(p)) {
        seen.add(p);
        staged.push(p);
      }
    }
  }
  return staged;
}

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
    const stableRemaining = [...remaining].sort();
    const reason =
      `Pre-merge cannot advance: OpenSpec change(s) still active on this PR: ${stableRemaining.join(", ")}. ` +
      `Run \`openspec archive <id>\` for each and push before pre-merge can continue.`;
    const diagnostic = buildStageDiagnostic({
      reasonCode: openspec.OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE,
      evidenceKey:
        `${openspec.OPENSPEC_ARCHIVE_APPLY_CONFLICT_REASON_CODE}:` +
        `${stableRemaining.join(",")}:archive_active_change_remains`,
      blockerKind: "openspec-invalid",
      reason,
      stage: "pre-merge",
      offrampClass: "openspec-invalid",
    });
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
    await recordDecision("fail", reason);
    return preMergeBlocked(reason, "openspec-invalid", "openspec-invalid", diagnostic);
  };

  let wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    // Worktree missing: resolve active membership from the reviewed PR-head tree
    // (GitHub Contents API), never cumulative PR path subtraction — the latter
    // masks archive-then-reintroduce (#467 / #714 review 2). `openspec.enabled: off`
    // disables the integration outright regardless of tip contents.
    // When tip has active change(s) or membership is unconfirmed, rematerialize
    // first (#769) instead of parking needs-human solely for absence.
    const mode = cfg.openspec?.enabled ?? "auto";
    if (mode === "off" || prNumber === undefined) {
      await recordDecision("skipped", "openspec-inactive");
      return null;
    }
    let remaining: string[] = [];
    let membershipUnconfirmed = false;
    let listingError = "";
    try {
      remaining = [...(await listPrHeadChangeDirsFn(cfg, prNumber))].sort();
    } catch (err) {
      membershipUnconfirmed = true;
      listingError = (err as Error).message ?? String(err);
    }
    if (!membershipUnconfirmed && remaining.length === 0) {
      // #714 / #758: express empty active set as shared archive-coherent
      // satisfaction so skip/no-candidates cannot disagree with residual-active
      // evaluation for the same head.
      const archiveNoop = await evaluatePostHarnessNoNewCommit({
        headBefore: "archive-no-candidates",
        headAfter: "archive-no-candidates",
        salvaged: false,
        salvageFoundNothing: true,
        stage: "pre-merge",
        issueNumber,
        goalCheck: () => preMergeArchiveCoherentGoalCheck({ activeIds: remaining }),
      });
      if (archiveNoop.decision === "advance") {
        await recordDecision("skipped", "no-candidates");
        return null;
      }
      // Empty set must satisfy the coherent check; fail closed if it does not.
      await recordDecision("skipped", "no-candidates");
      return null;
    }

    const ensureFn = deps.ensureManagedWorktree ?? ensureManagedWorktree;
    const remat = await ensureFn(cfg, issueNumber, {
      getOnDiskForIssue: getForIssueFn,
      runDir: deps.runDir,
      runStoreDeps: deps.runStoreDeps,
    });
    if (remat.result === "fail") {
      const activePart = membershipUnconfirmed
        ? `PR-head OpenSpec membership unconfirmed (${listingError})`
        : `active OpenSpec change(s) still on the PR tip: ${remaining.join(", ")}`;
      const reason =
        `OpenSpec worktree for #${issueNumber} not found on disk (${activePart}); ` +
        `rematerialize failed (${remat.blockerKind}): ${remat.reason}`;
      // Separate calls keep explicit BlockerKind string literals visible to the
      // blocked-recipes exhaustiveness scan (nested ternaries confuse its paren walk).
      if (remat.blockerKind === "worktree-capacity") {
        await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "worktree-capacity");
        await recordDecision("fail", reason);
        return preMergeBlocked(reason, "worktree-capacity");
      }
      if (remat.blockerKind === "worktree-creation-failed") {
        await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "worktree-creation-failed");
        await recordDecision("fail", reason);
        return preMergeBlocked(reason, "worktree-creation-failed");
      }
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "worktree-missing");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "worktree-missing");
    }
    // Rematerialize succeeded (or was skipped if race recreated the tree).
    const reResolved = await getForIssueFn(cfg, issueNumber);
    if (!reResolved) {
      // Defensive: ensure claimed pass/skipped but lookup still empty.
      const reason =
        `Rematerialize reported ${remat.result} for #${issueNumber} but worktree still ` +
        `missing on disk after recreate.`;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "worktree-creation-failed");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "worktree-creation-failed");
    }
    wt = reResolved;
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
  // the worktree is fully clean of *real* (product) work before archive. Block on
  // product-relevant dirty state — a path-prefix filter is unsafe two ways: a dirty
  // tracked openspec/ file (e.g. `M  openspec/specs/x.md`) would be silently discarded
  // by the rollback, and a porcelain rename/copy record (`R  openspec/a -> core/a`) has
  // a destination outside openspec/ that matching only the first path misses.
  //
  // Pipeline-internal marker files (`.pipeline-rebase-attempted`, #522 / #597) and
  // *untracked* engine-known non-product scratch (`?? artifacts/challenge-response-*.json`,
  // etc. — same class as format/test-gate trust via `classifyWorktreeDirt` / #1013)
  // are **not** operator product work. Parking archive for untracked dumps alone is a
  // factory defect (#597 markers; #1017 challenge-response dumps). Strip markers, then
  // classify residual with porcelain status preserved (#1017 review 1): only pure
  // untracked (`??`) scratch is waivable + git-cleanable. Tracked/modified scratch
  // blocks — otherwise it survives clean, rides `git add -A` into the archive commit,
  // and is at risk from destructive rollback (`git restore .`).
  //
  // Fail CLOSED: only proceed when `git status` SUCCEEDS and product (incl. tracked
  // scratch) dirt is empty. If the status check itself errors (non-zero exit, often
  // with empty stdout), we cannot prove the tree is clean — treating that as clean
  // would let the destructive rollback run over unproven state.
  const preArchiveStatus = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (preArchiveStatus.code !== 0) {
    const detail =
      `git status --porcelain failed (exit ${preArchiveStatus.code}): ${(preArchiveStatus.stderr || preArchiveStatus.stdout || "(no output)").trim()}`;
    await setBlockedFn(
      cfg,
      issueNumber,
      `Cannot verify a clean worktree before the OpenSpec archive, so a failed archive commit's destructive rollback could discard pre-existing work — ${detail}. Commit/stash changes (or fix the git error) and re-run.`,
      "pre-merge",
      "needs-human",
    );
    await recordDecision("fail", "pre-archive git status failed");
    return preMergeBlocked("pre-archive git status failed", "needs-human");
  }
  const withoutMarkers = stripPipelineInternalMarkers(preArchiveStatus.stdout);
  const { product: productPaths, untrackedScratch: scratchPaths } =
    classifyPreArchiveDirt(withoutMarkers);
  if (productPaths.length > 0) {
    const detail = `pre-existing dirty paths:\n${productPaths.join("\n")}`;
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
    await recordDecision("fail", "worktree dirty before archive");
    return preMergeBlocked("worktree dirty before archive", "needs-human");
  }
  // Marker and/or untracked non-product scratch residual only: remove engine-owned
  // paths so later porcelain checks stay clean. Product / tracked-scratch work was
  // already ruled out above. Do not stage or commit these paths into the product tree.
  if (preArchiveStatus.stdout.trim() !== "") {
    for (const marker of PIPELINE_INTERNAL_MARKER_FILES) {
      // Best-effort unlink via git clean of the untracked marker; ignore failures.
      await gitFn(wt.path, ["clean", "-fd", "--", marker], { ignoreFailure: true });
    }
    for (const scratchPath of scratchPaths) {
      // Best-effort unlink of untracked scratch only (e.g. challenge-response dumps).
      // Tracked scratch never reaches this loop — it blocks above (#1017 review 1).
      await gitFn(wt.path, ["clean", "-fd", "--", scratchPath], { ignoreFailure: true });
    }
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
    // #714 / #758: empty shared active set is archive-coherent satisfaction.
    const archiveNoop = await evaluatePostHarnessNoNewCommit({
      headBefore: "archive-no-candidates",
      headAfter: "archive-no-candidates",
      salvaged: false,
      salvageFoundNothing: true,
      stage: "pre-merge",
      issueNumber,
      goalCheck: () => preMergeArchiveCoherentGoalCheck({ activeIds: sharedActive }),
    });
    if (archiveNoop.decision === "advance" || archiveNoop.decision === "escalate") {
      // Empty set always satisfies; escalate would be a contract bug — still skip.
      await recordDecision("skipped", "no-candidates");
      return null;
    }
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
  const getHeadShaFn = async (p: string): Promise<string | null> => {
    const r = await gitFn(p, ["rev-parse", "HEAD"], { ignoreFailure: true });
    return r.stdout.trim() || null;
  };
  // Process-local cache of ledger claim (#759); durability is the stage-attempt ledger.
  let repairAttempted = false;
  const attemptRepairFn: SpecConsistencyDeps["attemptBoundedRepair"] =
    deps.attemptBoundedRepair ??
    (cfg.harnesses?.implementer
      ? async (changeId, issNo, runId) => {
          if (repairAttempted) return "already-attempted";
          // Ledger-first when runDir available so restart does not free-replay repair.
          const headForKey = await getHeadShaFn(wt.path);
          if (deps.runDir && headForKey) {
            const hydrated = hydrateStageAttemptLedger(deps.runDir);
            if (hydrated.ok && hasAttempted(hydrated.ledger, headForKey, "openspec_repair")) {
              repairAttempted = true;
              return "already-attempted";
            }
            if (hydrated.ok) {
              const claimed = claimAndPersistStageAttempt(deps.runDir, hydrated.ledger, {
                headSha: headForKey,
                action: "openspec_repair",
                itemId: String(issNo),
                typedReason: "openspec_bounded_spec_repair",
              });
              if (!claimed.ok) return "already-attempted"; // fail closed
              if (!claimed.created && hasAttempted(claimed.ledger, headForKey, "openspec_repair")) {
                repairAttempted = true;
                return "already-attempted";
              }
            }
          }
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
      const diagnostic = res.diagnostic
        ? buildStageDiagnostic({
            reasonCode: res.diagnostic.reasonCode,
            evidenceKey: res.diagnostic.evidenceKey,
            blockerKind: "openspec-invalid",
            reason,
            stage: "pre-merge",
            offrampClass: "openspec-invalid",
          })
        : undefined;
      await setBlockedFn(cfg, issueNumber, reason, "pre-merge", "openspec-invalid");
      await recordDecision("fail", reason);
      return preMergeBlocked(reason, "openspec-invalid", "openspec-invalid", diagnostic);
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
  // Stage everything, then unstage any engine-known scratch so challenge-response
  // JSON (and other non-product residual) cannot ride into the archive commit if
  // best-effort pre-archive clean left it behind (#1017 review 1 / no-auto-commit).
  // Fail closed when restore fails or scratch remains staged (#1017 review 2):
  // path-only classifyWorktreeDirt drops scratch from remainingProduct, so a
  // silent unstage failure would still auto-commit staged challenge-response JSON.
  await gitFn(wt.path, ["add", "-A"], { ignoreFailure: true });
  let status = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
  if (status.code !== 0) {
    const detail =
      `git status --porcelain failed after archive staging (exit ${status.code}): ` +
      `${(status.stderr || status.stdout || "(no output)").trim()}`;
    await setBlockedFn(
      cfg,
      issueNumber,
      `Cannot verify residual engine-known scratch was unstaged before the OpenSpec archive commit — ${detail}.`,
      "pre-merge",
      "needs-human",
    );
    await recordDecision("fail", "post-archive git status failed");
    return preMergeBlocked("post-archive git status failed", "needs-human");
  }
  {
    // XY-aware: only paths with a dirty index column need unstage (not `??` / ` M`).
    const toUnstage = stagedScratchPaths(status.stdout);
    if (toUnstage.length > 0) {
      const restore = await gitFn(
        wt.path,
        ["restore", "--staged", "--", ...toUnstage],
        { ignoreFailure: true },
      );
      if (restore.code !== 0) {
        const detail =
          restore.stderr.trim() || restore.stdout.trim() || `(exit ${restore.code})`;
        await setBlockedFn(
          cfg,
          issueNumber,
          `Cannot unstage engine-known scratch before OpenSpec archive commit ` +
            `(git restore --staged failed):\n${detail}\nScratch paths:\n${toUnstage.join("\n")}`,
          "pre-merge",
          "needs-human",
        );
        await recordDecision("fail", "post-archive unstage failed");
        return preMergeBlocked("post-archive unstage failed", "needs-human");
      }
      status = await gitFn(wt.path, ["status", "--porcelain"], { ignoreFailure: true });
      if (status.code !== 0) {
        const detail =
          `git status --porcelain failed after unstage (exit ${status.code}): ` +
          `${(status.stderr || status.stdout || "(no output)").trim()}`;
        await setBlockedFn(
          cfg,
          issueNumber,
          `Cannot verify residual engine-known scratch was unstaged before the OpenSpec archive commit — ${detail}.`,
          "pre-merge",
          "needs-human",
        );
        await recordDecision("fail", "post-archive git status failed");
        return preMergeBlocked("post-archive git status failed", "needs-human");
      }
    }
    // Confirm residual scratch is unstaged/untracked — never commit it.
    const stillStaged = stagedScratchPaths(status.stdout);
    if (stillStaged.length > 0) {
      await setBlockedFn(
        cfg,
        issueNumber,
        `Engine-known scratch remains staged after unstage and would enter the OpenSpec archive commit:\n` +
          `${stillStaged.join("\n")}`,
        "pre-merge",
        "needs-human",
      );
      await recordDecision("fail", "post-archive scratch still staged");
      return preMergeBlocked("post-archive scratch still staged", "needs-human");
    }
  }
  // Emptiness is product-path based: untracked scratch residual must not count as
  // "archive produced changes" and must not trigger a no-op commit attempt.
  const remainingProduct = classifyWorktreeDirt(parsePorcelainPaths(status.stdout)).product;
  if (remainingProduct.length === 0) {
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
  // the reviewed head. Configured push-auth (#980) owns the transport.
  const pushAuth = cfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH;
  const push = await runConfiguredGitPush({
    cwd: wt.path,
    auth: pushAuth,
    args: ["push", "origin", branch],
    deps: {
      gitConfigGet: async (cwd, key) => {
        const r = await gitFn(cwd, ["config", "--get", key], { ignoreFailure: true });
        return r.code === 0 ? r.stdout.trim() || null : null;
      },
      gitExec: gitExecForwardingEnv(wt.path, gitFn),
    },
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
        push.code !== 0
          ? (push.errorMessage ?? push.stderr.trim())
          : "OpenSpec archive pushed; CI will re-run",
      ),
    ).catch(() => {});
  }
  if (push.code !== 0) {
    const pushMsg = formatPushAuthFailure(
      pushAuth,
      push.errorMessage ?? (push.stderr.trim() || "push failed after archive"),
    );
    await setBlockedFn(
      cfg,
      issueNumber,
      pushMsg,
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
