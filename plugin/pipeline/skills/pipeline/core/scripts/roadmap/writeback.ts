// Phase 6 (hygiene write-back) + output writers: plan.json, roadmap.md, PR.
// All external I/O is injectable via WritebackDeps for unit testing.

import * as crypto from "node:crypto";
import type {
  PlanJson,
  HygieneItem,
  MilestoneSpec,
  RoadmapEntry,
  Tier,
  EffortSize,
  CrossRepoDep,
} from "./types.ts";

export interface WritebackDeps {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  gitCreateBranch(repoDir: string, branch: string, fromRef?: string): Promise<void>;
  gitSwitchBranch(repoDir: string, branch: string): Promise<void>;
  gitBranchExists(repoDir: string, branch: string): Promise<boolean>;
  gitCommit(repoDir: string, files: string[], message: string): Promise<void>;
  gitPushBranch(repoDir: string, branch: string): Promise<void>;
  findPrByHead(repo: string, head: string): Promise<string | null>;
  createPr(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  createLabel(repo: string, name: string, color: string): Promise<void>;
  applyLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  createMilestone(repo: string, title: string, dueOn?: string): Promise<number>;
  getMilestones(repo: string): Promise<Array<{ id: number; number: number; title: string }>>;
  assignIssueMilestone(repo: string, issueNumber: number, milestoneTitle: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  addComment(repo: string, issueNumber: number, body: string): Promise<void>;
  editIssue(repo: string, issueNumber: number, opts: { title?: string; body?: string }): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number>;
  getIssueState(repo: string, issueNumber: number): Promise<"open" | "closed" | null>;
  getIssueComments(repo: string, issueNumber: number): Promise<{ body: string }[]>;
  log(msg: string): void;
}

/**
 * Compute a content-addressed hash for a hygiene action (for idempotency sentinel).
 */
export function hygieneActionHash(item: HygieneItem): string {
  const payload = `${item.issue_number}:${item.action}:${item.comment_text}`;
  return crypto.createHash("sha1").update(payload).digest("hex").slice(0, 12);
}

/**
 * The sentinel comment marker for a hygiene action.
 */
export function hygieneSentinel(hash: string): string {
  return `<!-- roadmap-run:${hash} -->`;
}

/**
 * Write plan.json to the output directory.
 */
export async function writePlanJson(
  plan: PlanJson,
  outputDir: string,
  deps: WritebackDeps,
): Promise<void> {
  const outPath = `${outputDir}/plan.json`;
  await deps.writeFile(outPath, JSON.stringify(plan, null, 2) + "\n");
  deps.log(`[roadmap] wrote ${outPath}`);
}

/**
 * Render the roadmap.md human living-doc with stable IDs (RM-<number>).
 */
export function renderRoadmapMd(plan: PlanJson): string {
  const lines: string[] = [
    `# Backlog Roadmap — ${plan.repo}`,
    "",
    `> Generated: ${plan.generated_at}  |  Backlog SHA: \`${plan.backlog_sha}\``,
    "",
    "## Tier Summary",
    "",
  ];

  const tierOrder: Tier[] = ["enablers", "dependency-unlock", "high-value/low-risk", "larger-bets", "cleanup"];
  const byTier = new Map<Tier, RoadmapEntry[]>();
  for (const t of tierOrder) byTier.set(t, []);
  for (const entry of plan.roadmap) {
    byTier.get(entry.tier)?.push(entry);
  }

  for (const tier of tierOrder) {
    const entries = byTier.get(tier) ?? [];
    if (entries.length === 0) continue;

    lines.push(`### ${tier}`);
    lines.push("");

    for (const entry of entries) {
      const id = `RM-${entry.issue_number}`;
      const blocked = entry.blocked_by.length > 0
        ? ` _(blocked by ${entry.blocked_by.map((n) => `#${n}`).join(", ")})_`
        : "";
      lines.push(`- **${id}** #${entry.issue_number} — ${entry.title}${blocked}`);
      lines.push(`  - **Score:** ${entry.priority.toFixed(1)} (I:${entry.score_breakdown.impact} C:${entry.score_breakdown.confidence} E:${entry.score_breakdown.ease} R:${entry.score_breakdown.risk_reduction} D:${entry.score_breakdown.dep_leverage})`);
      lines.push(`  - **Effort:** ${entry.effort} | **Deps:** ${entry.dep_rationale}`);
      if (entry.risks.length > 0) {
        lines.push(`  - **Risks:** ${entry.risks.join("; ")}`);
      }
    }
    lines.push("");
  }

  // DONE tracker section
  lines.push("---");
  lines.push("");
  lines.push("## DONE tracker");
  lines.push("");
  lines.push("_Issues completed since last roadmap run. Update manually or re-run `pipeline roadmap` to refresh._");
  lines.push("");
  lines.push("| Issue | Title | Completed |");
  lines.push("|-------|-------|-----------|");
  lines.push("| _(none yet)_ | — | — |");
  lines.push("");

  // Hygiene proposals
  if (plan.hygiene.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Hygiene Proposals");
    lines.push("");
    lines.push("_Proposed changes to backlog health. Apply with `pipeline roadmap --apply`._");
    lines.push("");
    for (const h of plan.hygiene) {
      lines.push(`- **#${h.issue_number}** — Action: \`${h.action}\` | Evidence: ${h.evidence}`);
    }
    lines.push("");
  }

  // Cross-repo dependencies (populated when repo_map is configured)
  const crossRepo: CrossRepoDep[] = plan.dependency_graph.cross_repo ?? [];
  if (crossRepo.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Cross-Repo Dependencies");
    lines.push("");
    lines.push("_Declared inter-repo relationships for human sequencing. These are annotations only — the roadmap ordering above covers this repo's local backlog exclusively._");
    lines.push("");
    for (const dep of crossRepo) {
      lines.push(`- **#${dep.local_issue}** → \`${dep.repo}\` (${dep.direction}): ${dep.rationale}`);
    }
    lines.push("");
  }

  // Open questions
  if (plan.open_questions.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Open Questions");
    lines.push("");
    for (const q of plan.open_questions) {
      const related = q.related_issues.map((n) => `#${n}`).join(", ");
      lines.push(`- ${q.description}${related ? ` (${related})` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write roadmap.md to the output directory.
 */
export async function writeRoadmapMd(
  plan: PlanJson,
  outputDir: string,
  deps: WritebackDeps,
): Promise<void> {
  const md = renderRoadmapMd(plan);
  const outPath = `${outputDir}/roadmap.md`;
  await deps.writeFile(outPath, md);
  deps.log(`[roadmap] wrote ${outPath}`);
}

/**
 * Open a PR with the roadmap.md committed to docs/roadmaps/<repo>.md.
 * Skipped when config.pr_docs === false.
 */
export async function openRoadmapPr(
  plan: PlanJson,
  repoDir: string,
  baseBranch: string,
  deps: WritebackDeps,
): Promise<string | null> {
  const md = renderRoadmapMd(plan);
  const repoSlug = plan.repo.split("/").pop() ?? plan.repo;
  const branch = `roadmap/${repoSlug}-${plan.generated_at.slice(0, 10)}`;
  const docsPath = `${repoDir}/docs/roadmaps/${repoSlug}.md`;
  const relPath = `docs/roadmaps/${repoSlug}.md`;

  // Idempotency: if a PR already exists for this branch, return its URL without re-creating
  const existingPr = await deps.findPrByHead(plan.repo, branch);
  if (existingPr) {
    deps.log(`[roadmap] roadmap PR already exists for branch ${branch}: ${existingPr}`);
    return existingPr;
  }

  // Check if docs content is unchanged compared to what we'd write — no-op if identical
  const existingContent = await deps.readFile(docsPath);
  if (existingContent === md) {
    deps.log(`[roadmap] roadmap docs unchanged — skipping PR creation`);
    return null;
  }

  deps.log(`[roadmap] opening roadmap PR on branch ${branch}...`);
  const branchExists = await deps.gitBranchExists(repoDir, branch);
  if (!branchExists) {
    // Create branch from the configured base so the PR targets the right history
    await deps.gitCreateBranch(repoDir, branch, baseBranch);
  } else {
    // Always switch to the roadmap branch before writing — prevents committing to the
    // invoking branch (e.g., main) when the roadmap branch already exists locally.
    await deps.gitSwitchBranch(repoDir, branch);
  }
  await deps.writeFile(docsPath, md);
  const commitMsg = `docs: roadmap for ${plan.repo} (generated ${plan.generated_at.slice(0, 10)})\n\nIssue: #171\nPipeline-Run: 171/2026-06-17T04:37:16Z`;
  await deps.gitCommit(repoDir, [relPath], commitMsg);
  await deps.gitPushBranch(repoDir, branch);

  const prTitle = `docs: backlog roadmap for ${repoSlug} (${plan.generated_at.slice(0, 10)})`;
  const prBody = [
    `## Backlog Roadmap — ${plan.repo}`,
    "",
    `Generated by \`pipeline roadmap\` on ${plan.generated_at.slice(0, 10)}.`,
    "",
    `**Backlog SHA:** \`${plan.backlog_sha}\``,
    "",
    `This PR updates \`${relPath}\` with the current dependency-aware, scored roadmap.`,
    "",
    "_The pipeline never merges — a human owns this button._",
  ].join("\n");

  const prUrl = await deps.createPr(repoDir, prTitle, prBody, baseBranch, branch);
  deps.log(`[roadmap] roadmap PR opened: ${prUrl}`);
  return prUrl;
}

/**
 * Create GitHub milestones from plan.milestones[] and assign issues.
 * Idempotent: reuses existing milestones with the same title rather than
 * creating duplicates. Skipped when apply is false (dry-run).
 */
export async function applyMilestones(
  milestones: MilestoneSpec[],
  repo: string,
  apply: boolean,
  deps: WritebackDeps,
): Promise<void> {
  if (!apply) {
    deps.log(`[roadmap] dry-run: ${milestones.length} milestone(s) would be created/assigned`);
    for (const m of milestones) {
      deps.log(`[roadmap] dry-run: milestone "${m.title}" — issues: ${m.issue_numbers.join(", ")}`);
    }
    return;
  }

  const existing = await deps.getMilestones(repo);
  const byTitle = new Map(existing.map((m) => [m.title, m.number]));

  for (const spec of milestones) {
    let milestoneNumber = byTitle.get(spec.title);
    if (milestoneNumber === undefined) {
      const newNumber = await deps.createMilestone(repo, spec.title);
      milestoneNumber = newNumber;
      byTitle.set(spec.title, newNumber);
      deps.log(`[roadmap] created milestone "${spec.title}" (#${milestoneNumber})`);
    } else {
      deps.log(`[roadmap] reusing existing milestone "${spec.title}" (#${milestoneNumber})`);
    }
    for (const issueNumber of spec.issue_numbers) {
      await deps.assignIssueMilestone(repo, issueNumber, spec.title);
      deps.log(`[roadmap] assigned #${issueNumber} to milestone "${spec.title}"`);
    }
  }
}

/**
 * Apply hygiene actions (close/comment/edit/create) with idempotency sentinel.
 * Skipped when opts.apply is false (dry-run).
 */
export async function applyHygiene(
  hygiene: HygieneItem[],
  repo: string,
  opts: { apply: boolean },
  deps: WritebackDeps,
): Promise<void> {
  if (!opts.apply) {
    deps.log(`[roadmap] dry-run: ${hygiene.length} hygiene actions would be applied`);
    for (const h of hygiene) {
      deps.log(`[roadmap] dry-run: #${h.issue_number} — ${h.action}: ${h.comment_text.slice(0, 80)}`);
    }
    return;
  }

  for (const h of hygiene) {
    const hash = hygieneActionHash(h);
    const sentinel = hygieneSentinel(hash);

    if (h.action === "close") {
      const state = await deps.getIssueState(repo, h.issue_number);
      if (state === "closed") {
        deps.log(`[roadmap] hygiene: #${h.issue_number} already closed — skipping`);
        continue;
      }
      // Check if sentinel already posted
      const comments = await deps.getIssueComments(repo, h.issue_number);
      if (comments.some((c) => c.body.includes(sentinel))) {
        deps.log(`[roadmap] hygiene: #${h.issue_number} sentinel already present — skipping`);
        continue;
      }
      await deps.addComment(repo, h.issue_number, `${h.comment_text}\n\n${sentinel}`);
      await deps.closeIssue(repo, h.issue_number);
      deps.log(`[roadmap] hygiene: closed #${h.issue_number}`);
    } else if (h.action === "rewrite-title") {
      const comments = await deps.getIssueComments(repo, h.issue_number);
      if (comments.some((c) => c.body.includes(sentinel))) {
        deps.log(`[roadmap] hygiene: #${h.issue_number} sentinel already present — skipping`);
        continue;
      }
      await deps.addComment(repo, h.issue_number, `${h.comment_text}\n\n${sentinel}`);
      deps.log(`[roadmap] hygiene: rewrite-title comment added to #${h.issue_number}`);
    } else {
      // merge-duplicate, split, spike, postpone — post a comment
      const comments = await deps.getIssueComments(repo, h.issue_number);
      if (comments.some((c) => c.body.includes(sentinel))) {
        deps.log(`[roadmap] hygiene: #${h.issue_number} sentinel already present — skipping`);
        continue;
      }
      await deps.addComment(repo, h.issue_number, `${h.comment_text}\n\n${sentinel}`);
      deps.log(`[roadmap] hygiene: ${h.action} comment added to #${h.issue_number}`);
    }
  }
}
