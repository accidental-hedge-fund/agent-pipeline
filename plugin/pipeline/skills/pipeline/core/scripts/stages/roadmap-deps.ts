// Production RoadmapDeps wiring (#171).
// All external I/O is implemented here against real system calls; the roadmap
// engine itself (roadmap/index.ts) is dependency-injected and testable without
// any of this.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { resolveReviewerModelForHarness } from "../stage-routing.ts";
import { getOpenIssues, createMilestone, getMilestones } from "../gh.ts";
import type { RoadmapDeps } from "../roadmap/index.ts";
import type { PipelineConfig } from "../types.ts";

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
        { stream: true, model: resolveReviewerModelForHarness(cfg.models.review, cfg.harnesses.reviewer) },
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

    gitBranchExists: async (repoDir, branch) => {
      const r = spawnSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
        cwd: repoDir, encoding: "utf8",
      });
      return r.status === 0;
    },

    gitCreateBranch: async (repoDir, branch, fromRef) => {
      const args = fromRef
        ? ["checkout", "-b", branch, fromRef]
        : ["checkout", "-b", branch];
      const r = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git checkout -b ${branch} failed: ${r.stderr}`);
    },

    gitSwitchBranch: async (repoDir, branch) => {
      const r = spawnSync("git", ["checkout", branch], { cwd: repoDir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git checkout ${branch} failed: ${r.stderr}`);
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
