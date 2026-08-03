// Production RoadmapDeps wiring (#171).
// All external I/O is implemented here against real system calls; the roadmap
// engine itself (roadmap/index.ts) is dependency-injected and testable without
// any of this.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { resolveReviewerModelForHarness, reviewerModelSourceWasAuto } from "../stage-routing.ts";
import { getOpenIssues, createMilestone, getMilestones } from "../gh.ts";
import type { RoadmapDeps } from "../roadmap/index.ts";
import type { PipelineConfig } from "../types.ts";

/**
 * Explicit refspec so `refs/remotes/origin/<branch>` itself is updated.
 * Bare `git fetch origin <branch>` only populates FETCH_HEAD and leaves the
 * remote-tracking ref stale/missing (#632 review finding 75dd3a1d; same class
 * as #579 / pre-merge archive fetch).
 */
export function roadmapBranchFetchRefspec(branch: string): string {
  return `${branch}:refs/remotes/origin/${branch}`;
}

export type RoadmapThrowawayWorktreePlan =
  | { kind: "add"; addArgs: string[] }
  | { kind: "error"; message: string };

/**
 * Pure planner for roadmap throwaway `git worktree add` args (#632).
 *
 * When the explicit remote-tracking fetch succeeds, ALWAYS start from
 * `origin/<branch>` (via `-B`) so a stale local day-branch cannot win over the
 * published PR head. When the remote ref is missing (new day branch), fall back
 * to local or baseRef. Any other fetch failure fails closed rather than
 * silently creating from baseRef (which would non-fast-forward-fail on push
 * against an existing PR).
 */
export function planRoadmapThrowawayWorktreeAdd(opts: {
  branch: string;
  baseRef: string;
  wtDir: string;
  fetchStatus: number;
  fetchStderr: string;
  localBranchExists: boolean;
}): RoadmapThrowawayWorktreePlan {
  const { branch, baseRef, wtDir, fetchStatus, fetchStderr, localBranchExists } = opts;

  if (fetchStatus === 0) {
    // Prefer freshly fetched remote head over any local branch. `-B` creates or
    // resets the local branch name to that tip inside the throwaway worktree.
    return {
      kind: "add",
      addArgs: ["worktree", "add", "--force", "-B", branch, wtDir, `origin/${branch}`],
    };
  }

  const err = (fetchStderr || "").trim();
  const missingRemote = /couldn't find remote ref/i.test(err);
  if (!missingRemote) {
    return {
      kind: "error",
      message:
        `git fetch origin ${roadmapBranchFetchRefspec(branch)} failed: ${err || "(no output)"}`,
    };
  }

  // Expected for a brand-new day-keyed branch that has never been pushed.
  if (localBranchExists) {
    return {
      kind: "add",
      addArgs: ["worktree", "add", "--force", wtDir, branch],
    };
  }
  return {
    kind: "add",
    addArgs: ["worktree", "add", "--force", "-b", branch, wtDir, baseRef],
  };
}

/**
 * Build real RoadmapDeps from the resolved PipelineConfig.
 * All calls hit real gh CLI, real filesystem, and real harness invocations.
 */
