// Backlog roadmap engine orchestrator (#171).
// Runs 7 phases: comprehend → inventory → depgraph → score → roadmap → hygiene → critique.
// All I/O is injectable via RoadmapDeps; production wiring lives in pipeline.ts.

import * as path from "node:path";
import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import { partitionFindings } from "../review-policy.ts";
import type { ReviewFinding } from "../types.ts";
import type {
  PlanJson,
  DepEdge,
  HygieneItem,
  CritiqueEntry,
  OpenQuestion,
  RoadmapConfig,
  InventoryItem,
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
} from "./writeback.ts";
import type { WritebackDeps } from "./writeback.ts";

export interface RoadmapOpts {
  apply: boolean;
  next?: number;
  dryRun?: boolean;
  outputDir?: string;
}

export interface RoadmapDeps extends InventoryDeps, DepgraphDeps, WritebackDeps {}

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
 */
function buildCritiquePrompt(planJsonExcerpt: string): string {
  return (
    `You are adversarially reviewing a backlog roadmap plan for correctness and consistency.\n\n` +
    `## Plan excerpt\n\n\`\`\`json\n${planJsonExcerpt}\n\`\`\`\n\n` +
    `Attack the plan for:\n` +
    `1. Dependency-order violations (a dependent appears before its prerequisite in the roadmap)\n` +
    `2. Non-reproducible scores (scores that seem inconsistent with the described formula)\n` +
    `3. Missed duplicates (same work described twice with different issue numbers)\n` +
    `4. Mislabeled "ready" issues (issues that aren't actually actionable)\n\n` +
    `Return findings using this exact JSON schema:\n\`\`\`json\n${REVIEW_VERDICT_SCHEMA_BLOCK}\n\`\`\`\n\n` +
    `For dep-order violations, set category to "dep-order-violation".\n` +
    `Use severity "high" for dep-order violations, "medium" for score issues, "low" for style findings.\n` +
    `Return raw fenced JSON only.`
  );
}

/**
 * Generate basic hygiene proposals from the inventory.
 */
function generateHygiene(items: InventoryItem[]): HygieneItem[] {
  const hygiene: HygieneItem[] = [];

  for (const item of items) {
    const body = item.issue.body ?? "";
    const title = item.issue.title ?? "";

    if (body.trim().length < 100 && !body.includes("- [ ]")) {
      hygiene.push({
        issue_number: item.issue.number,
        action: "rewrite-title",
        comment_text:
          `## Roadmap: Issue needs more detail\n\n` +
          `This issue has a very short description and no acceptance criteria. ` +
          `Consider expanding with: Summary, User story, Acceptance criteria (- [ ] checkboxes), Out of scope.\n\n` +
          `*Automated by \`pipeline roadmap\`*`,
        evidence: `body length ${body.trim().length} chars, no acceptance criteria`,
      });
    }

    if (/spike|investigate|research|explore/.test(title.toLowerCase())) {
      hygiene.push({
        issue_number: item.issue.number,
        action: "spike",
        comment_text:
          `## Roadmap: This looks like a spike/research item\n\n` +
          `Consider time-boxing this to a fixed investigation period and creating a follow-up issue with findings.\n\n` +
          `*Automated by \`pipeline roadmap\`*`,
        evidence: "title contains research/spike keywords",
      });
    }
  }

  return hygiene;
}

/**
 * Resolve the output directory for plan.json and roadmap.md.
 */
