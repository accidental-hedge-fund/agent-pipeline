// Shared types + state-machine constants for the pipeline skill.

export const STAGES = [
  "backlog",
  "ready",
  "planning",
  "plan-review",
  "implementing",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "pre-merge",
  "eval-gate",
  "shipcheck-gate",
  "ready-to-deploy",
  // Terminal off-ramp: a review round hit `max_adversarial_rounds` with findings
  // still blocking. The item stops here with an advisory punch-list for a human
  // to override or fix — it is never auto-advanced to ready-to-deploy.
  "needs-human",
] as const;
export type Stage = (typeof STAGES)[number];

export const TERMINAL_STAGES = new Set<Stage>(["ready-to-deploy", "needs-human"]);
export const LABEL_PREFIX = "pipeline:";
export const BLOCKED_LABEL = "blocked";
export const HARNESS_LABEL_PREFIX = "harness:";

export type Harness = "claude" | "codex";

// ---------------------------------------------------------------------------
// External stage executors (#314) — named executor definitions that operators
// can assign per model-invoking stage, in place of the local claude/codex
// harness. Single-sourced here (not re-derived per file) so the config
// stage-eligibility gate and the runtime dispatcher can never drift.
// ---------------------------------------------------------------------------

/** The subset of STAGES that invoke a model at all (deterministic/gate-only
 *  stages — ready, pre-merge, eval-gate, deploy_ready, etc. — are excluded). */
export const MODEL_INVOKING_STAGES = [
  "planning",
  "plan-review",
  "implementing",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "shipcheck-gate",
] as const;
export type ModelInvokingStage = (typeof MODEL_INVOKING_STAGES)[number];

/** Prompt-contained stages: the prompt already carries (or can carry) all
 *  context needed to reach a verdict without exploring the repo — the only
 *  stages a `model-endpoint` executor may be assigned to. */
export const PROMPT_CONTAINED_STAGES = ["plan-review", "review-1", "review-2"] as const;

/** Execution-environment stages: need repo/tool access (read files, run
 *  tests/build, commit). A `model-endpoint` executor assigned here is rejected
 *  at config-parse time; only `agent-system` executors (or the local harness)
 *  are valid. */
export const EXECUTION_ENVIRONMENT_STAGES = [
  "planning",
  "implementing",
  "fix-1",
  "fix-2",
  "shipcheck-gate",
] as const;

export type ExecutorType = "agent-system" | "model-endpoint";

/** A full execution backend (OpenCode / HermesAgent / OpenClaw) addressed by a
 *  provider identifier and API endpoint. Valid for any model-invoking stage. */
export interface AgentSystemExecutorDefinition {
  type: "agent-system";
  provider: string;
  endpoint: string;
  /** Env-var name (or secret reference) resolved from the environment at
   *  invocation time — never a literal secret value. */
  credential?: string;
}

/** A raw OpenAI-compatible chat/completions endpoint (e.g. local Ollama).
 *  Valid only for PROMPT_CONTAINED_STAGES. */
export interface ModelEndpointExecutorDefinition {
  type: "model-endpoint";
  base_url: string;
  model: string;
  credential?: string;
}

export type ExecutorDefinition = AgentSystemExecutorDefinition | ModelEndpointExecutorDefinition;

// ---------------------------------------------------------------------------
// Blocker kinds (#134) — closed set of structurally-distinct failure classes.
//
// `setBlocked` posts the same "## Pipeline: Blocked" comment for every blocker,
// but the recovery VERB differs per class: a test-gate failure wants "fix the
// test, commit, re-run"; a merge conflict wants "rebase, push, re-run"; a
// needs-human off-ramp wants "fix or --override". The uniform `--unblock` hint
// (a label-clear + comment, no recovery) is the right verb for none of these.
// The call site always knows its class, so the recipe is a static lookup over a
// closed enum — not an inference about repo state.
// ---------------------------------------------------------------------------
// Single runtime source of truth (mirrors STAGES/Stage above) so the
// exhaustiveness test can iterate the kinds — `BlockerKind` is stripped at
// runtime, but `BLOCKER_KINDS` survives.
export const BLOCKER_KINDS = [
  "needs-human",
  "test-gate-exhausted",
  "no-commits",
  "harness-failure",
  "openspec-invalid",
  "openspec-stale-delta",
  "merge-conflict",
  "worktree-missing",
  "worktree-creation-failed",
  "pr-creation-failed",
  "no-pull-request",
  "plan-gen-failed",
  "push-failed",
  "eval-gate-misconfigured",
  "eval-gate-failed",
  "shipcheck-failed",
  "head-drift",
  "worktree-setup-failed",
  "build-failed",
] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** Default kind when a `setBlocked` call omits one (backward-compatible). */
export const DEFAULT_BLOCKER_KIND: BlockerKind = "needs-human";

/**
 * Per-kind "### How to unblock" recipe text. `{{N}}` is substituted with the
 * issue number at render time (see `renderRecipe` in gh.ts). Each recipe states
 * the verb that actually resolves its class — never the generic `--unblock`,
 * which only clears the label. Pinned by `blocked-recipes.test.ts`: changing or
 * dropping a recipe fails CI.
 */
