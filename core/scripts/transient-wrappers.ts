// Bounded retry wrappers for transient-retryable escalation sites (#760).
//
// Wrappers apply ONLY when inventory disposition is transient-retryable.
// Deliberately-fail-closed and reconcile-owned sites must not call these for
// automatic recovery. All deps are injectable — no real network/git in tests.

import {
  dispositionForSiteId,
  isTransientRetryableSite,
  type EscalationSiteDisposition,
} from "./escalation-dispositions.ts";
import { classifyGhError } from "./escalation-classify.ts";
import { isTransientGhError, type GhRunOptions, type GhSubprocessRunner } from "./gh.ts";
import type { StageDiagnosticReasonCode } from "./stage-diagnostic.ts";

// ---------------------------------------------------------------------------
// Shared backoff
// ---------------------------------------------------------------------------

export interface BackoffDeps {
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TRANSIENT_RETRIES = 3;

async function sleepMs(ms: number, deps: BackoffDeps): Promise<void> {
  const sleep = deps.sleep ?? ((n) => new Promise<void>((r) => setTimeout(r, n)));
  await sleep(ms);
}

// ---------------------------------------------------------------------------
// Gh label / read transient path
// ---------------------------------------------------------------------------

export interface TransientGhCallDeps extends BackoffDeps {
  runner: GhSubprocessRunner;
  isTransient?: (stderr: string) => boolean;
  retries?: number;
}

export type TransientGhResult =
  | { ok: true; stdout: string; attempts: number }
  | {
      ok: false;
      attempts: number;
      stderr: string;
      reason_code: StageDiagnosticReasonCode;
      exhausted: boolean;
    };

/**
 * Bounded gh invocation with the same transient classifier as ghRun.
 * On exhaustion returns a typed engine-owned failure — never invents human authority.
 */
export async function runTransientGh(
  args: string[],
  deps: TransientGhCallDeps,
): Promise<TransientGhResult> {
  const retries = deps.retries ?? DEFAULT_TRANSIENT_RETRIES;
  const isTransient = deps.isTransient ?? isTransientGhError;
  let lastStderr = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { stdout } = await deps.runner(args);
      return { ok: true, stdout, attempts: attempt + 1 };
    } catch (err) {
      const e = err as { stderr?: string | Buffer; message?: string };
      lastStderr = (e.stderr ?? "").toString() || e.message || String(err);
      const classified = classifyGhError(lastStderr);
      if (isTransient(lastStderr) && attempt < retries - 1) {
        await sleepMs(2 ** attempt * 1000, deps);
        continue;
      }
      return {
        ok: false,
        attempts: attempt + 1,
        stderr: lastStderr,
        reason_code: classified.reason_code,
        exhausted: isTransient(lastStderr),
      };
    }
  }
  return {
    ok: false,
    attempts: retries,
    stderr: lastStderr,
    reason_code: "transient-infra",
    exhausted: true,
  };
}

/**
 * Label-edit helper used by tests and dispositioned callers. Returns success
 * after retry on HTTP 504; deterministic 422 fails after one attempt.
 */
export async function runTransientLabelEdit(
  args: string[],
  deps: TransientGhCallDeps,
): Promise<TransientGhResult> {
  return runTransientGh(args, deps);
}

// ---------------------------------------------------------------------------
// Push with currency re-sync (no force-push)
// ---------------------------------------------------------------------------

export interface GitPushResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Complete #1038 park stderr (2026-08-17, v1.39.1, loop-73346e80c28e4e77-s1).
 * Local tip `8ea2d1a` was behind remote PR head `bb208ba`. Git rejected
 * non-fast-forward; waiting cannot make an older tip fast-forward.
 */
export const NON_FAST_FORWARD_PUSH_STDERR_1038 = [
  "To github.com:example/repo.git",
  " ! [rejected]        pipeline/1038-x -> pipeline/1038-x (non-fast-forward)",
  "error: failed to push some refs to 'github.com:example/repo.git'",
  "hint: Updates were rejected because the tip of your current branch is behind",
  "hint: its remote counterpart. Fetch first.",
].join("\n");

export interface PushFailureClassification {
  reason_code: StageDiagnosticReasonCode;
  head_drift: boolean;
  retryable: boolean;
}

/** Case-insensitive tokens that mark a stale-tip / non-fast-forward reject. */
const NON_FAST_FORWARD_TOKENS = ["non-fast-forward", "rejected", "fetch first"] as const;

