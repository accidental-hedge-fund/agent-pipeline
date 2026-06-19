// Shipcheck-gate stage (#148): reviewer-owned acceptance rubric evaluated after
// eval-gate and before ready-to-deploy.
//
// The reviewer harness (NOT the implementing harness) evaluates the rubric so
// the builder cannot self-certify. Advisory mode records pass/fail/findings
// without blocking; gate mode blocks ready-to-deploy on a fail verdict.
// A configurable max_rounds bound applies; timeout surfaces as needs-human.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  postComment as defaultPostComment,
  postPrComment as defaultPostPrComment,
  getPrForIssue as defaultGetPrForIssue,
  getPrDiff as defaultGetPrDiff,
  getIssueDetail as defaultGetIssueDetail,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { getForIssue as defaultGetForIssue, gitInWorktree as defaultGitInWorktree } from "../worktree.ts";
import { openspecContextFromDiff, readSpecDeltas } from "../openspec.ts";
import { readBundle as defaultReadBundle } from "../evidence-bundle.ts";
import { invoke as defaultInvoke } from "../harness.ts";
import { substitute } from "../prompts/index.ts";
import { SHIPCHECK_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import type {
  BlockerKind,
  EvidenceBundle,
  Outcome,
  PipelineConfig,
  ShipcheckVerdict,
  Stage,
} from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadShipcheckTemplate(): string {
  return fs.readFileSync(path.join(here, "../prompts/shipcheck.md"), "utf8");
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface BuildShipcheckPromptOpts {
  rubric: string;
  issueBody: string;
  planAndAcs: string;
  changedFiles: string;
  evalSummary?: string;
  openspecDeltas?: string;
}

export function buildShipcheckPrompt(opts: BuildShipcheckPromptOpts): string {
  return substitute(loadShipcheckTemplate(), {
    rubric: opts.rubric || "(no rubric provided)",
    issue_body: opts.issueBody || "(no issue body)",
    plan_and_acs: opts.planAndAcs || "(not available)",
    changed_files: opts.changedFiles || "(not available)",
    eval_summary: opts.evalSummary ?? "eval results: not available",
    openspec_deltas: opts.openspecDeltas || "(not applicable)",
    schema_block: SHIPCHECK_VERDICT_SCHEMA_BLOCK,
  });
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

/** Extract a ShipcheckVerdict from raw harness output.
 *  Tries fenced block first, then bare JSON. On parse failure returns a
 *  conservative fail verdict with the raw output as summary. */
export function parseShipcheckVerdict(
  raw: string,
  warn: (msg: string) => void = console.warn,
): ShipcheckVerdict {
  // Try fenced block: ```[json]\n...\n```
  const fencedMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = fencedMatch ? [fencedMatch[1], raw] : [raw];

  for (const candidate of candidates) {
    const jsonStart = candidate.indexOf("{");
    const jsonEnd = candidate.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) continue;
    try {
      const parsed = JSON.parse(candidate.slice(jsonStart, jsonEnd + 1)) as unknown;
      if (isShipcheckVerdict(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }

  const truncated = raw.slice(0, 500);
  warn(`[pipeline] shipcheck: could not parse verdict JSON from harness output; falling back to fail. Output: ${truncated}`);
  return {
    verdict: "fail",
    summary: truncated || "(no output)",
    criteria: [],
  };
}

function isShipcheckCriterion(c: unknown): boolean {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.criterion === "string" &&
    ["pass", "fail", "na"].includes(o.result as string) &&
    typeof o.note === "string"
  );
}

function isShipcheckVerdict(v: unknown): v is ShipcheckVerdict {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!["pass", "partial", "fail"].includes(o.verdict as string)) return false;
  if (typeof o.summary !== "string") return false;
  if (!Array.isArray(o.criteria)) return false;
  // Empty criteria array means the reviewer did not evaluate any rubric criterion.
  // Treat as parse failure so the conservative fail fallback fires rather than
  // silently advancing on a pass/partial with no human-auditable breakdown.
  if (o.criteria.length === 0) return false;
  return o.criteria.every(isShipcheckCriterion);
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

export function formatShipcheckComment(
  verdict: ShipcheckVerdict,
  mode: "advisory" | "gate",
): string {
  const header = mode === "advisory" ? "## Shipcheck (advisory)" : "## Shipcheck";
  const emoji = verdict.verdict === "pass" ? "✅" : verdict.verdict === "partial" ? "⚠️" : "❌";
  const lines: string[] = [
    header,
    "",
    `**Verdict**: ${emoji} ${verdict.verdict.toUpperCase()}`,
    `**Mode**: ${mode}`,
    "",
    "### Summary",
    verdict.summary,
  ];

  if (verdict.criteria.length > 0) {
    lines.push("", "### Criteria");
    lines.push("| Criterion | Result | Note |");
    lines.push("|-----------|--------|------|");
    for (const c of verdict.criteria) {
      const resultEmoji = c.result === "pass" ? "✅" : c.result === "na" ? "—" : "❌";
      lines.push(`| ${c.criterion} | ${resultEmoji} ${c.result} | ${c.note} |`);
    }
  }

  lines.push("", "---", "*Automated by Claude Code Pipeline Skill*");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deps seam
// ---------------------------------------------------------------------------

export interface ShipcheckDeps {
  getIssueDetail?: typeof defaultGetIssueDetail;
  getPrForIssue?: typeof defaultGetPrForIssue;
  getPrDiff?: typeof defaultGetPrDiff;
  getForIssue?: typeof defaultGetForIssue;
  postComment?: typeof defaultPostComment;
  postPrComment?: typeof defaultPostPrComment;
  transition?: typeof defaultTransition;
  silentTransition?: typeof defaultSilentTransition;
  setBlocked?: typeof defaultSetBlocked;
  /** Read a file at the given absolute path. Returns null when not found. */
  readFile?: (filePath: string) => string | null;
  /** Resolve a canonical path following symlinks. Default: fs.realpathSync. Throws on ENOENT. */
  realpathFn?: (filePath: string) => string;
  /** Read the evidence bundle for an issue. Returns null when not found. */
  readEvidenceBundle?: (stateDir: string, issue: number) => Promise<EvidenceBundle | null>;
  /** Run git diff --name-only in a worktree. Returns path list. */
  gitDiffNames?: (wtPath: string, base: string) => Promise<string[]>;
  /** Read OpenSpec spec deltas for a change dir name. Default: openspec.readSpecDeltas. */
  readSpecDeltasFn?: (wtPath: string, name: string) => string;
  /** Invoke the reviewer harness with a prompt. Returns stdout string or null on failure. */
  invokeReviewer?: (prompt: string, worktreeDir: string, timeoutSec: number) => Promise<{ stdout: string; success: boolean; timed_out?: boolean; stderr?: string }>;
}

// ---------------------------------------------------------------------------
// Main stage handler
// ---------------------------------------------------------------------------

export interface AdvanceShipcheckOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir; when set, eval results are read from it. */
  stateDir?: string;
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceShipcheckOpts = {},
  deps: ShipcheckDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: shipcheck-gate`);

  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const postPrCommentFn = deps.postPrComment ?? defaultPostPrComment;
  const getPrForIssueFn = deps.getPrForIssue ?? defaultGetPrForIssue;
  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const getPrDiffFn = deps.getPrDiff ?? defaultGetPrDiff;
  const readEvidenceBundleFn = deps.readEvidenceBundle ?? defaultReadBundle;
  const gitDiffNamesFn = deps.gitDiffNames ?? defaultGitDiffNames;
  const readSpecDeltasFnBound = deps.readSpecDeltasFn ?? readSpecDeltas;

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run shipcheck`);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "[dry-run]" };
  }

  // Skip path — disabled → silent label swap, no comment.
  if (!cfg.shipcheck_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate step disabled; skipping.`);
    await silentTransitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck-gate step disabled; skipping." };
  }

  // Load the issue detail for context.
  const detail = await getIssueDetailFn(cfg, issueNumber);
  const prNumber = await getPrForIssueFn(cfg, issueNumber);

  // Resolve the issue worktree; reviewer runs inside it when present.
  const wt = await getForIssueFn(cfg, issueNumber);
  const worktreeDir = wt?.path ?? cfg.repo_dir;

  // Compute rubric fallback from issue body before loading the configured file.
  const rubricFallback = extractAcceptanceCriteria(detail.body) || detail.body || "(no rubric available)";
  const rubric = loadRubric(cfg, deps, rubricFallback);

  // Gather changed-files summary from the PR diff.
  const changedFilesSummary = await gatherChangedFiles(cfg, prNumber, getPrDiffFn);

  // Extract plan and acceptance criteria from issue comments.
  const planAndAcs = extractPlanFromComments(detail.comments);

  // Extract eval summary from the evidence bundle when available.
  const evalSummary = opts.stateDir
    ? await gatherEvalSummary(opts.stateDir, issueNumber, readEvidenceBundleFn)
    : undefined;

  // Derive OpenSpec deltas from the worktree branch diff when applicable.
  const openspecDeltas = wt
    ? await gatherOpenspecDeltas(cfg, wt.path, gitDiffNamesFn, readSpecDeltasFnBound)
    : undefined;

  // Assemble prompt context.
  const prompt = buildShipcheckPrompt({
    rubric,
    issueBody: detail.body,
    planAndAcs,
    changedFiles: changedFilesSummary,
    evalSummary,
    openspecDeltas,
  });

  // Run reviewer harness up to max_rounds.
  const maxRounds = cfg.shipcheck_gate.max_rounds;
  const reviewerHarness = cfg.harnesses.reviewer;
  // Reuse cfg.review_timeout so repos can tune the reviewer latency budget centrally.
  const timeoutSec = cfg.review_timeout;

  let verdict: ShipcheckVerdict | null = null;
  let parseFailure = false;

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate retry (round ${round}/${maxRounds})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate invoking reviewer (${reviewerHarness})`);
    }

    let result: { stdout: string; success: boolean; timed_out?: boolean; stderr?: string };
    if (deps.invokeReviewer) {
      result = await deps.invokeReviewer(prompt, worktreeDir, timeoutSec);
    } else {
      const harnessResult = await defaultInvoke(reviewerHarness, worktreeDir, prompt, {
        timeoutSec,
      });
      result = {
        stdout: harnessResult.stdout,
        success: harnessResult.success,
        timed_out: harnessResult.timed_out,
        stderr: harnessResult.stderr,
      };
    }

    // Only parse stdout from successful invocations. A non-zero exit, spawn error,
    // or timeout must be treated as a failed round regardless of any output on
    // stdout — a timed-out process that happened to print parseable JSON must not
    // silently pass the gate.
    if (!result.success) {
      parseFailure = true;
      if (!verdict) {
        const timedOut = result.timed_out === true;
        const prefix = timedOut ? "[reviewer timed out]" : "[reviewer exited non-zero]";
        const detail = timedOut
          ? `timed out after ${timeoutSec}s`
          : result.stdout.trim() || result.stderr?.trim() || "no output";
        verdict = {
          verdict: "fail",
          summary: `${prefix}: ${detail.slice(0, 500)}`,
          criteria: [],
        };
      }
      continue;
    }

    let warnCalled = false;
    const parsed = parseShipcheckVerdict(result.stdout, (msg) => {
      console.warn(msg);
      warnCalled = true;
    });
    if (!warnCalled) {
      // Clean parse.
      verdict = parsed;
      parseFailure = false;
      break;
    }
    // Warn was called → parse failure, keep the fallback verdict for now but try again.
    verdict = parsed;
    parseFailure = true;
  }

  // If all rounds produced parse failures, handle per mode.
  if (parseFailure && verdict && verdict.verdict === "fail" && verdict.criteria.length === 0) {
    if (cfg.shipcheck_gate.mode === "gate") {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate parse failure after ${maxRounds} rounds (gate mode); blocking`);
      await setBlockedFn(
        cfg,
        issueNumber,
        `Shipcheck gate: could not parse a valid verdict from the reviewer after ${maxRounds} round(s). Raw output:\n\n${verdict.summary}`,
        "shipcheck-gate",
        "needs-human" as BlockerKind,
      );
      return { advanced: false, status: "blocked", reason: "shipcheck parse failure after max rounds", blockerKind: "needs-human" as BlockerKind };
    }
    // Advisory: warn and advance.
    console.warn(`[pipeline] #${issueNumber}: shipcheck-gate parse failure (advisory mode); advancing`);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck parse failure (advisory mode); advancing.");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck parse failure (advisory)" };
  }

  if (!verdict) {
    // Harness produced no output at all.
    if (cfg.shipcheck_gate.mode === "gate") {
      await setBlockedFn(cfg, issueNumber, "Shipcheck gate: reviewer harness produced no output.", "shipcheck-gate", "needs-human" as BlockerKind);
      return { advanced: false, status: "blocked", reason: "shipcheck: no harness output", blockerKind: "needs-human" as BlockerKind };
    }
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck: no harness output (advisory); advancing.");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck no output (advisory)" };
  }

  // Post verdict comment. Issue comment is authoritative; PR mirror is best-effort
  // so a transient PR API failure cannot strand the gate before it blocks/advances.
  const comment = formatShipcheckComment(verdict, cfg.shipcheck_gate.mode);
  await postCommentFn(cfg, issueNumber, comment);
  if (prNumber) {
    try {
      await postPrCommentFn(cfg, prNumber, comment);
    } catch (err) {
      console.warn(`[pipeline] #${issueNumber}: shipcheck-gate: PR mirror comment failed (non-fatal): ${String(err)}`);
    }
  }

  // Route based on mode and verdict.
  if (cfg.shipcheck_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate verdict=${verdict.verdict} (advisory mode); advancing`);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", `Shipcheck verdict: ${verdict.verdict} (advisory mode).`);
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: `shipcheck ${verdict.verdict} (advisory)` };
  }

  // Gate mode.
  if (verdict.verdict === "pass") {
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate passed; advancing`);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck passed.");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck passed" };
  }

  if (verdict.verdict === "partial") {
    if (cfg.shipcheck_gate.block_on_partial) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate partial verdict + block_on_partial; blocking`);
      await setBlockedFn(cfg, issueNumber, `Shipcheck gate: partial verdict.\n\n${verdict.summary}`, "shipcheck-gate", "needs-human" as BlockerKind);
      return { advanced: false, status: "blocked", reason: "shipcheck partial verdict", blockerKind: "needs-human" as BlockerKind };
    }
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate partial verdict (block_on_partial=false); advancing`);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck partial verdict (block_on_partial: false).");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck partial (not blocking)" };
  }

  // Fail verdict in gate mode.
  console.log(`[pipeline] #${issueNumber}: shipcheck-gate failed (gate mode); blocking`);
  await setBlockedFn(cfg, issueNumber, `Shipcheck gate failed.\n\n${verdict.summary}`, "shipcheck-gate", "needs-human" as BlockerKind);
  return { advanced: false, status: "blocked", reason: "shipcheck fail verdict", blockerKind: "needs-human" as BlockerKind };
}