function resolveOutputDir(repoDir: string, repo: string, optsOutputDir?: string): string {
  if (optsOutputDir) return optsOutputDir;
  const repoSlug = repo.replace("/", "_");
  return path.join(repoDir, ".agent-pipeline", "roadmap", repoSlug);
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

  // --next path: read plan.json without re-running the engine
  if (opts.next !== undefined && opts.next > 0) {
    await runNext(opts.next, outputDir, deps);
    return;
  }

  // Phase 1: Comprehend
  deps.log("[roadmap] phase 1: comprehend...");
  try {
    const allIssuesForCount = await deps.getOpenIssues(repo);
    const prompt = buildComprehendPrompt(repo, allIssuesForCount.length);
    await deps.runHarness(prompt);
    deps.log("[roadmap] phase 1: comprehension complete");
  } catch (err) {
    deps.log(`[roadmap] phase 1: comprehension warning: ${(err as Error).message}`);
  }

  // Phase 2: Inventory
  const items = await buildInventory(repo, config, deps);
  const backlogSha = computeBacklogSha(items.map((i) => i.issue));

  // Phase 3: Dependency graph
  let depGraph = await buildDepgraph(items, deps);

  // Phase 4: Score
  deps.log("[roadmap] phase 4: scoring...");
  const scored = scoreItems(items, depGraph, config.score_weights);

  // Phase 5: Roadmap tiers
  deps.log("[roadmap] phase 5: producing tiered roadmap...");
  let roadmap = applyDepAdjustment(scored, items, depGraph);

  // Phase 6: Hygiene
  deps.log("[roadmap] phase 6: hygiene analysis...");
  const hygiene = generateHygiene(items);

  // Phase 7: Adversarial critique (up to 2 correction rounds)
  deps.log("[roadmap] phase 7: adversarial critique...");

  const openQuestions: OpenQuestion[] = [...depGraph.open_questions];
  const critiqueEntries: CritiqueEntry[] = [];
  const MAX_CORRECTION_ROUNDS = 2;
  let correctionRound = 0;

  while (correctionRound < MAX_CORRECTION_ROUNDS) {
    const planExcerpt = JSON.stringify(
      {
        roadmap: roadmap.slice(0, 20).map((r) => ({
          rank: r.rank,
          issue_number: r.issue_number,
          tier: r.tier,
          priority: r.priority,
          blocked_by: r.blocked_by,
        })),
        dependency_graph: {
          must_precede: depGraph.must_precede,
          cycle_reports: depGraph.cycle_reports,
        },
      },
      null,
      2,
    );

    const critiqueResult = await deps.runHarness(buildCritiquePrompt(planExcerpt));

    if (!critiqueResult.success) {
      deps.log("[roadmap] phase 7: critique harness failed — skipping correction round");
      break;
    }

    const verdict = parseCritiqueVerdict(critiqueResult.output);
    if (!verdict || verdict.findings.length === 0) {
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

    const newEdges: DepEdge[] = [];
    for (const f of depViolations) {
      const nums = [...(f.title + " " + f.body).matchAll(/#(\d+)/g)].map(
        (m) => Number.parseInt(m[1], 10),
      );
      if (nums.length >= 2) {
        newEdges.push({
          from: nums[0],
          to: nums[1],
          file_line: f.file ? `${f.file}:${f.line_start ?? 0}` : "",
          rationale: `critique correction: ${f.body.slice(0, 100)}`,
        });
      }
    }

    if (newEdges.length > 0) {
      const allIssueNums = items.map((i) => i.issue.number);
      depGraph = addMustPrecedeEdges(depGraph, newEdges, allIssueNums);
      roadmap = sortRoadmapByTier(applyDepAdjustment(scored, items, depGraph));
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

  // Build final plan.json
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const plan: PlanJson = {
    generated_at: now,
    backlog_sha: backlogSha,
    repo,
    dependency_graph: depGraph,
    scored,
    roadmap,
    hygiene,
    milestones: [],
    new_issue_drafts: [],
    critique: critiqueEntries,
    open_questions: openQuestions,
  };

  // Ensure output dir exists, then write outputs
  await deps.writeFile(path.join(outputDir, ".gitkeep"), "");
  await writePlanJson(plan, outputDir, deps);
  await writeRoadmapMd(plan, outputDir, deps);

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
    deps.log(`\n[roadmap] dry-run complete. Run with --apply to execute GitHub write-backs.`);
    return;
  }

  await applyHygiene(plan.hygiene, repo, { apply: true }, deps);

  if (config.pr_docs !== false) {
    await openRoadmapPr(plan, repoDir, baseBranch, deps);
  }

  deps.log(`[roadmap] done — plan.json + roadmap.md written to ${outputDir}`);
}