function containsNonFastForwardToken(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return NON_FAST_FORWARD_TOKENS.some((token) => s.includes(token));
}

function isTransientTransportPushError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  if (isTransientGhError(stderr)) return true;
  if (s.includes("could not read from remote") || s.includes("connection reset")) return true;
  if (s.includes("rpc failed") || s.includes("early eof") || s.includes("http 5")) return true;
  if (s.includes("timed out") || s.includes("timeout")) return true;
  return false;
}

/**
 * Classify git-push stderr before retry eligibility. Non-fast-forward /
 * rejected / fetch-first is workflow-state with head_drift, never
 * transient-infra. HTTP 5xx / connection-reset without those tokens stay
 * transient-infra and may retry.
 */
export function classifyPushFailure(stderr: string): PushFailureClassification {
  if (containsNonFastForwardToken(stderr)) {
    return { reason_code: "workflow-state", head_drift: true, retryable: false };
  }
  if (isTransientTransportPushError(stderr)) {
    return { reason_code: "transient-infra", head_drift: false, retryable: true };
  }
  return { reason_code: "transient-infra", head_drift: false, retryable: false };
}

/** True when stderr is a transient transport blip eligible for currency retry. */
export function isTransientPushError(stderr: string): boolean {
  return classifyPushFailure(stderr).retryable;
}

/** True when a parked diagnostic is the stale-tip / non-fast-forward class. */
export function isStaleTipPushEvidence(opts: {
  reasonCode?: string;
  blockerKind?: string;
  reason?: string;
}): boolean {
  const reason = (opts.reason ?? "").toLowerCase();
  if (opts.blockerKind === "push-failed" && opts.reasonCode === "workflow-state") {
    return true;
  }
  return containsNonFastForwardToken(reason);
}

export interface PushWithCurrencyDeps extends BackoffDeps {
  /** git in worktree: (args) => result */
  git: (args: string[]) => Promise<GitPushResult>;
  /** Expected remote-tracking tip SHA that this push must still own (optional). */
  expectedRemoteSha?: string | null;
  /** Local HEAD that must remain the owned candidate before retry. */
  expectedLocalSha?: string | null;
  retries?: number;
  siteId?: string;
}

export type PushWithCurrencyResult =
  | { ok: true; attempts: number }
  | {
      ok: false;
      attempts: number;
      reason: string;
      reason_code: StageDiagnosticReasonCode;
      head_drift: boolean;
    };

function classifiedPushFailure(
  stderr: string,
  attempts: number,
): Extract<PushWithCurrencyResult, { ok: false }> {
  const classified = classifyPushFailure(stderr);
  return {
    ok: false,
    attempts,
    reason: stderr,
    reason_code: classified.reason_code,
    head_drift: classified.head_drift,
  };
}

/**
 * Push with bounded retry. Classify stderr before retry eligibility so a
 * non-fast-forward is workflow-state on every path, including fail-closed
 * siteId. Before each retry, re-sync/fetch and verify local HEAD still
 * matches the owned/reviewed candidate. Never force-pushes.
 */
export async function pushWithCurrencyCheck(
  branch: string,
  deps: PushWithCurrencyDeps,
): Promise<PushWithCurrencyResult> {
  if (deps.siteId && !isTransientRetryableSite(deps.siteId)) {
    // Still attempt once when called explicitly, but no retry loop for fail-closed sites.
    const once = await deps.git(["push", "origin", branch]);
    if (once.code === 0) return { ok: true, attempts: 1 };
    return classifiedPushFailure(once.stderr.trim() || "push failed", 1);
  }

  const retries = deps.retries ?? DEFAULT_TRANSIENT_RETRIES;
  let lastErr = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Currency re-sync: fetch remote tip and compare expected SHAs.
      await deps.git(["fetch", "origin", branch]);
      if (deps.expectedLocalSha) {
        const head = await deps.git(["rev-parse", "HEAD"]);
        const local = head.stdout.trim();
        if (local && local !== deps.expectedLocalSha) {
          return {
            ok: false,
            attempts: attempt + 1,
            reason:
              `push currency check failed: local HEAD ${local.slice(0, 7)} drifted from ` +
              `owned candidate ${deps.expectedLocalSha.slice(0, 7)}; refusing retry (no force-push)`,
            reason_code: "workflow-state",
            head_drift: true,
          };
        }
      }
      if (deps.expectedRemoteSha) {
        const remote = await deps.git(["rev-parse", `origin/${branch}`]);
        const remoteSha = remote.stdout.trim();
        // If remote advanced away from the expected base and we are not based on it, refuse.
        if (
          remoteSha &&
          deps.expectedRemoteSha &&
          remoteSha !== deps.expectedRemoteSha &&
          deps.expectedLocalSha
        ) {
          const contains = await deps.git([
            "merge-base",
            "--is-ancestor",
            remoteSha,
            deps.expectedLocalSha,
          ]);
          if (contains.code !== 0) {
            return {
              ok: false,
              attempts: attempt + 1,
              reason:
                `push currency check failed: remote origin/${branch} moved to ` +
                `${remoteSha.slice(0, 7)}; refusing retry (no force-push)`,
              reason_code: "workflow-state",
              head_drift: true,
            };
          }
        }
      }
      await sleepMs(2 ** (attempt - 1) * 1000, deps);
    }

    const push = await deps.git(["push", "origin", branch]);
    if (push.code === 0) return { ok: true, attempts: attempt + 1 };
    lastErr = push.stderr.trim() || push.stdout.trim() || "push failed";
    const classified = classifyPushFailure(lastErr);
    if (!classified.retryable || attempt >= retries - 1) {
      return classifiedPushFailure(lastErr, attempt + 1);
    }
  }
  return classifiedPushFailure(lastErr || "push failed", retries);
}

