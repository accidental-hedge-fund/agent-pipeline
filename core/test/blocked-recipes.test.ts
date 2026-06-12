// Per-kind blocked-recovery recipes (#134). Pure: no subprocess/network — the
// recipe rendering is exercised through the exported `renderRecipe` /
// `buildBlockedComment` helpers, not through `setBlocked`'s real `gh` I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKER_KINDS, BLOCKER_RECIPES, DEFAULT_BLOCKER_KIND } from "../scripts/types.ts";
import { buildBlockedComment, renderRecipe } from "../scripts/gh.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    "A human decision is required. Fix the findings described above, remove the " +
    "`pipeline:blocked` label, and re-run `$pipeline 7`. Or record an " +
    "audited disposition with " +
    '`$pipeline 7 --override "<finding-key>: <reason>"` to advance past an ' +
    "accepted or out-of-scope finding (the key comes from the review comment; " +
    "`--override` clears the label and resumes automatically).",
  "test-gate-exhausted":
    "The test/build gate failed after the pipeline's fix attempts were " +
    "exhausted. Fix the failing test(s) or build error in the worktree, commit " +
    "the fix, remove the `pipeline:blocked` label, then re-run `$pipeline 7`.",
  "no-commits":
    "The harness reported success but committed nothing and the worktree is " +
    "clean. Finish the work and commit it in the worktree (or re-run the step " +
    "manually), remove the `pipeline:blocked` label, then re-run " +
    "`$pipeline 7`. If real changes are sitting uncommitted in the worktree, " +
    "committing them lets the pipeline salvage and continue (#131).",
  "harness-failure":
    "The harness process crashed or timed out (see the error above). " +
    "Investigate and fix the root cause, remove the `pipeline:blocked` label, " +
    "then re-run `$pipeline 7`. A transient timeout can usually just be " +
    "unblocked and re-run as-is.",
  "openspec-invalid":
    "The OpenSpec change is structurally invalid. Run `openspec validate " +
    "<change>` in the worktree, fix the reported errors, commit, remove the " +
    "`pipeline:blocked` label, then re-run `$pipeline 7`.",
  "openspec-stale-delta":
    "The OpenSpec spec delta is stale relative to the committed code. Reconcile " +
    "the spec delta with the implementation (or run `openspec archive " +
    "<change>`), commit, remove the `pipeline:blocked` label, then re-run " +
    "`$pipeline 7`.",
  "merge-conflict":
    "The branch could not be merged or auto-rebased onto the target branch. " +
    "Rebase the branch on the latest target, resolve the conflicts, push, " +
    "remove the `pipeline:blocked` label, then re-run `$pipeline 7`.",
  "worktree-missing":
    "The worktree for this issue no longer exists, so fixes can't be applied. " +
    "Remove the `pipeline:blocked` label and re-run `$pipeline 7` to " +
    "recreate it from the branch, then continue.",
  "worktree-creation-failed":
    "Creating the worktree failed (see the error above). Check disk space and " +
    "git state (stale worktrees, lock files), remove the `pipeline:blocked` " +
    "label, then re-run `$pipeline 7`.",
  "pr-creation-failed":
    "Opening the pull request failed (see the error above). Check GitHub " +
    "permissions and rate limits, remove the `pipeline:blocked` label, then " +
    "re-run `$pipeline 7`.",
  "plan-gen-failed":
    "Plan generation failed (see the error above). Fix the root cause (often a " +
    "transient harness error), remove the `pipeline:blocked` label, then re-run " +
    "`$pipeline 7`.",
  "push-failed":
    "Pushing the branch failed for a non-conflict reason (see stderr above). " +
    "Resolve the push error (auth, remote, or branch protection), remove the " +
    "`pipeline:blocked` label, then re-run `$pipeline 7`.",
  "eval-gate-misconfigured":
    "`eval_gate.enabled` is true but no command is configured. Set " +
    "`eval_gate.command` in `.github/pipeline.yml`, remove the " +
    "`pipeline:blocked` label, then re-run `$pipeline 7`.",
  "eval-gate-failed":
    "The eval gate failed (see output above). Fix the failing evals in the " +
    "worktree, commit, remove the `pipeline:blocked` label, then re-run " +
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

