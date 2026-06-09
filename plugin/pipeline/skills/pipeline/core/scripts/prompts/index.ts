// Loaders for prompt templates with placeholder substitution.
//
// Templates live alongside this file as `<name>.md`. Placeholders use
// {{key}} syntax and are replaced with the values supplied to each builder.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { domainContext, readConventions } from "../config.ts";
import type { PipelineConfig } from "../types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function loadTemplate(name: string): string {
  return fs.readFileSync(path.join(here, `${name}.md`), "utf8");
}

export function substitute(template: string, vars: Record<string, string>): string {
  // Validate placeholders against the TEMPLATE, not the post-substitution
  // output. The output legitimately contains user content (issue bodies,
  // diffs, file contents) that may have its own `{{...}}` literals — Jinja
  // (`{{ url_for(...) }}`), Handlebars, Vue, Mustache, etc. Scanning the
  // output for stray placeholders would falsely fail any time the diff
  // touches a templated frontend file.
  const templateKeys = new Set<string>();
  const placeholderRe = /\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = placeholderRe.exec(template)) !== null) {
    templateKeys.add(m[1]);
  }
  const missing = [...templateKeys].filter((k) => !(k in vars));
  if (missing.length > 0) {
    throw new Error(
      `Unfilled prompt placeholder(s) ${missing.map((k) => `{{${k}}}`).join(", ")} ` +
        `(template substitution missed a key).`,
    );
  }
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, "g");
    out = out.replace(re, value);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface BuildPlanArgs {
  cfg: PipelineConfig;
  issueNumber: number;
  title: string;
  body: string;
  /** Optional carry-forward context (e.g. a last30days brief) for planning prompts. */
  carryForward?: string;
}

export function buildPlanningPrompt(a: BuildPlanArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("planning"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    carry_forward_context: carryForwardSection(a.carryForward),
  });
}

export interface BuildPlanningOpenspecArgs extends BuildPlanArgs {
  pipelineRunId: string;
}

/** OpenSpec-mode planning: the implementer authors a change (proposal/tasks/
 *  spec deltas) instead of a freeform plan. */
export function buildPlanningOpenspecPrompt(a: BuildPlanningOpenspecArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("planning_openspec"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    carry_forward_context: carryForwardSection(a.carryForward),
    pipeline_run_id: a.pipelineRunId,
  });
}

export interface BuildPlanReviewArgs extends BuildPlanArgs {
  plan: string;
  reviewer: string;
  implementer: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildPlanReviewPrompt(a: BuildPlanReviewArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("plan_review"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    plan: a.plan,
    reviewer: a.reviewer,
    implementer: a.implementer,
    spec_context: specContextSection(a.specContext),
  });
}

export interface BuildPlanRevisionArgs extends BuildPlanArgs {
  plan: string;
  feedback: string;
  reviewer: string;
  implementer: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildPlanRevisionPrompt(a: BuildPlanRevisionArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("plan_revision"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    plan: a.plan,
    feedback: a.feedback,
    reviewer: a.reviewer,
    implementer: a.implementer,
    spec_context: specContextSection(a.specContext),
  });
}

export interface BuildImplementingArgs extends BuildPlanArgs {
  plan: string;
  /** Pipeline run identifier for the commit traceability trailers (#20). */
  pipelineRunId: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildImplementingPrompt(a: BuildImplementingArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("implementing"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    plan: a.plan,
    pipeline_run_id: a.pipelineRunId,
    spec_context: specContextSection(a.specContext),
  });
}

export interface BuildReviewArgs extends BuildPlanArgs {
  plan: string;
  diff: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildReviewStandardPrompt(a: BuildReviewArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("review_standard"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    plan: a.plan,
    spec_context: specSection(a.specContext),
    diff: truncateDiff(a.diff, 50_000),
  });
}

export interface BuildAdversarialArgs extends BuildPlanArgs {
  diff: string;
  review1Summary?: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildReviewAdversarialPrompt(a: BuildAdversarialArgs): string {
  const dc = domainContext(a.cfg);
  const review1Section = a.review1Summary
    ? `## Review 1 Summary (already addressed)\n\n${a.review1Summary}\n\nThe issues above were already fixed. Focus on finding NEW problems.`
    : "";
  return substitute(loadTemplate("review_adversarial"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    review1_section: review1Section,
    spec_context: specSection(a.specContext),
    diff: truncateDiff(a.diff, 50_000),
  });
}

export interface BuildFixArgs {
  issueNumber: number;
  title: string;
  reviewFindings: string;
  fixRound: 1 | 2;
  /** Pipeline run identifier for the commit traceability trailers (#20). */
  pipelineRunId: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildFixPrompt(a: BuildFixArgs): string {
  return substitute(loadTemplate("fix"), {
    issue_number: String(a.issueNumber),
    title: a.title,
    fix_round: String(a.fixRound),
    review_type: a.fixRound === 1 ? "standard" : "adversarial",
    review_findings: a.reviewFindings,
    pipeline_run_id: a.pipelineRunId,
    spec_context: specContextSection(a.specContext),
  });
}

export interface BuildTestFixArgs {
  issueNumber: number;
  /** Human-readable command string (e.g. "pnpm run test"). */
  command: string;
  attempt: number;
  maxAttempts: number;
  /** Captured failure output from the test/build run. */
  output: string;
  /** Pipeline run identifier for the commit traceability trailers (#20). */
  pipelineRunId: string;
}

export function buildTestFixPrompt(a: BuildTestFixArgs): string {
  return substitute(loadTemplate("test_fix"), {
    issue_number: String(a.issueNumber),
    command: a.command,
    attempt: String(a.attempt),
    max_attempts: String(a.maxAttempts),
    test_output: truncateDiff(a.output, 16_000),
    pipeline_run_id: a.pipelineRunId,
  });
}

export interface BuildDocsArgs {
  cfg: PipelineConfig;
  issueNumber: number;
  title: string;
  diff: string;
}

export function buildDocsUpdatePrompt(a: BuildDocsArgs): string {
  const dc = domainContext(a.cfg);
  return substitute(loadTemplate("docs_update"), {
    domain_name: dc.name,
    domain_description: dc.description,
    issue_number: String(a.issueNumber),
    title: a.title,
    diff: truncateDiff(a.diff, 40_000),
  });
}

function carryForwardSection(s?: string): string {
  if (!s || !s.trim()) return "";
  return (
    "## Carry-Forward Context (last 30 days of public discourse)\n\n" +
    "Use this only where it informs the work; ignore irrelevant noise.\n\n" +
    s.trim()
  );
}

function specSection(specContext?: string): string {
  if (!specContext || !specContext.trim()) return "";
  return (
    "## OpenSpec — Intended Behavior (spec deltas)\n\n" +
    "The diff must satisfy these requirement changes. Flag any divergence from them.\n\n" +
    specContext.trim()
  );
}

function specContextSection(specContext?: string): string {
  if (!specContext || !specContext.trim()) return "";
  return (
    "\n## OpenSpec — Intended Behavior (spec deltas)\n\n" +
    "This work must satisfy these requirement changes.\n\n" +
    specContext.trim() +
    "\n"
  );
}

function truncateDiff(diff: string, cap: number): string {
  if (diff.length <= cap) return diff;
  return diff.slice(0, cap) + `\n\n[...diff truncated at ${Math.floor(cap / 1000)}KB]`;
}

// Exported for tests
export const _testing = { loadTemplate };
