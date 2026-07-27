// Contract-drift regression tests for the eval agent instruction contract
// (#607 — eval-agent-isolation-boundary). A required clause missing from
// EVAL_AGENT_CONTRACT_TEXT must fail one of these tests, naming the clause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EVAL_AGENT_CONTRACT_PATHS, EVAL_AGENT_CONTRACT_TEXT } from "../scripts/evals/agent-contract.ts";

/** Line-wrapping in the contract's prose must never break a substring match —
 *  normalize all whitespace runs to a single space before asserting. */
const NORMALIZED = EVAL_AGENT_CONTRACT_TEXT.replace(/\s+/g, " ");

test("contract installs at every root-instruction path a supported local-CLI harness reads", () => {
  assert.deepEqual([...EVAL_AGENT_CONTRACT_PATHS].sort(), ["AGENTS.md", "CLAUDE.md"]);
});

test("clause 1: contract requires direct work on the frozen evaluation task only", () => {
  assert.match(NORMALIZED, /work directly on the frozen evaluation task/i);
});

test("clause 2: contract prohibits planning delegation, nested worktrees, branch creation, commits, pushes, GitHub operations, and pipeline advancement", () => {
  assert.match(NORMALIZED, /not delegate this work to a planning workflow/i);
  assert.match(NORMALIZED, /not create or enter a nested worktree/i);
  assert.match(NORMALIZED, /not create a branch/i);
  assert.match(NORMALIZED, /git commit/i);
  assert.match(NORMALIZED, /git push/i);
  assert.match(NORMALIZED, /not perform any GitHub operation/i);
  assert.match(NORMALIZED, /not advance any pipeline stage/i);
  assert.match(NORMALIZED, /pipeline.*subcommand/i);
});

test("clause 3: contract denies authority to repository workflow documents and installed skills", () => {
  assert.match(NORMALIZED, /carry no authority inside this evaluation cell/i);
  assert.match(NORMALIZED, /installed\s+pipeline skill/i);
  assert.match(NORMALIZED, /not follow them in preference to this contract/i);
});

test("clause 4: contract states the cell is an evaluation with no external side effects", () => {
  assert.match(NORMALIZED, /evaluation cell with no external side effects/i);
  assert.match(NORMALIZED, /no real issue,\s+pull request, or branch is affected/i);
  assert.match(NORMALIZED, /not publish any result/i);
});

test("contract takes precedence over repository workflow instructions", () => {
  assert.match(NORMALIZED, /takes precedence over every other instruction file/i);
});
