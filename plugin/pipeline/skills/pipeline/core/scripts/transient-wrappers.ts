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

function isTransientPushError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  if (isTransientGhError(stderr)) return true;
  if (s.includes("could not read from remote") || s.includes("connection reset")) return true;
  if (s.includes("rpc failed") || s.includes("early eof") || s.includes("http 5")) return true;
  if (s.includes("timed out") || s.includes("timeout")) return true;
  // Reject non-fast-forward / rejected updates as non-transient.
  if (s.includes("non-fast-forward") || s.includes("fetch first") || s.includes("rejected")) {
    return false;
  }
  return false;
}

/**
 * Push with bounded retry. Before each retry, re-sync/fetch and verify local
 * HEAD still matches the owned/reviewed candidate. Never force-pushes.
 */
export async function pushWithCurrencyCheck(
  branch: string,
  deps: PushWithCurrencyDeps,
): Promise<PushWithCurrencyResult> {
  if (deps.siteId && !isTransientRetryableSite(deps.siteId)) {
    // Still attempt once when called explicitly, but no retry loop for fail-closed sites.
    const once = await deps.git(["push", "origin", branch]);
    if (once.code === 0) return { ok: true, attempts: 1 };
    return {
      ok: false,
      attempts: 1,
      reason: once.stderr.trim() || "push failed",
      reason_code: "transient-infra",
      head_drift: false,
    };
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
    if (!isTransientPushError(lastErr) || attempt >= retries - 1) {
      return {
        ok: false,
        attempts: attempt + 1,
        reason: lastErr,
        reason_code: "transient-infra",
        head_drift: false,
      };
    }
  }
  return {
    ok: false,
    attempts: retries,
    reason: lastErr,
    reason_code: "transient-infra",
    head_drift: false,
  };
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
