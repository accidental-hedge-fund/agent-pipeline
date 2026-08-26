// Regression for #773: advance loop can exhaust MAX_ITERATIONS on the
// transition *into* ready-to-deploy (residual pre-merge re-entry + disabled
// visual/eval skips). Terminal side-effects (PR label, Pipeline Complete,
// worktree removal) live in deploy_ready.finalize and must still run.
//
// Pure decision tests — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ITERATIONS,
  shouldHandleNonterminalIterationExhaustion,
  shouldRunDeferredTerminalFinalize,
} from "../scripts/pipeline-run.ts";
import type { Stage } from "../scripts/types.ts";

test("MAX_ITERATIONS is a finite positive safety backstop", () => {
  assert.equal(typeof MAX_ITERATIONS, "number");
  assert.ok(MAX_ITERATIONS >= 1);
  assert.ok(Number.isInteger(MAX_ITERATIONS));
});

test("shouldRunDeferredTerminalFinalize: true when R2D reached without in-loop finalize (#773)", () => {
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: false,
      alreadyFinalized: false,
      finalStage: "ready-to-deploy",
    }),
    true,
  );
});

test("shouldRunDeferredTerminalFinalize: false when finalize already ran in-loop", () => {
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: false,
      alreadyFinalized: true,
      finalStage: "ready-to-deploy",
    }),
    false,
  );
});

test("shouldRunDeferredTerminalFinalize: false under dry-run", () => {
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: true,
      alreadyFinalized: false,
      finalStage: "ready-to-deploy",
    }),
    false,
  );
});

test("shouldRunDeferredTerminalFinalize: false for non-terminal final stages", () => {
  const mid: Stage[] = [
    "ready",
    "planning",
    "implementing",
    "review-1",
    "fix-1",
    "review-2",
    "fix-2",
    "pre-merge",
    "visual-gate",
    "eval-gate",
    "shipcheck-gate",
    "needs-human",
  ];
  for (const finalStage of mid) {
    assert.equal(
      shouldRunDeferredTerminalFinalize({
        dryRun: false,
        alreadyFinalized: false,
        finalStage,
      }),
      false,
      `expected false for finalStage=${finalStage}`,
    );
  }
});

test("shouldRunDeferredTerminalFinalize: false when finalStage is null/undefined", () => {
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: false,
      alreadyFinalized: false,
      finalStage: null,
    }),
    false,
  );
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: false,
      alreadyFinalized: false,
      finalStage: undefined,
    }),
    false,
  );
});

/**
 * Documents the #770 burn path: residual re-entry + skip stages can consume
 * the entire iteration budget without a free slot for the R2D terminal stage.
 * The deferred-finalize decision must still fire when finalStage is R2D.
 */
test("shouldHandleNonterminalIterationExhaustion: true for exhausted non-terminal stages (#1245)", () => {
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: "pre-merge",
    }),
    true,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: "review-1",
    }),
    true,
  );
  for (const finalStage of [
    "fix-2",
    "eval-gate",
    "visual-gate",
    "shipcheck-gate",
    "implementing",
  ] as Stage[]) {
    assert.equal(
      shouldHandleNonterminalIterationExhaustion({
        iterationBudgetExhausted: true,
        finalStage,
      }),
      true,
      `expected true for finalStage=${finalStage}`,
    );
  }
});

test("shouldHandleNonterminalIterationExhaustion: false for R2D, needs-human, and no fall-through", () => {
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: "ready-to-deploy",
    }),
    false,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: "needs-human",
    }),
    false,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: false,
      finalStage: "pre-merge",
    }),
    false,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: false,
      finalStage: "review-1",
    }),
    false,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: null,
    }),
    false,
  );
  assert.equal(
    shouldHandleNonterminalIterationExhaustion({
      iterationBudgetExhausted: true,
      finalStage: undefined,
    }),
    false,
  );
});

test("shouldHandleNonterminalIterationExhaustion: not gated on dryRun", () => {
  const result = shouldHandleNonterminalIterationExhaustion({
    iterationBudgetExhausted: true,
    finalStage: "pre-merge",
  });
  assert.equal(result, true);
  assert.equal(
    shouldHandleNonterminalIterationExhaustion.length,
    1,
    "helper takes one args object; dryRun is not a parameter",
  );
});

test("shouldRunDeferredTerminalFinalize: #770-shaped iteration burn still defers finalize", () => {
  // Stages that each consume one MAX_ITERATIONS slot on the dogfood path:
  const burn: Stage[] = [
    "implementing",
    "design-gate",
    "review-1",
    "fix-1",
    "review-2",
    "fix-2",
    "pre-merge", // first — residual re-entry
    "review-2",
    "fix-2",
    "pre-merge", // second — pass
    "visual-gate", // disabled skip
    "eval-gate", // disabled skip → silentTransition to R2D
  ];
  assert.equal(burn.length, MAX_ITERATIONS, "dogfood path saturates the iteration cap");
  // After the last advance, finalStage is ready-to-deploy but the in-loop R2D
  // branch never ran — deferred finalize must be scheduled.
  assert.equal(
    shouldRunDeferredTerminalFinalize({
      dryRun: false,
      alreadyFinalized: false,
      finalStage: "ready-to-deploy",
    }),
    true,
  );
});
