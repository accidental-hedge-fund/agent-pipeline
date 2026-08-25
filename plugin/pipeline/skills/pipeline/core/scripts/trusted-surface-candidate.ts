// Trusted-surface candidate SHA resolution (#1243).
//
// Worktree HEAD remains the source when a managed worktree is on disk.
// After park-release, late-stage re-entry (at or after pre-merge) has no
// worktree; resolve from an explicit override or a linked open PR head that
// matches the last-advanced pin. Never invent a SHA from harness prose.
//
// PR head SHA is `gh pr view --json headRefOid` (confirmed 2026-08-25);
// typed wrapper: getPrDetail().head_sha.

import { STAGES, type Stage } from "./types.ts";
import {
  classifyGitShowResult,
  normalizeFullSha,
} from "./trusted-surface.ts";

/** All-zero SHA written only when fail-closed persist needs a schema-complete field. */
export const TRUSTED_SURFACE_SENTINEL_SHA = "0".repeat(40);

export type TrustedSurfaceCandidateSource = "worktree_head" | "override" | "pr_head";

export type LinkedPrHead = {
  prNumber: number;
  headSha: string;
};

export type ResolveTrustedSurfaceCandidateInput = {
  /** True when getOnDiskForIssue returned a managed worktree. */
  worktreePresent: boolean;
  worktreeHeadSha?: string | null;
  stage: string;
  /** Explicit candidate-SHA override (injectable seam; not a new public CLI). */
  overrideSha?: string | null;
  linkedPrHead?: LinkedPrHead | null;
  /** Last-advanced product candidate pin, or null when unknown. */
  lastAdvancedPin?: string | null;
};

export type ResolveTrustedSurfaceCandidateResult =
  | {
      ok: true;
      candidateSha: string;
      source: TrustedSurfaceCandidateSource;
    }
  | {
      ok: false;
      code:
        | "worktree_unavailable"
        | "candidate_sha_unresolved"
        | "candidate_sha_mismatch"
        | "invalid_candidate_sha";
      summary: string;
    };

