// Config loader: per-repo `.github/pipeline.yml` merged with built-in defaults.

import { z } from "zod";
import yaml from "js-yaml";
import { parseDocument } from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, STAGES, type Harness, type PipelineConfig } from "./types.ts";
import { loadProfile, type PipelineProfile } from "./profile.ts";

const PartialConfigSchema = z.object({
  repo: z.string().optional().describe("GitHub repository in 'owner/name' format (overrides auto-detected value)."),
  base_branch: z.string().optional().describe("Branch that PRs target and worktrees branch from."),
  worktree_root: z.string().optional().describe("Directory (relative to repo root) where pipeline worktrees are created."),
  max_concurrent_worktrees: z.number().int().positive().optional().describe("Maximum number of simultaneous in-flight worktrees."),
  auto_recovery_max_retries: z.number().int().min(0).optional().describe("Number of auto-recovery attempts when implementation blocks."),
  implementation_timeout: z.number().int().positive().optional().describe("Seconds for the implementation harness before timing out."),
  review_timeout: z.number().int().positive().optional().describe("Seconds per review stage."),
  fix_timeout: z.number().int().positive().optional().describe("Seconds per fix stage."),
  intake_timeout: z.number().int().positive().optional().describe("Seconds for the intake harness call before timing out."),
  sweep_timeout: z.number().int().positive().optional().describe("Seconds for the sweep harness call before timing out."),
  ci_timeout: z.number().int().positive().optional().describe("Seconds to wait for CI at pre-merge."),
  ci_poll_interval: z.number().int().positive().optional().describe("Seconds between CI status polls."),
  ci_no_run_grace_s: z.number().int().min(0).optional().describe("Seconds to wait before checking for zero check-runs when CI is pending. Default 60; set to 0 to check immediately."),
  // Each alias is independently optional so a partial `models:` block (e.g.
  // only `review:`) is valid — resolveConfig fills the rest from DEFAULT_CONFIG
  // and the inert-alias warning keys off which sub-keys were explicitly set.
  models: z
    .object({
      planning: z.string().optional().describe("Model alias for the planning phase (implementer harness)."),
      implementing: z.string().optional().describe("Model alias for the implementing phase (implementer harness)."),
      review: z.string().optional().describe("Model alias for the review phase (reviewer harness)."),
      fix: z.string().optional().describe("Model alias for the fix phase (implementer harness)."),
      intake: z.string().optional().describe("Model alias for the intake spec-generation step (always the claude harness, regardless of profile — never inert)."),
      sweep: z.string().optional().describe("Model alias for the sweep spec-generation step (always the claude harness, regardless of profile — never inert)."),
    })
    .strict()
    .optional()
    .describe("Per-phase model aliases; only honored when the role's harness is claude (codex ignores them)."),
  openspec: z
    .object({
      enabled: z.enum(["auto", "on", "off"]).optional().describe("Whether to require OpenSpec: auto=only when openspec/ exists, on=always, off=never."),
      bootstrap: z.boolean().optional().describe("Run 'openspec init' on repos that lack an openspec/ directory."),
    })
    .strict()
    .optional()
    .describe("OpenSpec spec-driven-development integration settings."),
  last30days: z
    .object({
      enabled: z.boolean().optional().describe("Enable the pre-planning activity brief (opt-in)."),
      timeout: z.number().int().positive().optional().describe("Timeout in seconds for the last-30-days step."),
    })
    .strict()
    .optional()
    .describe("Pre-planning activity brief from the last 30 days of git history."),
  steps: z
    .object({
      plan_review: z.boolean().optional().describe("Cross-harness review of the plan before coding begins."),
      standard_review: z.boolean().optional().describe("First review round (review-1) and its fix round."),
      adversarial_review: z.boolean().optional().describe("Second adversarial review round (review-2) and its fix round."),
      docs: z.boolean().optional().describe("Include documentation update instructions in the implementing prompt."),
    })
    .strict()
    .optional()
    .describe("Toggle optional pipeline steps on or off."),
  test_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the test gate before opening a PR."),
      command: z.string().optional().describe("Explicit test command; auto-detected from lockfile when absent."),
      max_attempts: z.number().int().positive().optional().describe("Maximum fix-harness invocations before blocking."),
      timeout: z.number().int().positive().optional().describe("Seconds per test/build run."),
    })
    .strict()
    .optional()
    .describe("Run the repo's tests/build before opening a PR."),
  eval_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the eval gate (set true to activate; one-time declaration per repo)."),
      command: z.string().optional().describe("Shell command to run evals (required when enabled)."),
      mode: z.enum(["gate", "advisory"]).optional().describe("gate: block on failure; advisory: record result and advance."),
      timeout: z.number().int().positive().optional().describe("Stage-level budget in seconds (shared across attempts)."),
      max_attempts: z.number().int().positive().optional().describe("Total attempts before giving up (1 = no retry)."),
    })
    .strict()
    .optional()
    .describe("Run the repo's eval harness after pre-merge."),
  shipcheck_gate: z
    .object({
      enabled: z.boolean().optional().describe("Enable the shipcheck gate."),
      mode: z.enum(["advisory", "gate"]).optional().describe("advisory: record findings without blocking; gate: block on failure."),
      max_rounds: z.number().int().min(1).optional().describe("Maximum reviewer invocations before routing to needs-human."),
      rubric_path: z.string().optional().describe("Repo-root-relative path to the Markdown rubric file."),
      block_on_partial: z.boolean().optional().describe("When true and mode=gate, a partial verdict also blocks."),
    })
    .strict()
    .optional()
    .describe("Reviewer-owned acceptance rubric gate after eval-gate."),
  review_policy: z
    .object({
      block_threshold: z.enum(["critical", "high", "medium", "low"]).optional().describe("Findings at or above this severity block progression; below advise only."),
      min_confidence: z.number().min(0).max(1).optional().describe("Findings below this confidence score (0–1) advise rather than block."),
      max_adversarial_rounds: z.number().int().positive().optional().describe("Maximum adversarial review re-runs before routing still-blocking findings to needs-human."),
      risk_proportional: z.boolean().optional().describe("When true and review-1 approved with zero findings (low-risk), review-2 evaluates findings against a raised effective threshold (stricter of configured and 'high'), so medium/low findings advise rather than block. Default false — review-2 blocking unchanged."),
      ceiling_action: z.enum(["park", "demote_and_advance"]).optional().describe("Action at the max_adversarial_rounds round-budget ceiling. park (default): hard-park at needs-human. demote_and_advance: auto-demote below-high findings to advisory, file a follow-up issue, and advance to pre-merge. High/critical findings always park regardless."),
      surface_recurrence_rounds: z.number().int().min(0).optional().describe("Consecutive-round threshold N for the (file + category) surface-recurrence guard (#234). When N same-surface new-key blocking findings appear in N consecutive rounds, the guard fires and routes the cluster through ceiling_action. 0 disables the guard. Default 3."),
    })
    .strict()
    .optional()
    .describe("Controls which review findings block progression vs. merely advise."),
  doctor: z
    .object({
      runOnStart: z.boolean().optional().describe("Run preflight checks before planning; abort on any failure."),
      failFast: z.boolean().optional().describe("Stop at the first failing check instead of collecting all failures."),
    })
    .strict()
    .optional()
    .describe("Deterministic preflight capability check settings."),
  // Optional override for the reviewer-role harness (#40). When set, the review
  // step invokes this CLI instead of the profile's default reviewer. An arbitrary
  // string (not an enum) because a custom reviewer CLI name is unconstrained;
  // whether it actually exists is a runtime check (like test_gate/eval_gate
  // `command`). The implementer harness remains profile-only — there is no
  // companion `implementer`/`harnesses` key, and the deleted `harnesses:` block
  // stays rejected by the strict schema.
  review_harness: z.string().optional().describe("Override the reviewer CLI for the review step (profile default when absent)."),
  conventions_md_path: z.string().optional().describe("Repo-root-relative path to the conventions file embedded in stage prompts."),
  domain_name: z.string().optional().describe("Human-readable project name used in prompts and logs."),
  domain_description: z.string().optional().describe("Short description of this repository for prompt context."),
  // Worktree bootstrap: dependency install step (#174). Non-empty string →
  // run that shell command; "" → skip entirely; absent → auto-detect from lockfile.
  setup_command: z.string().optional().describe("Shell command to run in the worktree after creation, before the test gate."),
  // Format/lint normalization gate (#182). Each entry runs after implementing
  // and fix-round harnesses exit. auto_fix: true commits changes and re-runs;
  // auto_fix: false blocks on non-zero exit without committing.
  format_gate: z
    .array(
      z.object({ command: z.string(), auto_fix: z.boolean() }).strict(),
    )
    .optional()
    .describe("Formatter/linter commands to run after implementing and fix-round harnesses exit."),
  // Opt-in sandboxed harness execution (#21). When true, the claude implementer
  // uses --permission-mode default instead of bypassPermissions.
  harness_sandbox: z.boolean().optional().describe("Run the claude implementer with --permission-mode default instead of bypassPermissions."),
  // Backlog roadmap engine (#171). Optional per-repo overrides for label
  // filtering, scoring weights, and write-back behaviour.
  roadmap: z
    .object({
      include_labels: z.array(z.string()).optional().describe("Include only issues with at least one of these labels."),
      exclude_labels: z.array(z.string()).optional().describe("Exclude issues that carry any of these labels."),
      score_weights: z
        .object({
          impact: z.number().optional(),
          confidence: z.number().optional(),
          ease: z.number().optional(),
          risk_reduction: z.number().optional(),
          dep_leverage: z.number().optional(),
        })
        .strict()
        .optional()
        .describe("Multiplier overrides for each scoring sub-factor (default: 1.0 each)."),
      hygiene_auto_apply: z.boolean().optional().describe("When true, hygiene actions are applied automatically with --apply (default: false)."),
      pr_docs: z.boolean().optional().describe("When false, skip opening the roadmap.md PR (default: true)."),
      release_model: z.enum(["semver", "continuous"]).optional().describe("How the roadmap groups issues into milestones: 'semver' (default) bundles into version-numbered release lanes; 'continuous' groups by theme/epic for continuous delivery."),
    })
    .strict()
    .optional()
    .describe("Backlog roadmap engine settings (#171)."),
  // Sweep backlog maintenance pass (#168). Optional per-repo thresholds for the
  // sufficiency heuristic that determines which issues get re-specced.
  sweep: z
    .object({
      min_body_length: z.number().int().min(0).optional().describe("Minimum body character count for an issue to be considered sufficient (default: 150)."),
      required_sections: z.array(z.string()).optional().describe("Section headings (without ##) that must be present for an issue to be considered sufficient (default: Summary, User story, Acceptance criteria, Out of scope)."),
    })
    .strict()
    .optional()
    .describe("Sweep backlog maintenance pass settings (#168)."),
  // Multi-actor override trust list (#229). GitHub identities whose
  // `## Pipeline: Finding override` and `## Pipeline: Scope override` comments
  // are trusted in addition to the current actor. Default: [] (actor-only).
  trusted_override_actors: z.array(z.string()).optional().describe("Additional GitHub identities whose override sentinels are trusted besides the current pipeline actor."),
  // Bounded auto-loop mode (#149). Opt-in; disabled by default. When enabled,
  // recoverable stops at allowlisted pipeline-owned stages convert from stop to
  // automatic continuation within explicit round/wall-clock budgets. Parks at
  // `needs-human` with an evidence-backed handoff on exhaustion. Does not grant
  // merge/deploy/publish authority or bypass any human checkpoint.
  auto_loop: z
    .object({
      enabled: z.boolean().optional().describe("Enable bounded auto-loop mode (default false)."),
      max_rounds: z.number().int().positive().optional().describe("Maximum automatic continuations per run before parking at needs-human."),
      max_wallclock_minutes: z.number().int().positive().optional().describe("Wall-clock budget in minutes; independent of max_rounds."),
      stages: z.array(z.enum(STAGES)).optional().describe("Pipeline stages eligible for automatic continuation when a recoverable stop occurs."),
    })
    .strict()
    .optional()
    .describe("Bounded auto-loop mode: continue recoverable stops at allowlisted stages within explicit budgets, then park at needs-human on exhaustion (#149)."),
}).strict();

