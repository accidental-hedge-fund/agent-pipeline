// Production RoadmapDeps wiring (#171).
// All external I/O is implemented here against real system calls; the roadmap
// engine itself (roadmap/index.ts) is dependency-injected and testable without
// any of this.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { invoke } from "../harness.ts";
import { getOpenIssues, createMilestone, getMilestones } from "../gh.ts";
import type { RoadmapDeps } from "../roadmap/index.ts";
import type { PipelineConfig } from "../types.ts";

/**
 * Build real RoadmapDeps from the resolved PipelineConfig.
 * All calls hit real gh CLI, real filesystem, and real harness invocations.
 */
// A healthy continuous run holds the marker lock for well under a minute (read plan.json +
// compute the marker + write). An empty/unstamped lock older than this is a crash remnant.
const STALE_MARKER_LOCK_MS = 60_000;

/** Stable identity + metadata of a lock file, captured at decision time. */
export interface MarkerLockId { dev: number; ino: number; mtimeMs: number; size: number; }

/**
 * Reclaim a stale `.marker.lock`. Two stale cases, each identity-guarded:
 *  - Recorded PID is no longer a live process (a crashed run) → reclaim.
 *  - Empty/malformed content (a crash in the openSync→writeSync window left a never-stamped
 *    lock); liveness can't be checked, so reclaim ONLY once the file is older than
 *    STALE_MARKER_LOCK_MS — a live run mid-stamp is never stolen.
 * Returns true when a stale lock was removed (the caller retries the acquire). The unlink is
 * guarded by the file's dev+ino+mtime+size, so a lock another recoverer unlinked-and-recreated
 * (a NEW inode) is never deleted — closing the content-only-guard TOCTOU (#214).
 */
function reclaimStaleMarkerLock(lockPath: string): boolean {
  let content: string;
  let id: MarkerLockId;
  try {
    content = fs.readFileSync(lockPath, "utf8").trim();
    const st = fs.lstatSync(lockPath);
    id = { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return false; // vanished — the next openSync("wx") wins on its own
  }
  const pid = Number(content);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0); // throws ESRCH if the owner is gone
      return false; // owner alive — not stale
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false; // EPERM etc → assume alive
    }
    return unlinkMarkerLockIfSame(lockPath, id);
  }
  if (Date.now() - id.mtimeMs < STALE_MARKER_LOCK_MS) return false;
  return unlinkMarkerLockIfSame(lockPath, id);
}

/**
 * Unlink the lock ONLY if the file still has the exact identity (dev+ino) and metadata we
 * captured — so a lock another run unlinked-and-recreated (a new inode) is never removed.
 * Returns true on removal. Exported for the concurrent-reclaimer regression test.
 */
export function unlinkMarkerLockIfSame(lockPath: string, expected: MarkerLockId): boolean {
  try {
    const st = fs.lstatSync(lockPath);
    if (
      st.dev === expected.dev &&
      st.ino === expected.ino &&
      st.mtimeMs === expected.mtimeMs &&
      st.size === expected.size
    ) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    /* changed or vanished — let the caller retry the acquire */
  }
  return false;
}

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
        { stream: true, model: cfg.models.review },
      );
      return { success: result.success, output: result.stdout };
    },

    writeFile: async (p, content) => {
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, content, "utf8");
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

    acquireMarkerLock: async (outputDir) => {
      // Ensure the output dir exists before locking: on a clean first run it does not yet
      // exist, and openSync(..., "wx") would ENOENT before any plan.json is written (#214).
      fs.mkdirSync(outputDir, { recursive: true });
      const lockPath = path.join(outputDir, ".marker.lock");
      const poll = async (attemptsLeft: number): Promise<void> => {
        let fd: number;
        try {
          fd = fs.openSync(lockPath, "wx");
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === "EEXIST") {
            // Reclaim a lock whose owner crashed (dead PID, or an old never-stamped empty lock),
            // identity-guarded (dev+ino) so a lock another run unlinked-and-recreated is never
            // removed — restores crash-recovery for unattended automation without the content-
            // only-guard TOCTOU (#214).
            if (reclaimStaleMarkerLock(lockPath)) return poll(attemptsLeft);
            if (attemptsLeft > 0) {
              await new Promise<void>((r) => setTimeout(r, 50));
              return poll(attemptsLeft - 1);
            }
            // Held by a LIVE owner and never freed — surface a clear, actionable error.
            throw new Error(
              `[roadmap] could not acquire the continuous marker lock at ${lockPath} (held after ~1s). ` +
                `Another \`pipeline roadmap\` run may hold it; if none is active, remove the file to ` +
                `proceed: rm "${lockPath}"`,
            );
          }
          throw err;
        }
        // Stamp the owner PID (informational, for diagnosing a stranded lock). If stamping
        // fails, remove the just-created lock so this process never leaves an empty one behind.
        try {
          fs.writeSync(fd, String(process.pid));
          fs.closeSync(fd);
        } catch (err) {
          try { fs.closeSync(fd); } catch { /* fd may already be closed */ }
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          throw err;
        }
      };
      await poll(20); // retry up to ~1 second
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* ignore ENOENT */ }
      };
    },

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