export type GitRunner = (
  cwd: string,
  args: string[],
  opts?: { ignoreFailure?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export type TrustedSurfaceObjectSource = {
  listChangedPaths(
    baseSha: string | null,
    candidateSha: string,
  ): Promise<{ paths: string[] } | { error: string }>;
  resolveBaseSha?(candidateSha: string): Promise<string | null>;
  readBaseBlob?(
    baseSha: string,
    path: string,
  ): Promise<
    | { kind: "content"; content: string }
    | { kind: "absent" }
    | { kind: "unreadable"; error: string }
  >;
};

export function isTrustedSurfaceSentinelSha(sha: string | null | undefined): boolean {
  if (typeof sha !== "string") return false;
  return sha.trim().toLowerCase() === TRUSTED_SURFACE_SENTINEL_SHA;
}

/**
 * Last-advanced product candidate pin from durable records (#1243).
 * Timestamped `candidates` (trusted-surface and successful pre-merge) are
 * compared by persisted decision time / event `at`; the newest valid SHA
 * wins. When no timestamped candidate remains, order is prior-run non-sentinel
 * trusted-surface SHAs (iteration order), then last successful pre-merge
 * candidate, then review SHA-gate pin. Sentinels and malformed values are
 * skipped. Null when none remain.
 */
export type DurablePinCandidate = {
  sha?: string | null;
  /** ISO-8601 time of the durable record (decision persist, event `at`, or run start). */
  at?: string | null;
};

export type DurableLastAdvancedPinSources = {
  /** Timestamped trusted-surface and pre-merge records; newest `at` wins. */
  candidates?: readonly DurablePinCandidate[];
  priorTrustedSurfaceShas?: readonly (string | null | undefined)[];
  preMergeCandidateSha?: string | null;
  reviewedSha?: string | null;
};

export type DurablePriorRunPinInput = {
  runId: string;
  trustedSurfaceCandidateSha?: string | null;
  /** Persist time of the trusted-surface decision; not run start. */
  trustedSurfaceDecidedAt?: string | null;
  events?: readonly DurablePriorRunEvent[];
};

export type DurablePriorRunEvent = {
  type?: string;
  stage?: string;
  outcome?: string;
  commits?: readonly string[];
  at?: string;
};

/** Parse `<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>` into an ISO-8601 timestamp. */
export function startedAtFromRunId(runId: string): string | null {
  const match = runId.match(
    /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/,
  );
  if (!match) return null;
  const [, date, hh, mm, ss, ms] = match;
  const iso = `${date}T${hh}:${mm}:${ss}${ms ? `.${ms}` : ""}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function pinTimeMs(at: string | null | undefined): number | null {
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function firstValidPinSha(
  raw: string | null | undefined,
): string | null {
  const sha = normalizeFullSha(raw);
  if (!sha || isTrustedSurfaceSentinelSha(sha)) return null;
  return sha;
}

export function selectDurableLastAdvancedPin(
  sources: DurableLastAdvancedPinSources,
): string | null {
  let bestSha: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  let foundTimestamped = false;
  for (const candidate of sources.candidates ?? []) {
    const sha = firstValidPinSha(candidate.sha);
    if (!sha) continue;
    const ms = pinTimeMs(candidate.at);
    if (ms === null) continue;
    if (!foundTimestamped || ms > bestMs) {
      bestSha = sha;
      bestMs = ms;
      foundTimestamped = true;
    }
  }
  if (bestSha) return bestSha;

  const ordered = [
    ...(sources.candidates ?? []).map((c) => c.sha),
    ...(sources.priorTrustedSurfaceShas ?? []),
    sources.preMergeCandidateSha,
    sources.reviewedSha,
  ];
  for (const raw of ordered) {
    const sha = firstValidPinSha(raw);
    if (sha) return sha;
  }
  return null;
}

/**
 * Last SHA recorded on a successful (`advanced`) pre-merge `stage_complete`
 * event. Newest matching event `at` wins; equal or missing timestamps keep
 * later file order. Skips sentinels and malformed values. Null when none remain.
 */
export function extractPreMergeCandidateFromEvents(
  events: readonly DurablePriorRunEvent[],
): DurablePinCandidate | null {
  let found: DurablePinCandidate | null = null;
  let foundMs = Number.NEGATIVE_INFINITY;
  for (const ev of events) {
    if (ev.type !== "stage_complete" || ev.stage !== "pre-merge") continue;
    if (ev.outcome !== "advanced") continue;
    for (const raw of ev.commits ?? []) {
      const sha = firstValidPinSha(raw);
      if (!sha) continue;
      const at = typeof ev.at === "string" ? ev.at : null;
      const ms = pinTimeMs(at) ?? Number.NEGATIVE_INFINITY;
      if (!found || ms >= foundMs) {
        found = { sha, at };
        foundMs = ms;
      }
      break;
    }
  }
  return found;
}

export function extractPreMergeCandidateShaFromEvents(
  events: readonly DurablePriorRunEvent[],
): string | null {
  return extractPreMergeCandidateFromEvents(events)?.sha ?? null;
}

/**
 * Timestamped last-advanced candidates from one prior run. Trusted-surface
 * uses persisted `decided_at` when present; otherwise run_start `at` or the
 * run-id timestamp. Successful pre-merge uses the newest matching event `at`,
 * falling back to the run timestamp.
 */
export function durablePinCandidatesFromPriorRun(
  input: DurablePriorRunPinInput,
): DurablePinCandidate[] {
  const events = input.events ?? [];
  const runAt = startedAtFromRunId(input.runId);
  let runStartAt: string | null = runAt;
  for (const ev of events) {
    if (ev.type !== "run_start") continue;
    const at = pinTimeMs(ev.at) !== null ? ev.at! : null;
    if (at) {
      runStartAt = at;
      break;
    }
  }
  const out: DurablePinCandidate[] = [];
  const tsSha = firstValidPinSha(input.trustedSurfaceCandidateSha);
  if (tsSha) {
    const decidedAt =
      pinTimeMs(input.trustedSurfaceDecidedAt) !== null
        ? input.trustedSurfaceDecidedAt!
        : runStartAt;
    out.push({ sha: tsSha, at: decidedAt });
  }
  const preMerge = extractPreMergeCandidateFromEvents(events);
  if (preMerge?.sha) {
    out.push({
      sha: preMerge.sha,
      at: pinTimeMs(preMerge.at) !== null ? preMerge.at : runStartAt,
    });
  }
  return out;
}

/**
 * Late-stage SHA fallback applies at or after `pre-merge` (inclusive),
 * including ready-to-deploy. Early stages still require a managed worktree.
 * `needs-human` / `backlog` are not this fallback.
 */
export function stageAtOrAfterPreMerge(stage: string): boolean {
  if (stage === "needs-human" || stage === "backlog") return false;
  const pre = STAGES.indexOf("pre-merge");
  const i = (STAGES as readonly string[]).indexOf(stage as Stage);
  return i >= pre;
}

/**
 * Resolve the product candidate SHA for a trusted-surface decision.
 * Pure: callers supply already-fetched worktree HEAD / PR head / override.
 */
export function resolveTrustedSurfaceCandidateSha(
  input: ResolveTrustedSurfaceCandidateInput,
): ResolveTrustedSurfaceCandidateResult {
  if (input.worktreePresent) {
    const sha = normalizeFullSha(input.worktreeHeadSha);
    if (!sha) {
      return {
        ok: false,
        code: "invalid_candidate_sha",
        summary: `Trusted-surface HEAD is not a full SHA: "${String(input.worktreeHeadSha ?? "").trim()}"`,
      };
    }
    return { ok: true, candidateSha: sha, source: "worktree_head" };
  }

  if (!stageAtOrAfterPreMerge(input.stage)) {
    return {
      ok: false,
      code: "worktree_unavailable",
      summary: "Trusted-surface could not resolve the managed worktree for this issue",
    };
  }

  const override = normalizeFullSha(input.overrideSha);
  const prSha = normalizeFullSha(input.linkedPrHead?.headSha);
  const pin = normalizeFullSha(input.lastAdvancedPin);

  if (override) {
    if (prSha && prSha !== override) {
      return {
        ok: false,
        code: "candidate_sha_mismatch",
        summary:
          "Trusted-surface candidate-SHA override does not match the linked open PR head",
      };
    }
    return { ok: true, candidateSha: override, source: "override" };
  }

  if (prSha) {
    if (pin && pin !== prSha) {
      return {
        ok: false,
        code: "candidate_sha_mismatch",
        summary:
          "Linked open PR head does not match the last-advanced candidate pin",
      };
    }
    return { ok: true, candidateSha: prSha, source: "pr_head" };
  }

  return {
    ok: false,
    code: "candidate_sha_unresolved",
    summary:
      "Trusted-surface could not resolve a candidate SHA: no managed worktree, no explicit override, and no linked open PR head",
  };
}

/**
 * Read changed paths / base blobs from a git checkout without creating a
 * managed worktree. Used when park-release already freed the issue tree.
 */
export function gitRepoObjectSource(
  cwd: string,
  git: GitRunner,
  baseBranch: string,
): TrustedSurfaceObjectSource {
  return {
    async resolveBaseSha() {
      const res = await git(cwd, ["rev-parse", `origin/${baseBranch}`], {
        ignoreFailure: true,
      });
      if (res.code !== 0) return null;
      return normalizeFullSha(res.stdout.trim());
    },
    async listChangedPaths(baseSha, candidateSha) {
      const range = baseSha
        ? `${baseSha}...${candidateSha}`
        : `origin/${baseBranch}...${candidateSha}`;
      const res = await git(cwd, ["diff", "--name-only", range], {
        ignoreFailure: true,
      });
      if (res.code !== 0) {
        return {
          error: `Trusted-surface changed-path diff failed (git exit ${res.code})`,
        };
      }
      return {
        paths: res.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      };
    },
    async readBaseBlob(baseSha, path) {
      const show = await git(cwd, ["show", `${baseSha}:${path}`], {
        ignoreFailure: true,
      });
      const kind = classifyGitShowResult(show);
      if (kind === "content") return { kind: "content", content: show.stdout };
      if (kind === "absent") return { kind: "absent" };
      return {
        kind: "unreadable",
        error: `unreadable base blob ${baseSha}:${path} (git exit ${show.code})`,
      };
    },
  };
}
