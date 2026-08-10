// Backlog roadmap engine orchestrator (#171).
// Runs 7 phases: comprehend → inventory → depgraph → score → roadmap → hygiene → critique.
// All I/O is injectable via RoadmapDeps; production wiring lives in pipeline.ts.

import * as path from "node:path";
import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import { partitionFindings } from "../review-policy.ts";
import type { ReviewFinding } from "../types.ts";
import type {
  PlanJson,
  RunStats,
  DepEdge,
  HygieneItem,
  MilestoneSpec,
  CritiqueEntry,
  OpenQuestion,
  RoadmapConfig,
  RoadmapEntry,
  InventoryItem,
  CrossRepoDep,
  DepGraph,
  CompatibilityClassification,
  CompatibilityImpact,
  CompatibilityRecommendation,
} from "./types.ts";
import { buildInventory, computeBacklogSha } from "./inventory.ts";
import type { InventoryDeps } from "./inventory.ts";
import { buildDepgraph, addMustPrecedeEdges } from "./depgraph.ts";
import type { DepgraphDeps } from "./depgraph.ts";
import { scoreItems, applyDepAdjustment, sortRoadmapByTier } from "./score.ts";
import {
  writePlanJson,
  writeRoadmapMd,
  openRoadmapPr,
  applyHygiene,
  applyMilestones,
  logReconciliationPreview,
} from "./writeback.ts";
import type { WritebackDeps } from "./writeback.ts";
import {
  buildReconciliationManifest,
  loadLiveState,
  applySemverReconciliation,
  parseShippedSemverTitles,
  saveReviewedManifest,
  loadReviewedManifest,
  loadProgress,
  validateSemverApplyReady,
} from "./reconcile.ts";
import type { ReconciliationManifest } from "./types.ts";
import { ROADMAP_ARTIFACT, artifactSubdir } from "../artifact-ignore.ts";

export interface RoadmapOpts {
  apply: boolean;
  next?: number;
  dryRun?: boolean;
  outputDir?: string;
  /** Cross-repo dependency map from config.repo_map. When set and non-empty,
   *  the engine gathers cross-repo annotations after the depgraph phase. */
  repoMap?: { depends_on: string[]; depended_on_by: string[] };
  /**
   * When applying SemVer reconciliation, require this reviewed manifest identity
   * (from a prior dry-run plan.json). Mismatch refuses apply (#910).
   */
  expectedReconciliationIdentity?: string;
}

export interface RoadmapDeps extends InventoryDeps, DepgraphDeps, WritebackDeps {
  /** Critique harness: must be the reviewer role (not implementer). */
  runCritiqueHarness(prompt: string): Promise<{ success: boolean; output: string }>;
  /** Return the latest git tag (e.g. "v1.6.0") or "" if no tags exist. */
  getLatestTag(repoDir: string): Promise<string>;
  /**
   * List shipped SemVer-like tags (e.g. `git tag --list 'v*'`).
   * Used to classify closed shipped milestones as immutable (#910).
   * Defaults to wrapping getLatestTag when absent.
   */
  listSemverTags?(repoDir: string): Promise<string[]>;
  /** Injectable clock for phase timing; defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Milestone builders
// ---------------------------------------------------------------------------

const SEMVER_TITLE_RE = /^v\d+\.\d+\.\d+$/;

/** Effort-points map: used by capacity-aware semver grouping and by tests. */
export const EFFORT_POINTS: Record<import("./types.ts").EffortSize, number> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
};

const DEFAULT_EFFORT_BUDGET = 8;
const DEFAULT_ISOLATE_BREAKING = true;
const HIGH_RISK_SIGNALS = ["Security-sensitive change", "Wide blast radius"];

/**
 * Parse a semver tag (e.g. "v1.6.0" or "1.6.0") into [major, minor, patch].
 * Returns [0, 0, 0] when the tag is absent or unparseable.
 */
function parseSemverTag(tag: string): [number, number, number] {
  const clean = tag.startsWith("v") ? tag.slice(1) : tag;
  const parts = clean.split(".").map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0], parts[1], parts[2]];
  }
  return [0, 0, 0];
}

/** Authoritative applied-impact labels (mutually exclusive). Case-insensitive match. */
const EXPLICIT_SEMVER_LABELS = ["semver:major", "semver:minor", "semver:patch"] as const;
const IMPACT_FROM_SEMVER_LABEL: Record<(typeof EXPLICIT_SEMVER_LABELS)[number], CompatibilityImpact> = {
  "semver:major": "major",
  "semver:minor": "minor",
  "semver:patch": "patch",
};

const FEATURE_LABELS = new Set(["feature", "enhancement", "feat"]);
const MAINTENANCE_LABELS = new Set([
  "chore",
  "maintenance",
  "bug",
  "bugfix",
  "refactor",
  "documentation",
  "docs",
]);
const RECOMMEND_MAJOR_LABELS = new Set(["breaking-change", "breaking"]);

/**
 * Non-binding recommendation from generic type / signal labels only.
 * Never sets applied impact. Title/body text is not consulted.
 */
function recommendFromTypeLabels(labelsLower: string[]): CompatibilityRecommendation | undefined {
  for (const l of labelsLower) {
    if (RECOMMEND_MAJOR_LABELS.has(l)) {
      return { impact: "major", source: l };
    }
  }
  for (const l of labelsLower) {
    if (FEATURE_LABELS.has(l)) {
      return { impact: "minor", source: l };
    }
  }
  for (const l of labelsLower) {
    if (MAINTENANCE_LABELS.has(l)) {
      return { impact: "patch", source: l };
    }
  }
  return undefined;
}

/**
 * Classify applied SemVer compatibility impact from exclusive `semver:*` labels only.
 *
 * - Exactly one of `semver:major` | `semver:minor` | `semver:patch` → resolved
 * - None → unresolved_missing (optional non-binding recommendation from type labels)
 * - Two or more distinct classes → unresolved_conflict
 *
 * Title and body text never set, upgrade, or downgrade applied impact.
 * `entry` is accepted for call-site stability; applied class does not use tier/score.
 */
