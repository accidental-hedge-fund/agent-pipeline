// Review stages: review-1 (standard) and review-2 (adversarial).
//
//   review-1 → review-2 (approve) OR fix-1 (needs-attention)
//   review-2 → pre-merge (approve) OR fix-2 (needs-attention)
//
// Review runs through the Codex Claude Code companion, mirroring $cc:review
// for review-1 and $cc:adversarial-review for review-2. Output is parsed from
// structured JSON when present; otherwise text verdict detection is
// conservative and defaults to "needs-attention".

import * as os from "node:os";
import * as path from "node:path";
import {
  findLatestCommentMatching,
  getIssueDetail,
  getPrDiff,
  getPrForIssue,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke, runCapped, type HarnessResult } from "../harness.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
} from "../prompts/index.ts";
import { getForIssue } from "../worktree.ts";
import * as openspec from "../openspec.ts";
import type {
  Outcome,
  PipelineConfig,
  ReviewFinding,
  ReviewVerdict,
  Stage,
} from "../types.ts";

const REVIEW_MARKER_PREFIX_R1 = "## Review 1";
const REVIEW_MARKER_PREFIX_R2 = "## Review 2";
const DEFAULT_CC_COMPANION = path.join(
  os.homedir(),
  ".codex",
  "plugins",
  "cache",
  "local-plugins",
  "cc",
  "local",
  "scripts",
  "claude-companion.mjs",
);

export interface AdvanceReviewOpts {
  dryRun?: boolean;
  model?: string;
}

export interface ClaudeCodeReviewCommand {
  cmd: string;
  args: string[];
  label: "$cc:review" | "$cc:adversarial-review";
}

export function buildClaudeCodeReviewCommand(
  cfg: Pick<PipelineConfig, "base_branch">,
  round: 1 | 2,
  opts: { model?: string; focusText?: string; companionPath?: string } = {},
): ClaudeCodeReviewCommand {
  const subcommand = round === 1 ? "review" : "adversarial-review";
  const label = round === 1 ? "$cc:review" : "$cc:adversarial-review";
  const args = [
    opts.companionPath ?? process.env.PIPELINE_CC_COMPANION ?? DEFAULT_CC_COMPANION,
    subcommand,
    "--view-state",
    "on-success",
    "--scope",
    "branch",
    "--base",
    cfg.base_branch,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (round === 2 && opts.focusText?.trim()) args.push(opts.focusText.trim());
  return { cmd: "node", args, label };
}

export async function advanceReview(
  cfg: PipelineConfig,
  issueNumber: number,
  round: 1 | 2,
  opts: AdvanceReviewOpts = {},
): Promise<Outcome> {
  const stage: Stage = round === 1 ? "review-1" : "review-2";
  const reviewer = cfg.review_mode === "claude-companion"
    ? (round === 1 ? "$cc:review" : "$cc:adversarial-review")
    : cfg.harnesses.reviewer;

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${reviewer}`);

  const prNumber = await getPrForIssue(cfg, issueNumber);
  if (!prNumber) {
    await setBlocked(cfg, issueNumber, "No pull request found for this issue.", stage);
    return { advanced: false, status: "blocked", reason: "no PR found" };
  }

  let diff: string;
  try {
    diff = await getPrDiff(cfg, prNumber);
  } catch (err) {
    const e = err as Error;
    await setBlocked(cfg, issueNumber, `Could not retrieve PR diff: ${e.message}`, stage);
    return { advanced: false, status: "blocked", reason: e.message };
  }
  if (!diff.trim()) {
    await setBlocked(cfg, issueNumber, "PR has an empty diff.", stage);
    return { advanced: false, status: "blocked", reason: "empty diff" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const plan = extractPlan(detail.comments);
  const review1Summary = round === 2 ? extractReview1Summary(detail.comments) : undefined;

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would invoke ${reviewer} for ${stage}`);
    return { advanced: true, from: stage, to: round === 1 ? "review-2" : "pre-merge", summary: "[dry-run]" };
  }

  // Run in worktree if available, otherwise repo root.
  const wt = await getForIssue(cfg, issueNumber);
  const cwd = wt?.path ?? cfg.repo_dir;

  const result = cfg.review_mode === "claude-companion"
    ? await invokeClaudeCodeReview(cfg, issueNumber, detail.title, round, cwd, opts)
    : await invokePromptHarnessReview(cfg, issueNumber, detail.title, detail.body, plan, review1Summary, diff, round, cwd, opts);

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlocked(cfg, issueNumber, `Review harness (${reviewer}) failed: ${reason}`, stage);
    return { advanced: false, status: "blocked", reason };
  }

  const verdict = parseStructuredVerdict(result.stdout);
  console.log(
    `[pipeline] #${issueNumber}: verdict=${verdict.verdict} findings=${verdict.findings.length}`,
  );

  await postComment(cfg, issueNumber, formatReviewComment(cfg, verdict, round, reviewer));

  if (verdict.verdict === "approve") {
    if (round === 1) {
      const approveTarget: Stage = cfg.steps.adversarial_review ? "review-2" : "pre-merge";
      const approveNote = cfg.steps.adversarial_review
        ? `Standard review by ${reviewer} — approved (${verdict.findings.length} findings).`
        : `Standard review by ${reviewer} — approved (${verdict.findings.length} findings). Adversarial review disabled; routing to pre-merge.`;
      await transition(cfg, issueNumber, "review-1", approveTarget, approveNote);
      return {
        advanced: true,
        from: "review-1",
        to: approveTarget,
        summary: `approved (${verdict.findings.length} findings)`,
      };
    } else {
      await transition(
        cfg,
        issueNumber,
        "review-2",
        "pre-merge",
        `Adversarial review by ${reviewer} — approved (${verdict.findings.length} findings).`,
      );
      return {
        advanced: true,
        from: "review-2",
        to: "pre-merge",
        summary: `adversarial approved (${verdict.findings.length} findings)`,
      };
    }
  }

  // needs-attention → fix
  const fixStage: Stage = round === 1 ? "fix-1" : "fix-2";
  await transition(
    cfg,
    issueNumber,
    stage,
    fixStage,
    `Review ${round} by ${reviewer} requested changes (${verdict.findings.length} findings).`,
  );
  return {
    advanced: true,
    from: stage,
    to: fixStage,
    summary: `${verdict.findings.length} findings`,
  };
}

