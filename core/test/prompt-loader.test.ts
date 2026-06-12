// Prompt loader: every template loads, placeholders substitute, unfilled
// placeholders fail loud.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  _testing,
  buildFixPrompt,
  buildImplementingPrompt,
  buildPlanningOpenspecPrompt,
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
  buildTestFixPrompt,
  substitute,
} from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function dummyConfig(): PipelineConfig {
  return {
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    domain_name: "Widget",
    domain_description: "the example widget service",
  };
}

/**
 * Config whose `conventions_md_path` resolves to a real, non-empty file on disk
 * containing `marker`, so `readConventions(cfg)` returns that content. Used to
 * assert the fix/test-fix prompts actually embed target-repo conventions (#108).
 */
function configWithConventions(marker: string): PipelineConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-conv-"));
  fs.writeFileSync(path.join(dir, "CONVENTIONS.md"), marker);
  return { ...dummyConfig(), repo_dir: dir, conventions_md_path: "CONVENTIONS.md" };
}

test("substitute: simple replacement", () => {
  const out = substitute("hello {{name}}!", { name: "world" });
  assert.equal(out, "hello world!");
});

test("substitute: multiple occurrences and keys", () => {
  const out = substitute("{{a}} - {{b}} - {{a}}", { a: "1", b: "2" });
  assert.equal(out, "1 - 2 - 1");
});

test("substitute: throws on unfilled placeholder", () => {
  assert.throws(
    () => substitute("hello {{missing}}!", { other: "ok" }),
    /Unfilled prompt placeholder/,
  );
});

