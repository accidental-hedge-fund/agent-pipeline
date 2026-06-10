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
  getPrDetail,
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
import {
  extractOverrides,
  findingKey,
  partitionFindings,
  type PartitionResult,
} from "../review-policy.ts";
import type {
  Outcome,
  PipelineConfig,
  ReviewFinding,
  ReviewVerdict,
  Stage,
} from "../types.ts";

const REVIEW_MARKER_PREFIX_R1 = "## Review 1";
const REVIEW_MARKER_PREFIX_R2 = "## Review 2";
// Machine-readable binding of a review verdict to the commit it evaluated (#16).
// Embedded as a dedicated HTML-comment sentinel on its own line so extraction
// can anchor to it without matching a SHA that happens to appear in the diff.
// Anchored to a full line; requires exactly 40 hex chars so short SHAs that
// may appear in model-authored prose or diff excerpts do not match. Global flag
// lets extractReviewedSha pick the LAST occurrence, guarding against injected
// sentinel content appearing earlier in the comment body.
const REVIEWED_SHA_RE = /^<!-- reviewed-sha: ([0-9a-fA-F]{40}) -->$/gm;
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

/**
 * External seams used by {@link advanceReview}, overridable in tests so the
 * verdict-normalization routing can be exercised without a real reviewer,
 * GitHub, or worktree. Defaults are the real implementations. Mirrors the
 * dependency-injection pattern used by `testgate.ts`'s `TestGateDeps`.
 */
export interface AdvanceReviewDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrDiff?: typeof getPrDiff;
  getPrDetail?: typeof getPrDetail;
  getIssueDetail?: typeof getIssueDetail;
  getForIssue?: typeof getForIssue;
  postComment?: typeof postComment;
  transition?: typeof transition;
  setBlocked?: typeof setBlocked;
  /** Runs one review round and returns the raw harness result. */
  runReview?: RunReviewFn;
}