export interface ResolveOptions {
  repoPath?: string;        // path to the target repo's working tree
  domainOverride?: string;  // --domain X (used as the "domain" name in logs)
  baseBranch?: string;      // --base
  profile?: string;         // shared-core profile name
  tolerateInvalidConfig?: boolean; // warn + fall back to defaults instead of throwing on invalid config (used by init)
  /** When true, a `gh repo view` failure sets repo="" instead of throwing.
   *  Used by `pipeline doctor` so the command can run its own cli/auth/repo-access
   *  checks and report proper remediation even when gh is missing or auth is expired. */
  tolerateGhFailure?: boolean;
  /** When true, suppress non-fatal config-resolution warnings (`console.warn`).
   *  Used by `pipeline doctor --is-ok`, whose documented contract is a zero-output
   *  0/1 polling gate — a valid config that merely emits a warning (e.g. an inert
   *  `models.*` alias) must not write to stderr (#154). */
  quiet?: boolean;
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

  // Load file config BEFORE gh repo discovery so doctor.runOnStart can be
  // detected and incorporated into tolerateGhFailure. Without this ordering a
  // repo with doctor.runOnStart: true would still exit via the generic config-
  // error path when gh is missing/auth-expired — before the preflight gate ran.
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
        if (opts.tolerateInvalidConfig) {
          if (!opts.quiet) {
            console.warn(`[pipeline] init: ${configPath} has validation errors — using defaults. Fix the file to apply custom settings.\n  ${errors}`);
          }
          // fileConfig stays as {} — all defaults apply
        } else {
          throw new Error(`Invalid ${configPath}: ${errors}`);
        }
      } else {
        fileConfig = result.data;
      }
    }
  }

  // tolerateGhFailure: caller flag (standalone doctor / --doctor) OR
  // doctor.runOnStart: true from the local config.  In both cases resolveConfig
  // must not throw on a gh failure so that the preflight gate can run and report
  // the real CLI/auth/repo-access failure with actionable remediation text.
  const tolerateGhFailure = opts.tolerateGhFailure || (fileConfig.doctor?.runOnStart === true);

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
    if (!tolerateGhFailure) {
      throw new Error(
        `Failed to discover GitHub repo for ${repoDir} via 'gh repo view'. Make sure 'gh' is authenticated.`,
      );
    }
    // gh unavailable or auth expired: set repo="" so the caller can still run
    // doctor checks (cli:gh, github-auth, repo-access) which surface the real failure.
    repo = "";
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
    auto_recovery_max_retries:
      fileConfig.auto_recovery_max_retries ?? DEFAULT_CONFIG.auto_recovery_max_retries,
    implementation_timeout:
      fileConfig.implementation_timeout ?? DEFAULT_CONFIG.implementation_timeout,
    review_timeout: fileConfig.review_timeout ?? DEFAULT_CONFIG.review_timeout,
    fix_timeout: fileConfig.fix_timeout ?? DEFAULT_CONFIG.fix_timeout,
    intake_timeout: fileConfig.intake_timeout ?? DEFAULT_CONFIG.intake_timeout,
    sweep_timeout: fileConfig.sweep_timeout ?? DEFAULT_CONFIG.sweep_timeout,
    ci_timeout: fileConfig.ci_timeout ?? DEFAULT_CONFIG.ci_timeout,
    ci_poll_interval: fileConfig.ci_poll_interval ?? DEFAULT_CONFIG.ci_poll_interval,
    ci_no_run_grace_s: fileConfig.ci_no_run_grace_s ?? DEFAULT_CONFIG.ci_no_run_grace_s,
    // Harness roles are profile-relative; the implementer can never be set by
    // repo config (the strict schema rejects a `harnesses:` key outright). The
    // reviewer defaults to the profile's value but is overridden here by the
    // optional `review_harness` key (#40) when present, so all stage code can
    // keep reading only `cfg.harnesses.reviewer`.
    harnesses: {
      implementer: profile.harnesses.implementer,
      reviewer: fileConfig.review_harness ?? profile.harnesses.reviewer,
    },
    models: {
      planning: fileConfig.models?.planning ?? DEFAULT_CONFIG.models.planning,
      implementing: fileConfig.models?.implementing ?? DEFAULT_CONFIG.models.implementing,
      review: fileConfig.models?.review ?? DEFAULT_CONFIG.models.review,
      fix: fileConfig.models?.fix ?? DEFAULT_CONFIG.models.fix,
      intake: fileConfig.models?.intake ?? DEFAULT_CONFIG.models.intake,
      sweep: fileConfig.models?.sweep ?? DEFAULT_CONFIG.models.sweep,
    },
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
    shipcheck_gate: {
      enabled: fileConfig.shipcheck_gate?.enabled ?? DEFAULT_CONFIG.shipcheck_gate.enabled,
      mode: fileConfig.shipcheck_gate?.mode ?? DEFAULT_CONFIG.shipcheck_gate.mode,
      max_rounds: fileConfig.shipcheck_gate?.max_rounds ?? DEFAULT_CONFIG.shipcheck_gate.max_rounds,
      rubric_path: fileConfig.shipcheck_gate?.rubric_path ?? DEFAULT_CONFIG.shipcheck_gate.rubric_path,
      block_on_partial: fileConfig.shipcheck_gate?.block_on_partial ?? DEFAULT_CONFIG.shipcheck_gate.block_on_partial,
    },
    review_policy: {
      block_threshold:
        fileConfig.review_policy?.block_threshold ?? DEFAULT_CONFIG.review_policy.block_threshold,
      min_confidence:
        fileConfig.review_policy?.min_confidence ?? DEFAULT_CONFIG.review_policy.min_confidence,
      max_adversarial_rounds:
        fileConfig.review_policy?.max_adversarial_rounds ??
        DEFAULT_CONFIG.review_policy.max_adversarial_rounds,
      risk_proportional:
        fileConfig.review_policy?.risk_proportional ?? DEFAULT_CONFIG.review_policy.risk_proportional,
      ceiling_action:
        fileConfig.review_policy?.ceiling_action ?? DEFAULT_CONFIG.review_policy.ceiling_action,
      surface_recurrence_rounds:
        fileConfig.review_policy?.surface_recurrence_rounds ??
        DEFAULT_CONFIG.review_policy.surface_recurrence_rounds,
    },
    doctor: {
      runOnStart: fileConfig.doctor?.runOnStart ?? DEFAULT_CONFIG.doctor.runOnStart,
      failFast: fileConfig.doctor?.failFast ?? DEFAULT_CONFIG.doctor.failFast,
    },
    conventions_md_path: fileConfig.conventions_md_path,
    domain_name: fileConfig.domain_name,
    domain_description: fileConfig.domain_description,
    setup_command: fileConfig.setup_command,
    format_gate: fileConfig.format_gate ?? DEFAULT_CONFIG.format_gate,
    harness_sandbox: fileConfig.harness_sandbox ?? DEFAULT_CONFIG.harness_sandbox,
    trusted_override_actors: fileConfig.trusted_override_actors,
    auto_loop: {
      enabled: fileConfig.auto_loop?.enabled ?? DEFAULT_CONFIG.auto_loop.enabled,
      max_rounds: fileConfig.auto_loop?.max_rounds ?? DEFAULT_CONFIG.auto_loop.max_rounds,
      max_wallclock_minutes: fileConfig.auto_loop?.max_wallclock_minutes ?? DEFAULT_CONFIG.auto_loop.max_wallclock_minutes,
      stages: fileConfig.auto_loop?.stages ?? DEFAULT_CONFIG.auto_loop.stages,
    },
    roadmap: fileConfig.roadmap
      ? { ...fileConfig.roadmap, release_model: fileConfig.roadmap.release_model ?? "semver" }
      : fileConfig.roadmap,
    sweep: fileConfig.sweep,
  };
  if (!opts.quiet) warnInertModelAliases(fileConfig.models, merged.harnesses);
  return merged;
}

