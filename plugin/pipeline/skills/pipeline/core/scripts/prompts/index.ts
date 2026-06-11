// Loaders for prompt templates with placeholder substitution.
//
// Templates live alongside this file as `<name>.md`. Placeholders use
// {{key}} syntax and are replaced with the values supplied to each builder.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { domainContext, readConventions } from "../config.ts";
import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
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
  /**
   * Human comments left on the posted plan, pre-formatted as `@login: body`
   * blocks (#26). When absent/blank the human-feedback section is omitted and
   * the rendered prompt is identical to one built without this parameter.
   */
  humanFeedback?: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildPlanRevisionPrompt(a: BuildPlanRevisionArgs): string {
  const dc = domainContext(a.cfg);
  const humanFeedback =
    a.humanFeedback && a.humanFeedback.trim()
      ? `\nHuman comments on the plan:\n\n${a.humanFeedback.trim()}\n\nIncorporate the human comments above. End your revised plan with a section headed exactly "## Human Feedback Acknowledgement" that lists each commenter as "- @login: addressed — <reason>" or "- @login: declined — <reason>". This section is required when human comments are present.\n`
      : "";
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
    human_feedback: humanFeedback,
    spec_context: specContextSection(a.specContext),
  });
}

export interface BuildImplementingArgs extends BuildPlanArgs {
  plan: string;
  /** Pipeline run identifier for the commit traceability trailers (#20). */
  pipelineRunId: string;
  /**
   * When true (`cfg.steps.docs`), the prompt instructs the implementer to
   * update affected documentation as part of the same change, so docs land
   * inside the reviewed diff (#91). When false, no docs ask is included.
   */
  docsEnabled?: boolean;
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
    docs_instruction: a.docsEnabled ? DOCS_INSTRUCTION_SECTION : "",
    spec_context: specContextSection(a.specContext),
  });
}

/**
 * Documentation ask folded into the implementing prompt when `steps.docs` is
 * on (#91): the implementer updates docs in the same change, so they are part
 * of the reviewed diff and the happy path needs no second CI cycle. Leading
 * newline + trailing newline keep the rendered prompt free of double blank
 * lines whether or not the section is present (same shape as spec_context).
 */
const DOCS_INSTRUCTION_SECTION = `
## Documentation Updates

Documentation is part of this change — update it in the same commit(s) so reviewers see code and docs together. Check and update where affected:
- **README.md** — if user-visible setup, workflows, features, or operations changed
- **CLAUDE.md** — if the change affects conventions agents need to know
- **Config docs and examples** — if config keys, flags, env vars, or setup steps were added or changed
- **Docstrings/comments in the files you changed** — if they are now inaccurate
- **Repo-local ops docs or runbooks** — if the change touches what they describe

If no documentation is affected, change nothing — do not add boilerplate docs.
`;

// Shared finding-severity rubric injected into BOTH review prompts so the
// reviewer's severity labels stay calibrated to what `review_policy.block_threshold`
// actually blocks on (#17). Single-sourced (like {{schema_block}}) so the two
// prompts cannot drift. An inflated severity turns an advisory note into a
// blocking fix round and is a primary cause of non-converging review loops.
const SEVERITY_RUBRIC = `## Severity Rubric

Rate each finding honestly against real-world impact — do NOT inflate. The policy blocks at its \`block_threshold\` and advances on anything below, so severity is the difference between a blocking fix round and an advisory note.

- **critical** — data loss/corruption, security or auth-boundary bypass, customer-facing outage, or an irreversible/unrecoverable state change.
- **high** — a real correctness defect, a race/ordering bug with concrete impact, or a failure path that strands a production dependency.
- **medium** — degraded-but-recoverable behavior, a missing edge case, or a hazard that needs a specific trigger to bite.
- **low** — defensive hardening, observability gaps, or minor inconsistencies unlikely to affect production.

Set each finding's \`category\` to a short machine-readable class (e.g. \`spec-divergence\`, \`correctness\`, \`security\`, \`data-loss\`, \`concurrency\`, \`observability\`) so downstream gates can key on the field instead of parsing prose.`;

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
    severity_rubric: SEVERITY_RUBRIC,
    schema_block: REVIEW_VERDICT_SCHEMA_BLOCK,
    diff: truncateDiff(a.diff, 50_000),
  });
}

export interface BuildAdversarialArgs extends BuildPlanArgs {
  diff: string;
  review1Summary?: string;
  /** Prior round-2 review comment, supplied only when review-2 is RE-running
   * after a fix (the convergence ratchet). Scopes the re-review to "verify
   * these are resolved + only escalating new findings" instead of a fresh hunt. */
  priorReview2Findings?: string;
  /** OpenSpec spec deltas for this change (empty/undefined when not applicable). */
  specContext?: string;
}

