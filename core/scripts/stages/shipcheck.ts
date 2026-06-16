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
  getIssueDetail as defaultGetIssueDetail,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { invoke as defaultInvoke } from "../harness.ts";
import { substitute } from "../prompts/index.ts";
import { SHIPCHECK_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import type {
  BlockerKind,
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

function isShipcheckVerdict(v: unknown): v is ShipcheckVerdict {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (!["pass", "partial", "fail"].includes(o.verdict as string)) return false;
  if (typeof o.summary !== "string") return false;
  if (!Array.isArray(o.criteria)) return false;
  return true;
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
  postComment?: typeof defaultPostComment;
  postPrComment?: typeof defaultPostPrComment;
  transition?: typeof defaultTransition;
  silentTransition?: typeof defaultSilentTransition;
  setBlocked?: typeof defaultSetBlocked;
  /** Read a file at the given absolute path. Returns null when not found. */
  readFile?: (filePath: string) => string | null;
  /** Invoke the reviewer harness with a prompt. Returns stdout string or null on failure. */
  invokeReviewer?: (prompt: string, worktreeDir: string, timeoutSec: number) => Promise<{ stdout: string; success: boolean }>;
}

// ---------------------------------------------------------------------------
// Main stage handler
// ---------------------------------------------------------------------------

export interface AdvanceShipcheckOpts {
  dryRun?: boolean;
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

  // Load rubric.
  const rubric = loadRubric(cfg, deps);

  // Build a basic changed-files summary from the PR.
  const changedFilesSummary = "(changed files: see PR diff)";

  // Assemble prompt context.
  const prompt = buildShipcheckPrompt({
    rubric,
    issueBody: detail.body,
    planAndAcs: "(plan: see issue and PR comments)",
    changedFiles: changedFilesSummary,
    evalSummary: undefined,
    openspecDeltas: undefined,
  });

  // Run reviewer harness up to max_rounds.
  const maxRounds = cfg.shipcheck_gate.max_rounds;
  const reviewerHarness = cfg.harnesses.reviewer;
  const timeoutSec = 300; // default per-round timeout

  let verdict: ShipcheckVerdict | null = null;
  let parseFailure = false;

  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1) {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate retry (round ${round}/${maxRounds})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: shipcheck-gate invoking reviewer (${reviewerHarness})`);
    }

    let stdout: string;
    if (deps.invokeReviewer) {
      const result = await deps.invokeReviewer(prompt, cfg.repo_dir, timeoutSec);
      if (!result.success && !result.stdout.trim()) {
        continue;
      }
      stdout = result.stdout;
    } else {
      const result = await defaultInvoke(reviewerHarness, cfg.repo_dir, prompt, {
        timeoutSec,
      });
      if (!result.success && !result.stdout.trim()) {
        continue;
      }
      stdout = result.stdout;
    }

    let warnCalled = false;
    const parsed = parseShipcheckVerdict(stdout, (msg) => {
      console.warn(msg);
      warnCalled = true;
    });
    if (!warnCalled) {
      // Clean parse.
      verdict = parsed;
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
      return { advanced: false, status: "blocked", reason: "shipcheck parse failure after max rounds" };
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
      return { advanced: false, status: "blocked", reason: "shipcheck: no harness output" };
    }
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck: no harness output (advisory); advancing.");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck no output (advisory)" };
  }

  // Post verdict comment.
  const comment = formatShipcheckComment(verdict, cfg.shipcheck_gate.mode);
  await postCommentFn(cfg, issueNumber, comment);
  if (prNumber) {
    await postPrCommentFn(cfg, prNumber, comment);
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
      return { advanced: false, status: "blocked", reason: "shipcheck partial verdict" };
    }
    console.log(`[pipeline] #${issueNumber}: shipcheck-gate partial verdict (block_on_partial=false); advancing`);
    await transitionFn(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "Shipcheck partial verdict (block_on_partial: false).");
    return { advanced: true, from: "shipcheck-gate", to: "ready-to-deploy", summary: "shipcheck partial (not blocking)" };
  }

  // Fail verdict in gate mode.
  console.log(`[pipeline] #${issueNumber}: shipcheck-gate failed (gate mode); blocking`);
  await setBlockedFn(cfg, issueNumber, `Shipcheck gate failed.\n\n${verdict.summary}`, "shipcheck-gate", "needs-human" as BlockerKind);
  return { advanced: false, status: "blocked", reason: "shipcheck fail verdict" };
}

// ---------------------------------------------------------------------------
// Rubric loading
// ---------------------------------------------------------------------------

function loadRubric(cfg: PipelineConfig, deps: ShipcheckDeps): string {
  const rubricPath = path.resolve(cfg.repo_dir, cfg.shipcheck_gate.rubric_path);
  const readFileFn = deps.readFile ?? defaultReadFile;
  const contents = readFileFn(rubricPath);
  if (contents !== null) return contents;

  console.warn(
    `[pipeline] shipcheck: rubric file not found at ${rubricPath}; falling back to issue body as rubric.`,
  );
  return "(rubric file not found — evaluating against issue acceptance criteria)";
}

function defaultReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