async function invokeClaudeCodeReview(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  round: 1 | 2,
  cwd: string,
  opts: AdvanceReviewOpts,
): Promise<HarnessResult> {
  const specHint = openspec.isActive(cfg, cwd)
    ? " The intended behavior is specified under openspec/changes/<change>/specs/ — verify the diff satisfies those spec deltas."
    : "";
  const focusText =
    round === 2
      ? `Pipeline adversarial review for issue #${issueNumber}: challenge whether the PR fully satisfies "${title}" and whether review-1 missed material risk.${specHint}`
      : undefined;
  const command = buildClaudeCodeReviewCommand(cfg, round, {
    model: opts.model ?? cfg.models.review,
    focusText,
  });
  return runCapped(
    command.cmd,
    command.args,
    cwd,
    cfg.review_timeout,
    true,
    command.label,
  );
}

async function invokePromptHarnessReview(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  body: string,
  plan: string,
  review1Summary: string | undefined,
  diff: string,
  round: 1 | 2,
  cwd: string,
  opts: AdvanceReviewOpts,
): Promise<HarnessResult> {
  const specContext = openspecContext(cfg, cwd);
  const prompt = round === 1
    ? buildReviewStandardPrompt({ cfg, issueNumber, title, body, plan, diff, specContext })
    : buildReviewAdversarialPrompt({ cfg, issueNumber, title, body, diff, review1Summary, specContext });
  return invoke(cfg.harnesses.reviewer, cwd, prompt, {
    timeoutSec: cfg.review_timeout,
    model: opts.model ?? cfg.models.review,
  });
}

/** OpenSpec spec deltas for the worktree's change, or "" when not applicable. */
function openspecContext(cfg: PipelineConfig, cwd: string): string {
  if (!openspec.isActive(cfg, cwd)) return "";
  const changes = openspec.listChangeDirs(cwd);
  return changes.length ? openspec.readSpecDeltas(cwd, changes[0]) : "";
}

// ---------------------------------------------------------------------------
// Pure parsers — exported for testability
// ---------------------------------------------------------------------------