test("planning prompt: builds with all keys substituted", () => {
  const out = buildPlanningPrompt({
    cfg: dummyConfig(),
    issueNumber: 42,
    title: "Add feature X",
    body: "do the thing",
  });
  assert.match(out, /#42/);
  assert.match(out, /Add feature X/);
  assert.match(out, /do the thing/);
  assert.match(out, /Widget/); // domain_name
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("planning prompt: empty body becomes (no description)", () => {
  const out = buildPlanningPrompt({
    cfg: dummyConfig(),
    issueNumber: 1,
    title: "t",
    body: "",
  });
  assert.match(out, /\(no description\)/);
});

test("planning_openspec prompt: builds with all keys + OpenSpec guidance", () => {
  const out = buildPlanningOpenspecPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "Add feature Y",
    body: "spec it",
    pipelineRunId: "7/2026-06-08T14:32:00Z",
  });
  assert.match(out, /#7/);
  assert.match(out, /Add feature Y/);
  assert.match(out, /OpenSpec/);
  assert.match(out, /openspec\/changes/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("planning_openspec prompt: instructs the trailers with substituted issue + run id (#20)", () => {
  const out = buildPlanningOpenspecPrompt({
    cfg: dummyConfig(),
    issueNumber: 42,
    title: "Some feature",
    body: "body",
    pipelineRunId: "42/2026-06-08T14:32:00Z",
  });
  assert.match(out, /Issue: #42/);
  assert.match(out, /Pipeline-Run: 42\/2026-06-08T14:32:00Z/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("planning prompt: injects carry-forward context when provided", () => {
  const out = buildPlanningPrompt({
    cfg: dummyConfig(),
    issueNumber: 9,
    title: "t",
    body: "b",
    carryForward: "### 1. Big cluster (score 9)",
  });
  assert.match(out, /Carry-Forward Context/);
  assert.match(out, /Big cluster/);
});

test("planning prompt: no carry-forward section + no leftover placeholders when absent", () => {
  const out = buildPlanningPrompt({ cfg: dummyConfig(), issueNumber: 9, title: "t", body: "b" });
  assert.doesNotMatch(out, /Carry-Forward Context/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("review_standard: injects OpenSpec spec context when provided", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    body: "b",
    plan: "p",
    diff: "d",
    specContext: "REQ: user must be able to log in",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /must be able to log in/);
});

test("review_standard: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    body: "b",
    plan: "p",
    diff: "d",
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("review_adversarial: injects OpenSpec spec context when provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 6,
    title: "t",
    body: "b",
    diff: "d",
    specContext: "REQ: tokens must expire",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /tokens must expire/);
});

test("plan_review prompt: includes plan, implementer, and reviewer", () => {
  const out = buildPlanReviewPrompt({
    cfg: dummyConfig(),
    issueNumber: 101,
    title: "Plan me",
    body: "Body",
    plan: "PLAN-CONTENT",
    implementer: "codex",
    reviewer: "claude",
  });
  assert.match(out, /PLAN-CONTENT/);
  assert.match(out, /codex/);
  assert.match(out, /claude/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_revision prompt: includes review feedback", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 102,
    title: "Revise me",
    body: "Body",
    plan: "ORIGINAL-PLAN",
    feedback: "REVIEW-FEEDBACK",
    implementer: "claude",
    reviewer: "codex",
  });
  assert.match(out, /ORIGINAL-PLAN/);
  assert.match(out, /REVIEW-FEEDBACK/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_revision prompt: omits human feedback section when humanFeedback absent (#26)", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 102,
    title: "Revise me",
    body: "Body",
    plan: "ORIGINAL-PLAN",
    feedback: "REVIEW-FEEDBACK",
    implementer: "claude",
    reviewer: "codex",
  });
  assert.doesNotMatch(out, /Human comments on the plan/);
  assert.doesNotMatch(out, /human comments above/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
  // Regression: no-feedback path must match the original revision instruction baseline
  assert.match(out, /Incorporate valid feedback, resolve conflicts explicitly, and keep the plan surgical\./);
});

test("plan_revision prompt: includes formatted human comments when provided (#26)", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 102,
    title: "Revise me",
    body: "Body",
    plan: "ORIGINAL-PLAN",
    feedback: "REVIEW-FEEDBACK",
    implementer: "claude",
    reviewer: "codex",
    humanFeedback: "@alice: please use the existing helper",
  });
  assert.match(out, /Human comments on the plan/);
  assert.match(out, /@alice: please use the existing helper/);
  assert.match(out, /REVIEW-FEEDBACK/);
  assert.match(out, /Incorporate the human comments above/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("implementing prompt: includes plan", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "PLAN-CONTENT-XYZ",
    pipelineRunId: "100/2026-06-08T14:32:00Z",
  });
  assert.match(out, /PLAN-CONTENT-XYZ/);
});

// #108: the conventions instruction must be accurate under BOTH profiles — the
// codex profile's conventions file is AGENTS.md, so the instruction must not name
// only CLAUDE.md. dummyConfig has no real conventions file (stub), so AGENTS.md can
// only come from the instruction line itself.
test("implementing prompt: conventions instruction names both CLAUDE.md and AGENTS.md, not just CLAUDE.md (#108)", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "100/2026-06-08T14:32:00Z",
  });
  assert.match(out, /AGENTS\.md/, "instruction must name AGENTS.md so it is correct under the codex profile");
  assert.match(out, /CLAUDE\.md/);
});

test("implementing prompt: instructs the trailers with substituted issue + run id (#20)", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "100/2026-06-08T14:32:00Z",
  });
  assert.match(out, /Issue: #100/);
  assert.match(out, /Pipeline-Run: 100\/2026-06-08T14:32:00Z/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("implementing prompt: docsEnabled adds the documentation-update instruction (#91)", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "100/2026-06-08T14:32:00Z",
    docsEnabled: true,
  });
  assert.match(out, /## Documentation Updates/);
  assert.match(out, /README\.md/);
  assert.match(out, /CLAUDE\.md/);
  // #108: the docs-update ask also names the conventions file; it must name
  // AGENTS.md too so it is accurate under the codex profile, not CLAUDE.md only.
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /do not add boilerplate docs/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
  assert.doesNotMatch(out, /\n\n\n/);
});

test("implementing prompt: docsEnabled false omits any docs ask (#91)", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 100,
    title: "Title",
    body: "Body",
    plan: "p",
    pipelineRunId: "100/2026-06-08T14:32:00Z",
    docsEnabled: false,
  });
  assert.doesNotMatch(out, /Documentation Updates/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
  assert.doesNotMatch(out, /\n\n\n/);
});

test("review_standard: includes plan + diff and the JSON schema", () => {
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    plan: "PLAN",
    diff: "diff --git a/x b/x\n+hello\n",
  });
  assert.match(out, /PLAN/);
  assert.match(out, /\+hello/);
  assert.match(out, /"verdict"/);
  assert.match(out, /"findings"/);
});

