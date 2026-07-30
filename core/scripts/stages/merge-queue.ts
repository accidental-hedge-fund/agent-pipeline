// Human-gated merge-queue drive with optional release-when-complete (#676).
//
// Walks selector-scoped pipeline:ready-to-deploy PRs one at a time through the
// existing merge surface (mergePr). Default is dry-run (no merges). Opt-in
// --release-when-complete prepares a release PR via shared runRelease when the
// queue is complete — never tags, publishes, or merges the release.
//
// Sibling issues #673–#675 own broader selection/hold design; this module
// provides the minimal drive + completion surface the release hook needs, with
// fully injectable deps so unit tests never touch network/git/subprocesses.

import { spawnSync } from "node:child_process";
import { mergePr, realMergeDeps, type MergeDeps } from "./merge.ts";
import {
  evaluateReleaseWhenComplete,
  isReleaseWhenCompleteEnabled,
  maybePrepareReleaseWhenComplete,
  missingReleaseVersionError,
  type ReleaseWhenCompleteHookResult,
  type RunReleaseFn,
} from "./merge-queue-release-when-complete.ts";
import { runRelease } from "./release.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MergeQueueCandidate {
  issueNumber: number;
  prNumber: number;
  title: string;
}

export interface MergeQueueHeldItem {
  issueNumber: number;
  prNumber: number;
  reason: string;
}

export interface MergeQueueNonCandidate {
  issueNumber: number;
  title?: string;
}

export interface MergeQueueOpts {
  /** Milestone title selector (required for candidate scope). */
  milestone: string;
  /**
   * When true, perform merges. When false (default), dry-run: plan only.
   * Commander `--apply` sets this true; bare dry-run is the safe default.
   */
  apply: boolean;
  /** CLI `--release-when-complete` flag. */
  releaseWhenComplete?: boolean;
  /** CLI `--release-version` (major|minor|patch|X.Y.Z). */
  releaseVersion?: string;
  /** Config `merge_queue.release_when_complete` (default false). */
  releaseWhenCompleteConfig?: boolean;
  repoDir: string;
  repo: string;
  baseBranch?: string;
  releaseModel?: "semver" | "continuous";
}

export interface MergeQueueDeps {
  /** List open R2D candidates for the milestone (issue + open PR). */
  listR2dCandidates(milestone: string): Promise<MergeQueueCandidate[]>;
  /**
   * Open milestone issues that are not R2D candidates (warning payload only).
   * `candidateIssueNumbers` is the set currently treated as candidates so the
   * impl can exclude them without a second eligibility pass when possible.
   */
  listOpenNonCandidates(
    milestone: string,
    candidateIssueNumbers: ReadonlySet<number>,
  ): Promise<MergeQueueNonCandidate[]>;
  /**
   * Merge one candidate via the existing human merge surface.
   * On throw, the drive holds the item and continues.
   */
  mergeCandidate(candidate: MergeQueueCandidate): Promise<void>;
  /** Shared release prepare entry (runRelease). */
  runRelease: RunReleaseFn;
  log(msg: string): void;
  error(msg: string): void;
}

export interface MergeQueueResult {
  mode: "dry-run" | "apply";
  /** Candidates present at drive start. */
  initialCandidates: MergeQueueCandidate[];
  /** Successfully merged (apply only). */
  merged: MergeQueueCandidate[];
  /** Held after merge failure (apply only). */
  held: MergeQueueHeldItem[];
  /** Remaining open R2D candidates after the drive (re-queried when apply). */
  remainingCandidates: MergeQueueCandidate[];
  openNonCandidates: MergeQueueNonCandidate[];
  release: ReleaseWhenCompleteHookResult;
  /** Process exit code for the CLI (0 ok, 1 release/merge failure, 2 usage). */
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

const R2D_LABEL = "pipeline:ready-to-deploy";

/**
 * Resolve the open same-repo PR number that closes `issueNumber`, or null.
 * Uses `gh pr list --search "closing:N"` shape already used elsewhere.
 */
function resolveOpenPrForIssue(
  repoDir: string,
  repo: string,
  issueNumber: number,
): number | null {
  const result = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--search",
      `closing:${issueNumber}`,
      "--json",
      "number",
      "--limit",
      "5",
    ],
    { encoding: "utf8", stdio: "pipe", cwd: repoDir },
  );
  if (result.status !== 0) return null;
  try {
    const items = JSON.parse(result.stdout.trim() || "[]") as Array<{ number: number }>;
    return items.length > 0 ? items[0].number : null;
  } catch {
    return null;
  }
}