export const BLOCKER_RECIPES: Record<BlockerKind, string> = {
  "needs-human":
    "A human decision is required. Fix the findings described above, remove the " +
    "`blocked` label, and re-run `$pipeline {{N}}`. Or record an " +
    "audited disposition with " +
    '`$pipeline {{N}} --override "<finding-key>: <reason>"` to advance past an ' +
    "accepted or out-of-scope finding (the key comes from the review comment; " +
    "`--override` clears the label and resumes automatically).",
  "test-gate-exhausted":
    "The test/build gate failed after the pipeline's fix attempts were " +
    "exhausted. Fix the failing test(s) or build error in the worktree, commit " +
    "the fix, remove the `blocked` label, then re-run `$pipeline {{N}}`.",
  "no-commits":
    "The harness reported success but committed nothing and the worktree is " +
    "clean. Finish the work and commit it in the worktree (or re-run the step " +
    "manually), remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`. If real changes are sitting uncommitted in the worktree, " +
    "committing them lets the pipeline salvage and continue (#131).",
  "harness-failure":
    "The harness process crashed or timed out (see the error above). " +
    "Investigate and fix the root cause, remove the `blocked` label, " +
    "then re-run `$pipeline {{N}}`. A transient timeout can usually just be " +
    "unblocked and re-run as-is.",
  "openspec-invalid":
    "The OpenSpec change is structurally invalid. Run `openspec validate " +
    "<change>` in the worktree, fix the reported errors, commit, remove the " +
    "`blocked` label, then re-run `$pipeline {{N}}`.",
  "openspec-stale-delta":
    "The OpenSpec spec delta is stale relative to the committed code. Update " +
    "`openspec/changes/<id>/specs/**` and `tasks.md` to match the " +
    "implementation, run `openspec validate <id>` to confirm the change is " +
    "valid, commit, remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
  "merge-conflict":
    "The branch could not be merged or auto-rebased onto the target branch. " +
    "Rebase the branch on the latest target, resolve the conflicts, push, " +
    "remove the `blocked` label, then re-run `$pipeline {{N}}`.",
  "worktree-missing":
    "The worktree for this issue no longer exists. The fix stage cannot run " +
    "without it — re-running will block again immediately. Recreate it manually " +
    "from the issue's branch (`git worktree add`), remove the `blocked` label, " +
    "then re-run `$pipeline {{N}}`.",
  "worktree-creation-failed":
    "Creating the worktree failed (see the error above). If a `.git/config.lock` " +
    "file is present, remove it: `rm -f .git/config.lock`. Delete the dangling " +
    "branch: `git branch -D pipeline/{{N}}-<slug>`. Remove the `blocked` label, " +
    "then re-run `$pipeline {{N}}`.",
  "pr-creation-failed":
    "Opening the pull request failed (see the error above). Check GitHub " +
    "permissions and rate limits, remove the `blocked` label, then " +
    "re-run `$pipeline {{N}}`.",
  "no-pull-request":
    "No pull request was found for this issue. The implementation stage may " +
    "not have run yet, or the PR was closed. Open or reopen a pull request " +
    "from the issue's branch, remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
  "plan-gen-failed":
    "Plan generation failed (see the error above). Fix the root cause (often a " +
    "transient harness error), remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
  "push-failed":
    "Pushing the branch failed for a non-conflict reason (see stderr above). " +
    "Resolve the push error (auth, remote, or branch protection), remove the " +
    "`blocked` label, then re-run `$pipeline {{N}}`.",
  "eval-gate-misconfigured":
    "`eval_gate.enabled` is true but no command is configured. Set " +
    "`eval_gate.command` in `.github/pipeline.yml`, remove the " +
    "`blocked` label, then re-run `$pipeline {{N}}`.",
  "eval-gate-failed":
    "The eval gate failed (see output above). Fix the failing evals in the " +
    "worktree, commit, remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
  "shipcheck-failed":
    "The shipcheck gate returned a failing or partial verdict (see the shipcheck " +
    "comment above for the specific concerns). Address the flagged concerns in " +
    "the worktree and commit the fix, remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
  "head-drift":
    "The worktree HEAD differs from the PR head (an unpushed local fix). Push the " +
    "local commits so the PR head includes the fix (`git push`), remove the " +
    "`blocked` label, then re-run `$pipeline {{N}}`.",
  "worktree-setup-failed":
    "The worktree dependency install step failed (see the error above). " +
    "Fix the root cause (package manager not installed, bad lockfile, network " +
    "issue), or set `setup_command: \"\"` in `.github/pipeline.yml` to skip " +
    "the install step. Then remove the `blocked` label and re-run " +
    "`$pipeline {{N}}`.",
  "build-failed":
    "The declared `build_command` failed while rebuilding generated artifacts " +
    "for this round's commit (see the output above). Fix the build in the " +
    "worktree, commit the fix, remove the `blocked` label, then re-run " +
    "`$pipeline {{N}}`.",
};

export type OpenspecMode = "auto" | "on" | "off";