export function realRoadmapDeps(cfg: PipelineConfig): RoadmapDeps {
  return {
    getOpenIssues: (repo, opts) => getOpenIssues(repo, opts),

    readFile: async (p) => {
      try {
        // Resolve relative paths against cfg.repo_dir so --repo-path and subdir runs work correctly
        const resolved = path.isAbsolute(p) ? p : path.join(cfg.repo_dir, p);
        return fs.readFileSync(resolved, "utf8");
      } catch {
        return null;
      }
    },

    runHarness: async (prompt) => {
      const result = await invoke(
        cfg.harnesses.implementer,
        cfg.repo_dir,
        prompt,
        { stream: true, model: cfg.models.implementing },
      );
      return { success: result.success, output: result.stdout };
    },

    runCritiqueHarness: async (prompt) => {
      const result = await invoke(
        cfg.harnesses.reviewer,
        cfg.repo_dir,
        prompt,
        {
          stream: true,
          model: resolveReviewerModelForHarness(
            cfg.harnesses.reviewerModel ?? cfg.models.review,
            cfg.harnesses.reviewer,
            reviewerModelSourceWasAuto(cfg, undefined),
          ),
        },
      );
      return { success: result.success, output: result.stdout };
    },

    writeFile: async (p, content) => {
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      // Atomic write (temp + rename): the rename is atomic on a single filesystem, so two
      // concurrent roadmap runs can't corrupt or partially clobber a shared output file such
      // as plan.json (last writer wins cleanly) — no lock needed (#214).
      const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, p);
    },

    /**
     * Throwaway linked worktree for roadmap docs PR writeback (#632).
     * Never switches the operator checkout. Path lives under
     * `<repoDir>/.worktrees/roadmap+…` and is force-removed in `finally`
     * (not counted as an issue-managed advance worktree). Branch is kept
     * after removal so the day-keyed PR head remains.
     */
    withThrowawayWorktree: async (repoDir, branch, baseRef, fn) => {
      const safeBranch = branch.replace(/\//g, "+");
      const wtDir = path.join(repoDir, ".worktrees", `roadmap+${safeBranch}+${process.pid}`);

      // Best-effort: drop a stale path from a prior crashed run at the same pid path.
      if (fs.existsSync(wtDir)) {
        spawnSync("git", ["worktree", "remove", "--force", wtDir], {
          cwd: repoDir, encoding: "utf8",
        });
      }
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });

      // Explicit destination refspec updates refs/remotes/origin/<branch> itself
      // (bare fetch only sets FETCH_HEAD — #632 review finding 75dd3a1d).
      const fetch = spawnSync(
        "git",
        ["fetch", "origin", roadmapBranchFetchRefspec(branch)],
        { cwd: repoDir, encoding: "utf8" },
      );

      const localBranchExists =
        spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
          cwd: repoDir, encoding: "utf8",
        }).status === 0;

      const plan = planRoadmapThrowawayWorktreeAdd({
        branch,
        baseRef,
        wtDir,
        fetchStatus: fetch.status ?? 1,
        fetchStderr: `${fetch.stderr || ""}${fetch.stdout || ""}`,
        localBranchExists,
      });
      if (plan.kind === "error") {
        throw new Error(plan.message);
      }

      const add = spawnSync("git", plan.addArgs, { cwd: repoDir, encoding: "utf8" });
      if (add.status !== 0) {
        throw new Error(
          `git worktree add for roadmap branch ${branch} failed: ${add.stderr || add.stdout}`,
        );
      }

      try {
        return await fn(wtDir);
      } finally {
        // Safety scope: only the path created above. Do not delete the branch —
        // the day-keyed PR still needs it.
        const rm = spawnSync("git", ["worktree", "remove", "--force", wtDir], {
          cwd: repoDir, encoding: "utf8",
        });
        if (rm.status !== 0) {
          // Cleanup failure must not override a successful PR URL or leave the
          // operator checkout on a different branch (we never switched it).
          process.stderr.write(
            `[roadmap] failed to remove throwaway worktree ${wtDir}: ${rm.stderr || rm.stdout}\n`,
          );
        }
      }
    },

    gitCommit: async (repoDir, files, message) => {
      const add = spawnSync("git", ["add", "--", ...files], { cwd: repoDir, encoding: "utf8" });
      if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);
      const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoDir, encoding: "utf8" });
      if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
    },

    gitPushBranch: async (repoDir, branch) => {
      const r = spawnSync("git", ["push", "origin", branch], { cwd: repoDir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git push failed: ${r.stderr}`);
    },

    findPrByHead: async (repo, head) => {
      const r = spawnSync(
        "gh",
        ["pr", "list", "--head", head, "--json", "url", "-R", repo, "--state", "open"],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      try {
        const items = JSON.parse(r.stdout) as Array<{ url: string }>;
        return items[0]?.url ?? null;
      } catch {
        return null;
      }
    },

    createPr: async (repoDir, title, body, base, head) => {
      const r = spawnSync(
        "gh",
        ["pr", "create", "--title", title, "--body", body, "--base", base, "--head", head, "-R", cfg.repo],
        { cwd: repoDir, encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`gh pr create failed: ${r.stderr}`);
      return r.stdout.trim();
    },

    createLabel: async (_repo, name, color) => {
      const r = spawnSync("gh", ["label", "create", name, "--color", color, "-R", cfg.repo], {
        encoding: "utf8",
      });
      if (r.status !== 0 && !/already exists/.test(r.stderr ?? "")) {
        throw new Error(`gh label create failed: ${r.stderr}`);
      }
    },

    applyLabel: async (_repo, issueNumber, label) => {
      const r = spawnSync(
        "gh",
        ["issue", "edit", String(issueNumber), "--add-label", label, "-R", cfg.repo],
        { encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`gh issue edit --add-label failed: ${r.stderr}`);
    },

    createMilestone: (repo, title, dueOn) => createMilestone(repo, title, dueOn),

    getMilestones: (repo) => getMilestones(repo),

    assignIssueMilestone: async (_repo, issueNumber, milestoneTitle) => {
      const r = spawnSync(
        "gh",
        ["issue", "edit", String(issueNumber), "--milestone", milestoneTitle, "-R", cfg.repo],
        { encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`gh issue edit --milestone failed: ${r.stderr}`);
    },

    getLatestTag: async (repoDir) => {
      const r = spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
        cwd: repoDir, encoding: "utf8",
      });
      return r.status === 0 ? r.stdout.trim() : "";
    },

    closeIssue: async (_repo, issueNumber) => {
      const r = spawnSync("gh", ["issue", "close", String(issueNumber), "-R", cfg.repo], {
        encoding: "utf8",
      });
      if (r.status !== 0) throw new Error(`gh issue close failed: ${r.stderr}`);
    },

    addComment: async (_repo, issueNumber, body) => {
      const r = spawnSync(
        "gh",
        ["issue", "comment", String(issueNumber), "--body", body, "-R", cfg.repo],
        { encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(`gh issue comment failed: ${r.stderr}`);
    },

    editIssue: async (_repo, issueNumber, editOpts) => {
      const args = ["issue", "edit", String(issueNumber), "-R", cfg.repo];
      if (editOpts.title) args.push("--title", editOpts.title);
      if (editOpts.body) args.push("--body", editOpts.body);
      const r = spawnSync("gh", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`gh issue edit failed: ${r.stderr}`);
    },

    createIssue: async (_repo, title, body, labels) => {
      const args = ["issue", "create", "--title", title, "--body", body, "-R", cfg.repo];
      for (const l of labels) args.push("--label", l);
      const r = spawnSync("gh", args, { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`gh issue create failed: ${r.stderr}`);
      const url = r.stdout.trim();
      const m = url.match(/\/(\d+)$/);
      if (!m) throw new Error(`Could not parse issue number from: ${url}`);
      return Number.parseInt(m[1], 10);
    },

    getIssueState: async (_repo, issueNumber) => {
      const r = spawnSync(
        "gh",
        ["issue", "view", String(issueNumber), "--json", "state", "-R", cfg.repo],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return null;
      try {
        const d = JSON.parse(r.stdout) as { state: string };
        return d.state.toLowerCase() === "closed" ? "closed" : "open";
      } catch {
        return null;
      }
    },

    getIssueComments: async (_repo, issueNumber) => {
      const r = spawnSync(
        "gh",
        ["issue", "view", String(issueNumber), "--json", "comments", "-R", cfg.repo],
        { encoding: "utf8" },
      );
      if (r.status !== 0) return [];
      try {
        const d = JSON.parse(r.stdout) as { comments: { body: string }[] };
        return d.comments ?? [];
      } catch {
        return [];
      }
    },

    log: (msg) => process.stdout.write(msg + "\n"),
  };
}