// ---------------------------------------------------------------------------
// Verified remote head + ancestor skip-push (stale local tip)
// ---------------------------------------------------------------------------

export type VerifiedRemoteHead =
  | { ok: true; sha: string; source: "open-pr" | "fetch-head" | "origin-branch" }
  | { ok: false; reason: "unverified-remote-head" };

export interface ResolveVerifiedRemoteHeadDeps {
  git: (args: string[]) => Promise<GitPushResult>;
  /** Open-PR head SHA for the managed branch, when an open PR exists. */
  resolveOpenPrHead?: () => Promise<string | null>;
}

/**
 * Resolve a verified target SHA: open-PR head first, else fetch and use
 * FETCH_HEAD / origin/<branch>. Verification failure does not invent a tip.
 */
export async function resolveVerifiedRemoteHead(
  branch: string,
  deps: ResolveVerifiedRemoteHeadDeps,
): Promise<VerifiedRemoteHead> {
  let prSha: string | null = null;
  if (deps.resolveOpenPrHead) {
    try {
      const raw = await deps.resolveOpenPrHead();
      prSha = raw && raw.trim() ? raw.trim() : null;
    } catch {
      prSha = null;
    }
  }

  const fetch = await deps.git(["fetch", "origin", branch]);
  const fetchOk = fetch.code === 0;

  if (prSha) {
    if (fetchOk) {
      const afterFetch = await deps.git(["rev-parse", "--verify", prSha]);
      if (afterFetch.code === 0 && afterFetch.stdout.trim()) {
        return { ok: true, sha: afterFetch.stdout.trim(), source: "open-pr" };
      }
    }
    // PR head is still the preferred target when the lookup succeeded; the
    // object may already be local even if fetch failed.
    const local = await deps.git(["rev-parse", "--verify", prSha]);
    if (local.code === 0 && local.stdout.trim()) {
      return { ok: true, sha: local.stdout.trim(), source: "open-pr" };
    }
    if (!fetchOk) return { ok: false, reason: "unverified-remote-head" };
    return { ok: false, reason: "unverified-remote-head" };
  }

  if (!fetchOk) return { ok: false, reason: "unverified-remote-head" };

  const fetchHead = await deps.git(["rev-parse", "FETCH_HEAD"]);
  const fetchSha = fetchHead.stdout.trim();
  if (fetchHead.code === 0 && fetchSha) {
    return { ok: true, sha: fetchSha, source: "fetch-head" };
  }
  const origin = await deps.git(["rev-parse", `origin/${branch}`]);
  const originSha = origin.stdout.trim();
  if (origin.code === 0 && originSha) {
    return { ok: true, sha: originSha, source: "origin-branch" };
  }
  return { ok: false, reason: "unverified-remote-head" };
}