export interface PipelineConfig {
  profile_name: string;
  invocation: string;
  review_mode: "prompt-harness";
  marker_footer: string;
  implementation_ready_message: string;
  conventions_default: string;
  domain: string;
  repo: string;            // owner/name
  repo_dir: string;        // absolute path
  base_branch: string;
  worktree_root: string;   // relative to repo_dir, default ".worktrees"
  max_concurrent_worktrees: number;
  auto_recovery_max_retries: number;
  // Timeouts (seconds)
  implementation_timeout: number;
  review_timeout: number;
  plan_review_timeout: number;
  fix_timeout: number;
  intake_timeout: number;
  sweep_timeout: number;
  ci_timeout: number;
  ci_poll_interval: number;
  ci_no_run_grace_s: number;
  // Pre-merge CI verification source (#350). "github" (default) waits for GitHub
  // Actions check-runs via `gh pr checks`. "local" relies on the current run's
  // recorded test-gate outcome and skips the GitHub Actions wait entirely.
  // Only enable "local" when the local gate is identical to full CI and branch
  // protection is operator-managed.
  ci_mode: "github" | "local";
  // Harness roles + models. The implementer is always taken from the active
  // profile (repo config cannot set it). The reviewer defaults to the profile's
  // value but MAY be overridden per-repo by the `review_harness` config key
  // (#40) to an arbitrary reviewer CLI — hence `string`, not `Harness`.
  // `reviewerModel`/`reviewerEffort` (#366) come only from the structured
  // `review_harness: { command, model?, effort? }` form; the string shorthand
  // leaves both unset so review routing falls back to `models.review`/`effort.review`.
  // `reviewerModel` is fully resolved here (Adversarial-stage `auto` is model-
  // invariant across rounds); `reviewerEffort` is left as-authored (possibly
  // `"auto"`) because its resolution is round-aware and happens at each
  // reviewer call site (plan-review vs. review-1 vs. review-2).
  // `reviewerModelWasAuto` records whether `reviewerModel` originated from the
  // `"auto"` sentinel (vs. an explicit alias) — reviewer call sites need this
  // to omit only an `auto`-resolved claude-only alias for a codex reviewer,
  // never an explicitly-configured one (#441).
  harnesses: { implementer: Harness; reviewer: string; reviewerModel?: string; reviewerModelWasAuto?: boolean; reviewerEffort?: string };
  // `reviewWasAuto` mirrors `reviewerModelWasAuto` for the `models.review`
  // fallback slot (#441): true when the file config explicitly set
  // `models.review: auto`, so reviewer call sites can distinguish an
  // auto-resolved claude-only alias from an explicit one when `reviewerModel`
  // is unset and `models.review` is the effective source.
  models: { planning: string; implementing: string; review: string; reviewWasAuto?: boolean; fix: string; intake: string; sweep: string };
  // Per-stage reasoning-effort overrides (#366), parallel to `models`. Each key
  // is independently optional; an absent key means no `--effort`/`-c
  // model_reasoning_effort` flag is emitted for that stage (the harness
  // operator's global effort setting applies). `review` is left as-authored
  // (possibly `"auto"`) for the same round-aware reason as `reviewerEffort`
  // above; the rest are fully resolved by `resolveConfig()`.
  effort: { planning?: string; implementing?: string; review?: string; fix?: string; intake?: string; sweep?: string };
  // Plan-review's own resolved effort (#366), derived from the `effort.planning`
  // config key but classified as Adversarial/Definitive (not Analytical/Iterative
  // like the `planning` stage itself) — see stage-routing.ts. Always concrete;
  // defaults to "medium" when `effort.planning` is unset, preserving the prior
  // hardcoded plan-review cap.
  plan_review_effort: string;
  // OpenSpec (spec-driven development) integration. "auto" activates only when
  // the target repo has an `openspec/` directory; "on"/"off" force it. When
  // `bootstrap` is true, planning runs `openspec init` on repos that lack it.
  openspec: { enabled: OpenspecMode; bootstrap: boolean };
  // last30days pre-planning brief (opt-in; default off). Adds external public
  // discourse for the issue topic as carry-forward context for planning.
  last30days: { enabled: boolean; timeout: number };
  // Configurable pipeline steps (#13). Per-repo on/off for the optional
  // "thoroughness" steps. Structural/safety steps (planning, implementing, and
  // the pre-merge CI + mergeability gates) have no toggle and are always on —
  // attempting to disable them is rejected at config-parse time (strict schema).
  steps: {
    plan_review: boolean;
    standard_review: boolean;
    adversarial_review: boolean;
    docs: boolean;
  };
  // Test/build gate (#15). When enabled, the target repo's own test/build
  // command runs in the worktree during implementation and after each fix
  // round; on failure a bounded generate→test→fix loop runs before a PR is
  // opened or the item advances. `command` is an explicit override; when absent
  // the command is auto-detected, and repos with none are skipped entirely.
  test_gate: {
    enabled: boolean;
    command?: string;
    max_attempts: number; // max fix-harness invocations before blocking
    timeout: number; // seconds per test/build run
  };
  // Eval gate (#12). When enabled, runs the repo's eval harness after pre-merge
  // and before ready-to-deploy. gate mode (default) blocks on fail; advisory
  // mode records the result and always advances.
  eval_gate: {
    enabled: boolean;
    command?: string;
    mode: "gate" | "advisory";
    timeout: number;   // seconds
    max_attempts: number; // total attempts (1 = no retry)
  };
  // Review severity policy (#17). Declares which finding severities block
  // progression vs. merely advise. Findings below `block_threshold` (or below
  // `min_confidence`) are recorded as advisory and do NOT route to a fix round;
  // when a review produces only advisory/overridden findings the item advances
  // as if approved. Operator overrides of individual blocking findings are
  // audited via `pipeline-override` comment sentinels. The default
  // (`block_threshold: "medium"`, `min_confidence: 0.7`) blocks medium-and-above
  // so real issues are fixed or explicitly overridden — not silently advised past
  // at the merge button (review comments land on the issue, but a human merges the
  // PR). Set `block_threshold: "high"` to also advise medium findings (more
  // throughput, less rigor) or `"low"` to block on every finding.
  // `max_adversarial_rounds` caps
  // how many times a review round may re-run before still-blocking findings are
  // recorded as advisory and the item is routed to the `needs-human` terminal
  // instead of looping to the iteration cap.
  // `risk_proportional` (#232): when true, review-2 scales its effective
  // block_threshold by the review-1 risk tier — low-risk changes (approved
  // with 0 findings) only block on high/critical findings in review-2.
  review_policy: {
    block_threshold: "critical" | "high" | "medium" | "low";
    min_confidence: number; // 0..1; findings below this advise rather than block
    max_adversarial_rounds: number; // cap review-round re-runs before needs-human
    risk_proportional: boolean; // scale review-2 threshold by review-1 risk tier (#232)
    // Action taken at the max_adversarial_rounds ceiling (#233). "park" (default):
    // hard-park at needs-human unchanged. "demote_and_advance": auto-demote
    // below-high findings to advisory, file a follow-up issue, and advance to
    // pre-merge — high/critical findings continue to hard-park regardless.
    ceiling_action: "park" | "demote_and_advance";
    // Consecutive-round threshold N for the (file + category) surface-recurrence
    // guard (#234). When N consecutive rounds each raise a new-key blocking finding
    // on the same (file + category) surface, the guard fires. 0 disables the guard.
    surface_recurrence_rounds: number;
  };
  // Doctor / preflight (#146). Opt-in, deterministic capability check that runs
  // before any autonomous work. `runOnStart` (default false) makes the checks run
  // at the start of an advance run and block it on failure; `failFast` (default
  // false) stops at the first failing check instead of collecting all failures.
  // Both default off so existing runs are completely unchanged unless explicitly
  // enabled (or `pipeline doctor` / `--doctor` is invoked).
  doctor: {
    runOnStart: boolean;
    failFast: boolean;
  };
  // Agent-logged minor-friction capture (#419). Opt-in; default disabled so
  // existing runs are unchanged. When enabled, the engine passes run/stage
  // identity env vars to harness child processes and injects a prompt
  // instruction pointing the agent at `pipeline papercut`.
  papercuts: {
    enabled: boolean;
    // Opt-in auto-file path (#421): default false. When true, the engine
    // clusters recurring papercut events and files pipeline:backlog issues
    // at run_complete and queue-batch end without a human running
    // `pipeline improve --apply`.
    auto_file: boolean;
    auto_file_window_hours: number;
    auto_file_max_per_window: number;
    auto_file_min_occurrences: number;
  };
  // Worktree bootstrap: dependency install step (#174).
  // When set to a non-empty string, that shell command is run in the worktree
  // instead of auto-detection. When set to "" the install step is skipped
  // entirely. When absent (undefined), auto-detection runs from lockfile.
  setup_command?: string;
  // Repo build command run after fix/auto-fix edits (#387). When declared, the
  // fix stage and the auto-fix (test-gate fix-loop) fold any generated-artifact
  // changes it produces into the round's HEAD commit before the gates certify,
  // so committed build artifacts (dist/, a plugin manifest, …) stay fresh. When
  // absent (undefined), no build command runs and fix/auto-fix behavior is
  // unchanged — there is no default/guessed command and no fallback.
  build_command?: string;
  // Opt-in sandboxed harness execution (#21). When true, the claude implementer
  // is invoked with --permission-mode default (claude's native sandboxed mode)
  // instead of --permission-mode bypassPermissions. The codex harness is
  // already workspace-sandboxed via --full-auto and is unaffected. Default false
  // preserves the current byte-identical invocation.
  harness_sandbox: boolean;
  // Conventions / domain context
  conventions_md_path?: string; // path to a CLAUDE.md or similar to embed
  domain_name?: string;
  domain_description?: string;
  // Shipcheck gate (#148). When enabled, runs a reviewer-harness acceptance
  // rubric after eval-gate and before ready-to-deploy. advisory mode (default)
  // records findings without blocking; gate mode blocks on a fail verdict.
  shipcheck_gate: {
    enabled: boolean;
    mode: "advisory" | "gate";
    max_rounds: number;
    rubric_path: string;
    block_on_partial: boolean;
  };
  // Format/lint normalization gate (#182). When non-empty, each entry's
  // command runs inside the worktree after the implementing and fix-round
  // harnesses exit. auto_fix: true → commit any produced changes and re-run;
  // auto_fix: false → block immediately on non-zero exit. Default: [].
  format_gate: { command: string; auto_fix: boolean }[];
  // Backlog roadmap engine (#171). Optional per-repo overrides for filtering,
  // scoring weights, and write-back behaviour. All keys are optional; defaults
  // apply when the block is absent.
  roadmap?: {
    include_labels?: string[];
    exclude_labels?: string[];
    score_weights?: {
      impact?: number;
      confidence?: number;
      ease?: number;
      risk_reduction?: number;
      dep_leverage?: number;
    };
    hygiene_auto_apply?: boolean;
    pr_docs?: boolean;
  };
  // Sweep backlog maintenance pass (#168). Optional per-repo sufficiency thresholds.
  sweep?: {
    min_body_length?: number;
    required_sections?: string[];
  };
  // Queue batch factory operation mode (#305). Optional operator defaults that
  // CLI flags override. All keys are optional; built-in defaults apply when absent.
  queue?: {
    max_issues?: number;
    budget_dollars?: number | null;
    concurrency?: number;
    max_failure_rate?: number;
  };
  // Additional GitHub identities whose `## Pipeline: Finding override` and
  // `## Pipeline: Scope override` comments are trusted in addition to the current
  // pipeline actor (#229). Useful for multi-actor setups (e.g., a CI bot and a
  // human operator share the same pipeline installation). Default: [] (actor-only).
  trusted_override_actors?: string[];
  // Bounded auto-loop mode (#149). When enabled, recoverable stops at allowlisted
  // pipeline-owned stages convert from stop to automatic continuation within
  // explicit round and wall-clock budgets, recording rationale per continuation,
  // then park at `needs-human` with evidence on exhaustion — without granting any
  // new shipping authority. Default: disabled.
  auto_loop: {
    enabled: boolean;
    max_rounds: number;
    max_wallclock_minutes: number;
    stages: Stage[];
  };
  // Auto-merge eligibility gate (#306). When enabled, classifies a PR as
  // `auto-merge-eligible` or `needs-human` after all existing gates pass.
  // The gate runs inside shipcheck-gate and does NOT block ready-to-deploy.
  // Default: disabled (no classification, no artifact).
  auto_merge_eligibility: {
    enabled: boolean;
    max_diff_lines: number;
    max_files: number;
    deny_paths: string[];
    allow_paths: string[];
    min_confidence: number;
  };
  // Stage-aware issue context snapshots (#318). When set, `max_chars` caps the
  // total character count of human comments included in the context snapshot
  // (oldest entries dropped first). When absent, the default (8000) applies.
  context_snapshot?: {
    max_chars: number;
  };
  // Cross-repo dependency map (#312). Declares inter-repo relationships so the
  // planning stage can surface open-issue context from related repos, and the
  // roadmap engine can identify cross-repo sequencing hints. Declarative only —
  // no cross-repo write, merge, PR creation, label propagation, or CI gating.
  // Relationships are declared independently per repo; no reverse-edge inference.
  // Resolves to { depends_on: [], depended_on_by: [] } when absent from .github/pipeline.yml.
  repo_map: {
    depends_on: string[];      // owner/repo strings this repo consumes
    depended_on_by: string[];  // owner/repo strings that consume this repo
  };
  // External event sink (#343). Opt-in; absent means run events are written
  // only to the local .agent-pipeline/runs/<id>/events.jsonl, unchanged from
  // today. When set, `command` is an operator-controlled forwarder that
  // receives each event's JSON line on stdin. `mode` selects whether the local
  // events.jsonl write still happens alongside delivery ("additive", the
  // default) or is skipped entirely ("exclusive").
  event_sink?: {
    command: string;
    mode: "additive" | "exclusive";
  };
  // External stage executors (#314). Named executor definitions ("executors:")
  // that operators may assign per model-invoking stage ("stage_executors:").
  // Both default to {} — a repo with neither key configured behaves exactly as
  // today (every stage runs through the local claude/codex harness).
  executors: Record<string, ExecutorDefinition>;
  stage_executors: Partial<Record<ModelInvokingStage, string>>;
}

