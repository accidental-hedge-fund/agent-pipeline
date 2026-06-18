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
}

export interface Milestone {
  id: number;
  number: number;
  title: string;
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

export interface DepGraph {
  must_precede: DepEdge[];
  should_precede: DepEdge[];
  parallel_safe: [IssueNumber, IssueNumber][];
  blocked_pending_decision: IssueNumber[];
  duplicate_merge: [IssueNumber, IssueNumber][];
  conflict_pairs: [IssueNumber, IssueNumber][];
  cycle_reports: CycleReport[];
  open_questions: OpenQuestion[];
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

export interface MilestoneSpec {
  title: string;
  issue_numbers: IssueNumber[];
  rationale: string;
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
  /** Present only when release_model === 'continuous'. CalVer format: YYYY.0M.MICRO */
  continuous_version_marker?: string;
}

export interface RoadmapConfig {
  include_labels?: string[];
  exclude_labels?: string[];
  score_weights?: ScoreWeights;
  hygiene_auto_apply?: boolean;
  pr_docs?: boolean;
  release_model?: 'semver' | 'continuous';
}

export type ReleaseModel = 'semver' | 'continuous';