export function buildReviewAdversarialPrompt(a: BuildAdversarialArgs): string {
  const dc = domainContext(a.cfg);
  const review1Section = a.review1Summary
    ? `## Review 1 Summary (already addressed)\n\n${a.review1Summary}\n\nThe issues above were already fixed. Focus on finding NEW problems.`
    : "";
  const priorReview2Section = a.priorReview2Findings
    ? `## Prior Adversarial Findings (this is a re-review)\n\nThe previous adversarial round raised the findings below; a fix has since landed:\n\n${a.priorReview2Findings}\n\nFirst, verify EACH prior finding is resolved — if any regressed, re-raise it. Then you may raise NEW findings, but only those introduced by the changes since that review and at or above the severity of the findings being fixed. Do not re-scan unchanged code for fresh lower-grade tangents — that is what prevents the review from converging.`
    : "";
  return substitute(loadTemplate("review_adversarial"), {
    domain_name: dc.name,
    domain_description: dc.description,
    conventions: readConventions(a.cfg),
    issue_number: String(a.issueNumber),
    title: a.title,
    body: a.body || "(no description)",
    review1_section: review1Section,
    prior_review2_findings: priorReview2Section,
    spec_context: specSection(a.specContext),
    severity_rubric: SEVERITY_RUBRIC,
    schema_block: REVIEW_VERDICT_SCHEMA_BLOCK,
    diff: truncateDiff(a.diff, 50_000),
  });
}

export interface BuildFixArgs {
  issueNumber: number;
  title: string;
  reviewFindings: string;
  /** Findings from ALL prior rounds on this PR (not just the current one), so the
   * fixer doesn't revert an earlier fix and re-trigger a resolved finding. */
  priorReviewHistory?: string;
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
    prior_review_history: fixHistorySection(a.priorReviewHistory),
    pipeline_run_id: a.pipelineRunId,
    spec_context: specContextSection(a.specContext),
    spec_revision_instruction: fixSpecRevisionInstruction(a.specContext),
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

function fixHistorySection(history?: string): string {
  if (!history || !history.trim()) return "";
  return (
    "\n## Prior Review Rounds (history)\n\n" +
    "These are findings from earlier rounds on this PR and the fixes already applied for them. " +
    "Do NOT revert a fix you previously made to satisfy a prior finding; if a prior fix is missing " +
    "from the current code, reapply it.\n\n" +
    history.trim() +
    "\n"
  );
}

function specContextSection(specContext?: string): string {
  if (!specContext || !specContext.trim()) return "";
  return (
    "\n## OpenSpec — Intended Behavior (spec deltas)\n\n" +
    "This work must stay consistent with these requirement changes.\n\n" +
    specContext.trim() +
    "\n"
  );
}

/**
 * Fix-round-only instruction (#106): when OpenSpec spec deltas are present, the
 * fix harness is permitted — and instructed — to revise the active change's
 * `specs/**` deltas if a finding's fix changes behavior they describe, so the
 * frozen-at-planning delta cannot drift out of sync with the implementation.
 * Empty (prompt unchanged) when no spec context is present, so the non-OpenSpec
 * fix path is identical. Self-delimiting (leading + trailing newline) so it
 * renders cleanly placed adjacent to {@link specContextSection}.
 */
function fixSpecRevisionInstruction(specContext?: string): string {
  if (!specContext || !specContext.trim()) return "";
  return (
    "\n### OpenSpec — keep the spec delta consistent with your fix\n\n" +
    "If addressing a finding changes behavior described by the spec deltas above, update the active " +
    "OpenSpec change's `specs/**` files (and `tasks.md`) so the spec matches the new behavior, then run " +
    "`openspec validate <id>` (the change you are working on) and include the updated spec files in the " +
    "**same** fix commit. This is the one exception to \"Do NOT change anything unrelated\" below: spec-delta " +
    "files your fix makes inaccurate SHALL be brought back into agreement. Do not otherwise rewrite the " +
    "spec — change only what your behavioral fix requires, and if no finding changes described behavior, " +
    "leave the spec deltas untouched.\n"
  );
}

function truncateDiff(diff: string, cap: number): string {
  if (diff.length <= cap) return diff;
  return diff.slice(0, cap) + `\n\n[...diff truncated at ${Math.floor(cap / 1000)}KB]`;
}

// Exported for tests
export const _testing = { loadTemplate };