export function classifyCompatibilityImpact(
  entry: RoadmapEntry,
  item: InventoryItem,
): CompatibilityClassification {
  void entry;
  const issueNumber = item.issue.number;
  const labelsLower = item.issue.labels.map((l) => l.toLowerCase());

  const presentExplicit = EXPLICIT_SEMVER_LABELS.filter((name) => labelsLower.includes(name));

  if (presentExplicit.length >= 2) {
    return {
      issue_number: issueNumber,
      status: "unresolved_conflict",
      applied_impact: null,
      source_label: null,
      uncertain: true,
      conflict_labels: [...presentExplicit],
    };
  }

  if (presentExplicit.length === 1) {
    const source = presentExplicit[0];
    return {
      issue_number: issueNumber,
      status: "resolved",
      applied_impact: IMPACT_FROM_SEMVER_LABEL[source],
      source_label: source,
      uncertain: false,
    };
  }

  const recommendation = recommendFromTypeLabels(labelsLower);
  return {
    issue_number: issueNumber,
    status: "unresolved_missing",
    applied_impact: null,
    source_label: null,
    uncertain: true,
    ...(recommendation !== undefined ? { recommendation } : {}),
  };
}

/**
 * Classify every roadmap issue (inventory missing → unresolved_missing).
 * Blocked issues remain classified for visibility; they are still excluded from lanes separately.
 */
export function buildCompatibilityClassifications(
  roadmap: RoadmapEntry[],
  items: InventoryItem[] = [],
): CompatibilityClassification[] {
  const itemByIssue = new Map<number, InventoryItem>();
  for (const item of items) {
    itemByIssue.set(item.issue.number, item);
  }

  return roadmap.map((entry) => {
    const item = itemByIssue.get(entry.issue_number);
    if (!item) {
      return {
        issue_number: entry.issue_number,
        status: "unresolved_missing" as const,
        applied_impact: null,
        source_label: null,
        uncertain: true,
      };
    }
    return classifyCompatibilityImpact(entry, item);
  });
}

/**
 * Build a product-term rationale string for a semver milestone.
 * Names at least one of: compatibility impact, theme cohesion, risk/capacity, or dependency.
 */
function buildMilestoneRationale(
  entries: RoadmapEntry[],
  impact: CompatibilityImpact,
): string {
  const impactPhrase =
    impact === "major"
      ? "Breaking-change compatibility impact (explicit semver:major)"
      : impact === "minor"
        ? "Backward-compatible feature work (explicit semver:minor)"
        : "Maintenance-only work (explicit semver:patch)";

  const tiers = [...new Set(entries.map((e) => e.tier))];
  const cohesionPhrase =
    tiers.length === 1
      ? `theme: ${tiers[0]}`
      : `mixed tiers: ${tiers.join(", ")}`;

  const capacityPhrase = `${entries.length} issue(s) within release capacity`;
  const issues = entries.map((e) => `#${e.issue_number}`).join(", ");

  return `${[impactPhrase, cohesionPhrase, capacityPhrase].join("; ")}. Issues: ${issues}.`;
}

/**
 * Bundle ranked issues with **resolved** applied SemVer impact into capacity-aware,
 * compatibility-impact-driven version-numbered release milestones:
 * - Only issues with resolved applied impact from exclusive `semver:*` labels enter lanes.
 * - Unresolved (missing / conflicting) issues are omitted from automatic assignment.
 * - Milestone boundaries use effort-weighted capacity; resolved major + isolate_breaking isolates.
 * - Semver increment reflects the highest **resolved applied** impact in the milestone.
 */
export function buildSemverLanes(
  roadmap: RoadmapEntry[],
  latestTag: string,
  items: InventoryItem[] = [],
  capacity?: { effort_budget?: number; isolate_breaking?: boolean },
  blockedPendingDecision?: Set<number>,
): MilestoneSpec[] {
  const excluded = blockedPendingDecision ?? new Set<number>();
  const unblocked = roadmap.filter((e) => !excluded.has(e.issue_number));
  if (unblocked.length === 0) return [];

  const budget = capacity?.effort_budget ?? DEFAULT_EFFORT_BUDGET;
  const isolateBreaking = capacity?.isolate_breaking ?? DEFAULT_ISOLATE_BREAKING;

  const itemByIssue = new Map<number, InventoryItem>();
  for (const item of items) {
    itemByIssue.set(item.issue.number, item);
  }

  // Only resolved applied-impact issues participate in packing / version walk.
  const classificationByIssue = new Map<number, CompatibilityClassification>();
  const eligible: RoadmapEntry[] = [];
  for (const entry of unblocked) {
    const item = itemByIssue.get(entry.issue_number);
    const classification = item
      ? classifyCompatibilityImpact(entry, item)
      : {
          issue_number: entry.issue_number,
          status: "unresolved_missing" as const,
          applied_impact: null,
          source_label: null,
          uncertain: true,
        };
    classificationByIssue.set(entry.issue_number, classification);
    if (classification.status === "resolved" && classification.applied_impact !== null) {
      eligible.push(entry);
    }
  }
  if (eligible.length === 0) return [];

  let [curMajor, curMinor, curPatch] = parseSemverTag(latestTag);
  const milestones: MilestoneSpec[] = [];

  function closeMilestone(entries: RoadmapEntry[]): void {
    if (entries.length === 0) return;

    let milestoneImpact: CompatibilityImpact = "patch";

    for (const entry of entries) {
      const impact = classificationByIssue.get(entry.issue_number)?.applied_impact;
      if (impact === "major") {
        milestoneImpact = "major";
      } else if (impact === "minor" && milestoneImpact !== "major") {
        milestoneImpact = "minor";
      }
    }

    if (milestoneImpact === "major") {
      curMajor += 1;
      curMinor = 0;
      curPatch = 0;
    } else if (milestoneImpact === "minor") {
      curMinor += 1;
      curPatch = 0;
    } else {
      curPatch += 1;
    }

    const title = `v${curMajor}.${curMinor}.${curPatch}`;
    const rationale = buildMilestoneRationale(entries, milestoneImpact);

    milestones.push({
      title,
      issue_numbers: entries.map((e) => e.issue_number),
      rationale,
      version_impact: milestoneImpact,
    });
  }

  let current: RoadmapEntry[] = [];
  let currentPoints = 0;

  for (const entry of eligible) {
    const points = EFFORT_POINTS[entry.effort] ?? 3;
    const applied = classificationByIssue.get(entry.issue_number)?.applied_impact;

    const isBreaking = applied === "major" && isolateBreaking;
    const isOversized = points >= budget;
    const isHighRisk = entry.risks.some((r) => HIGH_RISK_SIGNALS.includes(r));

    if (isBreaking || isOversized || isHighRisk) {
      closeMilestone(current);
      current = [];
      currentPoints = 0;
      closeMilestone([entry]);
    } else if (currentPoints + points > budget) {
      closeMilestone(current);
      current = [entry];
      currentPoints = points;
    } else {
      current.push(entry);
      currentPoints += points;
    }
  }

  closeMilestone(current);
  return milestones;
}

