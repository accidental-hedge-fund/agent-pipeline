import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeStagePrompt } from "../scripts/evals/stage-adapters.ts";
import { REVIEW_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import { validateFixture } from "../scripts/evals/fixture.ts";

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

test("materializeStagePrompt: review mode requires the production structured verdict", () => {
  const prompt = materializeStagePrompt("review", fixture);
  assert.match(prompt, /Return JSON only/);
  for (const field of [...REVIEW_SCHEMA_FIELDS.verdict, ...REVIEW_SCHEMA_FIELDS.finding]) {
    assert.match(prompt, new RegExp(`\\b${field}\\b`), `review schema field ${field} is missing`);
  }
});