test("test-gate-exhausted directs to fix the test, commit, clear label, and re-run", () => {
  const body = comment("test-gate-exhausted");
  assert.ok(body.includes("Fix the failing test"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("pipeline:blocked"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

test("needs-human directs to fix-and-re-run OR --override, and mentions label clearing", () => {
  const body = comment("needs-human");
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(body.includes("--override"));
  assert.ok(body.includes("pipeline:blocked"));
});

test("openspec-invalid directs to openspec validate, fix, commit, clear label, re-run", () => {
  const body = comment("openspec-invalid");
  assert.ok(body.includes("openspec validate"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("pipeline:blocked"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
});

test("merge-conflict directs to rebase, resolve, push, clear label, re-run", () => {
  const body = comment("merge-conflict");
  assert.ok(body.includes("Rebase"));
  assert.ok(body.includes("resolve"));
  assert.ok(body.includes("push"));
  assert.ok(body.includes("pipeline:blocked"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
});

// ---------------------------------------------------------------------------
// Default-kind fallback: buildBlockedComment requires a kind, but setBlocked
// defaults it. Pin that the default resolves to the needs-human recipe.
// ---------------------------------------------------------------------------

test("DEFAULT_BLOCKER_KIND renders the needs-human recipe", () => {
  assert.equal(renderRecipe(DEFAULT_BLOCKER_KIND, 7), renderRecipe("needs-human", 7));
});

// ---------------------------------------------------------------------------
// New eval-gate kinds (Finding 1 — eval.ts blockers were missing kinds).
// ---------------------------------------------------------------------------

test("eval-gate-misconfigured directs to set the command, clear label, re-run", () => {
  const body = comment("eval-gate-misconfigured");
  assert.ok(body.includes("eval_gate.command"));
  assert.ok(body.includes(".github/pipeline.yml"));
  assert.ok(body.includes("pipeline:blocked"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

test("eval-gate-failed directs to fix evals, commit, clear label, re-run", () => {
  const body = comment("eval-gate-failed");
  assert.ok(body.includes("eval"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("pipeline:blocked"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

// ---------------------------------------------------------------------------
// Regression guard: every production setBlocked call must pass an explicit
// BlockerKind so the recipe is correct for its failure class (Finding 1).
// Reads the stage source files and asserts that each setBlocked/setBlockedFn
// call includes one of the known kind strings — no call may omit the 5th arg
// and fall back to the default needs-human recipe.
// ---------------------------------------------------------------------------

test("every production setBlocked call passes an explicit BlockerKind", () => {
  const STAGE_FILES = [
    "scripts/stages/planning.ts",
    "scripts/stages/review.ts",
    "scripts/stages/fix.ts",
    "scripts/stages/pre_merge.ts",
    "scripts/stages/eval.ts",
  ];

  const kindsPattern = new RegExp(
    BLOCKER_KINDS.map((k) => `"${k}"`).join("|"),
  );

  for (const rel of STAGE_FILES) {
    const src = readFileSync(join(__dirname, "../", rel), "utf-8");
    const callRe = /\bsetBlocked(?:Fn)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      // Extract from call open to matching close paren, respecting nesting.
      const openAt = m.index + m[0].length - 1;
      let depth = 0, i = openAt, inStr = false, strChar = "";
      while (i < src.length) {
        const ch = src[i];
        if (inStr) {
          if (ch === strChar && src[i - 1] !== "\\") inStr = false;
        } else if (ch === '"' || ch === "'") {
          inStr = true; strChar = ch;
        } else if (ch === "`") {
          // skip template literal body
          i++;
          while (i < src.length && src[i] !== "`") i++;
        } else if (ch === "(") depth++;
        else if (ch === ")") { depth--; if (depth === 0) break; }
        i++;
      }
      const callText = src.slice(m.index, i + 1);
      const lineNo = src.slice(0, m.index).split("\n").length;
      assert.ok(
        kindsPattern.test(callText),
        `setBlocked call at ${rel}:${lineNo} lacks an explicit BlockerKind — ` +
          `every call must pass the 5th kind arg to render the correct recovery recipe`,
      );
    }
  }
});