type RunReviewFn = (
  companionMode: CompanionMode | null,
  cfg: PipelineConfig,
  issueNumber: number,
  detail: { title: string; body: string },
  plan: string,
  review1Summary: string | undefined,
  diff: string,
  round: 1 | 2,
  cwd: string,
  opts: AdvanceReviewOpts,
) => Promise<HarnessResult>;

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
  retryCount = 0,
  deps: AdvanceReviewDeps = {},
): Promise<Outcome> {
  const getPrForIssueFn = deps.getPrForIssue ?? getPrForIssue;
  const getPrDiffFn = deps.getPrDiff ?? getPrDiff;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const getIssueDetailFn = deps.getIssueDetail ?? getIssueDetail;
  const getForIssueFn = deps.getForIssue ?? getForIssue;
  const postCommentFn = deps.postComment ?? postComment;
  const transitionFn = deps.transition ?? transition;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const runReviewFn = deps.runReview ?? defaultRunReview;

  const stage: Stage = round === 1 ? "review-1" : "review-2";
  const companionMode = isCompanionMode(cfg.review_mode) ? cfg.review_mode : null;
  const reviewer = companionMode
    ? COMPANIONS[companionMode].labels[round - 1]
    : cfg.harnesses.reviewer;

  console.log(`[pipeline] #${issueNumber}: ${stage} by ${reviewer}`);

  const prNumber = await getPrForIssueFn(cfg, issueNumber);
  if (!prNumber) {
    await setBlockedFn(cfg, issueNumber, "No pull request found for this issue.", stage);
    return { advanced: false, status: "blocked", reason: "no PR found" };
  }

  // (#16) Capture HEAD SHA before fetching the diff so the stamped SHA matches
  // the diff being reviewed. SHA resolution is mandatory — a missing or invalid
  // SHA would produce an unverifiable verdict that the pre-merge gate can never
  // clear.
  let commitSha: string;
  try {
    const sha = (await getPrDetailFn(cfg, prNumber)).head_sha ?? "";
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      await setBlockedFn(cfg, issueNumber, `PR head SHA is missing or invalid: "${sha}"`, stage);
      return { advanced: false, status: "blocked", reason: "invalid SHA" };
    }
    commitSha = sha;
  } catch (err) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `Could not resolve PR head SHA: ${(err as Error).message}`,
      stage,
    );
    return { advanced: false, status: "blocked", reason: "SHA resolution failed" };
  }

  let diff: string;
  try {
    diff = await getPrDiffFn(cfg, prNumber);
  } catch (err) {
    const e = err as Error;
    await setBlockedFn(cfg, issueNumber, `Could not retrieve PR diff: ${e.message}`, stage);
    return { advanced: false, status: "blocked", reason: e.message };
  }
  if (!diff.trim()) {
    await setBlockedFn(cfg, issueNumber, "PR has an empty diff.", stage);
    return { advanced: false, status: "blocked", reason: "empty diff" };
  }

  // Verify HEAD didn't move between SHA capture and diff fetch. If it did,
  // the diff and the stamped SHA describe different states (#16).
  try {
    const postDiffSha = (await getPrDetailFn(cfg, prNumber)).head_sha ?? "";
    if (postDiffSha !== commitSha) {
      await setBlockedFn(
        cfg,
        issueNumber,
        `PR HEAD moved while fetching diff (${commitSha.slice(0, 7)} → ${postDiffSha.slice(0, 7)}). ` +
          `Re-run the review stage to evaluate a stable HEAD.`,
        stage,
      );
      return { advanced: false, status: "blocked", reason: "HEAD moved during diff fetch" };
    }
  } catch {
    // If the post-diff check fails, continue: the pre-merge gate will detect
    // staleness when it compares the stamped SHA against HEAD.
  }

  const detail = await getIssueDetailFn(cfg, issueNumber);
  const plan = extractPlan(detail.comments);
  const review1Summary = round === 2 ? extractReview1Summary(detail.comments) : undefined;

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would invoke ${reviewer} for ${stage}`);
    return { advanced: true, from: stage, to: round === 1 ? "review-2" : "pre-merge", summary: "[dry-run]" };
  }

  // Run in worktree if available, otherwise repo root.
  const wt = await getForIssueFn(cfg, issueNumber);
  const cwd = wt?.path ?? cfg.repo_dir;

  const result = await runReviewFn(
    companionMode,
    cfg,
    issueNumber,
    detail,
    plan,
    review1Summary,
    diff,
    round,
    cwd,
    opts,
  );

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlockedFn(cfg, issueNumber, `Review harness (${reviewer}) failed: ${reason}`, stage);
    return { advanced: false, status: "blocked", reason };
  }

  const verdict = parseStructuredVerdict(result.stdout, commitSha);
  console.log(
    `[pipeline] #${issueNumber}: verdict=${verdict.verdict} findings=${verdict.findings.length}`,
  );

  await postCommentFn(cfg, issueNumber, formatReviewComment(cfg, verdict, round, reviewer));

  if (verdict.verdict === "approve") {
    if (round === 1) {
      await transitionFn(
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
      await transitionFn(
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

  // Verdict normalization (#45): a `needs-attention` verdict carrying zero
  // enumerated findings has nothing concrete for a fix round to act on. Routing
  // it to fix burns a harness invocation on nothing and produces a misleading
  // "fixes pushed" comment (observed live in #34 → PR #44). It almost always
  // means the reviewer output couldn't be parsed into a structured verdict and
  // degraded to the conservative text default. Re-review once; if it still can't
  // produce findings, BLOCK and surface the raw output — do not auto-approve
  // (the text fallback can silently drop prose findings) and do not fix nothing.
  if (verdict.verdict === "needs-attention" && verdict.findings.length === 0) {
    if (retryCount === 0) {
      console.log(
        `[pipeline] #${issueNumber}: needs-attention+0-findings — triggering re-review (attempt ${retryCount + 1})`,
      );
      return advanceReview(cfg, issueNumber, round, opts, retryCount + 1, deps);
    }
    const raw = result.stdout.slice(0, 4000).trim() || "(no reviewer output captured)";
    await setBlockedFn(
      cfg,
      issueNumber,
      `Review ${round} returned \`needs-attention\` with zero enumerated findings on re-review, ` +
        `so there is nothing concrete to fix. The reviewer output likely could not be parsed into ` +
        `a structured verdict. Raw reviewer output:\n\n${raw}`,
      stage,
    );
    return {
      advanced: false,
      status: "blocked",
      reason: "needs-attention with 0 findings on re-review",
    };
  }

  // needs-attention with findings → apply the severity policy (#17). Partition
  // findings into blocking (at/above threshold + confidence, not overridden),
  // advisory (below threshold/confidence), and operator-overridden. Only
  // blocking findings route to a fix round. When none remain, the review still
  // ran and its findings are on the record — the item advances as if approved.
  const overrides = extractOverrides(detail.comments);
  const partition = partitionFindings(verdict.findings, cfg.review_policy, overrides);

  if (partition.blocking.length === 0) {
    await postCommentFn(cfg, issueNumber, advisoryAdvanceComment(cfg, round, reviewer, partition));
    const toStage: Stage = round === 1 ? "review-2" : "pre-merge";
    await transitionFn(
      cfg,
      issueNumber,
      stage,
      toStage,
      `Review ${round} by ${reviewer}: ${verdict.findings.length} finding(s), none above policy ` +
        `(${partition.advisory.length} advisory, ${partition.overridden.length} overridden) — advancing.`,
    );
    return {
      advanced: true,
      from: stage,
      to: toStage,
      summary: `${verdict.findings.length} findings below policy — advanced`,
    };
  }

  const fixStage: Stage = round === 1 ? "fix-1" : "fix-2";
  const advisoryNote =
    partition.advisory.length || partition.overridden.length
      ? ` (${partition.advisory.length} advisory + ${partition.overridden.length} overridden not blocking)`
      : "";
  await transitionFn(
    cfg,
    issueNumber,
    stage,
    fixStage,
    `Review ${round} by ${reviewer} requested changes (${partition.blocking.length} blocking ` +
      `of ${verdict.findings.length} findings${advisoryNote}).`,
  );
  return {
    advanced: true,
    from: stage,
    to: fixStage,
    summary: `${partition.blocking.length} blocking findings`,
  };
}

/**
 * Audited comment posted when a review produced findings but none block under
 * the active policy — the item advances, with the advisory/overridden findings
 * recorded so the decision is visible later (#17).
 */
function advisoryAdvanceComment(
  cfg: PipelineConfig,
  round: 1 | 2,
  reviewer: string,
  partition: PartitionResult,
): string {
  const lines = [
    `## Pipeline: Review ${round} advanced under severity policy`,
    "",
    `**Reviewer**: ${reviewer}`,
    `Findings were produced but none meet the repo's \`review_policy.block_threshold\` ` +
      `(\`${cfg.review_policy.block_threshold}\`, min_confidence ${cfg.review_policy.min_confidence}), ` +
      `so this item advances instead of routing to a fix round.`,
  ];
  if (partition.advisory.length) {
    lines.push("", "### Advisory (below policy — not blocking)");
    for (const { finding, reason } of partition.advisory) {
      lines.push(`- \`${findingKey(finding)}\` **[${(finding.severity ?? "medium").toUpperCase()}]** ${finding.title} — ${reason}`);
    }
  }
  if (partition.overridden.length) {
    lines.push("", "### Overridden (operator-dispositioned — not blocking)");
    for (const { finding, key, disposition } of partition.overridden) {
      lines.push(`- \`${key}\` **[${(finding.severity ?? "medium").toUpperCase()}]** ${finding.title} — ${disposition}`);
    }
  }
  lines.push("", (cfg.marker_footer ?? "*Automated by Claude Code Pipeline Skill*").trim());
  return lines.join("\n");
}

/** Default {@link RunReviewFn}: dispatches to the companion or prompt-harness reviewer. */
const defaultRunReview: RunReviewFn = (
  companionMode,
  cfg,
  issueNumber,
  detail,
  plan,
  review1Summary,
  diff,
  round,
  cwd,
  opts,
) =>
  companionMode
    ? invokeCompanionReview(companionMode, cfg, issueNumber, detail.title, round, cwd, opts)
    : invokePromptHarnessReview(cfg, issueNumber, detail.title, detail.body, plan, review1Summary, diff, round, cwd, opts);

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
  const specContext = openspec.openspecContext(cfg, cwd);
  const prompt = round === 1
    ? buildReviewStandardPrompt({ cfg, issueNumber, title, body, plan, diff, specContext })
    : buildReviewAdversarialPrompt({ cfg, issueNumber, title, body, diff, review1Summary, specContext });
  return invoke(cfg.harnesses.reviewer, cwd, prompt, {
    timeoutSec: cfg.review_timeout,
    model: opts.model ?? cfg.models.review,
  });
}

// ---------------------------------------------------------------------------
// Pure parsers — exported for testability
// ---------------------------------------------------------------------------

export function parseStructuredVerdict(
  output: string,
  commitSha = "",
): ReviewVerdict & { _raw?: string } {
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
          commitSha,
        };
      }
    } catch {
      // try the next candidate
    }
  }

  // Codex's standard review (`/codex:review`) returns Markdown prose, not JSON.
  // Parse it so real findings route to a fix instead of being silently dropped
  // (#50 — observed live on #48: a real [P2] finding was lost → needs-attention/0
  // → blocked run). The commit SHA is stamped here, not parsed from prose (#16).
  const prose = parseProseReview(output);
  if (prose) return { ...prose, commitSha };

  // Fall back to text-based verdict (conservative). This path produces no
  // structured findings, so log it: a fallback `needs-attention` is
  // indistinguishable from a genuine one at the routing site, and silent
  // degradation is exactly what burned a fix round on nothing in #45. `_raw`
  // carries the unparsed output forward so the routing layer can surface it.
  console.warn(
    "[pipeline] warning: verdict fallback — no structured JSON found in reviewer output; raw attached",
  );
  return {
    verdict: parseTextVerdict(output),
    summary: output.slice(0, 500),
    findings: [],
    next_steps: [],
    commitSha,
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

const SEVERITY_BY_PRIORITY: Record<string, ReviewFinding["severity"]> = {
  p0: "critical",
  p1: "high",
  p2: "medium",
  p3: "low",
};
const WORD_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/**
 * Parse Codex's native review (Markdown prose) into a structured verdict.
 * Codex reviews are NOT JSON, and the two review types use different shapes:
 *
 *   Standard (`/codex:review`):    "# Codex Review" … "Review comment:"
 *     - [P2] <title> — <file>:<start>-<end>       (em-dash location)
 *   Adversarial (`/codex:adversarial-review`):   "# Codex Adversarial Review" …
 *     "Verdict: …" … "Findings:"
 *     - [high] <title> (<file>:<start>-<end>)      (parenthesized location)
 *
 * `parseStructuredVerdict` only understood JSON, so these findings were silently
 * dropped (→ needs-attention/0 → blocked run). See #50. Returns `null` when the
 * output is not a recognizable Codex review, so callers fall through to the
 * conservative fallback — never a silent approve of unparsed content (#45).
 *
 * Returns a verdict without `commitSha`; the caller stamps it (#16).
 */
export function parseProseReview(output: string): Omit<ReviewVerdict, "commitSha"> | null {
  const text = output ?? "";
  if (
    !/^#{1,6}\s*Codex\b.*\bReview\b/im.test(text) &&
    !/^\s*(?:Review comment|Findings)\s*:/im.test(text) &&
    !/^\s*Verdict\s*:/im.test(text)
  ) {
    return null;
  }

  const headerRe = /^\s*[-*]\s*\[\s*(P[0-3]|critical|high|medium|low)\s*\]\s*(.+?)\s*$/i;
  // Two Codex location styles: "title — file:line" (standard, em-dash) and
  // "title (file:line)" (adversarial, parens); both may carry a line range.
  const locDash = /^(.*\S)\s+[—–-]\s+(\S.*?):(\d+)(?:\s*-\s*(\d+))?\s*$/;
  const locParen = /^(.*\S)\s+\((\S.*?):(\d+)(?:\s*-\s*(\d+))?\)\s*$/;

  const findings: ReviewFinding[] = [];
  let current: ReviewFinding | null = null;
  const flush = (): void => {
    if (current) {
      current.body = current.body.trim();
      findings.push(current);
      current = null;
    }
  };

  for (const line of text.split("\n")) {
    const h = line.match(headerRe);
    if (h) {
      flush();
      const tag = h[1].toLowerCase();
      const severity: ReviewFinding["severity"] =
        SEVERITY_BY_PRIORITY[tag] ??
        (WORD_SEVERITIES.has(tag) ? (tag as ReviewFinding["severity"]) : "medium");
      let title = h[2].trim();
      let file: string | undefined;
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      const loc = title.match(locDash) ?? title.match(locParen);
      if (loc) {
        title = loc[1].trim();
        file = loc[2].trim();
        lineStart = Number(loc[3]);
        lineEnd = loc[4] ? Number(loc[4]) : lineStart;
      }
      current = {
        severity,
        title,
        body: "",
        file,
        line_start: lineStart,
        line_end: lineEnd,
        confidence: 0.7,
        recommendation: "",
      };
      continue;
    }
    if (current) {
      const trimmed = line.trim();
      // Blank lines don't end a finding; indented lines continue its body; a
      // non-indented non-blank line ("Findings:", "Verdict:", "Next steps:", a
      // markdown header, or the next finding) ends it.
      if (trimmed === "") continue;
      if (/^\s/.test(line)) {
        current.body += (current.body ? "\n" : "") + trimmed;
      } else {
        flush();
      }
    }
  }
  flush();

  const summary = extractProseSummary(text);
  if (findings.length > 0) {
    return { verdict: "needs-attention", summary, findings, next_steps: [] };
  }

  // Recognized as a Codex review but with no parseable findings: only call it an
  // approve when the text positively says so. Otherwise return null so the
  // conservative fallback (re-review → block) applies — never silently approve.
  if (
    /^\s*Verdict\s*:\s*approve\b/im.test(text) ||
    /\bno (?:material )?(?:issues|findings|concerns|blocking)\b/i.test(text) ||
    /\b(?:looks good|lgtm|approved?|no problems found)\b/i.test(text)
  ) {
    return { verdict: "approve", summary, findings: [], next_steps: [] };
  }
  return null;
}

/** Pull a short summary from the prose preceding the findings list. */
function extractProseSummary(text: string): string {
  const head = text.split(/^\s*(?:Review comment|Findings)\s*:/im)[0] ?? text;
  const cleaned = head
    .replace(/^#{1,6}\s*Codex\b.*Review\s*$/im, "")
    .replace(/^\s*Target:.*$/im, "")
    .replace(/^\s*Verdict\s*:.*$/im, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return (cleaned || "Codex review").slice(0, 500);
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
  // Surface the reviewed commit in the header so it is visible which commit this
  // verdict covers (#16); the machine-readable sentinel is appended last.
  const shortSha = verdict.commitSha ? verdict.commitSha.slice(0, 7) : "";
  const heading = shortSha
    ? `## Review ${round} (${reviewType}) — ${verdict.verdict} (commit ${shortSha})`
    : `## Review ${round} (${reviewType}) — ${verdict.verdict}`;
  const lines = [
    heading,
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
      lines.push("", `**${i + 1}. [${sev}] ${f.title}**${conf} \`override-key: ${findingKey(f)}\``);
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
  // Sentinel last (#16): a dedicated, anchorable line the gate reads back to
  // verify the verdict still covers HEAD. Omitted when no SHA was resolved.
  if (verdict.commitSha) {
    lines.push("", `<!-- reviewed-sha: ${verdict.commitSha} -->`);
  }
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

/** Which review round a comment body belongs to, or null if it isn't one. */
function reviewRoundOf(body: string, only?: 1 | 2): 1 | 2 | null {
  const isR1 = body.startsWith(REVIEW_MARKER_PREFIX_R1);
  const isR2 = body.startsWith(REVIEW_MARKER_PREFIX_R2);
  if (only === 1) return isR1 ? 1 : null;
  if (only === 2) return isR2 ? 2 : null;
  if (isR2) return 2;
  if (isR1) return 1;
  return null;
}

/**
 * Read the commit a prior review verdict evaluated (#16) from the most recent
 * review comment. With `round`, only that round's comments are considered;
 * without it, the latest review comment of either round is used and its round
 * reported (so a gate can re-run the right review stage).
 *
 * Returns `null` when no review comment exists at all. Returns `{ sha: null }`
 * when a review comment exists but carries no `reviewed-sha` sentinel (a legacy
 * comment predating this change) — the gate treats that as unverifiable.
 */
export function extractReviewedSha(
  comments: { body: string }[],
  round?: 1 | 2,
): { sha: string | null; round: 1 | 2 } | null {
  const m = findLatestCommentMatching(
    comments.map((c) => ({ ...c, author: "", createdAt: "" })),
    (b) => reviewRoundOf(b, round) !== null,
  );
  if (!m) return null;
  // Reset lastIndex before each exec so the global regex is stateless across calls.
  REVIEWED_SHA_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  let cur: RegExpExecArray | null;
  while ((cur = REVIEWED_SHA_RE.exec(m.body)) !== null) {
    lastMatch = cur;
  }
  REVIEWED_SHA_RE.lastIndex = 0;
  return {
    sha: lastMatch?.[1] ?? null,
    round: reviewRoundOf(m.body, round) as 1 | 2,
  };
}

// Internal export for tests, so review.test isn't needed.
export const _internals = { extractPlan, extractReview1Summary };
