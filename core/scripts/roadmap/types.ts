// Shared types for the backlog-roadmap-engine (#171).

export type IssueNumber = number;

export interface Issue {
  number: IssueNumber;
  title: string;
  body: string;
  labels: string[];
  url: string;
  state: "open" | "closed";
  updatedAt?: string;
  /** Current GitHub milestone when known (inventory / recon fingerprint). */
  milestone?: { number: number; title: string } | null;
}

export interface Milestone {
  id: number;
  number: number;
  title: string;
}

/** Live milestone catalog entry for SemVer full reconciliation (#910). */
export interface MilestoneCatalogEntry {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  description: string;
  open_issues: number;
  closed_issues: number;
}

/** Open-issue snapshot used for live-state fingerprinting and stale detection (#910). */
export interface IssueMilestoneSnapshot {
  number: IssueNumber;
  state: "open" | "closed";
  milestone_number: number | null;
  milestone_title: string | null;
  updatedAt?: string;
  labels: string[];
}

/** Reconciliation mutation kinds under full SemVer milestone reconciliation. */
export type ReconciliationActionKind =
  | "create"
  | "reuse"
  | "reopen"
  | "rename"
  | "update_description"
  | "assign"
  | "clear_stale";

export interface ReconciliationAction {
  /** Stable id within one manifest (used for progress / resume). */
  id: string;
  kind: ReconciliationActionKind;
  /** GitHub milestone number when known. */
  milestone_number?: number;
  /** Current or target milestone title. */
  milestone_title?: string;
  /** Target title for rename. */
  new_title?: string;
  /** Target description for create / update_description. */
  description?: string;
  /** Affected issue for assign / clear_stale. */
  issue_number?: IssueNumber;
  /** Operator-facing detail for dry-run listing. */
  detail?: string;
}

export interface ReconciliationTargetMilestone {
  /** Stable GitHub milestone number when bound to an existing identity. */
  number?: number;
  title: string;
  description: string;
  version_impact?: CompatibilityImpact;
  issue_numbers: IssueNumber[];
}

export type CoverageBlockerReason =
  | "unresolved_missing"
  | "unresolved_conflict"
  | "unmilestoned"
  | "dual_membership"
  | "title_collision"
  | "shipped_immutable";

export interface CoverageBlocker {
  issue_number?: IssueNumber;
  reason: CoverageBlockerReason;
  detail: string;
}

/**
 * Reviewed reconciliation manifest: sole apply target for SemVer full recon (#910).
 * Apply executes only this action list against a matching live-state fingerprint.
 */
export interface ReconciliationManifest {
  /**
   * Content hash of the full reviewed package: targets, ordered actions,
   * coverage blockers, and live-state fingerprint (not a targets-only hash).
   */
  identity: string;
  /** Live-state fingerprint captured at preview / plan build time. */
  live_state_fingerprint: string;
  targets: ReconciliationTargetMilestone[];
  actions: ReconciliationAction[];
  coverage_blockers: CoverageBlocker[];
  generated_at: string;
}

/** Durable apply progress for safe partial-failure resume (#910). */
export interface ReconciliationProgress {
  manifest_identity: string;
  apply_start_fingerprint: string;
  /**
   * Live-state fingerprint after the last successful action (or apply-start when
   * none completed). Resume requires the fresh fingerprint to match this value
   * so external drift after any completed mutation aborts safely.
   */
  last_fingerprint?: string;
  /** Full ordered action list from the reviewed manifest (resume uses this, not a re-plan). */
  actions: ReconciliationAction[];
  completed: Array<{ id: string; result?: { milestone_number?: number } }>;
  next_pending_id: string | null;
  status: "in_progress" | "failed" | "complete";
  updated_at: string;
}

export interface InventoryItem {
  issue: Issue;
  touched_files: string[];
}

export interface DepEdge {
  from: IssueNumber;
  to: IssueNumber;
  file_line: string;
  rationale: string;
}

export interface CycleReport {
  issues: IssueNumber[];
  description: string;
}

export interface OpenQuestion {
  description: string;
  related_issues: IssueNumber[];
  rationale?: string;
}

/** One cross-repo dependency annotation emitted when repo_map is configured. */
export interface CrossRepoDep {
  /** Local issue that relates to a declared repo. */
  local_issue: IssueNumber;
  /** The declared owner/repo that the local issue depends on or is depended on by. */
  repo: string;
  /** Relationship direction from the local repo's perspective. */
  direction: "depends_on" | "depended_on_by";
  /** Human-readable rationale for why this cross-repo relationship was identified. */
  rationale: string;
}

export interface DepGraph {
  must_precede: DepEdge[];
  should_precede: DepEdge[];
  parallel_safe: [IssueNumber, IssueNumber][];
  blocked_pending_decision: IssueNumber[];
  duplicate_merge: [IssueNumber, IssueNumber][];
  conflict_pairs: [IssueNumber, IssueNumber][];
  cycle_reports: CycleReport[];
  open_questions: OpenQuestion[];
  /** Cross-repo dependency annotations (populated when repo_map is configured). */
  cross_repo: CrossRepoDep[];
}

export type Tier = "enablers" | "dependency-unlock" | "high-value/low-risk" | "larger-bets" | "cleanup";
export type EffortSize = "XS" | "S" | "M" | "L" | "XL";

export interface ScoreWeights {
  impact?: number;
  confidence?: number;
  ease?: number;
  risk_reduction?: number;
  dep_leverage?: number;
}

