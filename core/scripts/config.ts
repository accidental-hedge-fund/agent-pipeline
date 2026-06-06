// Config loader: per-repo `.github/pipeline.yml` merged with built-in defaults.

import { z } from "zod";
import yaml from "js-yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, type Harness, type PipelineConfig } from "./types.ts";
import { loadProfile, type PipelineProfile } from "./profile.ts";

const PartialConfigSchema = z.object({
  repo: z.string().optional(),
  base_branch: z.string().optional(),
  worktree_root: z.string().optional(),
  max_concurrent_worktrees: z.number().int().positive().optional(),
  auto_merge: z.boolean().optional(),
  auto_recovery_max_retries: z.number().int().min(0).optional(),
  implementation_timeout: z.number().int().positive().optional(),
  review_timeout: z.number().int().positive().optional(),
  fix_timeout: z.number().int().positive().optional(),
  ci_timeout: z.number().int().positive().optional(),
  ci_poll_interval: z.number().int().positive().optional(),
  harnesses: z
    .object({
      implementer: z.enum(["claude", "codex"]),
      reviewer: z.enum(["claude", "codex"]),
    })
    .optional(),
  models: z
    .object({
      planning: z.string(),
      review: z.string(),
      fix: z.string(),
    })
    .optional(),
  openspec: z
    .object({ enabled: z.enum(["auto", "on", "off"]) })
    .optional(),
  conventions_md_path: z.string().optional(),
  domain_name: z.string().optional(),
  domain_description: z.string().optional(),
}).strict();

export interface ResolveOptions {
  repoPath?: string;        // path to the target repo's working tree
  domainOverride?: string;  // --domain X (used as the "domain" name in logs)
  baseBranch?: string;      // --base
  profile?: string;         // shared-core profile name
}

/**
 * Resolve a PipelineConfig from cwd or explicit repoPath:
 *   1. Walk up from repoPath / cwd to find a .git dir → that's the repo root.
 *   2. Discover owner/name via `gh repo view`.
 *   3. If `<repo>/.github/pipeline.yml` exists, parse + validate; merge with defaults.
 *   4. CLI overrides (baseBranch) win.
 */
export function resolveConfig(opts: ResolveOptions = {}): PipelineConfig {
  const profile = loadProfile(opts.profile ?? process.env.PIPELINE_PROFILE ?? "codex");
  const startDir = opts.repoPath ? path.resolve(opts.repoPath) : process.cwd();
  const repoDir = findGitRoot(startDir);
  if (!repoDir) {
    throw new Error(
      `${profile.invocation}: no git repo found at or above ${startDir}. Run from inside a checkout, or pass --repo-path.`,
    );
  }

  // Discover owner/name via gh.
  let repo: string;
  try {
    const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    repo = out.trim();
  } catch (err) {
    throw new Error(
      `Failed to discover GitHub repo for ${repoDir} via 'gh repo view'. Make sure 'gh' is authenticated.`,
    );
  }

  // Load file config if present.
  const configPath = path.join(repoDir, ".github", "pipeline.yml");
  let fileConfig: z.infer<typeof PartialConfigSchema> = {};
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object") {
      const result = PartialConfigSchema.safeParse(parsed);
      if (!result.success) {
        const errors = result.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid ${configPath}: ${errors}`);
      }
      fileConfig = result.data;
    }
  }

  const merged: PipelineConfig = {
    profile_name: profile.name,
    invocation: profile.invocation,
    review_mode: profile.reviewMode,
    marker_footer: profile.markerFooter,
    implementation_ready_message: profile.implementationReadyMessage,
    conventions_default: profile.conventionsDefault,
    domain: opts.domainOverride ?? path.basename(repoDir),
    repo: fileConfig.repo ?? repo,
    repo_dir: repoDir,
    base_branch: opts.baseBranch ?? fileConfig.base_branch ?? DEFAULT_CONFIG.base_branch,
    worktree_root: fileConfig.worktree_root ?? DEFAULT_CONFIG.worktree_root,
    max_concurrent_worktrees:
      fileConfig.max_concurrent_worktrees ?? DEFAULT_CONFIG.max_concurrent_worktrees,
    auto_merge: fileConfig.auto_merge ?? DEFAULT_CONFIG.auto_merge,
    auto_recovery_max_retries:
      fileConfig.auto_recovery_max_retries ?? DEFAULT_CONFIG.auto_recovery_max_retries,
    implementation_timeout:
      fileConfig.implementation_timeout ?? DEFAULT_CONFIG.implementation_timeout,
    review_timeout: fileConfig.review_timeout ?? DEFAULT_CONFIG.review_timeout,
    fix_timeout: fileConfig.fix_timeout ?? DEFAULT_CONFIG.fix_timeout,
    ci_timeout: fileConfig.ci_timeout ?? DEFAULT_CONFIG.ci_timeout,
    ci_poll_interval: fileConfig.ci_poll_interval ?? DEFAULT_CONFIG.ci_poll_interval,
    // Harness ownership is profile-relative. Keep the legacy config key accepted,
    // but do not let repo config invert the invoking harness ownership split.
    harnesses: profile.harnesses,
    models: fileConfig.models ?? DEFAULT_CONFIG.models,
    openspec: fileConfig.openspec ?? DEFAULT_CONFIG.openspec,
    conventions_md_path: fileConfig.conventions_md_path,
    domain_name: fileConfig.domain_name,
    domain_description: fileConfig.domain_description,
  };
  return merged;
}

function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the conventions excerpt to embed in stage prompts. Falls back to a
 * stub if the configured path doesn't exist. Truncates to keep prompts
 * focused.
 */
export function readConventions(cfg: PipelineConfig, capChars = 8000): string {
  const filePath = cfg.conventions_md_path
    ? path.resolve(cfg.repo_dir, cfg.conventions_md_path)
    : path.join(cfg.repo_dir, cfg.conventions_default ?? "CLAUDE.md");
  if (!fs.existsSync(filePath)) {
    return "(no conventions file found — agents will use repo conventions inferred from the codebase)";
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length <= capChars) return text;
  return text.slice(0, capChars) + "\n\n[…conventions truncated]";
}

export function domainContext(cfg: PipelineConfig): { name: string; description: string } {
  return {
    name: cfg.domain_name ?? cfg.repo.split("/")[1] ?? cfg.domain,
    description: cfg.domain_description ?? "this repository",
  };
}
