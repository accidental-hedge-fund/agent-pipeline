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

// Map a TypeScript scalar type annotation to the schema-block hint vocabulary:
//   number              -> a bare angle-bracket hint  (<int>, <0.0-1.0>)
//   string / "a" | "b"  -> a quoted hint              ("<text>", "x" | "y")
//   boolean             -> an unquoted boolean-literal hint (true | false)
// Validates EVERY union arm rather than shortcutting on the first one. `undefined`
// arms are dropped (optional — about field presence, not value type, like the `?`
// fields). All remaining arms must agree on a single scalar value type; a `null`
// arm, a mixed union (e.g. `"low" | number`), an array, or any unrecognised arm
// makes the whole token "other", which the drift guard treats as a mismatch (fail
// closed) against a concrete schema hint — never a silent skip. (null ≠ undefined;
// the per-side skip, the first-arm shortcut, and the trailing-only strip were all
// adversarial-review gaps — validating every arm closes them at the root.)
function classifyTsType(token: string): "number" | "string" | "boolean" | "other" {
  const arms = token
    .split("|")
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a !== "undefined");
  if (arms.length === 0) return "other";
  const armCat = (arm: string): "number" | "string" | "boolean" | "other" => {
    if (arm === "number") return "number";
    if (arm === "boolean") return "boolean";
    if (arm === "string" || /^".*"$/.test(arm)) return "string"; // string or string literal
    return "other"; // null, arrays, mixed/unrecognised → fail closed
  };
  const cats = new Set(arms.map(armCat));
  return cats.size === 1 && !cats.has("other") ? [...cats][0]! : "other";
}

// Like `parseInterfaceFields`, but returns each field's raw value-type annotation
// token (the text after `:`, up to a `;`, a `//` comment, or EOL), keyed by field
// name. Array fields (ending with `[]`) are excluded since the schema block carries
// no comparable scalar hint for them; all other fields are kept, including ones
// whose annotation is not yet classified (e.g. `string | undefined`) — the drift
// guard treats an unrecognised token as a mismatch when the schema block carries a
// concrete hint. Kept separate from `parseInterfaceFields` so that function's
// `string[]` contract and its callers stay untouched (#85).
function parseInterfaceFieldTypes(src: string, interfaceName: string): Record<string, string> {
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
  const types: Record<string, string> = {};
  for (const line of body.split("\n")) {
    // Same property forms as parseInterfaceFields, plus a third group capturing
    // the annotation token (stops at `;`, a `//` comment, or end-of-line).
    const m = line.match(/^\s*(?:readonly\s+)?(?:(\w+)|"(\w+)")\??:\s*([^;/\n]+)/);
    if (!m) continue;
    const token = m[3].trim();
    if (token.endsWith("[]")) continue; // arrays: no scalar hint in schema block
    types[m[1] ?? m[2]] = token;
  }
  return types;
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

// A schema-block value hint is `number` when it's a bare angle-bracket placeholder
// (<int>, <0.0-1.0>), `string` when it's quoted ("<text>", "x" | "y"), and
// `boolean` when it's the unquoted boolean-literal form (true | false). Anything
// else — an array (`[`, `["<...>"]`) or nested object — is "other" and excluded
// from the value-type guard.
function classifySchemaHint(value: string): "number" | "string" | "boolean" | "other" {
  if (value.startsWith('"')) return "string";
  if (value.startsWith("<")) return "number";
  // Boolean-literal hint: unquoted "true | false" (or "true" / "false" alone).
  if (/^(true|false)(\s*\|\s*(true|false))?$/.test(value)) return "boolean";
  return "other";
}

// Companion to parseSchemaBlockFields: instead of just key order, capture each
// scalar key's value *category* so the drift guard can compare it to the matching
// TS field's type. Mirrors that walk (verdict keys at depth 1, finding keys at
// depth 3) and reads the value text after the key, classifying it via
// classifySchemaHint. Array/object values (findings, next_steps) classify as
// "other" and are skipped by the guard.
function parseSchemaBlockValueHints(block: string): Record<string, "number" | "string" | "boolean" | "other"> {
  const hints: Record<string, "number" | "string" | "boolean" | "other"> = {};
  let depth = 0;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"') {
      const m = block.slice(i).match(/^"(\w+)"\s*:\s*([^\n]*)/);
      if (m && (depth === 1 || depth === 3)) {
        const value = m[2].replace(/,\s*$/, "").trim();
        hints[m[1]] = classifySchemaHint(value);
      }
    }
  }
  return hints;
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

