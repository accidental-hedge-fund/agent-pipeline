/**
 * Pre-merge one-shot heal for generate-docs --check / CHANGELOG freshness
 * failures (#1081).
 *
 * Not an assertion-fix and not a flake re-run. Fetches tags (CHANGELOG is
 * tag-derived), regenerates via the existing docs-freshness heal, then pushes
 * a pipeline-internal commit. One attempt per head SHA is owned by the CI
 * recovery ladder.
 */

import { DEFAULT_GIT_PUSH_AUTH, gitExecForwardingEnv, runConfiguredGitPush } from "./git-push-auth.ts";
import { enforceDocsFreshness, type DocsFreshnessDeps } from "./docs-freshness.ts";
import type { PipelineConfig } from "./types.ts";
import { branchName, getOnDiskForIssue, gitInWorktree } from "./worktree.ts";

export interface CiDocsStaleHealCtx {
  prNumber: number;
  headSha: string;
  logExcerpt: string | null;
}

export interface CiDocsStaleHealDeps {
  getForIssue?: typeof getOnDiskForIssue;
  enforceDocsFreshness?: typeof enforceDocsFreshness;
  docsFreshness?: DocsFreshnessDeps;
  fetchTags?: (wtPath: string) => Promise<void>;
  gitPush?: (
    wtPath: string,
    branch: string,
    cfg: PipelineConfig,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

export async function runCiDocsStaleHeal(
  cfg: PipelineConfig,
  issueNumber: number,
  _ctx: CiDocsStaleHealCtx,
  deps: CiDocsStaleHealDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const enforceFn = deps.enforceDocsFreshness ?? enforceDocsFreshness;
  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt?.path) {
    return { ok: false, reason: "docs-stale heal: no managed worktree for issue" };
  }

  const fetchTagsFn =
    deps.fetchTags ??
    (async (wtPath: string) => {
      await gitInWorktree(wtPath, ["fetch", "--tags", "origin"], { ignoreFailure: true });
    });
  await fetchTagsFn(wt.path);

  const freshness = await enforceFn(wt.path, issueNumber, deps.docsFreshness ?? {});
  if (!freshness.ok) {
    return { ok: false, reason: freshness.reason };
  }
  if (!freshness.ran || !freshness.healed) {
    return {
      ok: false,
      reason:
        "docs-stale heal: local generate-docs check is already green or produced no commit; " +
        "refusing to claim a CI freshness heal without a new HEAD",
    };
  }

  const slug = wt.slug ?? "docs-heal";
  const branch = wt.branch ?? branchName(issueNumber, slug);
  const pushFn =
    deps.gitPush ??
    (async (wtPath: string, pushBranch: string, pushCfg: PipelineConfig) => {
      const pushAuth = pushCfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH;
      const push = await runConfiguredGitPush({
        cwd: wtPath,
        auth: pushAuth,
        args: ["push", "origin", pushBranch],
        deps: {
          gitConfigGet: async (cwd, key) => {
            const r = await gitInWorktree(cwd, ["config", "--get", key], { ignoreFailure: true });
            return r.code === 0 ? r.stdout.trim() || null : null;
          },
          gitExec: gitExecForwardingEnv(wtPath, gitInWorktree),
        },
      });
      if (push.code !== 0) {
        return {
          ok: false,
          reason: push.errorMessage ?? (push.stderr.trim() || "docs-stale heal push failed"),
        };
      }
      return { ok: true };
    });

  const pushed = await pushFn(wt.path, branch, cfg);
  if (!pushed.ok) {
    return { ok: false, reason: pushed.reason ?? "docs-stale heal push failed" };
  }
  return { ok: true };
}