export function parseStructuredVerdict(output: string): ReviewVerdict & { _raw?: string } {
  // Try fenced JSON first.
  const fenceMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates: string[] = [];
  if (fenceMatch) candidates.push(fenceMatch[1]);
  // Then any JSON-looking block containing "verdict".
  const inlineMatch = output.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (inlineMatch) candidates.push(inlineMatch[0]);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Partial<ReviewVerdict>;
      if (data.verdict === "approve" || data.verdict === "needs-attention") {
        return {
          verdict: data.verdict,
          summary: data.summary ?? "",
          findings: Array.isArray(data.findings) ? (data.findings as ReviewFinding[]) : [],
          next_steps: Array.isArray(data.next_steps) ? data.next_steps as string[] : [],
        };
      }
    } catch {
      // try the next candidate
    }
  }

  // Fall back to text-based verdict (conservative).
  return {
    verdict: parseTextVerdict(output),
    summary: output.slice(0, 500),
    findings: [],
    next_steps: [],
    _raw: output.slice(0, 4000),
  };
}

export function parseTextVerdict(output: string): "approve" | "needs-attention" {
  const upper = output.toUpperCase();
  // First-line scan for explicit signal.
  const firstLines = output.split("\n", 15).map((l) => l.trim().toUpperCase());
  for (const line of firstLines) {
    if (line.includes("NEEDS-ATTENTION") || line.includes("NEEDS_ATTENTION")) {
      return "needs-attention";
    }
    if (line.includes("REQUEST_CHANGES") || line.includes("REQUEST CHANGES")) {
      return "needs-attention";
    }
    if (line.includes("APPROVE") && !line.includes("NEEDS") && !line.includes("REQUEST")) {
      return "approve";
    }
  }
  if (upper.includes("NEEDS-ATTENTION") || upper.includes("REQUEST_CHANGES") || upper.includes("REQUEST CHANGES")) {
    return "needs-attention";
  }
  if (
    upper.includes("NO MATERIAL FINDINGS") ||
    upper.includes("NO FINDINGS") ||
    upper.includes("NO ISSUES FOUND") ||
    upper.includes("LOOKS SAFE")
  ) {
    return "approve";
  }
  if (upper.includes('"VERDICT": "APPROVE"') || upper.includes("**APPROVE**")) {
    return "approve";
  }
  return "needs-attention";
}

export function formatReviewComment(
  cfgOrVerdict: PipelineConfig | (ReviewVerdict & { _raw?: string }),
  verdictOrRound: (ReviewVerdict & { _raw?: string }) | 1 | 2,
  roundOrReviewer: 1 | 2 | string,
  maybeReviewer?: string,
): string {
  const cfg = maybeReviewer === undefined ? undefined : cfgOrVerdict as PipelineConfig;
  const verdict = maybeReviewer === undefined
    ? cfgOrVerdict as ReviewVerdict & { _raw?: string }
    : verdictOrRound as ReviewVerdict & { _raw?: string };
  const round = maybeReviewer === undefined ? verdictOrRound as 1 | 2 : roundOrReviewer as 1 | 2;
  const reviewer = maybeReviewer === undefined ? roundOrReviewer as string : maybeReviewer;
  const reviewType = round === 1 ? "Standard" : "Adversarial";
  const lines = [
    `## Review ${round} (${reviewType}) — ${verdict.verdict}`,
    `**Reviewer**: ${reviewer}`,
    "",
    verdict.summary,
  ];
  if (verdict.findings.length > 0) {
    lines.push("", "### Findings");
    verdict.findings.forEach((f, i) => {
      const sev = (f.severity ?? "medium").toUpperCase();
      const loc = f.line_start
        ? `${f.file ?? ""}:${f.line_start}-${f.line_end ?? f.line_start}`
        : f.file ?? "";
      const conf = f.confidence !== undefined ? ` (confidence: ${f.confidence})` : "";
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf}`);
      if (loc) lines.push(`Location: \`${loc}\``);
      if (f.body) lines.push(f.body);
      if (f.recommendation) lines.push(`**Recommendation**: ${f.recommendation}`);
    });
  }
  if (verdict._raw) {
    lines.push("", "### Raw Review Output", verdict._raw);
  }
  if (verdict.next_steps?.length) {
    lines.push("", "### Next Steps");
    for (const step of verdict.next_steps) lines.push(`- ${step}`);
  }
  lines.push(cfgFooter(cfg));
  return lines.join("\n");
}

function cfgFooter(cfg: PipelineConfig | undefined): string {
  return (cfg?.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim();
}

function extractPlan(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith("## Implementation Plan"),
  );
  return m?.body ?? "(plan not found in comments)";
}

function extractReview1Summary(comments: { body: string }[]): string {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => b.startsWith(REVIEW_MARKER_PREFIX_R1),
  );
  return (m?.body ?? "").slice(0, 2000);
}

// Internal export for tests, so review.test isn't needed.
export const _internals = { extractPlan, extractReview1Summary };
