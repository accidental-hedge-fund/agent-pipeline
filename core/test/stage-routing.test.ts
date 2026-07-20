// stage-routing.ts: auto model/effort routing matrix (#366).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuto,
  expandAutoModel,
  expandAutoEffort,
  STAGE_ROUTING,
  isClaudeOnlyModelAlias,
  resolveReviewerModelForHarness,
  reviewerModelSourceWasAuto,
} from "../scripts/stage-routing.ts";

test("resolveAuto: mechanical/iterative stages fork model by harness (implementing)", () => {
  assert.deepEqual(resolveAuto("implementing", "claude"), { model: "sonnet", effort: "low" });
  assert.deepEqual(resolveAuto("implementing", "codex"), { model: "gpt-5.5", effort: "low" });
});

test("resolveAuto: mechanical/iterative stages fork model by harness (fix)", () => {
  assert.deepEqual(resolveAuto("fix", "claude"), { model: "sonnet", effort: "low" });
  assert.deepEqual(resolveAuto("fix", "codex"), { model: "gpt-5.5", effort: "low" });
});

test("resolveAuto: analytical/iterative (planning) resolves opus regardless of harness", () => {
  assert.deepEqual(resolveAuto("planning", "claude"), { model: "opus", effort: "medium" });
  assert.deepEqual(resolveAuto("planning", "codex"), { model: "opus", effort: "medium" });
});

test("resolveAuto: analytical/ephemeral (intake, sweep) resolves sonnet/low regardless of harness", () => {
  assert.deepEqual(resolveAuto("intake", "claude"), { model: "sonnet", effort: "low" });
  assert.deepEqual(resolveAuto("intake", "codex"), { model: "sonnet", effort: "low" });
  assert.deepEqual(resolveAuto("sweep", "claude"), { model: "sonnet", effort: "low" });
});

test("resolveAuto: adversarial stages always resolve claude-fable-5, regardless of harness (#366 profile-independence)", () => {
  for (const stage of ["plan-review", "review-1", "review-2"] as const) {
    const viaClaude = resolveAuto(stage, "claude");
    const viaCodex = resolveAuto(stage, "codex");
    assert.equal(viaClaude.model, "claude-fable-5", `${stage} via claude`);
    assert.equal(viaCodex.model, "claude-fable-5", `${stage} via codex`);
    assert.notEqual(viaClaude.model, "fable-5", `${stage} must not use the short alias`);
  }
});

test("resolveAuto: adversarial permanence maps to distinct effort levels", () => {
  assert.equal(resolveAuto("plan-review", "claude").effort, "max", "plan-review is Definitive");
  assert.equal(resolveAuto("review-1", "claude").effort, "high", "review-1 is Iterative");
  assert.equal(resolveAuto("review-2", "claude").effort, "max", "review-2 is Definitive");
});

test("resolveAuto: never returns the unrecognized short alias 'fable-5' for any stage/harness combination", () => {
  for (const stage of Object.keys(STAGE_ROUTING) as (keyof typeof STAGE_ROUTING)[]) {
    for (const harness of ["claude", "codex"] as const) {
      const { model } = resolveAuto(stage, harness);
      assert.notEqual(model, "fable-5", `${stage}/${harness} must not resolve to the short alias`);
    }
  }
});

test("expandAutoModel: 'auto' routes through resolveAuto; other values pass through; undefined stays undefined", () => {
  assert.equal(expandAutoModel("auto", "implementing", "codex"), "gpt-5.5");
  assert.equal(expandAutoModel("haiku", "implementing", "codex"), "haiku");
  assert.equal(expandAutoModel(undefined, "implementing", "codex"), undefined);
});

test("expandAutoEffort: 'auto' routes through resolveAuto; other values pass through; undefined stays undefined", () => {
  assert.equal(expandAutoEffort("auto", "review-2", "claude"), "max");
  assert.equal(expandAutoEffort("critical", "review-2", "claude"), "critical");
  assert.equal(expandAutoEffort(undefined, "review-2", "claude"), undefined);
});

