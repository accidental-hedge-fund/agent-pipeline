// Opt-in release-when-complete for the human-gated merge queue (#676).
//
// After a merge-queue drive finishes, operators may ask the tool to prepare
// the next release PR (version bump, ROADMAP, mirror) for human review — never
// tag, publish, or merge the release. This module owns:
//
//   1. Pure queue-completeness evaluation
//   2. The post-drive prepare hook (invokes shared runRelease only)
//
// Completeness (queue-complete):
//   - no remaining open selector-scoped R2D candidates
//   - no held merge-queue items from the drive
// Open non-R2D / non-candidate issues do NOT block prepare (warning only).

import type { ReleaseOpts } from "./release.ts";

// ---------------------------------------------------------------------------
// Completeness inputs / result
// ---------------------------------------------------------------------------

export interface ReleaseWhenCompleteCandidate {
  issueNumber: number;
  prNumber: number;
}

export interface ReleaseWhenCompleteHeldItem {
  issueNumber: number;
  prNumber: number;
  reason: string;
}

export interface ReleaseWhenCompleteNonCandidate {
  issueNumber: number;
  title?: string;
}

export interface QueueCompletenessInput {
  remainingCandidates: readonly ReleaseWhenCompleteCandidate[];
  heldItems: readonly ReleaseWhenCompleteHeldItem[];
  openNonCandidates?: readonly ReleaseWhenCompleteNonCandidate[];
}

export interface QueueCompletenessResult {
  complete: boolean;
  /** Present when incomplete — names remaining candidates and/or holds. */
  skipReason?: string;
  /** Present when open non-candidates remain (never blocks completeness). */
  nonCandidateWarning?: string;
  remainingCandidateCount: number;
  heldCount: number;
  nonCandidateCount: number;
}

/**
 * Pure helper: is the merge queue complete for release-when-complete purposes?
 *
 * Complete when remaining R2D candidates are empty AND held items are empty.
 * Open non-R2D issues never flip complete → incomplete; they only contribute a
 * warning payload for the operator.
 */
export function evaluateReleaseWhenComplete(
  input: QueueCompletenessInput,
): QueueCompletenessResult {
  const remainingCandidateCount = input.remainingCandidates.length;
  const heldCount = input.heldItems.length;
  const nonCandidates = input.openNonCandidates ?? [];
  const nonCandidateCount = nonCandidates.length;

  const incompleteParts: string[] = [];
  if (remainingCandidateCount > 0) {
    const ids = input.remainingCandidates
      .map((c) => `#${c.issueNumber}→PR #${c.prNumber}`)
      .join(", ");
    incompleteParts.push(
      `${remainingCandidateCount} remaining ready-to-deploy candidate(s): ${ids}`,
    );
  }
  if (heldCount > 0) {
    const ids = input.heldItems
      .map((h) => `#${h.issueNumber}→PR #${h.prNumber} (${h.reason})`)
      .join(", ");
    incompleteParts.push(`${heldCount} held item(s): ${ids}`);
  }

  let nonCandidateWarning: string | undefined;
  if (nonCandidateCount > 0) {
    const ids = nonCandidates.map((n) => `#${n.issueNumber}`).join(", ");
    nonCandidateWarning =
      `${nonCandidateCount} open non-candidate issue(s) remain on the selector ` +
      `(do not block release prepare): ${ids}`;
  }

  if (incompleteParts.length > 0) {
    return {
      complete: false,
      skipReason: incompleteParts.join("; "),
      nonCandidateWarning,
      remainingCandidateCount,
      heldCount,
      nonCandidateCount,
    };
  }

  return {
    complete: true,
    nonCandidateWarning,
    remainingCandidateCount: 0,
    heldCount: 0,
    nonCandidateCount,
  };
}

// ---------------------------------------------------------------------------
// Opt-in resolution
// ---------------------------------------------------------------------------

/**
 * Release-when-complete is enabled when either the CLI flag or the config
 * default is true. Both unset/false → disabled.
 */
export function isReleaseWhenCompleteEnabled(
  cliFlag: boolean | undefined,
  configDefault: boolean | undefined,
): boolean {
  return Boolean(cliFlag) || Boolean(configDefault);
}

/**
 * Usage-error message when release-when-complete is enabled without a version.
 * Pure; callers exit non-zero and skip release mutations.
 */
export function missingReleaseVersionError(): string {
  return (
    "[merge-queue] --release-when-complete requires --release-version " +
    "<major|minor|patch|X.Y.Z>. No release prepare was run."
  );
}

