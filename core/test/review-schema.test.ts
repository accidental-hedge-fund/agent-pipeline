// Drift guard for the single-sourced review verdict JSON schema (#56).
//
// The review prompts no longer hand-copy the verdict JSON block; they embed
// `REVIEW_VERDICT_SCHEMA_BLOCK` via a `{{schema_block}}` placeholder. These
// tests fail loudly if the schema block and the `ReviewFinding`/`ReviewVerdict`
// field manifest (`REVIEW_SCHEMA_FIELDS`) diverge — the exact drift that, left
// unguarded, makes the reviewer emit a shape `parseStructuredVerdict` silently
// drops (findings disappear → needs-attention/0 → blocked run; see #45/#50/#52).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_SCHEMA_FIELDS,
  REVIEW_VERDICT_SCHEMA_BLOCK,
} from "../scripts/review-schema.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
  substitute,
} from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// Walk the schema block tracking brace/bracket depth, recording the order of
// keys at the verdict level (depth 1) and the finding level (depth 3). The block
// contains no `{}[]` inside string values, so raw depth counting is reliable.
function parseSchemaBlockFields(block: string): { verdict: string[]; finding: string[] } {
  const verdict: string[] = [];
  const finding: string[] = [];
  let depth = 0;
  const keyRe = /^"(\w+)"\s*:/;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"') {
      const m = block.slice(i).match(keyRe);
      if (m) {
        if (depth === 1) verdict.push(m[1]);
        else if (depth === 3) finding.push(m[1]);
      }
    }
  }
  return { verdict, finding };
}

const declaredFields = [...REVIEW_SCHEMA_FIELDS.verdict, ...REVIEW_SCHEMA_FIELDS.finding];

// Minimal config: the review builders only read domain + conventions. A repo_dir
// that does not exist makes readConventions return its "no conventions" default.
const cfg = {
  domain: "acme",
  repo: "acme/widget",
  repo_dir: "/tmp/does-not-exist-pipeline-56",
  domain_name: "Widget",
  domain_description: "the example widget service",
} as PipelineConfig;

test("drift guard: schema block fields match the ReviewFinding/ReviewVerdict manifest", () => {
  const parsed = parseSchemaBlockFields(REVIEW_VERDICT_SCHEMA_BLOCK);
  const inBlock = [...parsed.verdict, ...parsed.finding];

  const missingFromBlock = declaredFields.filter((f) => !inBlock.includes(f));
  const extraInBlock = inBlock.filter((f) => !declaredFields.includes(f));

  assert.deepEqual(
    missingFromBlock,
    [],
    `fields declared in ReviewFinding/ReviewVerdict but absent from REVIEW_VERDICT_SCHEMA_BLOCK: ${missingFromBlock.join(", ")}`,
  );
  assert.deepEqual(
    extraInBlock,
    [],
    `fields present in REVIEW_VERDICT_SCHEMA_BLOCK but not declared in ReviewFinding/ReviewVerdict: ${extraInBlock.join(", ")}`,
  );
});

test("drift guard: schema block preserves the historical field order and nesting", () => {
  const parsed = parseSchemaBlockFields(REVIEW_VERDICT_SCHEMA_BLOCK);
  // Locks the documented shape: verdict, summary, findings[{...}], next_steps.
  assert.deepEqual(parsed.verdict, ["verdict", "summary", "findings", "next_steps"]);
  assert.deepEqual(parsed.finding, [
    "severity",
    "title",
    "body",
    "file",
    "line_start",
    "line_end",
    "confidence",
    "recommendation",
  ]);
  assert.deepEqual(parsed.verdict, REVIEW_SCHEMA_FIELDS.verdict);
  assert.deepEqual(parsed.finding, REVIEW_SCHEMA_FIELDS.finding);
});

test("both review prompts substitute the schema block (no literal placeholder, all fields present)", () => {
  const standard = buildReviewStandardPrompt({
    cfg,
    issueNumber: 7,
    title: "T",
    body: "B",
    plan: "PLAN",
    diff: "diff --git a/x b/x\n+hello\n",
  });
  const adversarial = buildReviewAdversarialPrompt({
    cfg,
    issueNumber: 7,
    title: "T",
    body: "B",
    diff: "diff --git a/x b/x\n+hello\n",
  });

  for (const [name, out] of [
    ["review_standard", standard],
    ["review_adversarial", adversarial],
  ] as const) {
    assert.doesNotMatch(
      out,
      /\{\{\s*schema_block\s*\}\}/,
      `${name}: the {{schema_block}} placeholder must be substituted before the prompt is sent`,
    );
    for (const field of declaredFields) {
      assert.ok(
        out.includes(`"${field}"`),
        `${name}: rendered prompt is missing schema field "${field}"`,
      );
    }
  }
});

test("unresolved {{schema_block}} is a hard error, not a prompt sent with a literal token", () => {
  // The prompt builders rely on substitute() throwing when schema_block is not
  // supplied, so a skipped substitution can never reach the reviewer (#56).
  assert.throws(
    () => substitute("schema:\n```\n{{schema_block}}\n```\n", { other: "x" }),
    /Unfilled prompt placeholder\(s\) \{\{schema_block\}\}/,
  );
});
