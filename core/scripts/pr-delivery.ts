// Repository-qualified delivery authority for linked pull requests.
// A branch name alone is never push authority: fork heads can collide with
// privileged branches in the base repository.

import { getPrDetail, getPrForIssue } from "./gh.ts";
import type { PipelineConfig, PrDetail } from "./types.ts";

export interface PrDeliveryAuthority {
  branch: string;
  headSha: string;
  prNumber: number;
  repository: string;
}

export interface DeliveryHeadPreflightResult {
  ok: boolean;
  actualHead?: string;
  reason?: string;
}

/** Prove a managed worktree is exactly at the freshly-authorized PR head. */
export async function preflightDeliveryWorktreeHead(
  worktreePath: string,
  delivery: PrDeliveryAuthority,
  git: (
    cwd: string,
    args: string[],
    opts?: { ignoreFailure?: boolean },
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<DeliveryHeadPreflightResult> {
  const result = await git(worktreePath, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const actualHead = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(actualHead)) {
    return { ok: false, reason: "cannot verify managed worktree HEAD" };
  }
  if (actualHead !== delivery.headSha.toLowerCase()) {
    return {
      ok: false,
      actualHead,
      reason: `managed worktree HEAD ${actualHead} does not match live PR head ${delivery.headSha}`,
    };
  }
  return { ok: true, actualHead };
}

/** Accept only an open PR whose head is owned by the configured base repo. */
export function prDeliveryAuthority(
  cfg: PipelineConfig,
  pr: Pick<
    PrDetail,
    | "number"
    | "state"
    | "head_ref"
    | "head_sha"
    | "head_repo_full_name"
    | "is_cross_repository"
  >,
): PrDeliveryAuthority | null {
  const repository = (pr.head_repo_full_name ?? "").trim();
  const branch = pr.head_ref.trim();
  const headSha = pr.head_sha.trim().toLowerCase();
  if (
    pr.state !== "open" ||
    pr.is_cross_repository !== false ||
    repository.toLowerCase() !== cfg.repo.trim().toLowerCase() ||
    !branch ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0
  ) return null;
  return { branch, headSha, prNumber: pr.number, repository };
}

/** Resolve and revalidate the PR linked to an issue at the mutation boundary. */
export async function resolveLinkedPrDelivery(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: { getPrForIssue?: typeof getPrForIssue; getPrDetail?: typeof getPrDetail } = {},
): Promise<PrDeliveryAuthority | null> {
  try {
    const prNumber = await (deps.getPrForIssue ?? getPrForIssue)(cfg, issueNumber);
    if (prNumber == null) return null;
    const pr = await (deps.getPrDetail ?? getPrDetail)(cfg, prNumber);
    return prDeliveryAuthority(cfg, pr);
  } catch {
    return null;
  }
}