// Each `models.*` alias is honored by exactly one harness role. `models.review`
// drives the reviewer; `models.planning`/`models.implementing`/`models.fix` drive
// the implementer.
const MODEL_ALIAS_ROLES = [
  { key: "review", role: "reviewer" },
  { key: "planning", role: "implementer" },
  { key: "implementing", role: "implementer" },
  { key: "fix", role: "implementer" },
] as const;

/**
 * Warn (non-blocking) about `models.*` aliases that were explicitly set in
 * `.github/pipeline.yml` but are silently inert because the backing harness
 * role is `codex` — `harness.ts` passes `--model` only on the `claude` branch
 * (the codex branch ignores it). Advisory only: no throw, no fallback, and the
 * resolved config is unchanged (the inert alias is preserved in `config.models`).
 * Keys absent from `fileConfig.models` take their value from DEFAULT_CONFIG and
 * never warn — only user-authored, inert config does.
 */
function warnInertModelAliases(
  fileModels: z.infer<typeof PartialConfigSchema>["models"],
  harnesses: PipelineConfig["harnesses"],
): void {
  if (!fileModels) return;
  for (const { key, role } of MODEL_ALIAS_ROLES) {
    const value = fileModels[key];
    if (value === undefined) continue;
    if (harnesses[role] !== "codex") continue;
    console.warn(
      `[pipeline] config warning: models.${key} is set to "${value}" but the ${role} harness is "codex" — model aliases are only honored by the claude harness. The setting is ignored.`,
    );
  }
}

