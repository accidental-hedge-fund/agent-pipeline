// Per-kind blocked-recovery recipes (#134). Pure: no subprocess/network — the
// recipe rendering is exercised through the exported `renderRecipe` /
// `buildBlockedComment` helpers, not through `setBlocked`'s real `gh` I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKER_KINDS, BLOCKER_RECIPES, DEFAULT_BLOCKER_KIND } from "../scripts/types.ts";
import { buildBlockedComment, renderRecipe } from "../scripts/gh.ts";

// ---------------------------------------------------------------------------
// Exhaustiveness: every kind has a non-empty recipe, and the map has no extras.
// ---------------------------------------------------------------------------

test("BLOCKER_RECIPES has a non-empty entry for every BlockerKind", () => {
  for (const kind of BLOCKER_KINDS) {
    const recipe = BLOCKER_RECIPES[kind];
    assert.equal(typeof recipe, "string", `recipe for "${kind}" must be a string`);
    assert.ok(recipe.trim().length > 0, `recipe for "${kind}" must be non-empty`);
  }
});

test("BLOCKER_RECIPES has no keys outside BLOCKER_KINDS", () => {
  const known = new Set<string>(BLOCKER_KINDS);
  for (const key of Object.keys(BLOCKER_RECIPES)) {
    assert.ok(known.has(key), `BLOCKER_RECIPES has an unexpected key "${key}"`);
  }
  assert.equal(Object.keys(BLOCKER_RECIPES).length, BLOCKER_KINDS.length);
});

test("DEFAULT_BLOCKER_KIND is a real kind with a recipe", () => {
  assert.ok(BLOCKER_KINDS.includes(DEFAULT_BLOCKER_KIND));
  assert.ok(BLOCKER_RECIPES[DEFAULT_BLOCKER_KIND].trim().length > 0);
});

// ---------------------------------------------------------------------------
// renderRecipe: substitutes the {{N}} issue-number placeholder.
// ---------------------------------------------------------------------------

test("renderRecipe substitutes {{N}} with the issue number", () => {
  const rendered = renderRecipe("needs-human", 134);
  assert.ok(!rendered.includes("{{N}}"), "placeholder must be substituted");
  assert.ok(rendered.includes("$pipeline 134"), "issue number must appear in the command");
});

test("no recipe leaves a literal {{N}} after rendering", () => {
  for (const kind of BLOCKER_KINDS) {
    const rendered = renderRecipe(kind, 42);
    assert.ok(!rendered.includes("{{N}}"), `recipe "${kind}" left an unrendered {{N}}`);
  }
});

// ---------------------------------------------------------------------------
// Snapshot: pin each kind's rendered recipe text. A drifted/dropped recipe
// string fails here, naming the kind that changed.
// ---------------------------------------------------------------------------

const RECIPE_SNAPSHOTS: Record<(typeof BLOCKER_KINDS)[number], string> = {
  "needs-human":
    "A human decision is required. Fix the findings described above and re-run " +
    "`$pipeline 7`, or record an audited disposition with " +
    '`$pipeline 7 --override "<finding-key>: <reason>"` to advance past an ' +
    "accepted or out-of-scope finding (the key comes from the review comment).",
  "test-gate-exhausted":
    "The test/build gate failed after the pipeline's fix attempts were " +
    "exhausted. Fix the failing test(s) or build error in the worktree, commit " +
    "the fix, then re-run `$pipeline 7`.",
  "no-commits":
    "The harness reported success but committed nothing and the worktree is " +
    "clean. Finish the work and commit it in the worktree (or re-run the step " +
    "manually), then re-run `$pipeline 7`. If real changes are sitting " +
    "uncommitted in the worktree, committing them lets the pipeline salvage and " +
    "continue (#131).",
  "harness-failure":
    "The harness process crashed or timed out (see the error above). " +
    "Investigate and fix the root cause, then re-run `$pipeline 7`. A " +
    "transient timeout can usually just be re-run as-is.",
  "openspec-invalid":
    "The OpenSpec change is structurally invalid. Run `openspec validate " +
    "<change>` in the worktree, fix the reported errors, commit, then re-run " +
    "`$pipeline 7`.",
  "openspec-stale-delta":
    "The OpenSpec spec delta is stale relative to the committed code. Reconcile " +
    "the spec delta with the implementation (or run `openspec archive " +
    "<change>`), commit, then re-run `$pipeline 7`.",
  "merge-conflict":
    "The branch could not be merged or auto-rebased onto the target branch. " +
    "Rebase the branch on the latest target, resolve the conflicts, push, then " +
    "re-run `$pipeline 7`.",
  "worktree-missing":
    "The worktree for this issue no longer exists, so fixes can't be applied. " +
    "Re-run `$pipeline 7` to recreate it from the branch, then continue.",
  "worktree-creation-failed":
    "Creating the worktree failed (see the error above). Check disk space and " +
    "git state (stale worktrees, lock files), then re-run `$pipeline 7`.",
  "pr-creation-failed":
    "Opening the pull request failed (see the error above). Check GitHub " +
    "permissions and rate limits, then re-run `$pipeline 7`.",
  "plan-gen-failed":
    "Plan generation failed (see the error above). Fix the root cause (often a " +
    "transient harness error), then re-run `$pipeline 7`.",
  "push-failed":
    "Pushing the branch failed for a non-conflict reason (see stderr above). " +
    "Resolve the push error (auth, remote, or branch protection), then re-run " +
    "`$pipeline 7`.",
};