/** Human-readable one-line summary for logs / Markdown / apply preview. */
export function formatClassificationLine(c: CompatibilityClassification): string {
  if (c.status === "resolved") {
    return `#${c.issue_number}: applied=${c.applied_impact} source=${c.source_label}`;
  }
  if (c.status === "unresolved_conflict") {
    const labels = (c.conflict_labels ?? []).join(", ");
    return `#${c.issue_number}: unresolved_conflict labels=[${labels}] (no automatic milestone assignment)`;
  }
  const rec =
    c.recommendation !== undefined
      ? ` recommendation=${c.recommendation.impact} (from ${c.recommendation.source}, non-applied)`
      : "";
  return `#${c.issue_number}: unresolved_missing (no explicit semver:* label)${rec}`;
}

/**
 * Group roadmap issues by epic/theme label, falling back to tier name.
 * Titles are non-semver strings derived from label values or tier names.
 */
export function buildContinuousGroups(roadmap: RoadmapEntry[], items: InventoryItem[]): MilestoneSpec[] {
  if (roadmap.length === 0) return [];

  const labelByIssue = new Map<number, string[]>();
  for (const item of items) {
    labelByIssue.set(item.issue.number, item.issue.labels);
  }

  const EPIC_THEME_RE = /^(epic|theme):/;

  function groupKey(entry: RoadmapEntry): string {
    const labels = labelByIssue.get(entry.issue_number) ?? [];
    const epicLabel = labels.find((l) => EPIC_THEME_RE.test(l));
    if (epicLabel) return epicLabel;
    // Fall back to a human-readable tier name
    const tierNames: Record<string, string> = {
      enablers: "Tier 1: Enablers",
      "dependency-unlock": "Tier 2: Dependency Unlock",
      "high-value/low-risk": "Tier 3: High-Value / Low-Risk",
      "larger-bets": "Tier 4: Larger Bets",
      cleanup: "Tier 5: Cleanup",
    };
    return tierNames[entry.tier] ?? entry.tier;
  }

  const groups = new Map<string, number[]>();
  for (const entry of roadmap) {
    const key = groupKey(entry);
    const existing = groups.get(key);
    if (existing) {
      existing.push(entry.issue_number);
    } else {
      groups.set(key, [entry.issue_number]);
    }
  }

  return [...groups.entries()].map(([key, issue_numbers]) => ({
    title: key,
    issue_numbers,
    rationale: `Grouped by ${EPIC_THEME_RE.test(key) ? "label" : "tier"}: ${key}`,
  }));
}

/**
 * Build a CalVer marker in YYYY.0M.MICRO format.
 * MICRO is 0 on the first run of the month, 1 if a prior plan exists from the
 * same calendar month, etc.
 */
export function buildCalVerMarker(now: string, backlogSha: string): string {
  const date = new Date(now);
  const yyyy = date.getUTCFullYear().toString();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  // Lock-free, content-addressed: the third segment is a short prefix of the backlog SHA the
  // roadmap was generated against. Deterministic per backlog state — no read-modify-write
  // counter — so concurrent runs need no serializing lock and produce a correct marker (#214).
  const short = (backlogSha || "").replace(/[^0-9a-fA-F]/g, "").slice(0, 7).toLowerCase() || "0000000";
  return `${yyyy}.${mm}.${short}`;
}

interface CritiqueVerdict {
  verdict: string;
  findings: ReviewFinding[];
}

const STALE_THRESHOLD_DAYS = 7;

/** Minimum review policy for critique: block on high-severity findings. */
const CRITIQUE_POLICY = { block_threshold: "high" as const, min_confidence: 0.5 };

/**
 * Parse a structured critique verdict from harness output.
 * Uses the same review-schema.ts verdict shape.
 */
function parseCritiqueVerdict(output: string): CritiqueVerdict | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : output;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (!parsed.verdict || !Array.isArray(parsed.findings)) return null;
    return parsed as unknown as CritiqueVerdict;
  } catch {
    return null;
  }
}

/**
 * Build the comprehension prompt (phase 1): summary of repo context.
 */
function buildComprehendPrompt(repo: string, openIssueCount: number): string {
  return (
    `You are analyzing the repository "${repo}" to build understanding before roadmap planning.\n\n` +
    `Open issue count: ${openIssueCount}\n\n` +
    `Provide:\n` +
    `1. **Architecture summary**: what this repo builds, its main components.\n` +
    `2. **Engineering system**: CI/CD, testing patterns, branching strategy.\n` +
    `3. **Product intent**: what problem this repo solves and for whom.\n\n` +
    `Be concise (under 400 words). Focus on facts useful for issue prioritization.`
  );
}

/**
 * Build the adversarial critique prompt (phase 7).
 * Receives the full plan data so all mandatory checks have the information they need:
 * - score_breakdown per issue (for reproducibility checks)
 * - issue titles/labels (for duplicate and actionability checks)
 * - hygiene proposals (to detect mislabeling)
 * - full dep graph including open_questions
 * - ALL roadmap entries, not just top-20
 */
