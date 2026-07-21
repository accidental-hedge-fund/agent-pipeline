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
    "`blocked` label, and re-run `$pipeline 7`. Or record an " +
    "audited disposition with " +
    '`$pipeline 7 --override "<finding-key>: <reason>"` to advance past an ' +
    "accepted or out-of-scope finding (the key comes from the review comment; " +
    "`--override` clears the label and resumes automatically).",
  "test-gate-exhausted":
    "The test/build gate failed after the pipeline's fix attempts were " +
    "exhausted. Fix the failing test(s) or build error in the worktree, commit " +
    "the fix, remove the `blocked` label, then re-run `$pipeline 7`.",
  "no-commits":
    "The harness reported success but committed nothing and the worktree is " +
    "clean. Finish the work and commit it in the worktree (or re-run the step " +
    "manually), remove the `blocked` label, then re-run " +
    "`$pipeline 7`. If real changes are sitting uncommitted in the worktree, " +
    "committing them lets the pipeline salvage and continue (#131).",
  "harness-failure":
    "The harness process crashed or timed out (see the error above). " +
    "Investigate and fix the root cause, remove the `blocked` label, " +
    "then re-run `$pipeline 7`. A transient timeout can usually just be " +
    "unblocked and re-run as-is.",
  "openspec-invalid":
    "The OpenSpec change is structurally invalid. Run `openspec validate " +
    "<change>` in the worktree, fix the reported errors, commit, remove the " +
    "`blocked` label, then re-run `$pipeline 7`.",
  "openspec-stale-delta":
    "The OpenSpec spec delta is stale relative to the committed code. Update " +
    "`openspec/changes/<id>/specs/**` and `tasks.md` to match the " +
    "implementation, run `openspec validate <id>` to confirm the change is " +
    "valid, commit, remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "merge-conflict":
    "The branch could not be merged or auto-rebased onto the target branch. " +
    "Rebase the branch on the latest target, resolve the conflicts, push, " +
    "remove the `blocked` label, then re-run `$pipeline 7`.",
  "worktree-missing":
    "The worktree for this issue no longer exists. The fix stage cannot run " +
    "without it — re-running will block again immediately. Recreate it manually " +
    "from the issue's branch (`git worktree add`), remove the `blocked` label, " +
    "then re-run `$pipeline 7`.",
  "worktree-creation-failed":
    "Creating the worktree failed (see the error above). If a `.git/config.lock` " +
    "file is present, remove it: `rm -f .git/config.lock`. Delete the dangling " +
    "branch: `git branch -D pipeline/7-<slug>`. Remove the `blocked` label, " +
    "then re-run `$pipeline 7`.",
  "pr-creation-failed":
    "Opening the pull request failed (see the error above). Check GitHub " +
    "permissions and rate limits, remove the `blocked` label, then " +
    "re-run `$pipeline 7`.",
  "no-pull-request":
    "No pull request was found for this issue. The implementation stage may " +
    "not have run yet, or the PR was closed. Open or reopen a pull request " +
    "from the issue's branch, remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "plan-gen-failed":
    "Plan generation failed (see the error above). Fix the root cause (often a " +
    "transient harness error), remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "push-failed":
    "Pushing the branch failed for a non-conflict reason (see stderr above). " +
    "Resolve the push error (auth, remote, or branch protection), remove the " +
    "`blocked` label, then re-run `$pipeline 7`.",
  "eval-gate-misconfigured":
    "`eval_gate.enabled` is true but no command is configured. Set " +
    "`eval_gate.command` in `.github/pipeline.yml`, remove the " +
    "`blocked` label, then re-run `$pipeline 7`.",
  "eval-gate-failed":
    "The eval gate failed (see output above). Fix the failing evals in the " +
    "worktree, commit, remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "visual-gate-misconfigured":
    "`visual_gate.enabled` is true but no command is configured. Set " +
    "`visual_gate.command` in `.github/pipeline.yml`, remove the " +
    "`blocked` label, then re-run `$pipeline 7`.",
  "visual-gate-failed":
    "The visual gate failed (see output above). Fix the failing E2E/visual " +
    "checks in the worktree, commit, remove the `blocked` label, then " +
    "re-run `$pipeline 7`.",
  "shipcheck-failed":
    "The shipcheck gate returned a failing or partial verdict (see the shipcheck " +
    "comment above for the specific concerns). Address the flagged concerns in " +
    "the worktree and commit the fix, remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "head-drift":
    "The worktree HEAD differs from the PR head (an unpushed local fix). Push the " +
    "local commits so the PR head includes the fix (`git push`), remove the " +
    "`blocked` label, then re-run `$pipeline 7`.",
  "worktree-setup-failed":
    "The worktree dependency install step failed (see the error above). " +
    "Fix the root cause (package manager not installed, bad lockfile, network " +
    "issue), or set `setup_command: \"\"` in `.github/pipeline.yml` to skip " +
    "the install step. Then remove the `blocked` label and re-run " +
    "`$pipeline 7`.",
  "build-failed":
    "The declared `build_command` failed while rebuilding generated artifacts " +
    "for this round's commit (see the output above). Fix the build in the " +
    "worktree, commit the fix, remove the `blocked` label, then re-run " +
    "`$pipeline 7`.",
  "design-gate-failed":
    "The design-interrogation gate (#436) could not produce a valid decision " +
    "record or challenge verdict after its bounded re-ask, or the reviewer " +
    "harness is unavailable (see the error above). Investigate and fix the " +
    "root cause, remove the `blocked` label, then re-run `$pipeline 7`.",
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
  assert.ok(body.includes("`blocked`"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

test("needs-human directs to fix-and-re-run OR --override, and mentions label clearing", () => {
  const body = comment("needs-human");
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(body.includes("--override"));
  assert.ok(body.includes("`blocked`"));
});

test("openspec-invalid directs to openspec validate, fix, commit, clear label, re-run", () => {
  const body = comment("openspec-invalid");
  assert.ok(body.includes("openspec validate"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("`blocked`"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
});

test("openspec-stale-delta directs to update spec delta, validate, commit, clear label, re-run — never archive", () => {
  const body = comment("openspec-stale-delta");
  assert.ok(body.includes("openspec validate"), "should mention openspec validate");
  assert.ok(body.includes("commit"), "should mention commit");
  assert.ok(body.includes("`blocked`"), "should mention the blocked label");
  assert.ok(body.includes("re-run `$pipeline 7`"), "should mention re-run");
  assert.ok(!body.includes("openspec archive"), "must not tell operator to archive (bypasses the guard)");
});

test("merge-conflict directs to rebase, resolve, push, clear label, re-run", () => {
  const body = comment("merge-conflict");
  assert.ok(body.includes("Rebase"));
  assert.ok(body.includes("resolve"));
  assert.ok(body.includes("push"));
  assert.ok(body.includes("`blocked`"));
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
  assert.ok(body.includes("`blocked`"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

test("eval-gate-failed directs to fix evals, commit, clear label, re-run", () => {
  const body = comment("eval-gate-failed");
  assert.ok(body.includes("eval"));
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("`blocked`"));
  assert.ok(body.includes("re-run `$pipeline 7`"));
  assert.ok(!body.includes("--unblock"));
});

// shipcheck-failed is a distinct kind from eval-gate-failed (#302 pre-merge
// review): it must describe the shipcheck verdict, not direct the operator to
// "fix the failing evals" (the misleading recipe that reusing eval-gate-failed
// produced), while still mapping to the eval-shipcheck-failure taxonomy.
test("shipcheck-failed directs to address shipcheck concerns, commit, clear label, re-run — not 'evals'", () => {
  const body = comment("shipcheck-failed");
  assert.ok(body.includes("shipcheck"), "must name the shipcheck gate");
  assert.ok(!body.includes("eval"), "must not tell the operator to fix evals");
  assert.ok(body.includes("commit"));
  assert.ok(body.includes("`blocked`"));
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

// ---------------------------------------------------------------------------
// Regression guard: label name correctness (Finding 1, review 2).
// Recipes must name the real `blocked` label, not the non-existent
// `pipeline:blocked` label. A recipe mentioning `pipeline:blocked` would
// leave the real blocked label in place after the operator follows it.
// ---------------------------------------------------------------------------

test("no recipe mentions the non-existent 'pipeline:blocked' label", () => {
  for (const kind of BLOCKER_KINDS) {
    const rendered = renderRecipe(kind, 42);
    assert.ok(
      !rendered.includes("pipeline:blocked"),
      `recipe for "${kind}" references the non-existent pipeline:blocked label — use the real BLOCKED_LABEL ("blocked")`,
    );
  }
});

// ---------------------------------------------------------------------------
// worktree-missing: recipe must not promise re-run recreates the worktree
// (Finding 2, review 2). The fix/eval stages call getForIssue and block
// immediately — they never call createWorktree.
// ---------------------------------------------------------------------------

test("worktree-missing recipe does not falsely promise re-run will recreate the worktree", () => {
  const rendered = renderRecipe("worktree-missing", 42);
  assert.ok(
    !rendered.includes("recreate it from the branch"),
    "worktree-missing recipe must not claim re-running recreates the worktree",
  );
  assert.ok(
    rendered.includes("git worktree add"),
    "worktree-missing recipe must direct the operator to manually recreate with git worktree add",
  );
});

// ---------------------------------------------------------------------------
// no-pull-request: review stage uses this kind when no PR is found (not
// pr-creation-failed, which implies an API error during PR creation). The
// recipe must direct the operator to open/reopen a PR, not to check
// API permissions.
// ---------------------------------------------------------------------------

test("no-pull-request kind has a recipe that directs to open/reopen a pull request", () => {
  const body = comment("no-pull-request");
  assert.ok(body.includes("pull request"), "no-pull-request recipe must mention pull request");
  assert.ok(body.includes("`blocked`"), "no-pull-request recipe must mention clearing the blocked label");
  assert.ok(body.includes("re-run `$pipeline 7`"), "no-pull-request recipe must direct to re-run");
  assert.ok(!body.includes("--unblock"), "no-pull-request recipe must not direct to --unblock");
});

test("review stage uses no-pull-request kind (not pr-creation-failed) for missing PR", () => {
  const src = readFileSync(join(__dirname, "../scripts/stages/review.ts"), "utf-8");
  assert.ok(
    !src.includes('"pr-creation-failed"'),
    'review.ts must not use "pr-creation-failed" — the review stage does not create PRs; use "no-pull-request" for missing-PR cases',
  );
});

test("worktree-setup-failed directs to fix root cause or opt out via setup_command, clear label, re-run", () => {
  const body = comment("worktree-setup-failed");
  assert.ok(body.includes("dependency install"), "must mention the install step");
  assert.ok(body.includes("setup_command"), "must mention the setup_command opt-out");
  assert.ok(body.includes("`blocked`"), "must mention clearing the blocked label");
  assert.ok(body.includes("re-run `$pipeline 7`"), "must direct to re-run");
  assert.ok(!body.includes("--unblock"), "must not direct to --unblock");
});

// ---------------------------------------------------------------------------
// worktree-creation-failed: recipe must include the four .git/config.lock
// cleanup steps introduced in #183.
// ---------------------------------------------------------------------------

test("worktree-creation-failed directs to remove config lock, delete dangling branch, clear label, re-run", () => {
  const body = comment("worktree-creation-failed");
  assert.ok(body.includes("rm -f .git/config.lock"), "must include git config lock removal command");
  assert.ok(body.includes("git branch -D pipeline/"), "must include dangling branch deletion command");
  assert.ok(body.includes("`blocked`"), "must mention clearing the blocked label");
  assert.ok(body.includes("re-run `$pipeline 7`"), "must direct to re-run");
  assert.ok(!body.includes("--unblock"), "must not direct to --unblock");
});

// head-drift: must direct to push the local commits, not merely clear the label (#317).
test("head-drift directs to push local commits, clear label, re-run — not merely clear the label", () => {
  const body = comment("head-drift");
  assert.ok(body.includes("git push"), "must direct to push the local commits");
  assert.ok(body.includes("`blocked`"), "must mention clearing the blocked label");
  assert.ok(body.includes("re-run `$pipeline 7`"), "must direct to re-run");
  assert.ok(!body.includes("--unblock"), "must not direct to --unblock");
  // Recipe must NOT consist solely of a clear-the-label instruction.
  assert.ok(body.includes("push"), "must mention pushing");
});