// Keys resolved from the active profile at config time, never from defaults
// or `.github/pipeline.yml`.
type ProfileSourcedKeys =
  | "profile_name"
  | "invocation"
  | "review_mode"
  | "marker_footer"
  | "implementation_ready_message"
  | "conventions_default"
  | "harnesses";

export const DEFAULT_CONFIG: Omit<
  PipelineConfig,
  "domain" | "repo" | "repo_dir" | ProfileSourcedKeys
> = {
  base_branch: "main",
  worktree_root: ".worktrees",
  max_concurrent_worktrees: 5,
  auto_recovery_max_retries: 2,
  implementation_timeout: 2400,
  review_timeout: 1500,
  plan_review_timeout: 300,
  fix_timeout: 2400,
  intake_timeout: 600,
  sweep_timeout: 600,
  ci_timeout: 900,
  ci_poll_interval: 30,
  ci_no_run_grace_s: 60,
  ci_mode: "github",
  // review defaults to claude-fable-5 (#366): it is the auto-routed choice for
  // every Adversarial stage, so aligning the default with that routing
  // strengthens review rigor. Only honored when the reviewer harness is claude
  // (under --profile codex, or an explicit review_harness: claude) — under the
  // default --profile claude the reviewer is codex and the alias is inert
  // (warned), so this default change is a no-op there.
  models: { planning: "sonnet", implementing: "sonnet", review: "claude-fable-5", fix: "sonnet", intake: "sonnet", sweep: "sonnet" },
  effort: {},
  plan_review_effort: "medium",
  openspec: { enabled: "auto", bootstrap: false },
  last30days: { enabled: false, timeout: 600 },
  steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
  test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
  eval_gate: { enabled: false, mode: "gate" as const, timeout: 300, max_attempts: 2 },
  shipcheck_gate: {
    enabled: false,
    mode: "advisory" as const,
    max_rounds: 1,
    rubric_path: ".github/shipcheck-rubric.md",
    block_on_partial: false,
  },
  review_policy: { block_threshold: "medium" as const, min_confidence: 0.7, max_adversarial_rounds: 3, risk_proportional: false, ceiling_action: "park" as const, surface_recurrence_rounds: 3 },
  doctor: { runOnStart: false, failFast: false },
  papercuts: {
    enabled: false,
    auto_file: false,
    auto_file_window_hours: 24,
    auto_file_max_per_window: 3,
    auto_file_min_occurrences: 3,
  },
  format_gate: [] as { command: string; auto_fix: boolean }[],
  harness_sandbox: false,
  auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] as Stage[] },
  auto_merge_eligibility: {
    enabled: false,
    max_diff_lines: 300,
    max_files: 10,
    deny_paths: [] as string[],
    allow_paths: [] as string[],
    min_confidence: 0.8,
  },
  repo_map: { depends_on: [] as string[], depended_on_by: [] as string[] },
  executors: {} as Record<string, ExecutorDefinition>,
  stage_executors: {} as Partial<Record<ModelInvokingStage, string>>,
};

