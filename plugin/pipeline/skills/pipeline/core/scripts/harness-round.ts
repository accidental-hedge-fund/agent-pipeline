/**
 * Shared implementer-round skeleton (#629).
 *
 * Owns the common lifecycle duplicated across fix, planning implement,
 * visual-fix, eval-fix, and pre-merge auto-fix:
 *
 *   optional reattach → capture headBefore → invoke → salvage (when required)
 *   → stage-owned afterRound (verify / format-test / push / product outcomes)
 *
 * Stage-specific product policy stays in the caller via callbacks. Salvage
 * semantics are delegated to the existing `trySalvageUncommittedWork`
 * implementation — this helper does not reimplement staging rules.
 */

import type { trySalvageUncommittedWork } from "./salvage-harness-work.ts";

/** Minimal reattach result shape shared with worktree.reattachIfDetached. */
export type HarnessRoundReattachResult = { ok: true } | { ok: false; stderr: string };

export interface HarnessRoundDeps {
  /** Resolve HEAD in the worktree. Empty string when git is unavailable. */
  gitHead: (wtPath: string) => Promise<string>;
  /**
   * Reattach detached HEAD to the pipeline branch. Only called when
   * `options.reattach` is set.
   */
  reattach?: (
    wt: { path: string; slug: string },
    issueNumber: number,
  ) => Promise<HarnessRoundReattachResult>;
  /**
   * Salvage uncommitted work. Defaults are stage-injected; production callers
   * pass `trySalvageUncommittedWork` (or a test double).
   */
  salvage: (
    wtPath: string,
    issueNumber: number,
    pipelineRunId: string,
    stageLabel: string,
    salvageDeps?: Parameters<typeof trySalvageUncommittedWork>[4],
    scope?: string,
  ) => Promise<{ salvaged: boolean; failureReason?: string }>;
}

/**
 * Context handed to `afterRound` after invoke + optional salvage.
 * Stages use this for commit-range verification, format/test, push, and
 * stage-specific product outcomes (noop-clean, external-commit advance, …).
 */
export interface HarnessRoundContext<TInvoke> {
  /** HEAD captured immediately before harness invocation. */
  headBefore: string;
  /** HEAD after invoke and any salvage attempt. */
  headAfter: string;
  invokeResult: TInvoke;
  /** True only when both HEAD reads succeeded and are equal. */
  confirmedNoNewCommit: boolean;
  /** Whether salvage was attempted for this round. */
  salvageAttempted: boolean;
  /** True only when salvage created a commit. */
  salvaged: boolean;
  /** Present when a salvage attempt failed a git operation (#521). */
  salvageFailureReason?: string;
  /**
   * True when salvage was attempted, did not create a commit, and reported no
   * failure reason — i.e. the worktree was genuinely clean (#553).
   */
  salvageFoundNothing: boolean;
  /**
   * #758: when the consumer supplies `onCleanNoNewCommit` and the round is a
   * confirmed clean no-new-commit (salvage found nothing), the helper invokes
   * that callback and attaches the result here for `afterRound`. Stages use
   * this to route through the shared noop-advance contract without re-deriving
   * clean-noop preconditions. Undefined when the hook was omitted or the path
   * is not clean no-new-commit.
   */
  cleanNoNewCommitHookResult?: unknown;
}

/**
 * Options bag for {@link runHarnessRound}.
 *
 * Stage-specific commit gates, salvage labels, format/test ordering, push
 * coordination, and product outcomes remain caller-supplied — the helper only
 * sequences the shared skeleton.
 */
export interface HarnessRoundOptions<TInvoke, TResult> {
  wtPath: string;
  issueNumber: number;
  pipelineRunId: string;
  /** Label embedded in salvage commit subjects (stage-owned). */
  salvageLabel: string;
  /** Optional path scope for salvage (e.g. OpenSpec authoring `"openspec/"`). */
  salvageScope?: string;

  /**
   * When set, reattach runs before head capture / invoke. On failure the
   * harness is not invoked; `onReattachFailed` must produce the stage result.
   */
  reattach?: {
    wt: { path: string; slug: string };
    issueNumber: number;
  };

  /**
   * Optional preflight after reattach (if any) and before head capture.
   * Return `{ abort: result }` to short-circuit without invoke (e.g. claim-failed).
   */
  beforeInvoke?: () => Promise<{ abort: TResult } | void | undefined>;

