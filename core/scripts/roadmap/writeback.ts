// Phase 6 (hygiene write-back) + output writers: plan.json, roadmap.md, PR.
// All external I/O is injectable via WritebackDeps for unit testing.

import * as crypto from "node:crypto";
import { withTrailers } from "../traceability.ts";
import type {
  PlanJson,
  HygieneItem,
  MilestoneSpec,
  RoadmapEntry,
  Tier,
  EffortSize,
  CrossRepoDep,
  CompatibilityClassification,
  MilestoneCatalogEntry,
  IssueMilestoneSnapshot,
  ReconciliationManifest,
} from "./types.ts";

/**
 * Optional issue/run context for honest commit trailers on roadmap docs commits.
 * Both fields must be present to append trailers; partial context omits both
 * (never invent fossils). Normal `pipeline roadmap` has neither.
 */
export interface RoadmapPrTraceContext {
  issueNumber?: number;
  pipelineRunId?: string;
}

export interface WritebackDeps {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  /**
   * Run `fn` inside a throwaway linked worktree of `branch` (created from
   * `baseRef` when the branch is missing). Always attempts removal after `fn`
   * settles. Used by roadmap docs PR writeback so the operator `repoDir`
   * checkout is never branch-switched or committed into (#632).
   */
  withThrowawayWorktree<T>(
    repoDir: string,
    branch: string,
    baseRef: string,
    fn: (worktreeDir: string) => Promise<T>,
  ): Promise<T>;
  gitCommit(repoDir: string, files: string[], message: string): Promise<void>;
  gitPushBranch(repoDir: string, branch: string): Promise<void>;
  findPrByHead(repo: string, head: string): Promise<string | null>;
  createPr(repoDir: string, title: string, body: string, base: string, head: string): Promise<string>;
  createLabel(repo: string, name: string, color: string): Promise<void>;
  applyLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  createMilestone(repo: string, title: string, description?: string, dueOn?: string): Promise<number>;
  getMilestones(repo: string): Promise<Array<{ id: number; number: number; title: string }>>;
  /**
   * Full milestone catalog for SemVer reconciliation (state, description, issue counts).
   * Continuous apply may leave this as a thin wrapper around getMilestones.
   */
  listMilestonesDetailed(repo: string): Promise<MilestoneCatalogEntry[]>;
  /** Open issues with current milestone assignment for fingerprint + stale detection. */
  listOpenIssueMilestoneSnapshots(repo: string): Promise<IssueMilestoneSnapshot[]>;
  reopenMilestone(repo: string, milestoneNumber: number): Promise<void>;
  updateMilestone(
    repo: string,
    milestoneNumber: number,
    opts: { title?: string; description?: string },
  ): Promise<void>;
  assignIssueMilestone(repo: string, issueNumber: number, milestoneTitle: string): Promise<void>;
  clearIssueMilestone(repo: string, issueNumber: number): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  addComment(repo: string, issueNumber: number, body: string): Promise<void>;
  editIssue(repo: string, issueNumber: number, opts: { title?: string; body?: string }): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<number>;
  getIssueState(repo: string, issueNumber: number): Promise<"open" | "closed" | null>;
  getIssueComments(repo: string, issueNumber: number): Promise<{ body: string }[]>;
  log(msg: string): void;
}

/**
 * Build the roadmap docs commit message. Never hardcodes fossil #171 trailers.
 * Appends Issue / Pipeline-Run trailers only when both are supplied.
 */