// ---------------------------------------------------------------------------
// Step routing (#13): structural/safety steps are always on, so the spine
// planning → implementing → pre-merge → ready-to-deploy is always intact. Only
// review rounds are skipped here (centrally, by the orchestrator); plan-review
// and docs are skipped inside their own stages.
// ---------------------------------------------------------------------------

/** When a review stage is disabled, the next stage to advance to. */
export function reviewStageSkipTarget(cfg: Pick<PipelineConfig, "steps">, stage: Stage): Stage {
  if (stage === "review-1") return cfg.steps.adversarial_review ? "review-2" : "pre-merge";
  return "pre-merge";
}

// One transition outcome from a stage advance call.
export type Outcome =
  | { advanced: true; from: Stage; to: Stage; summary: string }
  | { advanced: false; status: "blocked"; reason: string; blockerKind?: BlockerKind }
  | { advanced: false; status: "waiting"; reason: string }
  | { advanced: false; status: "no-op"; reason: string }
  | { advanced: false; status: "finalized"; reason: string }
  | { advanced: false; status: "error"; reason: string };

// Issue/PR snapshot used by stage handlers.
export interface ItemDetail {
  number: number;
  type: "issue" | "pull_request";
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
  is_draft?: boolean;
}

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  url: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  mergeable: boolean | null;
  mergeable_state: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface CheckRun {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | "" | string;
  state: string;
  description?: string;
  link?: string;
}

