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