// Regression: parseInterfaceFieldTypes must capture the annotation token per field
// (number, string, string-literal union, nullable `T | undefined`, optional/readonly
// forms) and skip only array fields. Before #85-fix2, `string | undefined` was
// classified as "other" and silently dropped — this test fails without that fix.
test("parseInterfaceFieldTypes regression: captures scalar tokens, nullable unions, and skips array fields", () => {
  const src = `
interface SyntheticB {
  count: number;
  label: string;
  kind: "a" | "b" | "c";
  optionalCount?: number;
  readonly tag: string;
  nullable: string | undefined;
  items: string[];
  nested: ReviewFinding[];
// comment: ignored
}
`;
  const types = parseInterfaceFieldTypes(src, "SyntheticB");
  assert.deepEqual(
    types,
    {
      count: "number",
      label: "string",
      kind: '"a" | "b" | "c"',
      optionalCount: "number",
      tag: "string",
      nullable: "string | undefined",
    },
    "parseInterfaceFieldTypes must capture number/string/union/nullable/optional/readonly tokens and skip arrays",
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
    "spec_divergence_direction",
    "blocking",
    "prior_round_acknowledgment",
    "rejected_alternatives",
  ]);
  assert.deepEqual(parsed.verdict, REVIEW_SCHEMA_FIELDS.verdict);
  assert.deepEqual(parsed.finding, REVIEW_SCHEMA_FIELDS.finding);
});

// Regression (#85 finding 1): before the fix, parseInterfaceFieldTypes dropped
// `string | undefined` (classified as "other" → skipped), so renaming
// `line_start?: number` to `line_start: string | undefined` while the schema
// block still carried `<int>` was invisible to the guard. The fix changes
// parseInterfaceFieldTypes to skip only `[]` arrays, and extends classifyTsType
// to resolve `T | undefined` → classifyTsType(T).
test("drift guard: string union type vs bare hint is a mismatch (regression #85 finding 1)", () => {
  // Simulate a field rewritten to `string | undefined` while schema still says <int>
  const syntheticSrc = `
interface SyntheticFinding {
  line_start: string | undefined;
  confidence: number;
}
`;
  const syntheticBlock = `{
    "findings": [
        {
            "line_start": <int>,
            "confidence": <0.0-1.0>
        }
    ]
}`;

  const tsTypes = parseInterfaceFieldTypes(syntheticSrc, "SyntheticFinding");
  assert.ok(
    "line_start" in tsTypes,
    "parseInterfaceFieldTypes must include `string | undefined` fields (not skip them as 'other')",
  );
  assert.equal(tsTypes.line_start, "string | undefined");

  const hints = parseSchemaBlockValueHints(syntheticBlock);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const blockCat = hints[field];
    if (blockCat === undefined || blockCat === "other") continue;
    const tsCat = classifyTsType(token);
    if (tsCat !== blockCat) {
      mismatches.push(`${field}: \`${token}\` (${tsCat}) vs schema (${blockCat})`);
    }
  }

  assert.deepEqual(
    mismatches,
    ["line_start: `string | undefined` (string) vs schema (number)"],
    "drift guard must catch `string | undefined` vs `<int>` as a type-token mismatch",
  );
});