/** Structured verdict returned by the shipcheck-gate reviewer harness (#148). */
export interface ShipcheckCriterion {
  criterion: string;
  result: "pass" | "fail" | "na";
  note: string;
}

export interface ShipcheckVerdict {
  verdict: "pass" | "partial" | "fail";
  summary: string;
  criteria: ShipcheckCriterion[];
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence: number;
  recommendation: string;
  // Optional machine-readable class (e.g. "spec-divergence", "correctness",
  // "security"). Lets a gate read a structured field instead of inferring intent
  // from free-text prose — prose inference oscillates false-pos/false-neg and
  // never converges (the #106 detector failure). Gates SHOULD key on this, never
  // on keyword-matching a finding's body.
  category?: string;
  // When category is "spec-divergence", clarifies which entity must change (#356):
  // "code-behind-spec" — the active spec delta already requires the behavior; the
  // implementation must change. "spec-behind-code" — the accepted implementation
  // moved past the active delta; the spec delta must change. Absent when category is
  // not "spec-divergence" or when the direction cannot be determined with confidence.
  spec_divergence_direction?: "code-behind-spec" | "spec-behind-code";
  // Non-blocking marker (#236). Absent or true = classify normally by
  // severity/confidence. false = advisory regardless of severity and confidence;
  // the finding is recorded but does NOT route to a fix round.
  blocking?: boolean;
}

export interface ReviewVerdict {
  verdict: "approve" | "needs-attention";
  summary: string;
  findings: ReviewFinding[];
  next_steps: string[];
  // Full 40-char HEAD SHA the verdict evaluated (#16). Populated by the review
  // stage from the PR head at review time, not parsed from reviewer output.
  // Binds the verdict to a commit so a later gate can detect a stale approval
  // (HEAD moved) and re-review instead of trusting it.
  commitSha: string;
}

// ---------------------------------------------------------------------------
// Evidence bundle (#147) — a compact, machine-readable per-run audit artifact.
//
// One JSON file per run at `<stateDir>/<issue>/evidence.json`, accumulated
// incrementally as stages execute and finalized when the run ends. It records
// WHAT happened (stage transitions, commands, review verdicts, overrides,
// recoveries) so a run can be debugged/handed off without stitching the story
// from comments, commits, and logs. It is a write-only SUPPLEMENT: no pipeline
// logic reads it to make label/blocking/routing decisions, and GitHub labels +
// comments remain the authoritative state. Sensitive values (raw env vars,
// tokens, secrets) are never recorded — a `CommandRecord` carries only a command
// string, exit code, duration, and a capped output excerpt.
// ---------------------------------------------------------------------------

/** Current evidence-bundle JSON schema version. Bump on a breaking change. */
export const EVIDENCE_SCHEMA_VERSION = 1;

/** A single shell command executed by a stage. Deliberately minimal: only these
 *  four fields are ever recorded, so no raw env value, token, or secret can leak
 *  (#147). `outputExcerpt` is the first 500 chars of combined stdout/stderr. */