test("STAGE_ROUTING: the same key backs planning (Analytical/Iterative) and plan-review (Adversarial/Definitive) with different classifications", () => {
  assert.deepEqual(STAGE_ROUTING.planning, { nature: "analytical", permanence: "iterative" });
  assert.deepEqual(STAGE_ROUTING["plan-review"], { nature: "adversarial", permanence: "definitive" });
});

// ---------------------------------------------------------------------------
// isClaudeOnlyModelAlias / resolveReviewerModelForHarness (#441)
// ---------------------------------------------------------------------------

test("isClaudeOnlyModelAlias: recognizes the short claude aliases and any claude-* id", () => {
  assert.equal(isClaudeOnlyModelAlias("claude-fable-5"), true);
  assert.equal(isClaudeOnlyModelAlias("sonnet"), true);
  assert.equal(isClaudeOnlyModelAlias("opus"), true);
  assert.equal(isClaudeOnlyModelAlias("haiku"), true);
  assert.equal(isClaudeOnlyModelAlias("claude-opus-4-8"), true);
});

test("isClaudeOnlyModelAlias: does not flag codex-valid or unrelated ids", () => {
  assert.equal(isClaudeOnlyModelAlias("gpt-5.5"), false);
  assert.equal(isClaudeOnlyModelAlias("gpt-5.6-terra"), false);
});

test("resolveReviewerModelForHarness: codex reviewer + auto-resolved claude-only alias → undefined (omit -m)", () => {
  assert.equal(resolveReviewerModelForHarness("claude-fable-5", "codex", true), undefined);
  assert.equal(resolveReviewerModelForHarness("sonnet", "codex", true), undefined);
});

test("resolveReviewerModelForHarness: codex reviewer + EXPLICIT claude-only alias is forwarded verbatim (#441)", () => {
  // An explicit (non-auto) reviewer model must reach codex even if it happens
  // to be a claude-only alias, so codex can surface its own invalid-model error.
  assert.equal(resolveReviewerModelForHarness("claude-fable-5", "codex", false), "claude-fable-5");
  assert.equal(resolveReviewerModelForHarness("sonnet", "codex", false), "sonnet");
});

test("resolveReviewerModelForHarness: codex reviewer + codex-valid explicit id passes through verbatim", () => {
  assert.equal(resolveReviewerModelForHarness("gpt-5.6-terra", "codex", false), "gpt-5.6-terra");
});

test("resolveReviewerModelForHarness: claude reviewer always passes the model through verbatim", () => {
  assert.equal(resolveReviewerModelForHarness("claude-fable-5", "claude", true), "claude-fable-5");
  assert.equal(resolveReviewerModelForHarness("claude-fable-5", "claude", false), "claude-fable-5");
});

test("resolveReviewerModelForHarness: custom reviewer CLI passes the model through verbatim (invoke() ignores it anyway)", () => {
  assert.equal(resolveReviewerModelForHarness("claude-fable-5", "my-reviewer", true), "claude-fable-5");
});

test("resolveReviewerModelForHarness: undefined model stays undefined for any harness", () => {
  assert.equal(resolveReviewerModelForHarness(undefined, "codex", true), undefined);
});

test("reviewerModelSourceWasAuto: opts.model override is always explicit", () => {
  const cfg = { harnesses: { reviewerModel: "auto-resolved", reviewerModelWasAuto: true }, models: { review: "sonnet", reviewWasAuto: true } };
  assert.equal(reviewerModelSourceWasAuto(cfg as any, "gpt-5.6-terra"), false);
});

test("reviewerModelSourceWasAuto: falls back to harnesses.reviewerModelWasAuto when set", () => {
  const cfg = { harnesses: { reviewerModel: "sonnet", reviewerModelWasAuto: false }, models: { review: "claude-fable-5", reviewWasAuto: true } };
  assert.equal(reviewerModelSourceWasAuto(cfg as any, undefined), false);
});

test("reviewerModelSourceWasAuto: falls back to models.reviewWasAuto when reviewerModel is unset", () => {
  const cfg = { harnesses: { reviewerModel: undefined, reviewerModelWasAuto: undefined }, models: { review: "claude-fable-5", reviewWasAuto: true } };
  assert.equal(reviewerModelSourceWasAuto(cfg as any, undefined), true);
});
