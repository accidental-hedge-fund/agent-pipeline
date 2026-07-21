// Drift guard for the single-sourced design-challenge verdict JSON schema (#436),
// mirroring review-schema.test.ts's guard for REVIEW_VERDICT_SCHEMA_BLOCK.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_CHALLENGE_SCHEMA_BLOCK, DESIGN_CHALLENGE_SCHEMA_FIELDS } from "../scripts/review-schema.ts";
import { buildDesignInterrogationPrompt, substitute } from "../scripts/prompts/index.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prompts");

test("design_interrogation.md uses {{schema_block}} placeholder and does not embed the schema literally", () => {
  const template = readFileSync(join(promptsDir, "design_interrogation.md"), "utf8");
  assert.match(template, /\{\{\s*schema_block\s*\}\}/, "design_interrogation.md must contain {{schema_block}} placeholder");
  assert.ok(
    !template.includes(DESIGN_CHALLENGE_SCHEMA_BLOCK),
    "design_interrogation.md must not embed the schema block literally — use {{schema_block}} instead",
  );
});

test("buildDesignInterrogationPrompt substitutes the schema block", () => {
  const rendered = buildDesignInterrogationPrompt({
    body: "issue body",
    plan: "the plan",
    decisionRecordJson: "{}",
  });
  assert.ok(rendered.includes(DESIGN_CHALLENGE_SCHEMA_BLOCK));
  assert.ok(!/\{\{\s*schema_block\s*\}\}/.test(rendered));
});

test("unresolved {{schema_block}} is a hard error", () => {
  assert.throws(
    () => substitute("schema:\n```\n{{schema_block}}\n```\n", { other: "x" }),
    /Unfilled prompt placeholder\(s\) \{\{schema_block\}\}/,
  );
});

test("DESIGN_CHALLENGE_SCHEMA_FIELDS field names match the schema block's field names", () => {
  const fieldRe = /"(\w+)":/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(DESIGN_CHALLENGE_SCHEMA_BLOCK)) !== null) found.add(m[1]);
  for (const f of [...DESIGN_CHALLENGE_SCHEMA_FIELDS.verdict, ...DESIGN_CHALLENGE_SCHEMA_FIELDS.challenge]) {
    assert.ok(found.has(f), `expected schema block to mention field "${f}"`);
  }
});