export function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the minimal config needed by `pipeline release` without calling `gh`.
 * Reads repo_dir from the provided git root and base_branch from pipeline.yml
 * (local file only — no network calls).
 *
 * Uses the same YAML parse + Zod schema validation as resolveConfig, so a
 * malformed or schema-violating config surfaces an error rather than silently
 * falling back to "main". Falls back to the default branch only when the config
 * file is absent or base_branch is genuinely unset.
 */
export function resolveReleaseConfig(
  repoDir: string,
  baseBranchOverride?: string,
): { repo_dir: string; repo: string; base_branch: string; release_model?: 'semver' | 'continuous'; intake_model: string; intake_timeout: number } {
  let baseBranch = DEFAULT_CONFIG.base_branch;
  let releaseModel: 'semver' | 'continuous' | undefined;
  // Intake always runs through the claude harness (see stages/intake.ts), so this
  // alias is never inert; default it here and let pipeline.yml's models.intake override.
  let intakeModel: string = DEFAULT_CONFIG.models.intake;
  let intakeTimeout: number = DEFAULT_CONFIG.intake_timeout;
  const configPath = path.join(repoDir, ".github", "pipeline.yml");
  if (fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    // yaml.load throws YAMLException on malformed YAML — propagate to surface the config problem.
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === "object") {
      const result = PartialConfigSchema.safeParse(parsed);
      if (!result.success) {
        const errors = result.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid ${configPath}: ${errors}`);
      }
      if (typeof result.data.base_branch === "string") {
        baseBranch = result.data.base_branch;
      }
      if (result.data.roadmap?.release_model) {
        releaseModel = result.data.roadmap.release_model;
      }
      if (result.data.models?.intake) {
        intakeModel = result.data.models.intake;
      }
      if (typeof result.data.intake_timeout === "number") {
        intakeTimeout = result.data.intake_timeout;
      }
    }
  }
  return {
    repo_dir: repoDir,
    repo: "",
    base_branch: baseBranchOverride ?? baseBranch,
    release_model: releaseModel,
    intake_model: intakeModel,
    intake_timeout: intakeTimeout,
  };
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

  // Cap for any preserved carry-forward content to keep total output bounded.
  const sectionCap = Math.floor(capChars / 4);

  // Scan for ALL supported carry-forward headings — Lessons or Gotchas (including
  // combined headings like "Lessons / Gotchas") — anywhere in the file. A
  // maintainer-curated section can sit at any depth, so we preserve every such
  // section the plain cap would drop or clip, not just the first match. (Looking
  // at only the first heading let an early in-cap section hide a later after-cap
  // one — the #19 review-ceiling finding.) Each section ends at the next heading
  // of the same or higher level (or EOF).
  const carryRe = /^(#+)[ \t]+(Lessons|Gotchas)\b/gim;
  const sections = [...text.matchAll(carryRe)].map((m) => {
    const level = m[1]!.length;
    const headingLineEnd = text.indexOf("\n", m.index);
    const afterHeadingLine = headingLineEnd >= 0 ? text.slice(headingLineEnd + 1) : "";
    const nextHeadingRe = new RegExp(`^#{1,${level}}[ \\t]+`, "m");
    const nextM = nextHeadingRe.exec(afterHeadingLine);
    const end = nextM ? headingLineEnd + 1 + nextM.index : text.length;
    return { start: m.index, end };
  });

  // A section is "at risk" of truncation when it is not fully inside the head
  // excerpt: its body extends past the cap, or it starts after the cap entirely.
  // Sections wholly within the head already ride along in text.slice(0, capChars).
  const atRisk = sections.filter((s) => s.end > capChars);
  if (atRisk.length === 0) {
    return text.slice(0, capChars) + "\n\n[…conventions truncated]";
  }

  // If any at-risk section crosses the cap boundary, cut the head at that
  // section's start so the section is included whole exactly once (no
  // duplication). Otherwise keep the full head and append the after-cap section(s).
  const crossing = atRisk.filter((s) => s.start < capChars);
  const headCut = crossing.length ? Math.min(...crossing.map((s) => s.start)) : capChars;

  let out = text.slice(0, headCut).trimEnd() + "\n\n[…conventions truncated]";
  // Water-fill the carry-forward budget (sectionCap) across at-risk sections in
  // document order. Before spending on a section, RESERVE a minimum share for each
  // later section the budget can still afford, then let this section use whatever
  // is left over its own minimum. One rule, all layouts:
  //   • the reserve stops an earlier/larger section from consuming the budget and
  //     starving later ones (a big section is clipped, not allowed to hog);
  //   • giving back the reserve when few sections remain lets an early section grow
  //     and lets compact sections cost only their actual size — so every section
  //     that fits is fully included and a large early section is still represented;
  //   • spending is always bounded by `remaining`, so the total stays within
  //     sectionCap no matter how many sections exist.
  // Sections that no longer fit even minimally are disclosed, never silently dropped.
  const SEP = "\n\n";
  const CLIP_MARKER = "\n\n[…lessons section truncated]";
  const MIN_SHARE = 120; // guaranteed minimum representation per section (heading + a little)
  const MIN_PIECE = 40; // minimum useful clipped text before the marker
  let remaining = sectionCap;
  let appended = 0;
  for (let i = 0; i < atRisk.length; i++) {
    const s = atRisk[i]!;
    const sectionsAfter = atRisk.length - i - 1;
    // How many later sections can still get their minimum (minus this one's minimum).
    const affordableAfter = Math.max(0, Math.floor(remaining / MIN_SHARE) - 1);
    const reserve = Math.min(sectionsAfter, affordableAfter) * MIN_SHARE;
    const allow = remaining - reserve;
    const full = text.slice(s.start, s.end).trimEnd();
    const costFull = SEP.length + full.length;
    if (costFull <= allow) {
      out += SEP + full;
      remaining -= costFull;
      appended++;
    } else if (allow >= SEP.length + MIN_PIECE + CLIP_MARKER.length) {
      const textRoom = allow - SEP.length - CLIP_MARKER.length;
      const piece = full.slice(0, textRoom).trimEnd() + CLIP_MARKER;
      out += SEP + piece;
      remaining -= SEP.length + piece.length;
      appended++;
    }
    // else: not enough budget to represent this section meaningfully → omit it
    // (disclosed below) and keep scanning; a later smaller section may still fit.
  }
  const omitted = atRisk.length - appended;
  if (omitted > 0) {
    out += SEP + `[…${omitted} more lessons/gotchas section(s) truncated]`;
  }
  return out;
}