export interface CommandRecord {
  cmd: string;
  exitCode: number;
  durationMs: number;
  outputExcerpt: string;
}

/** Terminal disposition of a stage handler for this run. */
export type StageOutcome = "advanced" | "blocked" | "skipped" | "error";

/** Compact metadata about a harness prompt sent during a stage. Tokens/secrets
 *  are excluded via the same redaction path as `CommandRecord`. */
export interface PromptRecord {
  /** Short label for what this prompt does: "review-standard", "review-adversarial", "fix-1", etc. */
  kind: string;
  /** Harness that received the prompt ("claude" or "codex"). */
  harness: string;
  /** 8-char hex prefix of SHA-1 of the redacted prompt content — stable fingerprint. */
  hash: string;
  /** First 500 characters of the redacted prompt — enough context to diagnose review divergence. */
  excerpt: string;
}

/** One stage's slice of the run: when it was entered/exited, how it ended, the
 *  commits it produced, the commands it ran, and the prompts it sent to harnesses. */
export interface StageRecord {
  stage: string;
  enteredAt: string | null;
  exitedAt: string | null;
  outcome: StageOutcome | null;
  commits: string[];
  commands: CommandRecord[];
  prompts: PromptRecord[];
}

/** A structured per-finding record persisted into the run directory (#209).
 *  Carries the stable `findingKey` as the cross-round correlation handle plus
 *  the full `ReviewFinding` field set (text fields sanitized at write time).
 *  Optional source fields mirror `ReviewFinding` — absent when the reviewer
 *  did not supply them. */
export interface ReviewFindingRecord {
  /** findingKey applied to the sanitized record fields at write time. When line_start
   *  is absent the key hashes the title; sanitizing before computing prevents a
   *  secret-bearing title from acting as a persisted oracle. */
  key: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence: number;
  recommendation: string;
  category?: string;
  blocking?: boolean;
  /** Effective blocking status from partitionFindings: true when the finding
   *  landed in partition.blocking, false when advisory or overridden. Absent
   *  on records written before #209 fix-2. */
  effective_blocking?: boolean;
  /** findingPayloadFingerprint applied to the sanitized record fields at write time —
   *  disambiguates distinct findings that share the same findingKey within a round.
   *  Absent on records written before #209. */
  payload_fingerprint?: string;
  /** True when sanitization collapsed two or more distinct same-key findings in this
   *  round to the same key+payload_fingerprint pair. Consumers MUST NOT claim
   *  per-finding resolution for these records; use aggregate counts only. Absent
   *  (treat as false) on records without redaction collisions. */
  payload_fingerprint_ambiguous?: boolean;
}

/** Summary of one review round's verdict. `findingCounts` maps severity → count.
 *  `findings`, `harness`, `model`, and `selfReview` are additive optional fields
 *  (#209) — present on new records, absent on records written before #209. */
export interface ReviewRecord {
  round: number;
  sha: string;
  verdict: string;
  findingCounts: Record<string, number>;
  findings?: ReviewFindingRecord[];
  harness?: string;
  model?: string;
  selfReview?: boolean;
  /** External stage executor evidence (#314). `harness` above carries the
   *  executor NAME when this round was delegated via `stage_executors:`;
   *  `executorProvider` is the agent-system provider id or model-endpoint base
   *  URL; `executorModel` is the model name (model-endpoint only). Both absent
   *  for a round that ran on the local reviewer harness. */
  executorProvider?: string;
  executorModel?: string;
}

export type StageAccountingCostSource = "actual" | "estimated" | "unknown";

export interface StageAccountingUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_input_tokens?: number | null;
  reasoning_tokens?: number | null;
  cost_usd?: number | null;
}

/** Stage-level cost/accounting observation. Observational only: routing code
 *  must not read these records to decide labels, stages, reviewers, or merges. */
export interface StageAccountingRecord {
  schema_version: number;
  run_id: string;
  issue: number;
  stage: string;
  harness: string;
  model_slot: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  command_count: number;
  subprocess_count: number;
  outcome: string;
  blocker_kind: string | null;
  cost_source: StageAccountingCostSource;
  cost_usd: number | null;
  prompt_chars?: number | null;
  prompt_estimated_tokens?: number | null;
  usage?: StageAccountingUsage;
  /** Git HEAD SHA of the worktree at the time the test gate ran. Recorded by
   *  the test-gate harness so `ci_mode: local` can verify that the current PR
   *  head matches the commit that was actually tested (#350 review-2). */
  pr_head_sha?: string | null;
  /** External stage executor evidence (#314). `harness` carries the executor
   *  NAME (from `stage_executors:`) when this stage was delegated;
   *  `executor_provider` is the agent-system provider id or the model-endpoint
   *  base URL; `executor_model` is the model name (model-endpoint only). All
   *  absent for a stage that ran on the local claude/codex harness, unchanged. */
  executor_provider?: string | null;
  executor_model?: string | null;
}

export interface StageAccountingTotals {
  record_count: number;
  actual_cost_usd: number;
  estimated_cost_usd: number;
  unknown_cost_count: number;
}

export interface StageAccountingSummary {
  records: StageAccountingRecord[];
  totals: StageAccountingTotals;
}