test("each kind's rendered recipe matches its pinned snapshot", () => {
  for (const kind of BLOCKER_KINDS) {
    assert.equal(
      renderRecipe(kind, 7),
      RECIPE_SNAPSHOTS[kind],
      `recipe for "${kind}" drifted from its pinned snapshot`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildBlockedComment: the "### How to unblock" section carries the kind's
// recipe, and the generic `--unblock` hint never appears.
// ---------------------------------------------------------------------------

function comment(kind: (typeof BLOCKER_KINDS)[number], issueNumber = 7): string {
  return buildBlockedComment({
    issueNumber,
    stageStr: "implementing",
    harness: "claude",
    ts: "2026-06-12T00:00:00Z",
    reason: "something went wrong",
    kind,
  });
}

test("blocked comment renders the kind-specific recipe under 'How to unblock'", () => {
  for (const kind of BLOCKER_KINDS) {
    const body = comment(kind);
    const idx = body.indexOf("### How to unblock");
    assert.ok(idx >= 0, `"### How to unblock" missing for "${kind}"`);
    const section = body.slice(idx);
    assert.ok(
      section.includes(renderRecipe(kind, 7)),
      `recipe for "${kind}" missing under "How to unblock"`,
    );
  }
});

test("blocked comment never uses the generic --unblock hint (the #134 fix)", () => {
  // The uniform `--unblock` instruction was the wrong verb for ~11 of 12 classes.
  for (const kind of BLOCKER_KINDS) {
    assert.ok(
      !comment(kind).includes("--unblock"),
      `"${kind}" must not direct the operator to --unblock`,
    );
  }
});

test("test-gate-exhausted directs to fix the test, commit, and re-run", () => {
  const body = comment("test-gate-exhausted");
  assert.ok(body.includes("Fix the failing test"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

test("needs-human directs to fix-and-re-run OR --override", () => {
  const body = comment("needs-human");
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(body.includes("--override"));
});

test("openspec-invalid directs to openspec validate, fix, commit, re-run", () => {
  const body = comment("openspec-invalid");
  assert.ok(body.includes("openspec validate"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
});

test("merge-conflict directs to rebase, resolve, push, re-run", () => {
  const body = comment("merge-conflict");
  assert.ok(body.includes("Rebase"));
  assert.ok(body.includes("resolve"));
  assert.ok(body.includes("push"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
});

// ---------------------------------------------------------------------------
// Default-kind fallback: buildBlockedComment requires a kind, but setBlocked
// defaults it. Pin that the default resolves to the needs-human recipe.
// ---------------------------------------------------------------------------

test("DEFAULT_BLOCKER_KIND renders the needs-human recipe", () => {
  assert.equal(renderRecipe(DEFAULT_BLOCKER_KIND, 7), renderRecipe("needs-human", 7));
});