// ---------------------------------------------------------------------------
// Rubric loading
// ---------------------------------------------------------------------------

/**
 * Load the rubric from the configured file path. When absent, logs a warning
 * and returns the provided fallback text (typically the issue's acceptance
 * criteria section or full body).
 *
 * Rejects absolute rubric_path values and paths that normalize outside the repo
 * root to prevent local file disclosure via a malicious .github/pipeline.yml.
 * Also resolves symlinks (via realpathFn) and rejects rubric files whose real
 * path exits the repo boundary — closing the symlink-escape class.
 */
function loadRubric(cfg: PipelineConfig, deps: ShipcheckDeps, fallback: string): string {
  const repoDir = path.resolve(cfg.repo_dir);
  const rubricPath = path.resolve(cfg.repo_dir, cfg.shipcheck_gate.rubric_path);

  // Check at the file-read boundary: reject absolute rubric_path and any path
  // that normalizes to outside the repo root (e.g. "../../etc/passwd").
  if (
    path.isAbsolute(cfg.shipcheck_gate.rubric_path) ||
    !rubricPath.startsWith(repoDir + path.sep)
  ) {
    console.warn(
      `[pipeline] shipcheck: rubric_path "${cfg.shipcheck_gate.rubric_path}" resolves outside the repo root; using issue acceptance criteria as rubric.`,
    );
    return fallback;
  }

  // Resolve symlinks: a repo-local path could be a symlink whose target exits
  // the repo (e.g. .github/shipcheck-rubric.md → /etc/passwd). Call realpathFn
  // on both repo and rubric to get canonical paths, then recheck the boundary.
  // When realpathFn throws (file not found, dir not found) we fall through to
  // readFileFn which returns null for missing files — no change in that path.
  const realpathFn = deps.realpathFn ?? ((p: string) => fs.realpathSync(p) as string);
  try {
    const realRepo = realpathFn(repoDir);
    const realRubric = realpathFn(rubricPath);
    if (!realRubric.startsWith(realRepo + path.sep) && realRubric !== realRepo) {
      console.warn(
        `[pipeline] shipcheck: rubric_path "${cfg.shipcheck_gate.rubric_path}" resolves via symlink to a path outside the repo; using issue acceptance criteria as rubric.`,
      );
      return fallback;
    }
  } catch {
    // realpathFn threw (file or dir does not exist) — fall through to readFileFn.
  }

  const readFileFn = deps.readFile ?? defaultReadFile;
  const contents = readFileFn(rubricPath);
  if (contents !== null) return contents;

  console.warn(
    `[pipeline] shipcheck: rubric file not found at ${rubricPath}; using issue acceptance criteria as rubric.`,
  );
  return fallback;
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context assembly helpers
// ---------------------------------------------------------------------------

/**
 * Extract an acceptance-criteria section from an issue body, or return "".
 * Looks for a heading matching /acceptance crit/i or /^## ac$/i.
 */
export function extractAcceptanceCriteria(body: string): string {
  const m = body.match(
    /(?:^|\n)(#{1,3} (?:[Aa]cceptance [Cc]riteria|AC)\b[\s\S]*?)(?=\n#{1,3} |\n---|\n\*{3}|$)/,
  );
  return m ? m[1].trim() : "";
}

/**
 * Extract the implementation plan + ACs from the issue's comment history.
 * Scans newest-first so that a "## Revised Implementation Plan" posted after
 * plan-review takes precedence over the stale original plan.
 */
function extractPlanFromComments(
  comments: { author: string; body: string; createdAt: string }[],
): string {
  const reversed = [...comments].reverse();
  // Prefer the revised plan posted after plan-review.
  for (const c of reversed) {
    if (c.body.startsWith("## Revised Implementation Plan")) {
      return c.body.slice(0, 4000);
    }
  }
  // Fall back to the latest original plan.
  for (const c of reversed) {
    if (c.body.startsWith("## Implementation Plan")) {
      return c.body.slice(0, 4000);
    }
  }
  return "(not available)";
}

/**
 * Build a changed-files summary from the PR diff, including per-file line-count
 * deltas (additions/deletions) parsed from the unified diff body.
 * Falls back gracefully when no PR is linked or the diff fetch fails.
 */
async function gatherChangedFiles(
  cfg: PipelineConfig,
  prNumber: number | null,
  getPrDiffFn: typeof defaultGetPrDiff,
): Promise<string> {
  if (!prNumber) return "(no PR linked)";
  try {
    const diff = await getPrDiffFn(cfg, prNumber);
    const files: { filePath: string; additions: number; deletions: number }[] = [];
    let current: { filePath: string; additions: number; deletions: number } | null = null;

    for (const line of diff.split("\n")) {
      const m = line.match(/^diff --git a\/(.*) b\//);
      if (m) {
        if (current) files.push(current);
        current = { filePath: m[1], additions: 0, deletions: 0 };
      } else if (current) {
        // Count added/removed lines; skip the unified diff header lines (+++ / ---).
        if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
        else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
      }
    }
    if (current) files.push(current);

    if (!files.length) return "(no files changed)";
    return files.map((f) => `${f.filePath} (+${f.additions} -${f.deletions})`).join("\n");
  } catch {
    return "(changed files: see PR diff)";
  }
}

/**
 * Extract an eval summary from the evidence bundle at stateDir.
 * Returns a short human-readable string or undefined when unavailable.
 */
async function gatherEvalSummary(
  stateDir: string,
  issueNumber: number,
  readBundleFn: (stateDir: string, issue: number) => Promise<EvidenceBundle | null>,
): Promise<string | undefined> {
  try {
    const bundle = await readBundleFn(stateDir, issueNumber);
    if (!bundle) return undefined;
    const evalStage = bundle.stages.find((s) => s.stage === "eval-gate");
    if (!evalStage) return undefined;
    const lastCmd = evalStage.commands[evalStage.commands.length - 1];
    if (!lastCmd) return undefined;
    const outcome = lastCmd.exitCode === 0 ? "PASS" : "FAIL";
    return `eval-gate: ${outcome}\n${lastCmd.outputExcerpt}`;
  } catch {
    return undefined;
  }
}

/**
 * Archive change dir names referenced by a list of repo-relative diff paths.
 * Matches `openspec/changes/archive/<name>/…` and returns the full dir name
 * (which is date-prefixed in this repo, e.g. "2026-06-08-add-eval-gate").
 * Pure; exported for tests.
 */
export function archiveNamesFromPaths(paths: string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const m = p.replace(/\\/g, "/").match(/(?:^|\/)openspec\/changes\/archive\/([^/]+)\//);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * Derive OpenSpec spec deltas from the worktree's branch diff.
 *
 * Pre-merge archives active change dirs before routing to shipcheck, so the
 * normal active-path check inside openspecContextFromDiff returns nothing for
 * those changes. The diff then shows `openspec/changes/archive/<date>-<id>/…`
 * paths instead — we extract the full (date-prefixed) archive dir name from
 * those paths and read the spec deltas directly from the archive location.
 *
 * Two bugs in the prior implementation:
 *   1. changeIdsFromPaths explicitly ignores archive paths (m[1] !== "archive").
 *   2. Even if IDs were found, "archive/<id>" skipped the date prefix so the
 *      lookup dir didn't exist (real path is "archive/<date>-<id>").
 * archiveNamesFromPaths fixes both by extracting the full archive dir name.
 */
async function gatherOpenspecDeltas(
  cfg: PipelineConfig,
  wtPath: string,
  gitDiffNamesFn: (wtPath: string, base: string) => Promise<string[]>,
  readSpecDeltasFn: (wtPath: string, name: string) => string,
): Promise<string | undefined> {
  try {
    const diffPaths = await gitDiffNamesFn(wtPath, cfg.base_branch);

    // Try active change dirs first (the normal pre-archive path).
    const activeDeltas = openspecContextFromDiff(cfg, wtPath, diffPaths);
    if (activeDeltas) return activeDeltas;

    // After pre-merge archives the change, active dirs are gone and the diff
    // shows `openspec/changes/archive/<date>-<id>/…` paths. Respect explicit
    // opt-out; presence of archive paths in the diff implies the integration
    // is otherwise active for this repo.
    if (cfg.openspec?.enabled === "off") return undefined;
    const archiveNames = archiveNamesFromPaths(diffPaths);
    if (!archiveNames.length) return undefined;
    const archivedParts = archiveNames
      .map((name) => readSpecDeltasFn(wtPath, `archive/${name}`))
      .filter(Boolean);
    return archivedParts.length ? archivedParts.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}

/** Default git diff --name-only implementation. */
async function defaultGitDiffNames(wtPath: string, base: string): Promise<string[]> {
  const result = await defaultGitInWorktree(
    wtPath,
    ["diff", "--name-only", `origin/${base}...HEAD`],
    { ignoreFailure: true },
  );
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}