// Regression (#85 round 3): the value-type guard must not silently SKIP a scalar
// field whose TS token classifies as "other" — an unrecognised token on EITHER side
// is a mismatch (fail closed), never a `continue`. The earlier fixes oscillated by
// moving a skip between the TS and schema sides. It also draws the optional-vs-null
// line: `| undefined`/optional `?` is about presence (normalise to the base scalar),
// but `| null` is a real emitted JSON value the schema-block placeholder can't
// express, so it stays "other" and fails closed (per adversarial review — null ≠
// undefined).
test("value-type guard: optional normalises, but null + unrecognised tokens fail closed (#85)", () => {
  // Optional spelling normalises — presence, not value type.
  assert.equal(classifyTsType("string | undefined"), "string");
  assert.equal(classifyTsType("number | undefined"), "number");
  assert.equal(classifyTsType('"a" | "b" | undefined'), "string");
  // `| null` is a real emitted value the hint vocabulary can't express → stays "other".
  assert.equal(classifyTsType("string | null"), "other");
  assert.equal(classifyTsType("number | null"), "other");
  assert.equal(classifyTsType("string | null | undefined"), "other");
  assert.equal(classifyTsType("number | undefined | null"), "other");
  // Clean string-literal unions (the real `verdict` / `severity` fields) → "string".
  assert.equal(classifyTsType('"approve" | "needs-attention"'), "string");
  assert.equal(classifyTsType('"critical" | "high" | "medium" | "low"'), "string");
  // ...but EVERY arm is validated: a literal union with a null or non-string arm
  // (or a mixed union) fails closed — the first-arm `"` shortcut was a real gap.
  assert.equal(classifyTsType('"a" | "b" | null'), "other");
  assert.equal(classifyTsType('"low" | number'), "other");
  assert.equal(classifyTsType('"approve" | "needs-attention" | undefined'), "string");
  // Genuinely unrecognised forms also stay "other".
  assert.equal(classifyTsType("Record<string, number>"), "other");

  const syntheticSrc = [
    "export interface SyntheticOther {",
    "  summary: string | null;", // null is a real value → "other" → fails closed
    "  file: string | undefined;", // optional → normalises to "string" → matches
    "  line_start: Record<string, number>;", // unrecognised → "other" → fails closed
    "}",
  ].join("\n");
  // Schema block: string fields hinted quoted, number field hinted bare-angle.
  const syntheticBlock = [
    "{",
    '  "summary": "<one-line>",',
    '  "file": "<path>",',
    '  "findings": [',
    "    {",
    '      "line_start": <int>',
    "    }",
    "  ]",
    "}",
  ].join("\n");

  const tsTypes = parseInterfaceFieldTypes(syntheticSrc, "SyntheticOther");
  const hints = parseSchemaBlockValueHints(syntheticBlock);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const tsCat = classifyTsType(token);
    const blockCat = hints[field];
    if (tsCat === "other" || blockCat === undefined || blockCat === "other" || tsCat !== blockCat) {
      mismatches.push(`${field}: \`${token}\` (${tsCat}) vs schema (${blockCat ?? "absent"})`);
    }
  }

  // file (string | undefined → string) vs "<path>" (string) → matches (optional ok).
  // summary (string | null → other) vs "<one-line>" (string) → fails closed.
  // line_start (Record<…> → other) vs <int> (number) → fails closed.
  assert.deepEqual(
    mismatches.sort(),
    [
      "line_start: `Record<string, number>` (other) vs schema (number)",
      "summary: `string | null` (other) vs schema (string)",
    ],
    "null + unrecognised tokens must fail closed against a concrete hint; optional must normalise and match",
  );
});

// Value-type drift guard (#85): the field-name guards above keep the *keys* in
// sync but discard the `: number` / `: string` annotation, so flipping
// `line_start?: number` -> `string` while the block still hints `<int>` slips
// through. This compares each scalar field's TS type category against the schema
// block's value-hint category, so a number-vs-quoted (or string-vs-bare) drift
// fails. Array fields (tsCat === "other") are excluded; if the schema hint for a
// scalar TS field is "other" or absent, that is itself a mismatch.
test("drift guard: value-type tokens match schema block value hints", () => {
  const tsTypes: Record<string, string> = {
    ...parseInterfaceFieldTypes(typesSrc, "ReviewFinding"),
    ...parseInterfaceFieldTypes(typesSrc, "ReviewVerdict"),
  };
  // commitSha is stamped by the pipeline from the PR head and never appears in
  // the schema block (see the field-name guard above), so it has no hint to match.
  delete tsTypes.commitSha;

  const hints = parseSchemaBlockValueHints(REVIEW_VERDICT_SCHEMA_BLOCK);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const tsCat = classifyTsType(token);
    const blockCat = hints[field];
    // Array fields are already excluded at parse time, so every field reaching here
    // is scalar-intended. Fail closed SYMMETRICALLY: an unrecognised token on either
    // side is itself drift, never a silent skip. tsCat "other" = an unsupported TS
    // form for a scalar field; blockCat "other" = a non-scalar schema value (e.g. an
    // array `["..."]` or unquoted bare text) for a field the type system declares
    // scalar. blockCat undefined is already caught by the field-name guard; surfaced
    // here for completeness.
    if (tsCat === "other" || blockCat === undefined || blockCat === "other" || tsCat !== blockCat) {
      const hint = blockCat ?? "absent";
      mismatches.push(`${field}: types.ts \`${token}\` (${tsCat}) vs schema block hint (${hint})`);
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    `value-type drift between ReviewFinding/ReviewVerdict and REVIEW_VERDICT_SCHEMA_BLOCK:\n  ${mismatches.join("\n  ")}\n` +
      `Update the schema block value hint or the TS field type so both agree.`,
  );
});