/** An operator `--override` disposition applied during the run. */
export interface OverrideRecord {
  key: string;
  reason: string;
  /** Taxonomy kind for this override; always `"human-risk-override"` for
   *  operator-supplied `--override` dispositions. Optional for backward
   *  compatibility: absent on records written before #302. */
  kind?: import("./intervention.ts").HumanInterventionKind;
}

/** One auto-recovery event. */
export interface RecoveryRecord {
  trigger: string;
  round: number;
  at: string;
}

// ---------------------------------------------------------------------------
// Auto-merge eligibility gate (#306) — types for the deterministic policy
// envelope + LLM risk judge that classifies PRs as eligible or needs-human.
// ---------------------------------------------------------------------------

/** One deterministic policy check result recorded in the eligibility artifact. */
export interface EligibilityCheckResult {
  check: string;
  passed: boolean;
  reason?: string;
}

/** Structured risk classification emitted by the LLM eligibility judge.
 *  Field names and order MUST match ELIGIBILITY_JUDGE_SCHEMA_BLOCK in
 *  auto-merge-eligibility-schema.ts; the drift guard test fails if they diverge. */
export interface EligibilityJudgeOutput {
  scope_size: "tiny" | "small" | "medium" | "large";
  blast_radius: "low" | "medium" | "high";
  semantic_risk: "mechanical" | "localized_behavior" | "cross_cutting_behavior";
  reversibility: "trivial" | "normal" | "painful";
  confidence: number;
  reasons: string[];
  denial_reasons: string[];
}

/** Durable decision artifact written to the evidence bundle after gate evaluation. */
export interface AutoMergeEligibilityArtifact {
  eligibility: "auto-merge-eligible" | "needs-human";
  evaluated_at: string;
  deterministic_checks: EligibilityCheckResult[];
  denial_reasons: string[];
  judge_output: EligibilityJudgeOutput | null;
  ci_status_snapshot: { sha: string; conclusion: string; checked_at: string };
  review_verdict_snapshot: { verdict: string; finding_count: number; recorded_at: string };
  linked_run_id: string;
  linked_issue: number;
  linked_pr: number;
  revert_note: string;
}

/** The complete per-run evidence bundle written to `<stateDir>/<issue>/evidence.json`. */
export interface EvidenceBundle {
  schema_version: number;
  /** @deprecated Use `schema_version`. Kept for the transitional period per #161. */
  schemaVersion: number;
  runId: string;
  issue: number;
  pr: number | null;
  branch: string | null;
  harnesses: string[];
  stages: StageRecord[];
  reviews: ReviewRecord[];
  overrides: OverrideRecord[];
  recoveries: RecoveryRecord[];
  finalState: string | null;
  finalizedAt: string | null;
  /** ISO timestamp set once the PR/issue path-notification comment is posted;
   *  null until then. Guards against a duplicate comment on a re-finalize. */
  notifiedAt: string | null;
  /** All `human_intervention` events emitted during the run, in chronological
   *  order. Populated by `finalizeRun` from `events.jsonl`. Additive and
   *  optional: consumers that do not recognize this field SHALL ignore it. */
  interventions?: import("./intervention.ts").HumanInterventionEvent[];
  /** Finalized stage accounting copied from `stage_accounting` events by
   *  `finalizeRun`. Additive and optional for older bundles. */
  accounting?: StageAccountingSummary;
  /** Auto-merge eligibility artifact written by the eligibility gate when
   *  `auto_merge_eligibility.enabled` is true. Absent when gate is disabled. */
  auto_merge_eligibility?: AutoMergeEligibilityArtifact;
  /** Optional rationale recorded when a behavioral change intentionally ships
   *  without accompanying tests (e.g. pure refactors, generated code). When
   *  present, the eligibility gate's behavioral-change-without-tests hard-deny
   *  is suppressed. */
  no_test_rationale?: string;
}

// ---------------------------------------------------------------------------
// Issue-level evidence history (#377) — an append-only, issue-scoped JSONL
// artifact recording one compact timing/outcome record per finalized run, so
// resuming a pipeline run after a fix round never erases prior rounds' history.
// Deliberately narrower than EvidenceBundle: no commands/prompts/reviews — a
// timing rollup, not a second full bundle.
// ---------------------------------------------------------------------------

/** Current issue-evidence-history JSONL schema version. Bump on a breaking change. */
export const ISSUE_HISTORY_SCHEMA_VERSION = 1;

/** One stage's timing/outcome slice recorded in an issue-history entry. */
export interface IssueHistoryStageEntry {
  stage: string;
  enteredAt: string | null;
  exitedAt: string | null;
  durationMs: number | null;
  outcome: StageOutcome | null;
}

/** One line of `.agent-pipeline/history/issue-<N>.jsonl` — a compact,
 *  append-only record of a single finalized run for an issue. `run_id` is the
 *  filesystem-safe run-directory basename (the same identifier `summary.json`
 *  uses), so an entry joins back to its run directory. */
export interface IssueHistoryEntry {
  schema_version: number;
  run_id: string;
  issue: number;
  pr: number | null;
  branch: string | null;
  final_state: string | null;
  finalized_at: string | null;
  stages: IssueHistoryStageEntry[];
}

/** Partial stage update accepted by `recordStage` — `stage` identifies the entry
 *  to upsert; the other fields are merged in when present. */
export interface StageUpdate {
  stage: string;
  enteredAt?: string;
  exitedAt?: string;
  outcome?: StageOutcome;
  commits?: string[];
}
