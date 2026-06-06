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
  review_mode: "claude-companion" | "prompt-harness";
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
};

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
}