/** merge-base --is-ancestor: true, false, or null when git cannot decide. */
export async function isAncestorOfVerifiedHead(
  git: (args: string[]) => Promise<GitPushResult>,
  ancestor: string,
  verifiedHead: string,
): Promise<boolean | null> {
  const r = await git(["merge-base", "--is-ancestor", ancestor, verifiedHead]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

export type AncestorPushDecision =
  | { action: "skip"; verifiedHead: string; source: "open-pr" | "fetch-head" | "origin-branch" }
  | { action: "push"; reason: "local-ahead-or-diverged" | "unverified-remote-head" };

/**
 * After a fix-no-actionable-work decision: skip push when local HEAD is an
 * ancestor of the verified open-PR / remote head (remote ahead or equal).
 * Verification failure does not skip and does not reset.
 */
export async function decideAncestorPushAfterNoop(
  branch: string,
  deps: ResolveVerifiedRemoteHeadDeps & { localHead?: string },
): Promise<AncestorPushDecision> {
  const verified = await resolveVerifiedRemoteHead(branch, deps);
  if (!verified.ok) return { action: "push", reason: "unverified-remote-head" };
  const ancestor = await isAncestorOfVerifiedHead(
    deps.git,
    deps.localHead && deps.localHead.trim() ? deps.localHead.trim() : "HEAD",
    verified.sha,
  );
  if (ancestor === true) {
    return { action: "skip", verifiedHead: verified.sha, source: verified.source };
  }
  if (ancestor === null) return { action: "push", reason: "unverified-remote-head" };
  return { action: "push", reason: "local-ahead-or-diverged" };
}

// ---------------------------------------------------------------------------
// Pipeline-owned format self-fix
// ---------------------------------------------------------------------------

export type FormatSelfFixKind = "fix-commit-subject" | "impl-commit-ref" | "verdict-section";

export interface FormatSelfFixInput {
  kind: FormatSelfFixKind;
  /** Current text (commit subject, body, or markdown section). */
  current: string;
  /** Pipeline-owned target (e.g. prescribed subject). */
  prescribed: string;
  /** Validation: true when text satisfies the owned format. */
  validate: (text: string) => boolean;
  /** When true, content is human-authored and must not be rewritten. */
  humanProse?: boolean;
}

export interface FormatSelfFixDeps {
  /** Hard cap on rewrite attempts (default 1). */
  maxAttempts?: number;
}

export type FormatSelfFixResult =
  | { ok: true; text: string; rewrote: boolean; attempts: number }
  | {
      ok: false;
      text: string;
      attempts: number;
      reason: string;
      reason_code: StageDiagnosticReasonCode;
      refused_human_prose?: boolean;
    };

/**
 * Bounded rewrite of pipeline-owned formats only. Never rewrites human prose
 * or review finding bodies. On exhaustion escalates as engine-owned defect.
 */
export function selfFixPipelineFormat(
  input: FormatSelfFixInput,
  deps: FormatSelfFixDeps = {},
): FormatSelfFixResult {
  if (input.humanProse) {
    return {
      ok: false,
      text: input.current,
      attempts: 0,
      reason: "format self-fix refuses to rewrite human-authored prose",
      reason_code: "workflow-engine-defect",
      refused_human_prose: true,
    };
  }
  if (input.validate(input.current)) {
    return { ok: true, text: input.current, rewrote: false, attempts: 0 };
  }

  const maxAttempts = deps.maxAttempts ?? 1;
  let text = input.current;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Pipeline-owned rewrite: replace with the prescribed format string.
    text = input.prescribed;
    if (input.validate(text)) {
      return { ok: true, text, rewrote: true, attempts: attempt };
    }
  }
  return {
    ok: false,
    text,
    attempts: maxAttempts,
    reason: `pipeline format self-fix exhausted for ${input.kind}`,
    reason_code: "workflow-engine-defect",
  };
}

/** Convenience: build the prescribed fix-round commit subject. */
export function prescribedFixCommitSubject(round: 1 | 2, issueNumber: number): string {
  return `fix: address review ${round} findings (#${issueNumber})`;
}

export function validateFixCommitSubject(
  subject: string,
  round: 1 | 2,
  issueNumber: number,
): boolean {
  return new RegExp(
    `fix:\\s+address review ${round} findings \\(#${issueNumber}\\)`,
    "i",
  ).test(subject);
}

// ---------------------------------------------------------------------------
// Disposition gate helper
// ---------------------------------------------------------------------------

export function assertTransientWrapperEligible(
  siteId: string,
): EscalationSiteDisposition {
  const d = dispositionForSiteId(siteId);
  if (d !== "transient-retryable") {
    throw new Error(
      `transient wrapper refused for site ${siteId} (disposition=${d}); ` +
        `only transient-retryable sites may use automatic retry wrappers`,
    );
  }
  return d;
}

// Re-export GhRunOptions for callers that forward seams.
export type { GhRunOptions };