// ---------------------------------------------------------------------------
// Post-drive hook
// ---------------------------------------------------------------------------

export type ReleaseWhenCompleteStatus =
  | "disabled"
  | "usage_error"
  | "skipped"
  | "would_prepare"
  | "prepared"
  | "failed";

export interface ReleaseWhenCompleteHookResult {
  status: ReleaseWhenCompleteStatus;
  /** True when the overall command should exit non-zero after reporting. */
  exitNonZero: boolean;
  skipReason?: string;
  error?: string;
  nonCandidateWarning?: string;
  version?: string;
}

export interface ReleaseWhenCompleteHookOpts {
  /** Effective opt-in (CLI OR config). */
  enabled: boolean;
  /** Operator version intent: major|minor|patch|X.Y.Z */
  version?: string;
  /** Merge-queue dry-run: disclose intent, never mutate. */
  dryRun?: boolean;
}

/** Minimal release prepare entry — matches runRelease's public signature. */
export type RunReleaseFn = (
  versionArg: string,
  opts: ReleaseOpts,
  cfg: {
    repo_dir: string;
    repo: string;
    base_branch?: string;
    release_model?: "semver" | "continuous";
  },
) => Promise<void>;

export interface ReleaseWhenCompleteHookDeps {
  runRelease: RunReleaseFn;
  log(msg: string): void;
  error(msg: string): void;
}

export interface ReleasePrepareConfig {
  repo_dir: string;
  repo: string;
  base_branch?: string;
  release_model?: "semver" | "continuous";
}

/**
 * Post-drive release prepare hook.
 *
 * - Disabled → no-op, release never called
 * - Enabled without version → usage_error (no release call)
 * - Incomplete queue → skipped with reason (no release call)
 * - Complete + dry-run → would_prepare disclosure (no release call / no side effects)
 * - Complete + live → runRelease(version, { noEdit: true }, …)
 * - Prepare failure → failed status; caller keeps merge outcomes intact
 *
 * This path never tags, publishes to npm, or merges the release PR: it only
 * wires the prepare-only `runRelease` entry.
 */
export async function maybePrepareReleaseWhenComplete(
  opts: ReleaseWhenCompleteHookOpts,
  completeness: QueueCompletenessResult,
  releaseCfg: ReleasePrepareConfig,
  deps: ReleaseWhenCompleteHookDeps,
): Promise<ReleaseWhenCompleteHookResult> {
  if (!opts.enabled) {
    return { status: "disabled", exitNonZero: false };
  }

  if (!opts.version || opts.version.trim() === "") {
    const msg = missingReleaseVersionError();
    deps.error(msg);
    return { status: "usage_error", exitNonZero: true, error: msg };
  }

  const version = opts.version.trim();

  if (completeness.nonCandidateWarning) {
    deps.log(`[merge-queue] warning: ${completeness.nonCandidateWarning}`);
  }

  if (!completeness.complete) {
    const skipReason =
      completeness.skipReason ?? "queue is not complete";
    deps.log(
      `[merge-queue] release-when-complete skipped: ${skipReason}`,
    );
    return {
      status: "skipped",
      exitNonZero: false,
      skipReason,
      nonCandidateWarning: completeness.nonCandidateWarning,
      version,
    };
  }

  if (opts.dryRun) {
    deps.log(
      `[merge-queue] dry-run: would prepare release ${version} ` +
        `(queue complete; no PR created, no release-managed files written)`,
    );
    return {
      status: "would_prepare",
      exitNonZero: false,
      nonCandidateWarning: completeness.nonCandidateWarning,
      version,
    };
  }

  deps.log(
    `[merge-queue] queue complete — preparing release ${version} (non-interactive)`,
  );

  try {
    // Prepare-only: noEdit so the drive never waits on $EDITOR.
    // runRelease itself does not tag, publish, or merge the release PR.
    await deps.runRelease(version, { noEdit: true }, releaseCfg);
    deps.log(
      `[merge-queue] release prepare succeeded for ${version} — release PR is open for human review`,
    );
    return {
      status: "prepared",
      exitNonZero: false,
      nonCandidateWarning: completeness.nonCandidateWarning,
      version,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = `[merge-queue] release prepare failed: ${message}`;
    deps.error(error);
    deps.error(
      "[merge-queue] merges already completed remain done; fix the release tree and re-run `pipeline release` manually if needed",
    );
    return {
      status: "failed",
      exitNonZero: true,
      error,
      nonCandidateWarning: completeness.nonCandidateWarning,
      version,
    };
  }
}