export function domainContext(cfg: PipelineConfig): { name: string; description: string } {
  return {
    name: cfg.domain_name ?? cfg.repo.split("/")[1] ?? cfg.domain,
    description: cfg.domain_description ?? "this repository",
  };
}

// ---------------------------------------------------------------------------
// JSON Schema generation (#156)
// ---------------------------------------------------------------------------

/**
 * Returns the JSON Schema (draft-2020-12) for `.github/pipeline.yml`, derived
 * from `PartialConfigSchema`. Used by `pipeline config schema`.
 */
export function generateConfigSchema(): object {
  return z.toJSONSchema(PartialConfigSchema);
}

// ---------------------------------------------------------------------------
// Config validation (#156): never-throws alternative to resolveConfig()
// ---------------------------------------------------------------------------

/** Dotted paths of fields whose misconfiguration changes review coverage or
 *  paid-call volume. A bad value in any of these is always severity "error"
 *  with rigorGating:true so that a typo never silently degrades rigor. */
export const RIGOR_GATING_PATHS: readonly string[] = [
  "review_policy.block_threshold",
  "review_policy.min_confidence",
  "review_policy.max_adversarial_rounds",
  "review_policy.risk_proportional",
  "review_policy.ceiling_action",
  "review_policy.surface_recurrence_rounds",
  "steps.plan_review",
  "steps.standard_review",
  "steps.adversarial_review",
  "eval_gate.enabled",
  "eval_gate.mode",
  "shipcheck_gate.enabled",
  "shipcheck_gate.mode",
  "shipcheck_gate.max_rounds",
  "shipcheck_gate.block_on_partial",
];

