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
  "worktree-setup-failed",
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
  "worktree-setup-failed":
    "The worktree dependency install step failed (see the error above). " +
    "Fix the root cause (package manager not installed, bad lockfile, network " +
    "issue), or set `setup_command: \"\"` in `.github/pipeline.yml` to skip " +
    "the install step. Then remove the `blocked` label and re-run " +
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
  fix_timeout: number;
  ci_timeout: number;
  ci_poll_interval: number;
  // Harness roles + models. The implementer is always taken from the active
  // profile (repo config cannot set it). The reviewer defaults to the profile's
  // value but MAY be overridden per-repo by the `review_harness` config key
  // (#40) to an arbitrary reviewer CLI — hence `string`, not `Harness`.
  harnesses: { implementer: Harness; reviewer: string };
  models: { planning: string; implementing: string; review: string; fix: string };
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
  // Worktree bootstrap: dependency install step (#174).
  // When set to a non-empty string, that shell command is run in the worktree
  // instead of auto-detection. When set to "" the install step is skipped
  // entirely. When absent (undefined), auto-detection runs from lockfile.
  setup_command?: string;
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
  fix_timeout: 2400,
  ci_timeout: 900,
  ci_poll_interval: 30,
  models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
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
  format_gate: [] as { command: string; auto_fix: boolean }[],
  harness_sandbox: false,
  auto_loop: { enabled: false, max_rounds: 3, max_wallclock_minutes: 60, stages: [] as Stage[] },
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
}

/** An operator `--override` disposition applied during the run. */
export interface OverrideRecord {
  key: string;
  reason: string;
}

/** One auto-recovery event. */
export interface RecoveryRecord {
  trigger: string;
  round: number;
  at: string;
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
