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