test("review_adversarial: omits review1 section when not provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    diff: "diff",
  });
  assert.doesNotMatch(out, /Review 1 Summary/);
});

test("review_adversarial: includes review1 section when provided", () => {
  const out = buildReviewAdversarialPrompt({
    cfg: dummyConfig(),
    issueNumber: 7,
    title: "T",
    body: "B",
    diff: "diff",
    review1Summary: "ROUND-ONE-SUMMARY",
  });
  assert.match(out, /Review 1 Summary/);
  assert.match(out, /ROUND-ONE-SUMMARY/);
});

test("review_adversarial: omits the ratchet section on a first run, includes it on a re-run", () => {
  const base = { cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", diff: "diff" };
  const first = buildReviewAdversarialPrompt(base);
  assert.doesNotMatch(first, /Prior Adversarial Findings/);
  const rerun = buildReviewAdversarialPrompt({
    ...base,
    priorReview2Findings: "## Review 2 — needs-attention\n- [HIGH] stranding",
  });
  assert.match(rerun, /Prior Adversarial Findings \(this is a re-review\)/);
  assert.match(rerun, /verify EACH prior finding is resolved/);
  assert.match(rerun, /stranding/);
});

test("review prompts: both include the shared severity rubric (calibration for the policy threshold)", () => {
  const std = buildReviewStandardPrompt({
    cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", plan: "P", diff: "d",
  });
  const adv = buildReviewAdversarialPrompt({ cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", diff: "d" });
  for (const out of [std, adv]) {
    assert.match(out, /## Severity Rubric/);
    assert.match(out, /do NOT inflate/);
    assert.match(out, /machine-readable class/); // the `category` tagging guidance
  }
});

test("review_adversarial: enumerate-all replaces the old one-finding-at-a-time instruction (the drip fix)", () => {
  const out = buildReviewAdversarialPrompt({ cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", diff: "d" });
  assert.match(out, /Enumerate EVERY material finding/);
  assert.doesNotMatch(out, /Prefer one strong finding/);
});

// #57 prompt-craft helpers: build both review prompts with the same dummy inputs.
function builtReviewPrompts(): { std: string; adv: string } {
  const std = buildReviewStandardPrompt({
    cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", plan: "P", diff: "d",
  });
  const adv = buildReviewAdversarialPrompt({ cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", diff: "d" });
  return { std, adv };
}

test("review prompts: both embed the shared confidence calibration block byte-for-byte (#57)", () => {
  const { std, adv } = builtReviewPrompts();
  for (const out of [std, adv]) {
    // The single-sourced constant, verbatim — drift between rounds is structurally impossible.
    assert.ok(out.includes(_testing.CONFIDENCE_CALIBRATION_BLOCK), "prompt is missing the shared calibration block");
    assert.match(out, /## Confidence Calibration/);
    assert.match(out, /min_confidence/); // ties bands to the #86 policy floor
    assert.match(out, /block_threshold/);
  }
});

test("review prompts: both scope review to the diff + blast radius, before the checklist/finding bar (#57)", () => {
  const { std, adv } = builtReviewPrompts();
  for (const out of [std, adv]) {
    assert.match(out, /## Scope/);
    assert.match(out, /blast radius/);
    assert.match(out, /out of scope/);
  }
  // Spec: the scoping instruction precedes the finding bar / checklist so the
  // reviewer scopes before they assess.
  assert.ok(std.indexOf("## Scope") < std.indexOf("Reference dimensions"));
  assert.ok(adv.indexOf("## Scope") < adv.indexOf("## Finding Bar"));
});

test("review prompts: both frame the false-positive cost and the advisory-band escape hatch (#57)", () => {
  const { std, adv } = builtReviewPrompts();
  for (const out of [std, adv]) {
    assert.match(out, /## False-Positive Cost/);
    assert.match(out, /full fix cycle/);
    assert.match(out, /advisory band/);
  }
});

test("review prompts: each carries round-tailored few-shot examples + the anchor-only guard (#57)", () => {
  const { std, adv } = builtReviewPrompts();
  for (const out of [std, adv]) {
    assert.match(out, /## Calibration Examples/);
    assert.match(out, /A model finding/);
    assert.match(out, /A suppressed concern/);
    assert.match(out, /never report them as findings/);
  }
  // Round-specific (intentionally NOT single-sourced): the examples match each round's stance.
  assert.match(std, /welcome email/);
  assert.match(adv, /double-charges on retry/);
});

test("review_standard: risk-first structure with the checklist demoted to reference dimensions (#57)", () => {
  const { std } = builtReviewPrompts();
  assert.match(std, /## Review Method — Risk First/);
  assert.match(std, /Start your `summary` with a risk tier/);
  assert.match(std, /Reference dimensions \(allocate depth by risk, not equally\)/);
  // Risk assessment comes before the dimensions list.
  assert.ok(std.indexOf("Risk First") < std.indexOf("Reference dimensions"));
});

test("review_standard: deterministic CI-answered asks are removed (#57)", () => {
  const { std } = builtReviewPrompts();
  assert.doesNotMatch(std, /Acceptance criteria met\?/);
  assert.doesNotMatch(std, /CI expectations/);
});

test("review_adversarial: two-tier attack surface — core always, enterprise items repo-tailored (#57)", () => {
  const { adv } = builtReviewPrompts();
  assert.match(adv, /Core tier — evaluate the diff against ALL of these on every run/);
  assert.match(adv, /Repo-tailored tier/);
  assert.match(adv, /only those that fit this repo/);
  // The enterprise-flavored items are conditional examples, not core mandates.
  assert.match(adv, /tenant isolation only if the repo is multi-tenant/);
  assert.match(adv, /PHI \/ sensitive-data retention only if it handles such data/);
});

test("review prompts: round-role summaries differentiate round-1 from round-2 (#57)", () => {
  const { std, adv } = builtReviewPrompts();
  assert.match(std, /broad risk survey, first pass/);
  assert.match(adv, /targeted deep-dive on high-risk vectors not yet resolved by round-1/);
});

test("review_adversarial: operating stance instructs de-dup against round-1 / prior round-2 findings (#57)", () => {
  const { adv } = builtReviewPrompts();
  assert.match(adv, /do NOT re-raise findings already covered/);
  assert.match(adv, /unless new evidence materially elevates/);
});

test("review_adversarial: re-review with priorReview2Findings — Operating Stance preserves the ratchet, not just suppresses unresolved findings (#57)", () => {
  const base = { cfg: dummyConfig(), issueNumber: 7, title: "T", body: "B", diff: "diff" };
  const rerun = buildReviewAdversarialPrompt({
    ...base,
    priorReview2Findings: "## Review 2\n- [HIGH] missing null guard on checkout path",
  });
  // Injected section (from buildReviewAdversarialPrompt) carries the ratchet
  assert.match(rerun, /verify EACH prior finding is resolved/);
  // Template-level Operating Stance must explicitly state the ratchet obligation for
  // prior round-2 re-review — it must not only tell the reviewer to suppress.
  assert.match(rerun, /ratchet obligation overrides de-duplication/);
  assert.match(rerun, /re-raise every finding/);
  // De-dup still applies to round-1 summaries (the existing instruction is preserved)
  assert.match(rerun, /round-1 summary appears above, do NOT re-raise/);
});

test("fix prompt: round 1 = standard, round 2 = adversarial", () => {
  const r1 = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "FINDINGS-X",
    fixRound: 1,
    pipelineRunId: "5/2026-06-08T14:32:00Z",
  });
  const r2 = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "FINDINGS-X",
    fixRound: 2,
    pipelineRunId: "5/2026-06-08T14:32:00Z",
  });
  assert.match(r1, /standard/);
  assert.match(r2, /adversarial/);
  assert.match(r1, /FINDINGS-X/);
  assert.match(r2, /FINDINGS-X/);
});

test("fix prompt: spec-revision instruction + consistency framing only when OpenSpec context is present (#106)", () => {
  const withSpec = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    fixRound: 1,
    pipelineRunId: "r",
    specContext: "#### cap/spec.md\n\n### Requirement: X SHALL do Y",
  });
  assert.match(withSpec, /keep the spec delta consistent with your fix/);
  assert.match(withSpec, /must stay consistent with/);
  assert.doesNotMatch(withSpec, /must satisfy these requirement changes/);

  const withoutSpec = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    fixRound: 1,
    pipelineRunId: "r",
  });
  assert.doesNotMatch(withoutSpec, /keep the spec delta consistent with your fix/);
  assert.doesNotMatch(withoutSpec, /\{\{[a-zA-Z_]+\}\}/, "no leftover placeholders on the non-OpenSpec path");
});

test("fix prompt: instructs the trailers with substituted issue + run id (#20)", () => {
  const out = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    fixRound: 1,
    pipelineRunId: "5/2026-06-08T14:32:00Z",
  });
  assert.match(out, /Issue: #5/);
  assert.match(out, /Pipeline-Run: 5\/2026-06-08T14:32:00Z/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("fix prompt: includes prior-round history only when provided (the don't-revert guard)", () => {
  const without = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5, title: "t", reviewFindings: "f", fixRound: 2, pipelineRunId: "r",
  });
  assert.doesNotMatch(without, /Prior Review Rounds/);
  const withHistory = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    priorReviewHistory: "--- Prior review 2 attempt 1 ---\nflipped publicly_accessible back to false",
    fixRound: 2,
    pipelineRunId: "r",
  });
  assert.match(withHistory, /Prior Review Rounds \(history\)/);
  assert.match(withHistory, /Do NOT revert a fix/);
  assert.match(withHistory, /publicly_accessible/);
});

// #108: the fix and test-fix prompts must embed the target repo's conventions
// explicitly (via readConventions → {{conventions}}), the same way implementing
// does — not rely on best-effort host auto-load of CLAUDE.md/AGENTS.md. These two
// tests bite: drop the `conventions` key from the builder map (or the placeholder
// from the template) and the asserted content disappears / substitute throws.
test("fix prompt: embeds the target repo's conventions (#108)", () => {
  const marker = "EDIT-core-NEVER-plugin-GOLDEN-RULE-7f3a";
  const out = buildFixPrompt({
    cfg: configWithConventions(marker),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    fixRound: 1,
    pipelineRunId: "r",
  });
  assert.match(out, new RegExp(marker), "fix prompt is missing the injected conventions content");
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("test_fix prompt: embeds the target repo's conventions (#108)", () => {
  const marker = "RUN-npm-run-ci-BEFORE-DONE-9c2b";
  const out = buildTestFixPrompt({
    cfg: configWithConventions(marker),
    issueNumber: 15,
    command: "npm test",
    attempt: 1,
    maxAttempts: 3,
    output: "fail",
    pipelineRunId: "r",
  });
  assert.match(out, new RegExp(marker), "test-fix prompt is missing the injected conventions content");
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

// #108: when no conventions file exists at the resolved path the injection must
// degrade gracefully to readConventions' stub (identical to implementing.md) —
// it must not throw or leave an unfilled placeholder. dummyConfig's repo_dir does
// not exist, so readConventions returns its stub.
test("fix/test-fix prompts: render the readConventions stub (no throw) when no conventions file (#108)", () => {
  const fixOut = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    title: "t",
    reviewFindings: "f",
    fixRound: 1,
    pipelineRunId: "r",
  });
  const testFixOut = buildTestFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 5,
    command: "npm test",
    attempt: 1,
    maxAttempts: 3,
    output: "fail",
    pipelineRunId: "r",
  });
  assert.match(fixOut, /no conventions file found/);
  assert.match(testFixOut, /no conventions file found/);
  assert.doesNotMatch(fixOut, /\{\{[a-zA-Z_]+\}\}/);
  assert.doesNotMatch(testFixOut, /\{\{[a-zA-Z_]+\}\}/);
});

test("test_fix prompt: includes command, attempt counter, and failure output", () => {
  const out = buildTestFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 15,
    command: "pnpm run test",
    attempt: 2,
    maxAttempts: 3,
    output: "FAIL-OUTPUT-XYZ",
    pipelineRunId: "15/2026-06-08T14:32:00Z",
  });
  assert.match(out, /#15/);
  assert.match(out, /pnpm run test/);
  assert.match(out, /attempt 2 of 3/);
  assert.match(out, /FAIL-OUTPUT-XYZ/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("test_fix prompt: instructs the trailers with substituted issue + run id (#20)", () => {
  const out = buildTestFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 15,
    command: "npm test",
    attempt: 1,
    maxAttempts: 1,
    output: "fail",
    pipelineRunId: "15/2026-06-08T14:32:00Z",
  });
  assert.match(out, /Issue: #15/);
  assert.match(out, /Pipeline-Run: 15\/2026-06-08T14:32:00Z/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("test_fix prompt: large failure output is truncated", () => {
  const out = buildTestFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 1,
    command: "npm test",
    attempt: 1,
    maxAttempts: 1,
    output: "y".repeat(20_000),
    pipelineRunId: "1/2026-06-08T14:32:00Z",
  });
  assert.match(out, /diff truncated at 16KB/);
});

test("review prompt: large diff is truncated", () => {
  const big = "x".repeat(60_000);
  const out = buildReviewStandardPrompt({
    cfg: dummyConfig(),
    issueNumber: 1,
    title: "t",
    body: "b",
    plan: "p",
    diff: big,
  });
  assert.match(out, /diff truncated at 50KB/);
});

test("plan_review prompt: injects OpenSpec spec context when provided", () => {
  const out = buildPlanReviewPrompt({
    cfg: dummyConfig(),
    issueNumber: 10,
    title: "t",
    body: "b",
    plan: "p",
    reviewer: "codex",
    implementer: "claude",
    specContext: "REQ: plan must include a migration rollback step",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /plan must include a migration rollback step/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_review prompt: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildPlanReviewPrompt({
    cfg: dummyConfig(),
    issueNumber: 10,
    title: "t",
    body: "b",
    plan: "p",
    reviewer: "codex",
    implementer: "claude",
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_revision prompt: injects OpenSpec spec context when provided", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 11,
    title: "t",
    body: "b",
    plan: "p",
    feedback: "needs work",
    reviewer: "codex",
    implementer: "claude",
    specContext: "REQ: revision must address auth timeout scenario",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /revision must address auth timeout scenario/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("plan_revision prompt: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 11,
    title: "t",
    body: "b",
    plan: "p",
    feedback: "needs work",
    reviewer: "codex",
    implementer: "claude",
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("implementing prompt: injects OpenSpec spec context when provided", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 12,
    title: "t",
    body: "b",
    plan: "p",
    specContext: "REQ: implementation must handle empty input gracefully",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /handle empty input gracefully/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("implementing prompt: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 12,
    title: "t",
    body: "b",
    plan: "p",
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("fix prompt: injects OpenSpec spec context when provided", () => {
  const out = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 13,
    title: "t",
    reviewFindings: "FINDINGS",
    fixRound: 1,
    specContext: "REQ: fix must preserve idempotency guarantee",
  });
  assert.match(out, /Intended Behavior/);
  assert.match(out, /preserve idempotency guarantee/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

test("fix prompt: no spec section + no leftover placeholders when specContext absent", () => {
  const out = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 13,
    title: "t",
    reviewFindings: "FINDINGS",
    fixRound: 1,
  });
  assert.doesNotMatch(out, /Intended Behavior/);
  assert.doesNotMatch(out, /\{\{[a-zA-Z_]+\}\}/);
});

// Regression: empty specContext must not introduce extra blank lines (non-OpenSpec
// runs must produce byte-for-byte the same prompt as before spec_context was added).
test("plan_review prompt: no extra blank lines when specContext absent", () => {
  const out = buildPlanReviewPrompt({
    cfg: dummyConfig(),
    issueNumber: 10,
    title: "t",
    body: "b",
    plan: "p",
    reviewer: "codex",
    implementer: "claude",
  });
  assert.doesNotMatch(out, /\n\n\n/);
});

test("plan_revision prompt: no extra blank lines when specContext absent", () => {
  const out = buildPlanRevisionPrompt({
    cfg: dummyConfig(),
    issueNumber: 11,
    title: "t",
    body: "b",
    plan: "p",
    feedback: "fb",
    reviewer: "codex",
    implementer: "claude",
  });
  assert.doesNotMatch(out, /\n\n\n/);
});

test("implementing prompt: no extra blank lines when specContext absent", () => {
  const out = buildImplementingPrompt({
    cfg: dummyConfig(),
    issueNumber: 12,
    title: "t",
    body: "b",
    plan: "p",
  });
  assert.doesNotMatch(out, /\n\n\n/);
});

test("fix prompt: no extra blank lines when specContext absent", () => {
  const out = buildFixPrompt({
    cfg: dummyConfig(),
    issueNumber: 13,
    title: "t",
    reviewFindings: "FINDINGS",
    fixRound: 1,
  });
  assert.doesNotMatch(out, /\n\n\n/);
});
