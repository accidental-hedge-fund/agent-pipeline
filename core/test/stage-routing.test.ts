// stage-routing.ts: auto model/effort routing matrix (#366).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAuto, expandAutoModel, expandAutoEffort, STAGE_ROUTING } from "../scripts/stage-routing.ts";

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
