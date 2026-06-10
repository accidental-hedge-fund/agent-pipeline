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
  "ready-to-deploy",
] as const;
export type Stage = (typeof STAGES)[number];

export const TERMINAL_STAGES = new Set<Stage>(["ready-to-deploy"]);
export const LABEL_PREFIX = "pipeline:";
export const BLOCKED_LABEL = "blocked";
export const HARNESS_LABEL_PREFIX = "harness:";

export type Harness = "claude" | "codex";

export type OpenspecMode = "auto" | "on" | "off";

export interface PipelineConfig {
  profile_name: string;
  invocation: string;
  review_mode: "claude-companion" | "codex-companion" | "prompt-harness";
  marker_footer: string;
  implementation_ready_message: string;
  conventions_default: string;
  domain: string;
  repo: string;            // owner/name
  repo_dir: string;        // absolute path
  base_branch: string;
  worktree_root: string;   // relative to repo_dir, default ".worktrees"
  max_concurrent_worktrees: number;
  auto_merge: boolean;
  auto_recovery_max_retries: number;
  // Timeouts (seconds)
  implementation_timeout: number;
  review_timeout: number;
  fix_timeout: number;
  ci_timeout: number;
  ci_poll_interval: number;
  // Harnesses + models
  harnesses: { implementer: Harness; reviewer: Harness };
  models: { planning: string; review: string; fix: string };
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
  // audited via `pipeline-override` comment sentinels. Default
  // (`block_threshold: "low"`, `min_confidence: 0`) blocks on every finding,
  // reproducing pre-#17 behavior.
  review_policy: {
    block_threshold: "critical" | "high" | "medium" | "low";
    min_confidence: number; // 0..1; findings below this advise rather than block
  };
  // Conventions / domain context
  conventions_md_path?: string; // path to a CLAUDE.md or similar to embed
  domain_name?: string;
  domain_description?: string;
}

export const DEFAULT_CONFIG: Omit<PipelineConfig, "domain" | "repo" | "repo_dir"> = {
  base_branch: "main",
  worktree_root: ".worktrees",
  max_concurrent_worktrees: 5,
  auto_merge: false,
  auto_recovery_max_retries: 2,
  implementation_timeout: 2400,
  review_timeout: 1500,
  fix_timeout: 2400,
  ci_timeout: 900,
  ci_poll_interval: 30,
  harnesses: { implementer: "codex", reviewer: "claude" },
  models: { planning: "sonnet", review: "opus", fix: "sonnet" },
  openspec: { enabled: "auto", bootstrap: false },
  last30days: { enabled: false, timeout: 600 },
  steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
  test_gate: { enabled: true, max_attempts: 3, timeout: 300 },
  eval_gate: { enabled: false, mode: "gate" as const, timeout: 300, max_attempts: 2 },
  review_policy: { block_threshold: "low" as const, min_confidence: 0 },
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
  | { advanced: false; status: "blocked"; reason: string }
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

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence: number;
  recommendation: string;
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
