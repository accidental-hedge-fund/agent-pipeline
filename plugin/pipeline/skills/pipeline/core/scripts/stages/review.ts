// Review stages: review-1 (standard) and review-2 (adversarial).
//
//   review-1 → review-2 (approve) OR fix-1 (needs-attention)
//   review-2 → pre-merge (approve) OR fix-2 (needs-attention)
//
// When the profile's review_mode is a *companion* mode, review runs through a
// cross-harness reviewer plugin: "claude-companion" drives Claude Code via
// cc-plugin-codex ($cc:review / $cc:adversarial-review); "codex-companion"
// drives Codex via codex-plugin-cc (/codex:review / /codex:adversarial-review).
// review-1 maps to the plugin's standard review, review-2 to its adversarial
// review. Output is parsed from structured JSON when present; otherwise text
// verdict detection is conservative and defaults to "needs-attention".
// "prompt-harness" mode instead runs the reviewer CLI directly with the
// pipeline's own review prompt.

import * as fs from "node:fs";
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
// Companion plugin script locations. The pipeline shells out to the companion
// .mjs directly; an explicit PIPELINE_*_COMPANION env var always wins, otherwise
// we use the first candidate path that EXISTS — installs move between layouts
// (e.g. cc-plugin-codex's uninstall prunes the legacy local path, and
// codex-plugin-cc's active copy lives in a versioned cache dir), so a single
// hardcoded default goes stale. Candidates are listed best-first.

// cc-plugin-codex companion (drives Claude Code from Codex), under CODEX_HOME.
function ccCompanionCandidates(): string[] {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return [
    path.join(codexHome, "plugins", "cache", "local-plugins", "cc", "local", "scripts", "claude-companion.mjs"),
    path.join(codexHome, "plugins", "cc", "scripts", "claude-companion.mjs"),
  ];
}

// codex-plugin-cc companion (drives Codex from Claude Code), under the Claude
// plugin dir: the stable marketplace clone, then any versioned install cache
// (newest first).
function codexCompanionCandidates(): string[] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const candidates = [
    path.join(claudeDir, "plugins", "marketplaces", "openai-codex", "plugins", "codex", "scripts", "codex-companion.mjs"),
  ];
  const cacheBase = path.join(claudeDir, "plugins", "cache", "openai-codex", "codex");
  if (fs.existsSync(cacheBase)) {
    for (const version of fs.readdirSync(cacheBase).sort().reverse()) {
      candidates.push(path.join(cacheBase, version, "scripts", "codex-companion.mjs"));
    }
  }
  return candidates;
}

export type CompanionMode = "claude-companion" | "codex-companion";

interface CompanionSpec {
  /** Ordered candidate companion script paths (best-first); first existing wins. */
  candidates: () => string[];
  /** Env var that overrides the companion script path. */
  envVar: string;
  /** Reviewer labels for [round 1 (standard), round 2 (adversarial)]. */
  labels: readonly [string, string];
  /**
   * claude-companion's review is a prompt-driven Claude turn that honors
   * --view-state and --model (a Claude model name). codex-companion's standard
   * review maps to Codex's *native* reviewer, which honors neither: an unknown
   * --view-state flag and any extra positional are treated as review focus text
   * (which native review rejects), and --model expects a Codex model — not the
   * Claude model name ("opus") the pipeline carries. So both are gated per mode.
   */
  viewState: boolean;
  passModel: boolean;
}

const COMPANIONS: Record<CompanionMode, CompanionSpec> = {
  "claude-companion": {
    candidates: ccCompanionCandidates,
    envVar: "PIPELINE_CC_COMPANION",
    labels: ["$cc:review", "$cc:adversarial-review"],
    viewState: true,
    passModel: true,
  },
  "codex-companion": {
    candidates: codexCompanionCandidates,
    envVar: "PIPELINE_CODEX_COMPANION",
    labels: ["/codex:review", "/codex:adversarial-review"],
    viewState: false,
    passModel: false,
  },
};

/** Resolve the companion script path: explicit arg → env override → first existing candidate. */
function resolveCompanionPath(spec: CompanionSpec, companionPath?: string): string {
  if (companionPath) return companionPath;
  const override = process.env[spec.envVar];
  if (override) return override;
  const candidates = spec.candidates();
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

export function isCompanionMode(mode: string): mode is CompanionMode {
  return mode === "claude-companion" || mode === "codex-companion";
}

/** Human-readable reviewer label for summaries, given the configured review mode. */
export function reviewerLabel(cfg: Pick<PipelineConfig, "review_mode" | "harnesses">): string {
  if (isCompanionMode(cfg.review_mode)) {
    const spec = COMPANIONS[cfg.review_mode];
    const name = cfg.review_mode === "claude-companion" ? "Claude Code" : "Codex";
    return `${name} (${spec.labels[0]} + ${spec.labels[1]})`;
  }
  return cfg.harnesses.reviewer;
}

export interface AdvanceReviewOpts {
  dryRun?: boolean;
  model?: string;
}

export interface CompanionReviewCommand {
  cmd: string;
  args: string[];
  label: string;
}

export function buildCompanionReviewCommand(
  mode: CompanionMode,
  cfg: Pick<PipelineConfig, "base_branch">,
  round: 1 | 2,
  opts: { model?: string; focusText?: string; companionPath?: string } = {},
): CompanionReviewCommand {
  const spec = COMPANIONS[mode];
  const subcommand = round === 1 ? "review" : "adversarial-review";
  const label = spec.labels[round - 1];
  const args = [resolveCompanionPath(spec, opts.companionPath), subcommand];
  if (spec.viewState) args.push("--view-state", "on-success");
  args.push("--scope", "branch", "--base", cfg.base_branch);
  if (spec.passModel && opts.model) args.push("--model", opts.model);
  // Round-2 adversarial review takes free-text focus as a positional. It MUST
  // be appended last so no flag is misparsed as focus text by the companion.
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
  const companionMode = isCompanionMode(cfg.review_mode) ? cfg.review_mode : null;
  const reviewer = companionMode
    ? COMPANIONS[companionMode].labels[round - 1]
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

  const result = companionMode
    ? await invokeCompanionReview(companionMode, cfg, issueNumber, detail.title, round, cwd, opts)
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
      await transition(
        cfg,
        issueNumber,
        "review-1",
        "review-2",
        `Standard review by ${reviewer} — approved (${verdict.findings.length} findings).`,
      );
      return {
        advanced: true,
        from: "review-1",
        to: "review-2",
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

async function invokeCompanionReview(
  mode: CompanionMode,
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
  const command = buildCompanionReviewCommand(mode, cfg, round, {
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
