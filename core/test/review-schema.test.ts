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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_SCHEMA_FIELDS,
  REVIEW_VERDICT_SCHEMA_BLOCK,
} from "../scripts/review-schema.ts";
import {
  buildReviewAdversarialPrompt,
  buildReviewStandardPrompt,
  substitute,
  _testing,
} from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// Extract field names from a named `interface Foo { ... }` block in TypeScript
// source text. Handles optional fields (`name?:`) and ignores comment lines.
function parseInterfaceFields(src: string, interfaceName: string): string[] {
  const marker = `interface ${interfaceName} {`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Interface ${interfaceName} not found in types.ts`);
  const bodyStart = src.indexOf("{", start) + 1;
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(bodyStart, i - 1);
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    // Accepts all valid TS property forms regardless of indentation:
    //   optional leading spaces (column 0 allowed), optional 'readonly' modifier,
    //   bare or "quoted" identifier, optional '?' for optional properties.
    const m = line.match(/^\s*(?:readonly\s+)?(?:(\w+)|"(\w+)")\??:/);
    if (m) fields.push(m[1] ?? m[2]);
  }
  return fields;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesSrc = readFileSync(join(__dirname, "../scripts/types.ts"), "utf-8");

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

// Pull the fenced code block that immediately follows "Return ONLY valid JSON
// matching this schema" in a rendered review prompt. The extracted text must
// equal REVIEW_VERDICT_SCHEMA_BLOCK exactly — any extra or missing field in a
// hand-copied block causes this comparison to fail.
function extractRenderedSchemaBlock(rendered: string): string {
  const m = rendered.match(/Return ONLY valid JSON[^\n]*\n\n```\n([\s\S]*?)\n```/);
  if (!m) throw new Error("Could not find fenced schema block in rendered prompt");
  return m[1];
}

// Regression: parseInterfaceFields must detect all valid TS property forms.
// Each bypass form below was a latent hole in the old /^\s+(\w+)\??:/ regex.
test("parseInterfaceFields regression: unindented, readonly, quoted, and optional properties are all detected", () => {
  const src = `
interface SyntheticA {
  indented: string;
unindented: string;
  readonly readonlyField: string;
  "quotedField": string;
  optional?: number;
// comment: ignored
}
`;
  const fields = parseInterfaceFields(src, "SyntheticA");
  assert.deepEqual(
    fields,
    ["indented", "unindented", "readonlyField", "quotedField", "optional"],
    "parseInterfaceFields must detect unindented, readonly, quoted, and optional properties",
  );
});

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

// This test is the critical link that makes the drift guard non-bypassable:
// it reads the *actual* TypeScript source and compares interface field names
// against REVIEW_SCHEMA_FIELDS. Without it, adding a field to ReviewFinding
// while forgetting FINDING_FIELD_GUARD passes silently under --experimental-strip-types
// (which strips types but never type-checks).
test("drift guard: REVIEW_SCHEMA_FIELDS tracks the actual interface declarations in types.ts", () => {
  const findingFromSrc = parseInterfaceFields(typesSrc, "ReviewFinding");
  // commitSha is excluded from the verdict side: it is stamped by the pipeline
  // from the PR head, not emitted by the reviewer, and must NOT appear in the
  // schema block sent to the reviewer (see VERDICT_FIELD_GUARD in review-schema.ts).
  const verdictFromSrc = parseInterfaceFields(typesSrc, "ReviewVerdict").filter(
    (f) => f !== "commitSha",
  );

  assert.deepEqual(
    findingFromSrc,
    REVIEW_SCHEMA_FIELDS.finding,
    `ReviewFinding fields in types.ts (${findingFromSrc.join(", ")}) ` +
      `don't match REVIEW_SCHEMA_FIELDS.finding (${REVIEW_SCHEMA_FIELDS.finding.join(", ")}). ` +
      `Update FINDING_FIELD_GUARD in review-schema.ts to match.`,
  );
  assert.deepEqual(
    verdictFromSrc,
    REVIEW_SCHEMA_FIELDS.verdict,
    `ReviewVerdict fields in types.ts (${verdictFromSrc.join(", ")}) ` +
      `don't match REVIEW_SCHEMA_FIELDS.verdict (${REVIEW_SCHEMA_FIELDS.verdict.join(", ")}). ` +
      `Update VERDICT_FIELD_GUARD in review-schema.ts to match.`,
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
    "category",
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
    // Extract the fenced schema block from the rendered prompt and compare it
    // exactly to REVIEW_VERDICT_SCHEMA_BLOCK. A hand-copied block with extra
    // fields or reordered keys fails here even if it contains all current fields.
    const extracted = extractRenderedSchemaBlock(out);
    assert.equal(
      extracted,
      REVIEW_VERDICT_SCHEMA_BLOCK,
      `${name}: extracted schema block must exactly match REVIEW_VERDICT_SCHEMA_BLOCK (extra fields or drift fail here)`,
    );
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

test("review prompt templates use {{schema_block}} placeholder and do not embed the schema literally", () => {
  // If either template drops the placeholder in favour of a hand-copied block,
  // substitute() would silently ignore the schema_block value and the reviewer
  // would receive whatever literal text the template author typed — bypassing
  // the single-source guard entirely. This test closes that gap by asserting
  // both that the placeholder is present and that the schema constant itself is
  // not duplicated verbatim in the template file.
  const { loadTemplate } = _testing;
  for (const name of ["review_standard", "review_adversarial"]) {
    const tmpl = loadTemplate(name);
    assert.match(
      tmpl,
      /\{\{\s*schema_block\s*\}\}/,
      `${name}.md must contain {{schema_block}} placeholder — a literal hand-copied block bypasses the single-source guard`,
    );
    assert.ok(
      !tmpl.includes(REVIEW_VERDICT_SCHEMA_BLOCK),
      `${name}.md must not embed the schema block literally — use {{schema_block}} instead`,
    );
  }
});
