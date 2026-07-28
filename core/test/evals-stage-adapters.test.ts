import { test } from "node:test";
import assert from "node:assert/strict";
import {
  materializePipelineImplementationPrompt,
  materializePipelinePlanReviewPrompt,
  materializePipelinePlanRevisionPrompt,
  materializePipelineReview1Prompt,
  materializePipelineReview2Prompt,
  materializeStagePrompt,
} from "../scripts/evals/stage-adapters.ts";
import { REVIEW_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const fixture = validateFixture({
  fixture_id: "review-prompt",
  schema_version: 1,
  base_commit: "b63d9ba64a4ec72a583a1795ef9ca0d3a57bddcd",
  task_input: "Review the change.",
  stage_entry_artifacts: { review: { diff: "diff --git a/a.ts b/a.ts" } },
  public_checks: [],
  grader_refs: [{ grader: "review", version: "1" }],
  category: "review",
  risk: "low",
  provenance: "synthetic",
}, "review-prompt.json");
const cfg = {
  ...DEFAULT_CONFIG,
  profile_name: "test",
  invocation: "test",
  review_mode: "prompt-harness",
  marker_footer: "",
  implementation_ready_message: "",
  conventions_default: "AGENTS.md",
  domain: "agent-pipeline",
  repo: "owner/agent-pipeline",
  repo_dir: "/nonexistent/eval-cell",
} as PipelineConfig;
const promptBase = {
  cfg,
  fixture,
  primary: { harness: "grok" },
  reviewer: { harness: "codex" },
};

test("materializeStagePrompt: review mode requires the production structured verdict", () => {
  const prompt = materializeStagePrompt("review", fixture);
  assert.match(prompt, /Return ONLY valid JSON/);
  for (const field of [...REVIEW_SCHEMA_FIELDS.verdict, ...REVIEW_SCHEMA_FIELDS.finding]) {
    assert.match(prompt, new RegExp(`\\b${field}\\b`), `review schema field ${field} is missing`);
  }
});

test("pipeline-paired prompts preserve the actual plan and plan-review feedback", () => {
  const review = materializePipelinePlanReviewPrompt({ ...promptBase, plan: "actual generated plan" });
  assert.match(review, /actual generated plan/);
  assert.match(review, /## Plan Review Verdict/);
  const revision = materializePipelinePlanRevisionPrompt({
    ...promptBase,
    plan: "actual generated plan",
    feedback: "reviewer feedback",
  });
  assert.match(revision, /actual generated plan/);
  assert.match(revision, /reviewer feedback/);
});

test("pipeline-paired reuses production stage contracts with an evaluation-only execution override", () => {
  const implementation = materializePipelineImplementationPrompt({
    ...promptBase,
    plan: "approved plan",
    pipelineRunId: "eval-1",
  });
  assert.match(implementation, /## Implementation Plan/);
  assert.match(implementation, /Evaluation Execution Override/);
  assert.match(implementation, /Leave the validated file changes uncommitted/);

  const review1 = materializePipelineReview1Prompt({ ...promptBase, plan: "approved plan", diff: "+change" });
  assert.match(review1, /standard code review/);
  const review2 = materializePipelineReview2Prompt({
    ...promptBase,
    diff: "+fixed",
    review1Summary: "review one context",
  });
  assert.match(review2, /adversarial software review/);
  assert.match(review2, /review one context/);
});