export function buildRoadmapCommitMessage(
  plan: PlanJson,
  trace?: RoadmapPrTraceContext,
): string {
  const subject = `docs: roadmap for ${plan.repo} (generated ${plan.generated_at.slice(0, 10)})`;
  if (
    trace?.issueNumber !== undefined &&
    Number.isFinite(trace.issueNumber) &&
    trace.issueNumber > 0 &&
    typeof trace.pipelineRunId === "string" &&
    trace.pipelineRunId.length > 0
  ) {
    return withTrailers(subject, trace.issueNumber, trace.pipelineRunId);
  }
  return subject;
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

  // Release milestones (semver or continuous groupings)
  if (plan.milestones.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Release milestones");
    lines.push("");
    for (const m of plan.milestones) {
      const impact =
        m.version_impact !== undefined ? ` · impact: \`${m.version_impact}\`` : "";
      lines.push(`### ${m.title}${impact}`);
      lines.push("");
      lines.push(`- **Issues:** ${m.issue_numbers.map((n) => `#${n}`).join(", ")}`);
      lines.push(`- **Rationale:** ${m.rationale}`);
      if (m.uncertainty) {
        lines.push(`- **Note:** ${m.uncertainty}`);
      }
      lines.push("");
    }
  }

  // SemVer full reconciliation summary (#910)
  if (plan.reconciliation) {
    const r = plan.reconciliation;
    lines.push("---");
    lines.push("");
    lines.push("## SemVer milestone reconciliation");
    lines.push("");
    lines.push(
      `_Identity: \`${r.identity}\` · Fingerprint: \`${r.live_state_fingerprint}\` · ` +
        `Actions: ${r.actions.length} · Coverage blockers: ${r.coverage_blockers.length}_`,
    );
    lines.push("");
    lines.push(
      "Dry-run lists every planned create/reuse/reopen/rename/description/assign/clear-stale action. " +
        "`--apply` executes only this reviewed manifest when the live-state fingerprint still matches. " +
        "Theme/epic labels are secondary metadata and never satisfy the release-milestone invariant.",
    );
    lines.push("");
    if (r.coverage_blockers.length > 0) {
      lines.push("### Coverage blockers");
      lines.push("");
      for (const b of r.coverage_blockers) {
        const issue = b.issue_number !== undefined ? `#${b.issue_number} ` : "";
        lines.push(`- ${issue}**${b.reason}**: ${b.detail}`);
      }
      lines.push("");
    }
    if (r.actions.length > 0) {
      lines.push("### Planned actions");
      lines.push("");
      for (const a of r.actions) {
        lines.push(`- \`${a.kind}\` ${a.detail ?? a.id}`);
      }
      lines.push("");
    }
  }

  // Per-issue SemVer compatibility classification (semver model only)
  const classifications: CompatibilityClassification[] =
    plan.compatibility_classifications ?? [];
  if (classifications.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Compatibility impact");
    lines.push("");
    lines.push(
      "_Applied impact comes only from exclusive `semver:major` / `semver:minor` / `semver:patch` labels. " +
        "Title and body text do not set the class. Unresolved issues are not auto-assigned to SemVer milestones._",
    );
    lines.push("");
    lines.push("| Issue | Status | Applied | Source | Uncertainty | Recommendation |");
    lines.push("|-------|--------|---------|--------|-------------|----------------|");
    for (const c of classifications) {
      const applied = c.applied_impact ?? "—";
      const source = c.source_label ?? "—";
      const uncertainty =
        c.status === "unresolved_conflict"
          ? `conflict: ${(c.conflict_labels ?? []).join(", ")}`
          : c.status === "unresolved_missing"
            ? "missing explicit semver:* label"
            : "—";
      const recommendation =
        c.recommendation !== undefined
          ? `${c.recommendation.impact} (from \`${c.recommendation.source}\`, non-applied)`
          : "—";
      lines.push(
        `| #${c.issue_number} | \`${c.status}\` | \`${applied}\` | \`${source}\` | ${uncertainty} | ${recommendation} |`,
      );
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
 * Open or refresh a PR with roadmap.md committed to docs/roadmaps/<repo>.md.
 *
 * All branch create/checkout, file write, commit, and push run inside a
 * throwaway linked worktree — the operator `repoDir` checkout is never
 * switched or committed into (#632). When a day-keyed PR already exists,
 * content is compared against the branch head (via the worktree) and refreshed
 * when it differs; identical content is a no-op that still returns the PR URL.
 *
 * Commit trailers: only when both issue number and pipeline run id are supplied
 * via `trace`. Never hardcodes fossil #171 values.
 */
export async function openRoadmapPr(
  plan: PlanJson,
  repoDir: string,
  baseBranch: string,
  deps: WritebackDeps,
  trace?: RoadmapPrTraceContext,
): Promise<string | null> {
  const md = renderRoadmapMd(plan);
  const repoSlug = plan.repo.split("/").pop() ?? plan.repo;
  const branch = `roadmap/${repoSlug}-${plan.generated_at.slice(0, 10)}`;
  const relPath = `docs/roadmaps/${repoSlug}.md`;

  const existingPr = await deps.findPrByHead(plan.repo, branch);

  return deps.withThrowawayWorktree(repoDir, branch, baseBranch, async (worktreeDir) => {
    // Compare against branch-head content in the throwaway worktree — never the
    // operator working tree alone (which may be dirty or on a different branch).
    const docsPath = `${worktreeDir}/${relPath}`;
    const existingContent = await deps.readFile(docsPath);

    if (existingContent === md) {
      if (existingPr) {
        deps.log(`[roadmap] roadmap docs unchanged on branch ${branch} — keeping existing PR: ${existingPr}`);
        return existingPr;
      }
      deps.log(`[roadmap] roadmap docs unchanged — skipping PR creation`);
      return null;
    }

    deps.log(
      existingPr
        ? `[roadmap] refreshing roadmap docs on branch ${branch} (existing PR: ${existingPr})...`
        : `[roadmap] opening roadmap PR on branch ${branch}...`,
    );

    await deps.writeFile(docsPath, md);
    const commitMsg = buildRoadmapCommitMessage(plan, trace);
    // Commit/push must use the throwaway worktree path, not operator repoDir.
    await deps.gitCommit(worktreeDir, [relPath], commitMsg);
    await deps.gitPushBranch(worktreeDir, branch);

    if (existingPr) {
      deps.log(`[roadmap] roadmap PR updated: ${existingPr}`);
      return existingPr;
    }

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
      "_The advance path never merges. Integration requires an operator-authorized merge surface._",
    ].join("\n");

    // createPr cwd can be either path; head branch is already pushed. Prefer
    // worktree for consistency with isolation invariants.
    const prUrl = await deps.createPr(worktreeDir, prTitle, prBody, baseBranch, branch);
    deps.log(`[roadmap] roadmap PR opened: ${prUrl}`);
    return prUrl;
  });
}

/**
 * Create GitHub milestones from plan.milestones[] and assign issues.
 * Continuous / legacy title-idempotent path only.
 * SemVer full reconciliation uses `applySemverReconciliation` in reconcile.ts (#910).
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
      const impact =
        m.version_impact !== undefined ? ` version_impact=${m.version_impact}` : "";
      deps.log(
        `[roadmap] dry-run: milestone "${m.title}"${impact} — issues: ${m.issue_numbers.join(", ")}`,
      );
    }
    return;
  }

  const existing = await deps.getMilestones(repo);
  const byTitle = new Map(existing.map((m) => [m.title, m.number]));

  for (const spec of milestones) {
    let milestoneNumber = byTitle.get(spec.title);
    if (milestoneNumber === undefined) {
      const newNumber = await deps.createMilestone(repo, spec.title, spec.rationale);
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
 * Log every planned SemVer reconciliation action and coverage blocker (dry-run).
 * Does not mutate GitHub.
 */
export function logReconciliationPreview(
  manifest: ReconciliationManifest,
  deps: Pick<WritebackDeps, "log">,
): void {
  deps.log(
    `\n[roadmap] SemVer reconciliation preview (identity=${manifest.identity} fingerprint=${manifest.live_state_fingerprint}):`,
  );
  if (manifest.coverage_blockers.length > 0) {
    deps.log(
      `[roadmap] coverage blockers (${manifest.coverage_blockers.length}) — apply will refuse until resolved:`,
    );
    for (const b of manifest.coverage_blockers) {
      const issue = b.issue_number !== undefined ? `#${b.issue_number} ` : "";
      deps.log(`  - ${issue}[${b.reason}] ${b.detail}`);
    }
  }
  if (manifest.actions.length === 0) {
    deps.log(`[roadmap] no reconciliation mutations required (converged or blocked only)`);
  } else {
    deps.log(`[roadmap] planned actions (${manifest.actions.length}):`);
    for (const a of manifest.actions) {
      deps.log(`  - [${a.kind}] ${a.id}${a.detail ? ` — ${a.detail}` : ""}`);
    }
  }
  deps.log(
    `[roadmap] theme/epic labels are secondary metadata only; they never satisfy the release-milestone invariant.`,
  );
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