export interface ScoreBreakdown {
  impact: number;
  confidence: number;
  ease: number;
  effort: number;
  risk_reduction: number;
  dep_leverage: number;
}

export interface ScoredItem {
  issue_number: IssueNumber;
  priority: number;
  score_breakdown: ScoreBreakdown;
  tier: Tier;
  effort: EffortSize;
  risks: string[];
  dep_rationale: string;
  touched_files: string[];
}

export interface RoadmapEntry {
  rank: number;
  issue_number: IssueNumber;
  title: string;
  tier: Tier;
  priority: number;
  score_breakdown: ScoreBreakdown;
  dep_rationale: string;
  touched_files: string[];
  effort: EffortSize;
  risks: string[];
  unblocks: IssueNumber[];
  blocked_by: IssueNumber[];
}

export type HygieneAction =
  | "close"
  | "merge-duplicate"
  | "rewrite-title"
  | "split"
  | "spike"
  | "postpone";

export interface HygieneItem {
  issue_number: IssueNumber;
  action: HygieneAction;
  comment_text: string;
  evidence: string;
  applied?: boolean;
}

export type CompatibilityImpact = "major" | "minor" | "patch";

/** Applied SemVer classification status for one issue. */
export type CompatibilityStatus =
  | "resolved"
  | "unresolved_missing"
  | "unresolved_conflict";

/** Non-binding type-label hint; never sets applied impact or milestone versioning. */
export interface CompatibilityRecommendation {
  impact: CompatibilityImpact;
  /** Label (or short source key) that produced the recommendation. */
  source: string;
}

/**
 * Per-issue compatibility classification under `release_model: semver`.
 * Applied impact comes only from exclusive `semver:major|minor|patch` labels.
 */
export interface CompatibilityClassification {
  issue_number: IssueNumber;
  status: CompatibilityStatus;
  /** Resolved applied impact, or null when status is unresolved. */
  applied_impact: CompatibilityImpact | null;
  /** Winning `semver:*` label when resolved; null when unresolved. */
  source_label: string | null;
  /** True when applied impact is not resolved (missing or conflicting labels). */
  uncertain: boolean;
  /** Optional non-binding recommendation from generic type labels when missing. */
  recommendation?: CompatibilityRecommendation;
  /** Distinct conflicting `semver:*` labels when status is unresolved_conflict. */
  conflict_labels?: string[];
}

export interface MilestoneSpec {
  title: string;
  issue_numbers: IssueNumber[];
  rationale: string;
  /** Compatibility impact driving the semver increment for this milestone. */
  version_impact?: CompatibilityImpact;
  /**
   * Optional operator note (e.g. summary of excluded unresolved issues).
   * Must not invent applied impact for issues placed in the milestone.
   */
  uncertainty?: string;
}

export interface NewIssueDraft {
  title: string;
  body: string;
  labels: string[];
  rationale: string;
}

export interface CritiqueEntry {
  severity: string;
  title: string;
  body: string;
  file?: string;
  line_start?: number;
  line_end?: number;
  confidence?: number;
  recommendation: string;
  category?: string;
  is_advisory: boolean;
}

export interface RunStats {
  open_issue_count: number;
  filtered_issue_count: number;
  inventory_harness_calls: number;
  inventory_harness_skipped: number;
  depgraph_candidates_textual: number;
  depgraph_candidates_shared_file: number;
  depgraph_candidates_cross_file: number;
  depgraph_verify_calls: number;
  depgraph_verify_skipped: number;
  critique_rounds: number;
  phase_elapsed_ms: Record<string, number>;
}

export interface PlanJson {
  generated_at: string;
  backlog_sha: string;
  repo: string;
  dependency_graph: DepGraph;
  scored: ScoredItem[];
  roadmap: RoadmapEntry[];
  hygiene: HygieneItem[];
  milestones: MilestoneSpec[];
  new_issue_drafts: NewIssueDraft[];
  critique: CritiqueEntry[];
  open_questions: OpenQuestion[];
  /**
   * Per-issue SemVer compatibility classifications (present under release_model
   * semver / default). Continuous runs omit this field.
   */
  compatibility_classifications?: CompatibilityClassification[];
  /**
   * Full SemVer milestone reconciliation manifest (semver / default only).
   * Dry-run and apply share this reviewed target; continuous runs omit it.
   */
  reconciliation?: ReconciliationManifest;
  /** Present only when release_model === 'continuous'. CalVer format: YYYY.0M.MICRO */
  continuous_version_marker?: string;
  run_stats?: RunStats;
}

export interface ReleaseCapacity {
  /** Per-milestone effort-points budget (XS=1 S=2 M=3 L=5 XL=8; default: 8). */
  effort_budget?: number;
  /**
   * Give each resolved `semver:major` issue its own milestone (default: true).
   * Prose-only or recommendation-only issues are never treated as breaking.
   */
  isolate_breaking?: boolean;
}

export interface RoadmapConfig {
  include_labels?: string[];
  exclude_labels?: string[];
  score_weights?: ScoreWeights;
  hygiene_auto_apply?: boolean;
  pr_docs?: boolean;
  release_model?: 'semver' | 'continuous';
  release_capacity?: ReleaseCapacity;
  inventory_concurrency?: number;
  depgraph_concurrency?: number;
  depgraph_verify_cap?: number;
}

export type ReleaseModel = 'semver' | 'continuous';