function buildCritiquePrompt(
  roadmap: import("./types.ts").RoadmapEntry[],
  depGraph: import("./types.ts").DepGraph,
  hygiene: import("./types.ts").HygieneItem[],
  openQuestions: import("./types.ts").OpenQuestion[],
  items: InventoryItem[],
): string {
  const planData = JSON.stringify(
    {
      roadmap: roadmap.map((r) => ({
        rank: r.rank,
        issue_number: r.issue_number,
        title: r.title,
        tier: r.tier,
        priority: r.priority,
        score_breakdown: r.score_breakdown,
        effort: r.effort,
        blocked_by: r.blocked_by,
        unblocks: r.unblocks,
        risks: r.risks,
        dep_rationale: r.dep_rationale,
      })),
      dependency_graph: {
        must_precede: depGraph.must_precede,
        cycle_reports: depGraph.cycle_reports,
        open_questions: depGraph.open_questions,
      },
      hygiene_proposals: hygiene.map((h) => ({ issue_number: h.issue_number, action: h.action, evidence: h.evidence })),
      open_questions: openQuestions,
      issue_metadata: items.map((i) => ({
        number: i.issue.number,
        title: i.issue.title,
        labels: i.issue.labels,
        body_length: i.issue.body.length,
        has_acceptance_criteria: /- \[ \]/.test(i.issue.body),
      })),
    },
    null,
    2,
  );

  return (
    `You are adversarially reviewing a backlog roadmap plan for correctness and consistency.\n\n` +
    `## Full plan data\n\n\`\`\`json\n${planData}\n\`\`\`\n\n` +
    `Attack the plan for:\n` +
    `1. Dependency-order violations (a dependent appears before its prerequisite in the roadmap; check rank vs blocked_by)\n` +
    `2. Non-reproducible scores (verify: priority = (impact × confidence × ease) + risk_reduction + dep_leverage from score_breakdown)\n` +
    `3. Missed duplicates (same work described twice with different issue numbers; compare titles and labels)\n` +
    `4. Mislabeled "ready" issues (issues with no acceptance criteria or very short bodies that may not be actionable)\n\n` +
    `Return findings using this exact JSON schema:\n\`\`\`json\n${REVIEW_VERDICT_SCHEMA_BLOCK}\n\`\`\`\n\n` +
    `For dep-order violations, set category to "dep-order-violation".\n` +
    `Use severity "high" for dep-order violations, "medium" for score issues, "low" for style findings.\n` +
    `Return raw fenced JSON only.`
  );
}

/**
 * Generate hygiene proposals from the inventory.
 * Returns { hygiene, openQuestions }: proposals with concrete file:line evidence go to hygiene[];
 * issue-only observations (no file:line citation) go to openQuestions so that maintainers
 * are not asked to apply an action without a verifiable code reference.
 */
function generateHygiene(items: InventoryItem[]): { hygiene: HygieneItem[]; openQuestions: OpenQuestion[] } {
  const hygiene: HygieneItem[] = [];
  const openQuestions: OpenQuestion[] = [];

  for (const item of items) {
    const body = item.issue.body ?? "";
    const title = item.issue.title ?? "";
    const firstFile = item.touched_files[0];

    if (body.trim().length < 100 && !body.includes("- [ ]")) {
      if (firstFile) {
        // We have a source-file reference: use it as the file:line citation
        hygiene.push({
          issue_number: item.issue.number,
          action: "rewrite-title",
          comment_text:
            `## Roadmap: Issue needs more detail\n\n` +
            `This issue has a very short description and no acceptance criteria. ` +
            `Consider expanding with: Summary, User story, Acceptance criteria (- [ ] checkboxes), Out of scope.\n\n` +
            `*Automated by \`pipeline roadmap\`*`,
          evidence: `${firstFile}:1 (issue body ${body.trim().length} chars, no acceptance criteria)`,
        });
      } else {
        openQuestions.push({
          description: `Issue #${item.issue.number} "${title}" has a very short body (${body.trim().length} chars) and no acceptance criteria — consider rewriting`,
          related_issues: [item.issue.number],
          rationale: "issue metadata only; no file:line evidence available",
        });
      }
    }

    if (/spike|investigate|research|explore/.test(title.toLowerCase())) {
      if (firstFile) {
        hygiene.push({
          issue_number: item.issue.number,
          action: "spike",
          comment_text:
            `## Roadmap: This looks like a spike/research item\n\n` +
            `Consider time-boxing this to a fixed investigation period and creating a follow-up issue with findings.\n\n` +
            `*Automated by \`pipeline roadmap\`*`,
          evidence: `${firstFile}:1 (title contains research/spike keywords)`,
        });
      } else {
        openQuestions.push({
          description: `Issue #${item.issue.number} "${title}" looks like a spike/research item — consider time-boxing`,
          related_issues: [item.issue.number],
          rationale: "issue metadata only; no file:line evidence available",
        });
      }
    }
  }

  return { hygiene, openQuestions };
}

/**
 * Resolve the output directory for plan.json and roadmap.md.
 */
function resolveOutputDir(repoDir: string, repo: string, optsOutputDir?: string): string {
  if (optsOutputDir) return optsOutputDir;
  const repoSlug = repo.replace("/", "_");
  return path.join(artifactSubdir(repoDir, ROADMAP_ARTIFACT), repoSlug);
}

/**
 * Emit the top-N dependency-safe issues from an existing plan.json.
 * Returns false when plan.json is not found.
 */
export async function runNext(
  n: number,
  outputDir: string,
  deps: Pick<RoadmapDeps, "readFile" | "log">,
): Promise<boolean> {
  const planPath = path.join(outputDir, "plan.json");
  const content = await deps.readFile(planPath);
  if (!content) {
    deps.log(`[roadmap] --next: no plan.json found at ${planPath}. Run 'pipeline roadmap' first.`);
    return false;
  }

  let plan: PlanJson;
  try {
    plan = JSON.parse(content) as PlanJson;
  } catch {
    deps.log(`[roadmap] --next: plan.json is invalid JSON. Re-run 'pipeline roadmap'.`);
    return false;
  }

  const generatedAt = plan.generated_at ? new Date(plan.generated_at).getTime() : 0;
  const ageDays = (Date.now() - generatedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > STALE_THRESHOLD_DAYS) {
    deps.log(
      `[roadmap] WARNING: plan.json is ${Math.floor(ageDays)} days old (threshold: ${STALE_THRESHOLD_DAYS} days). Consider re-running 'pipeline roadmap'.`,
    );
  }

  const topN = plan.roadmap.slice(0, n);
  deps.log(`\n[roadmap] Top ${n} dependency-safe issues:\n`);
  for (const entry of topN) {
    deps.log(
      `  ${entry.rank}. #${entry.issue_number} — ${entry.title} (${entry.tier}, score: ${entry.priority.toFixed(1)}, effort: ${entry.effort})`,
    );
  }
  return true;
}