const RIGOR_GATING_SET = new Set(RIGOR_GATING_PATHS);

export interface Diagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
  line?: number;
  rigorGating?: true;
}

export interface ValidateConfigResult {
  valid: boolean;
  diagnostics: Diagnostic[];
}

export interface ValidateConfigDeps {
  /** Read file contents; return null if the file does not exist. Defaults to fs.readFileSync. */
  readFile?: (filePath: string) => string | null;
  /** Find the git root above startDir; return null if none found. Defaults to the internal findGitRoot. */
  findGitRoot?: (startDir: string) => string | null;
  /** Harnesses used for inert-model detection. When absent, loaded from `profile` (or PIPELINE_PROFILE env var). */
  harnesses?: { implementer: string; reviewer: string };
  /** Profile name to load harnesses from when `harnesses` is not injected. Defaults to PIPELINE_PROFILE env var or "codex". */
  profile?: string;
}

const defaultReadFile = (fp: string): string | null => {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return null;
  }
};

/** Convert a 0-based character offset in `text` to a 1-indexed line number. */
function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Build a dotted-path → 1-indexed source-line resolver from raw YAML text, so
 * validation diagnostics for unknown keys and bad values carry a line a desktop
 * editor can attach to (#156). Uses the `yaml` CST (`parseDocument` node ranges)
 * rather than regex scanning, so it is correct for flow mappings
 * (`review_policy: { block_threshold: typo }`) and never matches config-like text
 * inside a block scalar. Returns a resolver that yields undefined when the path
 * cannot be located or the source cannot be parsed positionally.
 */
export function buildLineLookup(text: string): (dotPath: string) => number | undefined {
  let doc: ReturnType<typeof parseDocument> | undefined;
  try {
    doc = parseDocument(text, { keepSourceTokens: false });
  } catch {
    return () => undefined;
  }
  type RangedNode = { range?: [number, number, number] };
  type Pair = { key?: ({ value?: unknown } & RangedNode) };
  return (dotPath: string): number | undefined => {
    if (!dotPath) return undefined;
    const segments = dotPath.split(".");
    const last = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1);
    try {
      // Prefer the offending KEY's source range over the value's, so a multiline
      // mapping value (`block_threshold:\n    typo: true`) still points at the key
      // line, not the nested value line.
      const parent = parentPath.length === 0 ? doc!.contents : doc!.getIn(parentPath, true);
      const items = (parent as { items?: Pair[] } | undefined)?.items;
      if (Array.isArray(items)) {
        for (const pair of items) {
          if (pair?.key && String(pair.key.value) === last) {
            const keyOffset = pair.key.range?.[0];
            if (typeof keyOffset === "number") return lineFromOffset(text, keyOffset);
          }
        }
      }
      // Fallback to the value node range (e.g. sequence indices, or when the key
      // range is unavailable).
      const node = doc!.getIn(segments, true) as RangedNode | undefined;
      const offset = node?.range?.[0];
      return typeof offset === "number" ? lineFromOffset(text, offset) : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Validate `.github/pipeline.yml` at the git root of `repoPath` without throwing.
 * All error conditions are returned as structured `Diagnostic` objects.
 * Exits 1 semantics are determined by the caller based on `severity: "error"` diagnostics.
 */
export function validateConfig(
  repoPath: string,
  deps: ValidateConfigDeps = {},
): ValidateConfigResult {
  const diagnostics: Diagnostic[] = [];

  // 1. Find git root
  const findGitRootFn = deps.findGitRoot ?? findGitRoot;
  const resolvedStart = path.resolve(repoPath);
  const gitRoot = findGitRootFn(resolvedStart);
  if (!gitRoot) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `No git repository found at or above ${resolvedStart}.`,
    });
    return { valid: false, diagnostics };
  }

  // 2. Read pipeline.yml
  const readFileFn = deps.readFile ?? defaultReadFile;
  const configPath = path.join(gitRoot, ".github", "pipeline.yml");
  const text = readFileFn(configPath);
  if (text === null) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `Config file not found: ${configPath}`,
    });
    return { valid: false, diagnostics };
  }

  // 3. Parse YAML
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (err: unknown) {
    const yamlErr = err as { mark?: { line?: number }; message?: string };
    const rawLine = yamlErr?.mark?.line;
    const diag: Diagnostic = {
      severity: "error",
      path: "",
      message: `YAML parse error: ${yamlErr?.message ?? String(err)}`,
    };
    if (typeof rawLine === "number") {
      diag.line = rawLine + 1; // js-yaml uses 0-indexed lines
    }
    diagnostics.push(diag);
    return { valid: false, diagnostics };
  }

  // 4. Null YAML (empty file, "---", "~", "null") is valid (no overrides applied).
  // Any other non-object root (scalar, boolean, number, sequence) is an error.
  if (parsed == null) {
    return { valid: true, diagnostics: [] };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    diagnostics.push({
      severity: "error",
      path: "",
      message: `Config must be a YAML mapping (object), got ${Array.isArray(parsed) ? "sequence" : typeof parsed}.`,
    });
    return { valid: false, diagnostics };
  }

  // 5. Zod validation
  const result = PartialConfigSchema.safeParse(parsed);
  if (!result.success) {
    const lineOf = buildLineLookup(text);
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") {
        // Each unknown key becomes its own diagnostic
        const parentPath = issue.path.join(".");
        for (const key of (issue as { path: (string | number)[]; keys: string[]; message: string }).keys) {
          const dotPath = parentPath ? `${parentPath}.${key}` : key;
          const diag: Diagnostic = {
            severity: "error",
            path: dotPath,
            message: `Unrecognized key: "${key}"`,
          };
          const line = lineOf(dotPath);
          if (line !== undefined) diag.line = line;
          diagnostics.push(diag);
        }
      } else {
        const dotPath = issue.path.join(".");
        const diag: Diagnostic = {
          severity: "error",
          path: dotPath,
          message: issue.message,
        };
        const line = lineOf(dotPath);
        if (line !== undefined) diag.line = line;
        if (RIGOR_GATING_SET.has(dotPath)) {
          diag.rigorGating = true;
        }
        diagnostics.push(diag);
      }
    }
    return { valid: false, diagnostics };
  }

  // 6. Inert-model alias detection
  const fileConfig = result.data;
  if (fileConfig.models) {
    let harnesses = deps.harnesses;
    if (!harnesses) {
      try {
        const profileName = deps.profile ?? process.env.PIPELINE_PROFILE ?? "codex";
        harnesses = loadProfile(profileName).harnesses;
      } catch {
        // Profile unavailable — skip inert warnings rather than failing
        harnesses = undefined;
      }
    }
    // Apply review_harness from the file config (same override resolveConfig applies),
    // so inert-model detection reflects the actual effective reviewer at runtime.
    if (harnesses && fileConfig.review_harness) {
      harnesses = { ...harnesses, reviewer: fileConfig.review_harness };
    }
    if (harnesses) {
      for (const { key, role } of MODEL_ALIAS_ROLES) {
        const value = fileConfig.models[key];
        if (value === undefined) continue;
        if (harnesses[role] !== "codex") continue;
        diagnostics.push({
          severity: "warning",
          path: `models.${key}`,
          message: `models.${key} is set to "${value}" but the ${role} harness is "codex" — model aliases are only honored by the claude harness. The setting is ignored at runtime.`,
        });
      }
    }
  }

  const hasError = diagnostics.some((d) => d.severity === "error");
  return { valid: !hasError, diagnostics };
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
auto_recovery_max_retries: ${d.auto_recovery_max_retries} # auto-recovery attempts when implementation blocks
implementation_timeout: ${d.implementation_timeout} # seconds for the implementation harness
review_timeout: ${d.review_timeout} # seconds per review stage
fix_timeout: ${d.fix_timeout} # seconds per fix stage
intake_timeout: ${d.intake_timeout} # seconds for the intake harness call before timing out
sweep_timeout: ${d.sweep_timeout} # seconds for the sweep harness call before timing out
ci_timeout: ${d.ci_timeout} # seconds to wait for CI at pre-merge
ci_poll_interval: ${d.ci_poll_interval} # seconds between CI status polls
ci_no_run_grace_s: ${d.ci_no_run_grace_s} # seconds to wait before checking for zero check-runs when CI appears pending; set to 0 to check immediately

