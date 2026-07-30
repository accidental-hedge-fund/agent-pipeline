// Drift guard: high-traffic operator copy must not equate plan-review with
// human sign-off / human approval (#574). Reads checked-in README (and host
// skills for the same forbidden equality phrases) — no network, git, or
// subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const README_PATH = path.join(repoRoot, "README.md");
const HOST_SKILLS = [
  { label: "claude", path: path.join(repoRoot, "hosts/claude/SKILL.md") },
  { label: "codex", path: path.join(repoRoot, "hosts/codex/SKILL.md") },
] as const;

/**
 * Equality claims that collapse plan-review into human approval.
 * Matched against markdown-stripped text. Explicit negation is stripped first
 * so "plan-review is not human sign-off" does not false-positive if a broader
 * pattern is added later.
 */
const FORBIDDEN_EQUALITY: { name: string; re: RegExp }[] = [
  {
    name: "plan-review is the human sign-off",
    re: /plan-review\s+is\s+the\s+human\s+sign-off/i,
  },
  {
    name: "plan-review is human sign-off",
    re: /plan-review\s+is\s+human\s+sign-off/i,
  },
  {
    name: "plan-review is the human approval",
    re: /plan-review\s+is\s+the\s+human\s+approval/i,
  },
  {
    name: "plan-review is human approval",
    re: /plan-review\s+is\s+human\s+approval/i,
  },
  {
    name: "plan-review is a human sign-off",
    re: /plan-review\s+is\s+a\s+human\s+sign-off/i,
  },
  {
    name: "plan-review is a human approval",
    re: /plan-review\s+is\s+a\s+human\s+approval/i,
  },
];

/** Strip markdown emphasis/code and collapse whitespace for phrase matching. */
function flattenDocs(source: string): string {
  return source
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Remove explicit distinction / negation clauses so correct docs that say
 * "plan-review is not human sign-off" do not trip equality patterns.
 */
function stripExplicitNegations(flat: string): string {
  return flat
    .replace(
      /plan-review\s+is\s+(?:not|never)\s+(?:the\s+)?(?:a\s+)?human\s+(?:sign-off|approval)/gi,
      " ",
    )
    .replace(
      /not\s+(?:the\s+)?(?:a\s+)?human\s+sign-off/gi,
      " ",
    )
    .replace(
      /not\s+(?:the\s+)?(?:a\s+)?human\s+approval/gi,
      " ",
    );
}

/** Exported for bite-check tests via module-local use. */
function assertNoForbiddenPlanReviewAuthority(source: string, label: string): void {
  const flat = stripExplicitNegations(flattenDocs(source));
  for (const { name, re } of FORBIDDEN_EQUALITY) {
    assert.ok(
      !re.test(flat),
      `${label}: forbidden phrase equating plan-review with human approval (${name})`,
    );
  }
}

function lifecycleSection(source: string): string {
  const match = source.match(/## Lifecycle[\s\S]*?(?=\n## Contents|\n## [A-Z])/);
  assert.ok(match, "README must have a Lifecycle section before Contents");
  return match[0];
}

function humanPlanFeedbackSection(source: string): string {
  const match = source.match(
    /### Human plan feedback[\s\S]*?(?=\n### |\n## )/,
  );
  assert.ok(match, "README must have a Human plan feedback section");
  return match[0];
}

// ---------------------------------------------------------------------------
// README — forbidden equality
// ---------------------------------------------------------------------------

test("README must not equate plan-review with human sign-off/approval (#574)", () => {
  const source = fs.readFileSync(README_PATH, "utf8");
  assertNoForbiddenPlanReviewAuthority(source, "README.md");
});

// ---------------------------------------------------------------------------
// README Lifecycle — positive authority language
// ---------------------------------------------------------------------------

test("README Lifecycle band describes independent agent plan review + feedback window (#574)", () => {
  const lifecycle = lifecycleSection(fs.readFileSync(README_PATH, "utf8"));
  assert.match(
    lifecycle,
    /independent agent plan review/i,
    "Lifecycle must name independent agent plan review",
  );
  assert.match(
    lifecycle,
    /human feedback window/i,
    "Lifecycle must name the human feedback window",
  );
  assert.ok(
    !/plan-review\s+is\s+the\s+human\s+sign-off/i.test(flattenDocs(lifecycle)),
    "Lifecycle must not claim plan-review is the human sign-off",
  );
  // Do not claim unconditional independence: qualify or point at same-harness fallback.
  assert.match(
    flattenDocs(lifecycle),
    /same-harness self-review|same-harness fallback|reviewer CLI is missing/i,
    "Lifecycle must qualify independence with same-harness fallback when reviewer CLI is missing",
  );
});

// ---------------------------------------------------------------------------
// README Human plan feedback — empty-window + boundary
// ---------------------------------------------------------------------------

test("README Human plan feedback states empty-window semantics and authority boundary (#574)", () => {
  const section = humanPlanFeedbackSection(fs.readFileSync(README_PATH, "utf8"));
  const flat = flattenDocs(section);

  assert.match(
    flat,
    /independent agent plan review/i,
    "section must name independent agent plan review",
  );
  assert.match(
    flat,
    /human feedback window/i,
    "section must name the human feedback window",
  );
  // Markdown-stripped: "does **not** block" → "does not block"
  assert.ok(
    /does not block the advance/i.test(flat),
    "section must state missing human comments do not block the advance",
  );
  assert.ok(
    /not recorded as human approval/i.test(flat),
    "section must state missing human comments are not recorded as human approval",
  );
  assert.match(
    flat,
    /human approval|human-owned merge|ready-to-deploy/i,
    "section must keep terminal human approval / merge distinct",
  );
  assert.match(
    flat,
    /human attestation/i,
    "section must name human attestation as distinct from plan sign-off",
  );
  // Independence must not be overstated on the #39 reviewer-missing path.
  assert.match(
    flat,
    /same-harness (?:fallback|self-review)/i,
    "section must disclose same-harness fallback when asserting independent plan-review",
  );
  assert.ok(
    /not\s+independent agent plan review/i.test(flat) ||
      /is not independent/i.test(flat),
    "section must state that labeled same-harness self-review is not independent agent plan review",
  );
});

// ---------------------------------------------------------------------------
// Host skills — same forbidden equality (cheap extension)
// ---------------------------------------------------------------------------

for (const { label, path: skillPath } of HOST_SKILLS) {
  test(`host skill ${label}: must not equate plan-review with human sign-off/approval (#574)`, () => {
    const source = fs.readFileSync(skillPath, "utf8");
    assertNoForbiddenPlanReviewAuthority(source, `hosts/${label}/SKILL.md`);
  });
}

// ---------------------------------------------------------------------------
// Guard bite / allow checks (prove the patterns work)
// ---------------------------------------------------------------------------

test("drift-guard fails on the historical README equality phrase (#574)", () => {
  const bad =
    "`planning` writes the plan, and `plan-review` is the human sign-off before implementation starts.";
  assert.throws(
    () => assertNoForbiddenPlanReviewAuthority(bad, "historical-bad"),
    (err: unknown) => err instanceof assert.AssertionError,
  );
});

test("drift-guard allows explicit distinction / negation sentences (#574)", () => {
  const ok = [
    "plan-review is independent agent review and is not human sign-off.",
    "`plan-review` is **not** the human sign-off before implementation.",
    "Plan-review is never human approval; human merge remains at ready-to-deploy.",
  ].join("\n");
  assertNoForbiddenPlanReviewAuthority(ok, "negation-ok");
});