export function realMergeQueueDeps(
  repoDir: string,
  repo: string,
  mergeDeps?: MergeDeps,
): MergeQueueDeps {
  const md = mergeDeps ?? realMergeDeps(repo);

  return {
    async listR2dCandidates(milestone: string): Promise<MergeQueueCandidate[]> {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          R2D_LABEL,
          "--milestone",
          milestone,
          "--json",
          "number,title",
          "--limit",
          "200",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[merge-queue] gh issue list failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
      }>;
      const candidates: MergeQueueCandidate[] = [];
      for (const item of items) {
        const prNumber = resolveOpenPrForIssue(repoDir, repo, item.number);
        if (prNumber == null) continue;
        candidates.push({
          issueNumber: item.number,
          prNumber,
          title: item.title,
        });
      }
      // Stable order: ascending issue number.
      candidates.sort((a, b) => a.issueNumber - b.issueNumber);
      return candidates;
    },

    async listOpenNonCandidates(
      milestone: string,
      candidateIssueNumbers: ReadonlySet<number>,
    ): Promise<MergeQueueNonCandidate[]> {
      const result = spawnSync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--milestone",
          milestone,
          "--json",
          "number,title,labels",
          "--limit",
          "200",
        ],
        { encoding: "utf8", stdio: "pipe", cwd: repoDir },
      );
      if (result.status !== 0) {
        throw new Error(
          `[merge-queue] gh issue list (all open) failed (exit ${result.status}): ${result.stderr?.trim() ?? ""}`,
        );
      }
      const items = JSON.parse(result.stdout.trim() || "[]") as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
      }>;
      return items
        .filter((item) => !candidateIssueNumbers.has(item.number))
        .map((item) => ({ issueNumber: item.number, title: item.title }));
    },

    async mergeCandidate(candidate: MergeQueueCandidate): Promise<void> {
      await mergePr(candidate.prNumber, md);
    },

    runRelease: (versionArg, opts, cfg) => runRelease(versionArg, opts, cfg),

    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the merge-queue drive (dry-run or apply) and optionally prepare a release
 * when the queue is complete.
 *
 * Failure isolation: if release prepare fails after merges, merge outcomes stay
 * intact and exitCode becomes non-zero after reporting.
 */
export async function runMergeQueue(
  opts: MergeQueueOpts,
  deps: MergeQueueDeps,
): Promise<MergeQueueResult> {
  const enabled = isReleaseWhenCompleteEnabled(
    opts.releaseWhenComplete,
    opts.releaseWhenCompleteConfig,
  );
  const dryRun = !opts.apply;

  // Usage gate before any merge or release mutation.
  if (enabled && (!opts.releaseVersion || opts.releaseVersion.trim() === "")) {
    const msg = missingReleaseVersionError();
    deps.error(msg);
    return {
      mode: dryRun ? "dry-run" : "apply",
      initialCandidates: [],
      merged: [],
      held: [],
      remainingCandidates: [],
      openNonCandidates: [],
      release: {
        status: "usage_error",
        exitNonZero: true,
        error: msg,
      },
      exitCode: 2,
    };
  }

  const initialCandidates = await deps.listR2dCandidates(opts.milestone);
  const candidateNums = new Set(initialCandidates.map((c) => c.issueNumber));
  const openNonCandidates = await deps.listOpenNonCandidates(
    opts.milestone,
    candidateNums,
  );

  deps.log(
    `[merge-queue] milestone=${JSON.stringify(opts.milestone)} ` +
      `mode=${dryRun ? "dry-run" : "apply"} candidates=${initialCandidates.length}`,
  );

  const merged: MergeQueueCandidate[] = [];
  const held: MergeQueueHeldItem[] = [];

  if (dryRun) {
    if (initialCandidates.length === 0) {
      deps.log("[merge-queue] dry-run: no ready-to-deploy candidates");
    } else {
      deps.log("[merge-queue] dry-run planned merges (no merges performed):");
      for (const c of initialCandidates) {
        deps.log(
          `  - issue #${c.issueNumber} PR #${c.prNumber}: ${c.title}`,
        );
      }
    }
    if (!enabled) {
      // Dry-run without flag: do not list prepare-release as a planned action.
      deps.log("[merge-queue] dry-run: release-when-complete is off (no release prepare planned)");
    }
  } else {
    // Sequential single-flight merges via existing merge surface.
    for (const c of initialCandidates) {
      deps.log(
        `[merge-queue] merging issue #${c.issueNumber} PR #${c.prNumber}…`,
      );
      try {
        await deps.mergeCandidate(c);
        merged.push(c);
        deps.log(
          `[merge-queue] merged issue #${c.issueNumber} PR #${c.prNumber}`,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        held.push({
          issueNumber: c.issueNumber,
          prNumber: c.prNumber,
          reason,
        });
        deps.log(
          `[merge-queue] held issue #${c.issueNumber} PR #${c.prNumber}: ${reason}`,
        );
      }
    }
  }

  // Completeness: dry-run uses current state; apply re-queries remaining R2D.
  const remainingCandidates = dryRun
    ? initialCandidates
    : await deps.listR2dCandidates(opts.milestone);

  // Held items for completeness: apply uses drive holds; dry-run has none yet.
  const heldForCompleteness = dryRun ? [] : held;

  const completeness = evaluateReleaseWhenComplete({
    remainingCandidates: remainingCandidates.map((c) => ({
      issueNumber: c.issueNumber,
      prNumber: c.prNumber,
    })),
    heldItems: heldForCompleteness.map((h) => ({
      issueNumber: h.issueNumber,
      prNumber: h.prNumber,
      reason: h.reason,
    })),
    openNonCandidates: openNonCandidates.map((n) => ({
      issueNumber: n.issueNumber,
      title: n.title,
    })),
  });

  const release = await maybePrepareReleaseWhenComplete(
    {
      enabled,
      version: opts.releaseVersion,
      dryRun,
    },
    completeness,
    {
      repo_dir: opts.repoDir,
      repo: opts.repo,
      base_branch: opts.baseBranch,
      release_model: opts.releaseModel,
    },
    {
      runRelease: deps.runRelease,
      log: deps.log,
      error: deps.error,
    },
  );

  let exitCode = 0;
  if (release.exitNonZero) {
    exitCode = release.status === "usage_error" ? 2 : 1;
  }

  return {
    mode: dryRun ? "dry-run" : "apply",
    initialCandidates,
    merged,
    held,
    remainingCandidates,
    openNonCandidates,
    release,
    exitCode,
  };
}
