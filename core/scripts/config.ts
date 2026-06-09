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
    .object({
      enabled: z.enum(["auto", "on", "off"]).optional(),
      bootstrap: z.boolean().optional(),
    })
    .optional(),
  last30days: z
    .object({
      enabled: z.boolean().optional(),
      timeout: z.number().int().positive().optional(),
    })
    .optional(),
  steps: z
    .object({
      plan_review: z.boolean().optional(),
      standard_review: z.boolean().optional(),
      adversarial_review: z.boolean().optional(),
      docs: z.boolean().optional(),
    })
    .strict()
    .optional(),
  test_gate: z
    .object({
      enabled: z.boolean().optional(),
      command: z.string().optional(),
      max_attempts: z.number().int().positive().optional(),
      timeout: z.number().int().positive().optional(),
    })
    .optional(),
  eval_gate: z
    .object({
      enabled: z.boolean().optional(),
      command: z.string().optional(),
      mode: z.enum(["gate", "advisory"]).optional(),
      timeout: z.number().int().positive().optional(),
      max_attempts: z.number().int().positive().optional(),
    })
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
    openspec: {
      enabled: fileConfig.openspec?.enabled ?? DEFAULT_CONFIG.openspec.enabled,
      bootstrap: fileConfig.openspec?.bootstrap ?? DEFAULT_CONFIG.openspec.bootstrap,
    },
    last30days: {
      enabled: fileConfig.last30days?.enabled ?? DEFAULT_CONFIG.last30days.enabled,
      timeout: fileConfig.last30days?.timeout ?? DEFAULT_CONFIG.last30days.timeout,
    },
    steps: {
      plan_review: fileConfig.steps?.plan_review ?? DEFAULT_CONFIG.steps.plan_review,
      standard_review: fileConfig.steps?.standard_review ?? DEFAULT_CONFIG.steps.standard_review,
      adversarial_review: fileConfig.steps?.adversarial_review ?? DEFAULT_CONFIG.steps.adversarial_review,
      docs: fileConfig.steps?.docs ?? DEFAULT_CONFIG.steps.docs,
    },
    test_gate: {
      enabled: fileConfig.test_gate?.enabled ?? DEFAULT_CONFIG.test_gate.enabled,
      command: fileConfig.test_gate?.command,
      max_attempts: fileConfig.test_gate?.max_attempts ?? DEFAULT_CONFIG.test_gate.max_attempts,
      timeout: fileConfig.test_gate?.timeout ?? DEFAULT_CONFIG.test_gate.timeout,
    },
    eval_gate: {
      enabled: fileConfig.eval_gate?.enabled ?? DEFAULT_CONFIG.eval_gate.enabled,
      command: fileConfig.eval_gate?.command,
      mode: fileConfig.eval_gate?.mode ?? DEFAULT_CONFIG.eval_gate.mode,
      timeout: fileConfig.eval_gate?.timeout ?? DEFAULT_CONFIG.eval_gate.timeout,
      max_attempts: fileConfig.eval_gate?.max_attempts ?? DEFAULT_CONFIG.eval_gate.max_attempts,
    },
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

/**
 * Write a commented starter `.github/pipeline.yml` to the repo if absent.
 * Uses exclusive-create (`flag: "wx"`) so a concurrent second call never
 * clobbers an existing file — EEXIST → { created: false }.
 */
export async function scaffoldDefaultConfig(repoDir: string): Promise<{ created: boolean }> {
  const configDir = path.join(repoDir, ".github");
  const configPath = path.join(configDir, "pipeline.yml");

  fs.mkdirSync(configDir, { recursive: true });

  try {
    fs.writeFileSync(configPath, buildConfigTemplate(), { flag: "wx" });
    return { created: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") return { created: false };
    throw e;
  }
}

function buildConfigTemplate(): string {
  const d = DEFAULT_CONFIG;
  return `# Pipeline configuration for this repo — created by \`pipeline init\`.
# Every key is shown at its current default value; edit any line to override.
# Delete a key to fall back to the built-in default. Lines that are commented
# out (e.g. the \`command:\` entries) are optional overrides — uncomment to set.

base_branch: ${d.base_branch} # branch PRs target and worktrees branch from
worktree_root: ${d.worktree_root} # dir (relative to repo) holding pipeline worktrees
max_concurrent_worktrees: ${d.max_concurrent_worktrees} # cap on simultaneous in-flight worktrees
auto_merge: ${d.auto_merge} # accepted for back-compat; the pipeline stops at ready-to-deploy
auto_recovery_max_retries: ${d.auto_recovery_max_retries} # auto-recovery attempts when implementation blocks
implementation_timeout: ${d.implementation_timeout} # seconds for the implementation harness
review_timeout: ${d.review_timeout} # seconds per review stage
fix_timeout: ${d.fix_timeout} # seconds per fix stage
ci_timeout: ${d.ci_timeout} # seconds to wait for CI at pre-merge
ci_poll_interval: ${d.ci_poll_interval} # seconds between CI status polls

models: # model alias per phase (resolved by the active harness)
  planning: ${d.models.planning}
  review: ${d.models.review}
  fix: ${d.models.fix}

openspec:
  enabled: ${d.openspec.enabled} # auto | on | off
  bootstrap: ${d.openspec.bootstrap} # if true, run \`openspec init\` on repos lacking openspec/

last30days:
  enabled: ${d.last30days.enabled} # opt-in pre-planning activity brief
  timeout: ${d.last30days.timeout} # seconds

steps: # turn optional steps off for speed/preference (default: all on)
  plan_review: ${d.steps.plan_review} # cross-harness review of the plan before coding
  standard_review: ${d.steps.standard_review} # review-1 (and its fix round)
  adversarial_review: ${d.steps.adversarial_review} # review-2 (and its fix round)
  docs: ${d.steps.docs} # docs-update pass in pre-merge

test_gate: # run the repo's tests/build before opening a PR
  enabled: ${d.test_gate.enabled} # set false to disable entirely
  # command: pnpm test # explicit command; auto-detected when absent
  max_attempts: ${d.test_gate.max_attempts} # fix-harness invocations before blocking
  timeout: ${d.test_gate.timeout} # seconds per test/build run

eval_gate: # run the repo's eval harness after pre-merge
  enabled: ${d.eval_gate.enabled} # set true to enable (one-time declaration per repo)
  # command: pnpm evals # shell command to run; required when enabled
  mode: ${d.eval_gate.mode} # gate: block on fail | advisory: record and advance
  timeout: ${d.eval_gate.timeout} # stage-level budget in seconds (shared across attempts)
  max_attempts: ${d.eval_gate.max_attempts} # total attempts before giving up (1 = no retry)
`;
}