// Regression (#85 finding 2): the prior fix still skipped schema-side "other" hints,
// so changing a scalar string field's schema block value from a quoted hint to an
// unsupported non-scalar form (e.g. `["<...>"]`) was invisible to the guard. The fix
// inverts the skip condition: skip only when the *TS* side is non-scalar, so a scalar
// TS field with a schema-side "other" hint is reported as a mismatch.
// Boolean type-token tests (#236): classifyTsType must recognise `boolean` as a
// distinct category (not "number" or "string"), and classifySchemaHint must
// recognise `true | false` as the boolean-literal hint category.
test("classifyTsType: boolean is a distinct category; boolean | undefined normalises to boolean (#236)", () => {
  assert.equal(classifyTsType("boolean"), "boolean", "plain boolean must classify as 'boolean'");
  assert.equal(classifyTsType("boolean | undefined"), "boolean", "optional boolean must normalise to 'boolean'");
  // Mixed boolean arms stay 'other' (fail closed).
  assert.equal(classifyTsType("boolean | string"), "other", "mixed boolean+string must be 'other'");
  assert.equal(classifyTsType("boolean | null"), "other", "boolean | null must be 'other' (null ≠ undefined)");
});

test("classifySchemaHint: 'true | false' classifies as 'boolean'; quoted form is 'string', not 'boolean' (#236)", () => {
  assert.equal(classifySchemaHint("true | false"), "boolean", "'true | false' must be 'boolean'");
  assert.equal(classifySchemaHint("true"), "boolean", "'true' alone must be 'boolean'");
  assert.equal(classifySchemaHint("false"), "boolean", "'false' alone must be 'boolean'");
  // A quoted form must be 'string', not 'boolean' — the mismatch the spec requires.
  assert.equal(classifySchemaHint('"true"'), "string", 'quoted "true" must be string, not boolean');
  // A numeric bare-angle hint must not be 'boolean'.
  assert.equal(classifySchemaHint("<int>"), "number", "'<int>' must be 'number', not 'boolean'");
});

test("drift guard: boolean TS field with 'true | false' schema hint passes (#236)", () => {
  const syntheticSrc = `
interface SyntheticFinding {
  blocking: boolean;
}
`;
  const syntheticBlock = `{
    "findings": [
        {
            "blocking": true | false
        }
    ]
}`;
  const tsTypes = parseInterfaceFieldTypes(syntheticSrc, "SyntheticFinding");
  const hints = parseSchemaBlockValueHints(syntheticBlock);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const tsCat = classifyTsType(token);
    const blockCat = hints[field];
    if (tsCat === "other" || blockCat === undefined || blockCat === "other" || tsCat !== blockCat) {
      mismatches.push(`${field}: \`${token}\` (${tsCat}) vs schema (${blockCat ?? "absent"})`);
    }
  }
  assert.deepEqual(mismatches, [], "boolean field with 'true | false' hint must pass drift guard");
});

test("drift guard: boolean TS field with quoted schema hint is a mismatch (#236)", () => {
  const syntheticSrc = `
interface SyntheticFinding {
  blocking: boolean;
}
`;
  const syntheticBlock = `{
    "findings": [
        {
            "blocking": "true"
        }
    ]
}`;
  const tsTypes = parseInterfaceFieldTypes(syntheticSrc, "SyntheticFinding");
  const hints = parseSchemaBlockValueHints(syntheticBlock);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const tsCat = classifyTsType(token);
    const blockCat = hints[field];
    if (tsCat === "other" || blockCat === undefined || blockCat === "other" || tsCat !== blockCat) {
      mismatches.push(`${field}: \`${token}\` (${tsCat}) vs schema (${blockCat ?? "absent"})`);
    }
  }
  assert.deepEqual(
    mismatches,
    ['blocking: `boolean` (boolean) vs schema (string)'],
    "boolean TS field with a quoted schema hint must be caught as a type-token mismatch",
  );
});

test("drift guard: scalar TS field with unsupported schema hint (other) is a mismatch (regression #85 finding 2)", () => {
  // Simulate `summary: string` with its schema hint changed to an array form.
  const syntheticSrc = `
interface SyntheticVerdict {
  summary: string;
  confidence: number;
}
`;
  const syntheticBlock = `{
    "summary": ["<terse ship/no-ship assessment>"],
    "confidence": <0.0-1.0>
}`;

  const tsTypes = parseInterfaceFieldTypes(syntheticSrc, "SyntheticVerdict");
  const hints = parseSchemaBlockValueHints(syntheticBlock);

  const mismatches: string[] = [];
  for (const [field, token] of Object.entries(tsTypes)) {
    const tsCat = classifyTsType(token);
    if (tsCat === "other") continue;
    const blockCat = hints[field];
    if (blockCat === undefined || blockCat === "other" || tsCat !== blockCat) {
      const hint = blockCat ?? "absent";
      mismatches.push(`${field}: \`${token}\` (${tsCat}) vs schema (${hint})`);
    }
  }

  assert.deepEqual(
    mismatches,
    ["summary: `string` (string) vs schema (other)"],
    "drift guard must catch scalar TS string field whose schema hint is a non-scalar/unsupported form",
  );
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