# models: # per-phase model alias — only honored when the role's harness is claude; codex ignores it (setting an inert one prints a warning). Uncomment to override.
#   planning: ${d.models.planning} # implementer harness
#   implementing: ${d.models.implementing} # implementer harness
#   review: ${d.models.review} # reviewer harness
#   fix: ${d.models.fix} # implementer harness
#   intake: ${d.models.intake} # intake spec-generation — always the claude harness (never inert)
#   sweep: ${d.models.sweep} # sweep spec-generation — always the claude harness (never inert)

# review_harness: my-reviewer # override the reviewer CLI for the review step (default: the profile's reviewer). The CLI receives the JSON-verdict prompt as a positional arg and must print a fenced JSON verdict block on stdout. The implementer harness is not configurable.

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
  docs: ${d.steps.docs} # include the docs-update instruction in the implementing prompt

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

# shipcheck_gate: # reviewer-owned acceptance rubric after eval-gate (#148). Disabled by default.
#   enabled: ${d.shipcheck_gate.enabled} # set true to enable
#   mode: ${d.shipcheck_gate.mode} # advisory: record findings without blocking | gate: block on fail
#   max_rounds: ${d.shipcheck_gate.max_rounds} # max reviewer invocations before needs-human
#   rubric_path: ${d.shipcheck_gate.rubric_path} # repo-root-relative path to Markdown rubric file
#   block_on_partial: ${d.shipcheck_gate.block_on_partial} # when true and mode=gate, partial verdict also blocks