/**
 * Gather cross-repo dependency annotations when repo_map is configured.
 * Non-blocking: logs a named warning for unreachable repos and continues.
 * Deduplicates repos across both directions, fetching each exactly once.
 * Returns the dep graph with `cross_repo` populated.
 */
async function gatherCrossRepoDeps(
  graph: DepGraph,
  items: InventoryItem[],
  opts: RoadmapOpts,
  deps: Pick<RoadmapDeps, "getOpenIssues" | "log">,
): Promise<DepGraph> {
  const repoMap = opts.repoMap;
  if (!repoMap) return graph;
  const allDeclared = [...(repoMap.depends_on ?? []), ...(repoMap.depended_on_by ?? [])];
  if (allDeclared.length === 0) return graph;

  deps.log("[roadmap] phase 3b: gathering cross-repo dependency annotations...");

  // Deduplicate repos; if a repo appears in both directions, favour depends_on.
  const repoDirection = new Map<string, "depends_on" | "depended_on_by">();
  for (const r of (repoMap.depended_on_by ?? [])) repoDirection.set(r, "depended_on_by");
  for (const r of (repoMap.depends_on ?? [])) repoDirection.set(r, "depends_on");

  const crossRepo: CrossRepoDep[] = [];

  for (const [declaredRepo, direction] of repoDirection) {
    let declaredIssues: { number: number; title: string }[];
    try {
      declaredIssues = await deps.getOpenIssues(declaredRepo);
    } catch (err) {
      deps.log(
        `[roadmap] repo_map: ${declaredRepo} unreachable — continuing without its cross-repo edges: ${(err as Error).message}`,
      );
      continue;
    }

    const declaredIssueNumbers = new Set(declaredIssues.map((i) => i.number));
    const repoLower = declaredRepo.toLowerCase();

    for (const item of items) {
      const text = `${item.issue.title} ${item.issue.body}`;
      const textLower = text.toLowerCase();
      const mentionsRepo = textLower.includes(repoLower);
      const mentionedIssueNums = [...text.matchAll(/#(\d+)/g)]
        .map((m) => Number.parseInt(m[1]!, 10))
        .filter((n) => declaredIssueNumbers.has(n));

      if (mentionsRepo || mentionedIssueNums.length > 0) {
        crossRepo.push({
          local_issue: item.issue.number,
          repo: declaredRepo,
          direction,
          rationale: mentionsRepo
            ? `local issue text references \`${declaredRepo}\``
            : `local issue references #${mentionedIssueNums[0]} from \`${declaredRepo}\``,
        });
      }
    }
  }

  deps.log(`[roadmap] phase 3b: ${crossRepo.length} cross-repo annotation(s) identified`);
  return { ...graph, cross_repo: crossRepo };
}

/**
 * Main roadmap engine: orchestrates all 7 phases.
 */
export async function runRoadmap(
  repo: string,
  repoDir: string,
  baseBranch: string,
  config: RoadmapConfig,
  opts: RoadmapOpts,
  deps: RoadmapDeps,
): Promise<void> {
  deps.log("[roadmap] starting backlog-roadmap-engine...");

  const outputDir = resolveOutputDir(repoDir, repo, opts.outputDir);

  // --next path: validate then read plan.json without re-running the engine
  if (opts.next !== undefined) {
    const n = opts.next;
    if (!Number.isInteger(n) || n <= 0) {
      const msg = `--next requires a positive integer, got: ${String(n)}. Usage: pipeline roadmap --next <N>`;
      deps.log(`[roadmap] error: ${msg}`);
      throw new Error(msg);
    }
    await runNext(n, outputDir, deps);
    return;
  }

  const clock = deps.now ?? Date.now;
  const phaseElapsedMs: Record<string, number> = {};

  async function timed<T>(phaseName: string, fn: () => Promise<T>): Promise<T> {
    const start = clock();
    try {
      return await fn();
    } finally {
      phaseElapsedMs[phaseName] = clock() - start;
    }
  }

  // Phase 1: Comprehend
  let openIssueCount = 0;
  await timed("comprehend", async () => {
    deps.log("[roadmap] phase 1: comprehend...");
    try {
      const allIssuesForCount = await deps.getOpenIssues(repo);
      openIssueCount = allIssuesForCount.length;
      const prompt = buildComprehendPrompt(repo, allIssuesForCount.length);
      await deps.runHarness(prompt);
      deps.log("[roadmap] phase 1: comprehension complete");
    } catch (err) {
      deps.log(`[roadmap] phase 1: comprehension warning: ${(err as Error).message}`);
    }
  });

  // Phase 2: Inventory
  const { items, stats: inventoryStats } = await timed("inventory", () =>
    buildInventory(repo, config, deps),
  );
  const backlogSha = computeBacklogSha(items.map((i) => i.issue));

  // Phase 3: Dependency graph
  const { graph: depGraphResult, stats: depgraphStats } = await timed("depgraph", () =>
    buildDepgraph(items, deps, config),
  );
  let depGraph = depGraphResult;

  // Phase 3b: Cross-repo dependency annotations (non-blocking, opt-in via repo_map)
  depGraph = await timed("cross-repo", () =>
    gatherCrossRepoDeps(depGraph, items, opts, deps),
  );

  // Phase 4: Score
  const scored_result = await timed("score", async () => {
    deps.log("[roadmap] phase 4: scoring...");
    return scoreItems(items, depGraph, config.score_weights);
  });
  let scored = scored_result;

  // Phase 5: Roadmap tiers (canonical tier order within each dep-tier preserved)
  let roadmap = await timed("roadmap", async () => {
    deps.log("[roadmap] phase 5: producing tiered roadmap...");
    return applyDepAdjustment(scored, items, depGraph);
  });

  // Phase 6: Hygiene (proposals with file:line go to hygiene[]; issue-only to openQuestions)
  const { hygiene, openQuestions: hygieneOpenQuestions } = await timed("hygiene", async () => {
    deps.log("[roadmap] phase 6: hygiene analysis...");
    return generateHygiene(items);
  });

  // Phase 7: Adversarial critique (up to 2 correction rounds, using reviewer harness)
  const openQuestions: OpenQuestion[] = [...depGraph.open_questions, ...hygieneOpenQuestions];
  const critiqueEntries: CritiqueEntry[] = [];
  const MAX_CORRECTION_ROUNDS = 2;
  let correctionRound = 0;

  await timed("critique", async () => {
    deps.log("[roadmap] phase 7: adversarial critique...");

    while (correctionRound < MAX_CORRECTION_ROUNDS) {
      const critiqueResult = await deps.runCritiqueHarness(
        buildCritiquePrompt(roadmap, depGraph, hygiene, openQuestions, items),
      );

      if (!critiqueResult.success) {
        deps.log("[roadmap] phase 7: critique harness failed — recording as open question");
        openQuestions.push({
          description: "Adversarial critique harness failed — roadmap may have undetected dep-order violations",
          related_issues: [],
          rationale: "critique harness returned success:false; re-run 'pipeline roadmap' to retry",
        });
        break;
      }

      const verdict = parseCritiqueVerdict(critiqueResult.output);
      if (verdict === null) {
        // Malformed output — treat as a critique failure, not a clean approval
        deps.log("[roadmap] phase 7: critique returned malformed output — recording open question");
        openQuestions.push({
          description: "Adversarial critique returned malformed output — roadmap may have undetected dep-order violations",
          related_issues: [],
          rationale: "critique output was not parseable as a review verdict JSON; re-run 'pipeline roadmap' to retry",
        });
        break;
      }
      if (verdict.findings.length === 0) {
        deps.log("[roadmap] phase 7: no critique findings — plan looks good");
        break;
      }

      const { blocking, advisory } = partitionFindings(verdict.findings, CRITIQUE_POLICY);

      for (const { finding } of advisory) {
        critiqueEntries.push({
          severity: finding.severity,
          title: finding.title,
          body: finding.body,
          file: finding.file,
          line_start: finding.line_start,
          line_end: finding.line_end,
          confidence: finding.confidence,
          recommendation: finding.recommendation,
          category: finding.category,
          is_advisory: true,
        });
      }

      const depViolations = blocking.filter((f) => f.category === "dep-order-violation");

      if (depViolations.length === 0) {
        for (const f of blocking) {
          critiqueEntries.push({
            severity: f.severity,
            title: f.title,
            body: f.body,
            file: f.file,
            line_start: f.line_start,
            line_end: f.line_end,
            confidence: f.confidence,
            recommendation: f.recommendation,
            category: f.category,
            is_advisory: false,
          });
        }
        break;
      }

      correctionRound++;
      deps.log(
        `[roadmap] phase 7: correction round ${correctionRound} — ${depViolations.length} dep-order violation(s)`,
      );

      // Only allow critique to re-assert ordering for edges already source-verified
      // in phase 3. Critique text is not a source-verification path.
      // Only edges already classified as HARD (must_precede) in phase 3 may be
      // re-asserted directly from critique text. should_precede is advisory
      // (is_strong:false) and must NOT be promoted to a hard ordering constraint on
      // critique text alone — record it as an open question instead so it does not
      // silently serialize work or inflate dep_leverage (#292 review-2 finding).
      const mustEdgeKeys = new Set(
        depGraph.must_precede.map((e) => `${e.from}:${e.to}`),
      );
      const shouldEdgeKeys = new Set(
        depGraph.should_precede.map((e) => `${e.from}:${e.to}`),
      );

      const newEdges: DepEdge[] = [];
      for (const f of depViolations) {
        const nums = [...(f.title + " " + f.body).matchAll(/#(\d+)/g)].map(
          (m) => Number.parseInt(m[1], 10),
        );
        if (nums.length >= 2) {
          const edgeKey = `${nums[0]}:${nums[1]}`;
          if (mustEdgeKeys.has(edgeKey)) {
            newEdges.push({
              from: nums[0],
              to: nums[1],
              file_line: f.file ? `${f.file}:${f.line_start ?? 0}` : "",
              rationale: `critique correction: ${f.body.slice(0, 100)}`,
            });
          } else if (shouldEdgeKeys.has(edgeKey)) {
            openQuestions.push({
              description: `Critique proposed promoting advisory edge #${nums[0]}→#${nums[1]} to a hard dependency: ${f.title}`,
              related_issues: [nums[0], nums[1]],
              rationale: `edge exists only as advisory should_precede (is_strong:false); not promoted to must_precede without source re-verification; critique: ${f.body.slice(0, 200)}`,
            });
          } else {
            openQuestions.push({
              description: `Critique proposed unverified dep edge #${nums[0]}→#${nums[1]}: ${f.title}`,
              related_issues: [nums[0], nums[1]],
              rationale: `edge not source-verified; critique correction: ${f.body.slice(0, 200)}`,
            });
          }
        } else {
          // Fewer than two issue references parsed — there is no actionable edge.
          // Record the finding visibly instead of silently dropping it before the
          // newEdges.length === 0 break (#292 review-2: a blocking dep-order critique
          // must never vanish from plan.json).
          openQuestions.push({
            description: `Unparseable dep-order critique finding (could not extract two issue references): ${f.title}`,
            related_issues: nums,
            rationale: `dep-order violation preserved as an open question; no verified edge applied; critique: ${f.body.slice(0, 200)}`,
          });
        }
      }

      if (newEdges.length > 0) {
        const allIssueNums = items.map((i) => i.issue.number);
        depGraph = addMustPrecedeEdges(depGraph, newEdges, allIssueNums);
        // Re-score with the updated dep graph so dep_leverage and dep_rationale reflect
        // the corrected edges before rebuilding the roadmap order.
        scored = scoreItems(items, depGraph, config.score_weights);
        roadmap = applyDepAdjustment(scored, items, depGraph);
      } else {
        // All proposed corrections were unverified; break to avoid re-critiquing
        // an unchanged roadmap (unverified edges already recorded in openQuestions).
        break;
      }

      if (correctionRound >= MAX_CORRECTION_ROUNDS) {
        for (const f of depViolations) {
          openQuestions.push({
            description: `Unresolved dep-order violation after ${MAX_CORRECTION_ROUNDS} correction rounds: ${f.title}`,
            related_issues: [...(f.title + " " + f.body).matchAll(/#(\d+)/g)].map(
              (m) => Number.parseInt(m[1], 10),
            ),
            rationale: f.body.slice(0, 200),
          });
        }
        deps.log(
          `[roadmap] phase 7: correction cap reached — ${depViolations.length} violation(s) promoted to open_questions`,
        );
      }
    }
  });

  // Assemble run_stats from per-phase counts and timings.
  const runStats: RunStats = {
    open_issue_count: openIssueCount,
    filtered_issue_count: items.length,
    inventory_harness_calls: inventoryStats.harness_calls,
    inventory_harness_skipped: inventoryStats.harness_skipped,
    depgraph_candidates_textual: depgraphStats.candidates_textual,
    depgraph_candidates_shared_file: depgraphStats.candidates_shared_file,
    depgraph_candidates_cross_file: depgraphStats.candidates_cross_file,
    depgraph_verify_calls: depgraphStats.verify_calls,
    depgraph_verify_skipped: depgraphStats.verify_skipped,
    critique_rounds: correctionRound,
    phase_elapsed_ms: phaseElapsedMs,
  };

  deps.log(
    `[roadmap] run_stats: inventory harness=${runStats.inventory_harness_calls} skipped=${runStats.inventory_harness_skipped}` +
    ` depgraph verify=${runStats.depgraph_verify_calls} skipped=${runStats.depgraph_verify_skipped}` +
    ` critique_rounds=${runStats.critique_rounds}`,
  );

  // Build milestones based on release_model (semver default)
  deps.log("[roadmap] phase 8: building milestone groupings...");
  const releaseModel = config.release_model ?? "semver";
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let milestones: MilestoneSpec[];
  let continuousVersionMarker: string | undefined;
  let compatibilityClassifications: CompatibilityClassification[] | undefined;
  let reconciliation: ReconciliationManifest | undefined;
  let reconcileLive:
    | Awaited<ReturnType<typeof loadLiveState>>
    | undefined;

  if (releaseModel === "continuous") {
    milestones = buildContinuousGroups(roadmap, items);
    // Lock-free, content-addressed marker derived from the backlog SHA — no read-modify-write
    // counter, so concurrent runs need no serializing lock and produce a correct, deterministic
    // marker (#214). (The lock + stale-reclaim were removed: every recovery race lived there.)
    continuousVersionMarker = buildCalVerMarker(now, backlogSha);
    deps.log(`[roadmap] continuous model: ${milestones.length} theme group(s), marker=${continuousVersionMarker}`);
  } else {
    const latestTag = await deps.getLatestTag(repoDir);
    const blockedSet = new Set(depGraph.blocked_pending_decision);
    compatibilityClassifications = buildCompatibilityClassifications(roadmap, items);
    // Full recon applies the milestoned invariant to every open issue in scope,
    // including dependency-blocked issues (design Decision 2). Pack lanes without
    // excluding blocked issues so every resolved open issue is manifested.
    // Full recon requires every open issue in scope to be manifested. Include
    // dependency-blocked issues in lane packing so they receive a SemVer milestone
    // (design Decision 2). Unresolved classifications remain coverage blockers.
    milestones = buildSemverLanes(
      roadmap,
      latestTag,
      items,
      config.release_capacity,
      new Set(),
    );
    void blockedSet;
    deps.log(
      `[roadmap] semver model: ${milestones.length} lane(s) (latest tag: ${latestTag || "(none)"}); ` +
        `${compatibilityClassifications.filter((c) => c.status === "resolved").length} resolved / ` +
        `${compatibilityClassifications.filter((c) => c.status !== "resolved").length} unresolved impact`,
    );
    for (const c of compatibilityClassifications) {
      if (c.status === "unresolved_conflict") {
        openQuestions.push({
          description:
            `Issue #${c.issue_number} has conflicting explicit SemVer labels ` +
            `(${(c.conflict_labels ?? []).join(", ")}); applied impact unresolved — no automatic milestone assignment`,
          related_issues: [c.issue_number],
          rationale: "Resolve to exactly one of semver:major, semver:minor, or semver:patch",
        });
      } else if (c.status === "unresolved_missing") {
        const recNote =
          c.recommendation !== undefined
            ? ` Non-binding recommendation: ${c.recommendation.impact} (from ${c.recommendation.source}).`
            : "";
        openQuestions.push({
          description:
            `Issue #${c.issue_number} has no explicit semver:* compatibility-impact label; ` +
            `applied impact unresolved — no automatic milestone assignment.${recNote}`,
          related_issues: [c.issue_number],
          rationale: "Add exactly one of semver:major, semver:minor, or semver:patch",
        });
      }
    }

    // Full SemVer reconciliation manifest (#910)
    const tagList =
      deps.listSemverTags !== undefined
        ? await deps.listSemverTags(repoDir)
        : latestTag
          ? [latestTag]
          : [];
    const shipped = parseShippedSemverTitles(tagList);
    const scope = new Set(items.map((i) => i.issue.number));
    reconcileLive = await loadLiveState(repo, shipped, deps, scope);
    reconciliation = buildReconciliationManifest({
      milestones,
      classifications: compatibilityClassifications,
      openIssueNumbers: items.map((i) => i.issue.number),
      live: reconcileLive,
      generatedAt: now,
    });
    deps.log(
      `[roadmap] reconciliation: identity=${reconciliation.identity} ` +
        `fingerprint=${reconciliation.live_state_fingerprint} ` +
        `actions=${reconciliation.actions.length} blockers=${reconciliation.coverage_blockers.length}`,
    );
  }

  // Build final plan.json.
  const plan: PlanJson = {
    generated_at: now,
    backlog_sha: backlogSha,
    repo,
    dependency_graph: depGraph,
    scored,
    roadmap,
    hygiene,
    milestones,
    new_issue_drafts: [],
    critique: critiqueEntries,
    open_questions: openQuestions,
    ...(compatibilityClassifications !== undefined
      ? { compatibility_classifications: compatibilityClassifications }
      : {}),
    ...(reconciliation !== undefined ? { reconciliation } : {}),
    ...(continuousVersionMarker !== undefined ? { continuous_version_marker: continuousVersionMarker } : {}),
    run_stats: runStats,
  };

  // Ensure output dir exists, then write outputs. Writes are atomic (temp + rename in the real
  // deps), so concurrent runs can't corrupt or partially clobber a shared plan.json.
  await deps.writeFile(path.join(outputDir, ".gitkeep"), "");
  await writePlanJson(plan, outputDir, deps);
  await writeRoadmapMd(plan, outputDir, deps);

  if (plan.compatibility_classifications && plan.compatibility_classifications.length > 0) {
    deps.log(`\n[roadmap] compatibility classifications:`);
    for (const c of plan.compatibility_classifications) {
      deps.log(`  ${formatClassificationLine(c)}`);
    }
  }

  if (opts.dryRun || !opts.apply) {
    deps.log(`\n[roadmap] dry-run: top 10 roadmap items:`);
    for (const entry of plan.roadmap.slice(0, 10)) {
      deps.log(`  ${entry.rank}. #${entry.issue_number} — ${entry.title} (${entry.tier})`);
    }
    if (plan.hygiene.length > 0) {
      deps.log(`\n[roadmap] dry-run: ${plan.hygiene.length} hygiene actions (not applied):`);
      for (const h of plan.hygiene) {
        deps.log(`  - #${h.issue_number}: ${h.action}`);
      }
    }
    if (releaseModel === "continuous") {
      if (plan.milestones.length > 0) {
        deps.log(`\n[roadmap] dry-run: ${plan.milestones.length} milestone(s) (not applied):`);
        for (const m of plan.milestones) {
          deps.log(
            `  - "${m.title}" (version_impact=${m.version_impact ?? "n/a"}): ${m.issue_numbers.join(", ")}`,
          );
        }
      }
    } else if (plan.reconciliation) {
      // Persist the exact reviewed preview artifact for --apply (finding c33d6a3c).
      await saveReviewedManifest(outputDir, plan.reconciliation, deps);
      logReconciliationPreview(plan.reconciliation, deps);
      deps.log(
        `[roadmap] reviewed reconciliation manifest saved for --apply ` +
          `(identity=${plan.reconciliation.identity})`,
      );
    }
    deps.log(`\n[roadmap] dry-run complete. Run with --apply to execute GitHub write-backs.`);
    return;
  }

  deps.log(`\n[roadmap] apply: executing GitHub write-backs...`);

  if (releaseModel === "continuous") {
    await applyHygiene(plan.hygiene, repo, { apply: true }, deps);
    // Continuous keeps title-idempotent create/reuse/assign only (#910 non-goal).
    await applyMilestones(plan.milestones, repo, true, deps);
  } else {
    // SemVer: load the exact reviewed preview manifest; never apply a freshly
    // regenerated action list (finding c33d6a3c).
    const reviewed = await loadReviewedManifest(outputDir, deps);
    if (!reviewed) {
      const msg =
        "No reviewed reconciliation manifest found; run a dry-run preview first " +
        "so --apply can execute the exact reviewed artifact";
      deps.log(`[roadmap] SemVer reconciliation apply refused: ${msg}`);
      throw new Error(`SemVer reconciliation apply refused: ${msg}`);
    }
    const expectedIdentity =
      opts.expectedReconciliationIdentity ?? reviewed.identity;
    if (plan.reconciliation && plan.reconciliation.identity !== reviewed.identity) {
      const msg =
        `Plan identity ${plan.reconciliation.identity} differs from reviewed preview ` +
        `${reviewed.identity}; run a new dry-run preview before apply`;
      deps.log(`[roadmap] SemVer reconciliation apply refused: ${msg}`);
      throw new Error(`SemVer reconciliation apply refused: ${msg}`);
    }

    // Refresh live state before any write-back; gate fingerprint/coverage first
    // so hygiene cannot mutate on a stale or blocked reconciliation (8420b97a).
    const scope = new Set(items.map((i) => i.issue.number));
    const tagList =
      deps.listSemverTags !== undefined
        ? await deps.listSemverTags(repoDir)
        : (await deps.getLatestTag(repoDir))
          ? [await deps.getLatestTag(repoDir)]
          : [];
    const freshLive = await loadLiveState(
      repo,
      parseShippedSemverTitles(tagList),
      deps,
      scope,
    );
    const existingProgress = await loadProgress(outputDir, deps);
    const gate = validateSemverApplyReady(reviewed, freshLive, {
      expectedIdentity,
      resumeProgress: existingProgress,
    });
    if (!gate.ok) {
      deps.log(`[roadmap] SemVer reconciliation apply refused: ${gate.reason}`);
      throw new Error(`SemVer reconciliation apply refused: ${gate.reason}`);
    }

    await applyHygiene(plan.hygiene, repo, { apply: true }, deps);

    const result = await applySemverReconciliation(
      reviewed,
      repo,
      outputDir,
      deps,
      {
        live: freshLive,
        expectedIdentity,
        gatesAlreadyChecked: true,
      },
    );
    if (!result.ok) {
      deps.log(`[roadmap] SemVer reconciliation apply refused: ${result.reason}`);
      throw new Error(`SemVer reconciliation apply refused: ${result.reason}`);
    }
  }

  if (config.pr_docs !== false) {
    await openRoadmapPr(plan, repoDir, baseBranch, deps);
  }

  deps.log(`[roadmap] done — plan.json + roadmap.md written to ${outputDir}`);
}
