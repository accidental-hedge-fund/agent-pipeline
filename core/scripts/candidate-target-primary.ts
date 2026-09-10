import * as path from "node:path";
import { primaryWorktreeFromPorcelain, type RunStoreRootGitRunner } from "./run-store.ts";
import { ownerRepoFromPackageRepository } from "./production-engine-pin.ts";

/** Read-only validation for the hidden exact-candidate artifact-owner binding. */
export async function validateCandidateTargetPrimary(
  target: string,
  candidateRepository: string,
  git: RunStoreRootGitRunner,
): Promise<string | null> {
  const listed = await git(target, ["worktree", "list", "--porcelain"], { ignoreFailure: true }).catch(() => null);
  const primary = listed?.code === 0 ? primaryWorktreeFromPorcelain(listed.stdout) : null;
  if (!primary || path.normalize(primary) !== target) return "candidate target primary is not the canonical primary checkout";
  const remote = await git(target, ["remote", "get-url", "origin"]);
  const targetRepo = remote.code === 0 ? ownerRepoFromPackageRepository(remote.stdout.trim()) : null;
  return targetRepo === candidateRepository ? null : "candidate target primary origin does not match the candidate repository";
}