review_policy: # which review findings block progression vs. merely advise (#17)
  block_threshold: ${d.review_policy.block_threshold} # critical|high|medium|low — findings below this advise, not block (set 'low' to block on every finding)
  min_confidence: ${d.review_policy.min_confidence} # 0..1 — findings below this confidence advise, not block
  max_adversarial_rounds: ${d.review_policy.max_adversarial_rounds} # cap review-round re-runs; after this, still-blocking findings go advisory and the item routes to needs-human
  # risk_proportional: ${d.review_policy.risk_proportional} # when true and review-1 approved with 0 findings (low risk), review-2 only blocks on high/critical findings (#232)
  # ceiling_action: ${d.review_policy.ceiling_action} # park (default): hard-park at needs-human at the round ceiling; demote_and_advance: auto-demote below-high findings to advisory, file a follow-up issue, and advance to pre-merge (high/critical always park) (#233)
  # surface_recurrence_rounds: ${d.review_policy.surface_recurrence_rounds} # (file+category) surface-recurrence guard: after N consecutive rounds of new-key blocking findings on the same surface, routes the cluster through ceiling_action; 0 disables (#234)

doctor: # deterministic preflight capability check (#146) — run \`pipeline doctor\` standalone, or enable run-start gating here
  runOnStart: ${d.doctor.runOnStart} # if true, run the preflight checks before planning and abort the run on any failure
  failFast: ${d.doctor.failFast} # if true, stop at the first failing check instead of collecting all failures

# auto_loop: # bounded auto-loop mode (#149) — opt-in; disabled by default
#   enabled: false # set true to enable; when false (default) the advance loop is byte-for-byte unchanged
#   max_rounds: 3 # maximum automatic continuations per run before parking at needs-human
#   max_wallclock_minutes: 60 # wall-clock budget in minutes (independent of max_rounds)
#   # stages: [eval-gate, shipcheck-gate] # allowlisted stages eligible for automatic continuation
#   #   Known stages: backlog, ready, planning, plan-review, implementing,
#   #                 review-1, fix-1, review-2, fix-2, pre-merge, eval-gate,
#   #                 shipcheck-gate, ready-to-deploy, needs-human

# setup_command: "pnpm install" # shell command to run in the worktree after creation, before the test gate (#174)
#   Auto-detected from lockfile when absent (pnpm-lock.yaml → pnpm install, yarn.lock → yarn install, package-lock.json → npm ci)
#   Set to "" to skip the install step entirely (opt-out). Examples:
#     setup_command: ""                                       # opt-out
#     setup_command: "pnpm install --frozen-lockfile"         # override auto-detection
#     setup_command: "pnpm install && pnpm run build:types"   # multi-step setup

# format_gate: [] # run formatter/linter commands after the implementing and fix-round harnesses (#182)
#   Each entry runs in the worktree root. auto_fix: true commits any changes and re-runs to verify;
#   auto_fix: false blocks immediately on non-zero exit. Default: [] (no gate; existing behavior).
#   Examples (Rust repo):
#     - command: cargo fmt
#       auto_fix: true
#     - command: cargo clippy -D warnings
#       auto_fix: false
#   Examples (JS/TS repo):
#     - command: eslint --fix src/
#       auto_fix: true
# harness_sandbox: false # set true to run the claude implementer with --permission-mode default
#   instead of bypassPermissions (#21). The codex harness is already sandboxed
#   via --full-auto and is unaffected. Default false → current invocation unchanged.
`;
}
