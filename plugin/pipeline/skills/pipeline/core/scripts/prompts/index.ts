// Loaders for prompt templates with placeholder substitution.
//
// Templates live alongside this file as `<name>.md`. Placeholders use
// {{key}} syntax and are replaced with the values supplied to each builder.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { domainContext, readConventions } from "../config.ts";
import { REVIEW_VERDICT_SCHEMA_BLOCK } from "../review-schema.ts";
import { DEFAULT_CONFIG } from "../types.ts";
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

// Shared confidence calibration injected into BOTH review prompts (#57), single-
// sourced like SEVERITY_RUBRIC so the two rounds cannot drift. It gives the
// `confidence` field consistent meaning run-to-run and ties it to
// `review_policy.min_confidence` (#86): a finding below the policy floor is
// advisory regardless of severity, so honest low confidence is how the reviewer
// flags uncertainty without forcing a wasted fix round. Bands reference the
// policy concept, not the configured number, so the text stays correct when a
// repo tunes its floor.
const CONFIDENCE_CALIBRATION_BLOCK = `## Confidence Calibration

Set each finding's \`confidence\` honestly — do NOT default to a high value. The active \`review_policy\` treats a finding whose \`confidence\` is below its \`min_confidence\` floor as ADVISORY (recorded, but it does not block) regardless of severity; a finding at or above the floor blocks per the severity \`block_threshold\`. Calibrated confidence is how you flag genuine uncertainty without forcing a fix round.

- **High (>= 0.8)** — you have concrete evidence in the diff; the finding is fully traceable to a specific code path you can point at.
- **Medium (0.5–0.8)** — you have a reasonable basis but cannot rule out missing context; the finding is plausible, not certain.
- **Low (< 0.5)** — you are speculating or lack the context to be sure; the finding may not apply at all.

If you cannot trace a finding to a specific code path in the diff, its confidence belongs below 0.5 — or omit the finding entirely.`;

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
    confidence_calibration: buildConfidenceCalibrationWithPolicy(a.cfg.review_policy),
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
    confidence_calibration: buildConfidenceCalibrationWithPolicy(a.cfg.review_policy),
    schema_block: REVIEW_VERDICT_SCHEMA_BLOCK,
    diff: truncateDiff(a.diff, 50_000),
  });
}

export interface BuildFixArgs {
  /** Used to embed the target repo's conventions via {@link readConventions},
   * the same way {@link buildImplementingPrompt} does (#108) — so the editing
   * fix round is convention-aware explicitly, not via best-effort host auto-load. */
  cfg: PipelineConfig;
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
    conventions: readConventions(a.cfg),
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
  /** Used to embed the target repo's conventions via {@link readConventions} (#108),
   * mirroring {@link buildImplementingPrompt} so the test-fix editing round is
   * convention-aware explicitly rather than via best-effort host auto-load. */
  cfg: PipelineConfig;
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
    conventions: readConventions(a.cfg),
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

/**
 * Augments the shared calibration block with the active review_policy values so
 * reviewers can tell concretely whether a given confidence score will block or
 * advise under this repo's configuration (#57). Falls back to DEFAULT_CONFIG when
 * cfg.review_policy is absent (e.g. in tests that omit it).
 */
function buildConfidenceCalibrationWithPolicy(
  reviewPolicy?: { min_confidence?: number; block_threshold?: string },
): string {
  const defaults = DEFAULT_CONFIG.review_policy;
  const minConf = reviewPolicy?.min_confidence ?? defaults.min_confidence;
  const blockThresh = reviewPolicy?.block_threshold ?? defaults.block_threshold;
  return (
    CONFIDENCE_CALIBRATION_BLOCK +
    `\n\nActive policy: min_confidence \`${minConf}\`, block_threshold \`${blockThresh}\`. ` +
    `Findings with confidence < ${minConf} are advisory regardless of severity; ` +
    `at or above ${minConf} they block when severity meets the \`${blockThresh}\` threshold.`
  );
}

export interface BuildIntakeArgs {
  description: string;
  repoContext: string;
  roadmapContext: string;
}

export function buildIntakePrompt(a: BuildIntakeArgs): string {
  return substitute(loadTemplate("intake"), {
    description: a.description,
    repo_context: a.repoContext,
    roadmap_context: a.roadmapContext,
  });
}

export interface BuildSweepArgs {
  issueTitle: string;
  existingBody: string;
  repoContext: string;
}

export function buildSweepPrompt(a: BuildSweepArgs): string {
  return substitute(loadTemplate("sweep"), {
    issue_title: a.issueTitle,
    existing_body: a.existingBody,
    repo_context: a.repoContext,
  });
}

// Exported for tests. CONFIDENCE_CALIBRATION_BLOCK is exposed so the drift test
// can assert both review prompts embed the shared constant byte-for-byte.
export const _testing = { loadTemplate, CONFIDENCE_CALIBRATION_BLOCK };