  /** Spawn the harness. Called only after successful reattach/preflight. */
  invoke: () => Promise<TInvoke>;

  /**
   * Whether to attempt salvage after invoke. Stage policy:
   * - visual/eval: success + confirmed no-new-commit
   * - pre-merge auto-fix / planning implement: confirmed no-new-commit (any exit)
   * - fix: crash path always attempts; success path only on no-new-commit
   */
  shouldAttemptSalvage: (ctx: {
    headBefore: string;
    headAfter: string;
    confirmedNoNewCommit: boolean;
    invokeResult: TInvoke;
  }) => boolean;

  /**
   * Stage-owned continuation after invoke + optional salvage. Performs
   * commit-gate / format / test / push / product outcomes.
   */
  afterRound: (ctx: HarnessRoundContext<TInvoke>) => Promise<TResult>;

  /**
   * #758 optional hook: when the round is a confirmed clean no-new-commit
   * (HEAD unchanged, salvage attempted and found nothing), the helper calls
   * this callback before `afterRound` so migrated consumers can run the shared
   * noop-advance goal evaluation. When omitted, stages keep their pre-existing
   * clean no-commit / noop-clean / block product rule (no default always-advance).
   */
  onCleanNoNewCommit?: (ctx: {
    headBefore: string;
    headAfter: string;
    invokeResult: TInvoke;
  }) => Promise<unknown> | unknown;

  /** Required when `reattach` is set. */
  onReattachFailed?: (stderr: string) => TResult | Promise<TResult>;

  deps: HarnessRoundDeps;
}

/**
 * Run one implementer round through the shared skeleton.
 *
 * Order: reattach (opt) → beforeInvoke (opt) → headBefore → invoke → salvage
 * (when `shouldAttemptSalvage`) → afterRound.
 */
export async function runHarnessRound<TInvoke, TResult>(
  options: HarnessRoundOptions<TInvoke, TResult>,
): Promise<TResult> {
  const { deps } = options;

  if (options.reattach) {
    const reattachFn = deps.reattach;
    if (!reattachFn) {
      throw new Error("runHarnessRound: reattach requested but deps.reattach is missing");
    }
    if (!options.onReattachFailed) {
      throw new Error("runHarnessRound: reattach requested but onReattachFailed is missing");
    }
    const reattach = await reattachFn(options.reattach.wt, options.reattach.issueNumber);
    if (!reattach.ok) {
      return options.onReattachFailed(reattach.stderr);
    }
  }

  if (options.beforeInvoke) {
    const pre = await options.beforeInvoke();
    if (pre && "abort" in pre) {
      return pre.abort;
    }
  }

  const headBefore = await deps.gitHead(options.wtPath);
  const invokeResult = await options.invoke();
  let headAfter = await deps.gitHead(options.wtPath);
  const confirmedNoNewCommit = Boolean(
    headBefore && headAfter && headBefore === headAfter,
  );

  let salvageAttempted = false;
  let salvaged = false;
  let salvageFailureReason: string | undefined;
  let salvageFoundNothing = false;

  const shouldSalvage = options.shouldAttemptSalvage({
    headBefore,
    headAfter,
    confirmedNoNewCommit,
    invokeResult,
  });

  if (shouldSalvage) {
    salvageAttempted = true;
    const salvageResult = await deps.salvage(
      options.wtPath,
      options.issueNumber,
      options.pipelineRunId,
      options.salvageLabel,
      undefined,
      options.salvageScope,
    );
    salvaged = salvageResult.salvaged;
    salvageFailureReason = salvageResult.failureReason;
    salvageFoundNothing = !salvaged && !salvageFailureReason;
    if (salvaged) {
      headAfter = await deps.gitHead(options.wtPath);
    }
  }

  let cleanNoNewCommitHookResult: unknown;
  if (
    options.onCleanNoNewCommit &&
    confirmedNoNewCommit &&
    salvageAttempted &&
    salvageFoundNothing &&
    !salvaged
  ) {
    cleanNoNewCommitHookResult = await options.onCleanNoNewCommit({
      headBefore,
      headAfter,
      invokeResult,
    });
  }

  return options.afterRound({
    headBefore,
    headAfter,
    invokeResult,
    confirmedNoNewCommit,
    salvageAttempted,
    salvaged,
    salvageFailureReason,
    salvageFoundNothing,
    cleanNoNewCommitHookResult,
  });
}
