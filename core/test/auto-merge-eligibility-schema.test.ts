// Schema drift guard for the auto-merge eligibility judge schema (#306).
//
// Ensures ELIGIBILITY_JUDGE_SCHEMA_BLOCK, ELIGIBILITY_JUDGE_SCHEMA_FIELDS, and
// the EligibilityJudgeOutput interface in types.ts cannot diverge silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ELIGIBILITY_JUDGE_SCHEMA_BLOCK,
  ELIGIBILITY_JUDGE_SCHEMA_FIELDS,
} from "../scripts/auto-merge-eligibility-schema.ts";
import { buildJudgePrompt } from "../scripts/stages/auto_merge_eligibility.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesSrc = readFileSync(join(__dirname, "../scripts/types.ts"), "utf-8");

// Extract field names from a named interface block.
function parseInterfaceFields(src: string, interfaceName: string): string[] {
  const marker = `interface ${interfaceName} {`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`Interface ${interfaceName} not found`);
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
    const m = line.match(/^\s*(?:readonly\s+)?(?:(\w+)|"(\w+)")\??:/);
    if (m) fields.push(m[1] ?? m[2]);
  }
  return fields;
}

// Parse field names from the schema block (top-level keys only).
function parseSchemaBlockTopLevelFields(block: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  const keyRe = /^"(\w+)"\s*:/;
  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"' && depth === 1) {
      const m = block.slice(i).match(keyRe);
      if (m) fields.push(m[1]);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Drift guard: schema block fields match EligibilityJudgeOutput interface
// ---------------------------------------------------------------------------

test("drift guard: ELIGIBILITY_JUDGE_SCHEMA_BLOCK fields match EligibilityJudgeOutput in types.ts", () => {
  const fromInterface = parseInterfaceFields(typesSrc, "EligibilityJudgeOutput");
  const fromBlock = parseSchemaBlockTopLevelFields(ELIGIBILITY_JUDGE_SCHEMA_BLOCK);

  const missingFromBlock = fromInterface.filter((f) => !fromBlock.includes(f));
  const extraInBlock = fromBlock.filter((f) => !fromInterface.includes(f));

  assert.deepEqual(
    missingFromBlock,
    [],
    `fields in EligibilityJudgeOutput but absent from ELIGIBILITY_JUDGE_SCHEMA_BLOCK: ${missingFromBlock.join(", ")}`,
  );
  assert.deepEqual(
    extraInBlock,
    [],
    `fields in ELIGIBILITY_JUDGE_SCHEMA_BLOCK but not in EligibilityJudgeOutput: ${extraInBlock.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// Drift guard: ELIGIBILITY_JUDGE_SCHEMA_FIELDS tracks the interface
// ---------------------------------------------------------------------------

test("drift guard: ELIGIBILITY_JUDGE_SCHEMA_FIELDS matches EligibilityJudgeOutput fields in types.ts", () => {
  const fromInterface = parseInterfaceFields(typesSrc, "EligibilityJudgeOutput");

  assert.deepEqual(
    fromInterface,
    ELIGIBILITY_JUDGE_SCHEMA_FIELDS,
    `EligibilityJudgeOutput fields in types.ts (${fromInterface.join(", ")}) ` +
      `don't match ELIGIBILITY_JUDGE_SCHEMA_FIELDS (${ELIGIBILITY_JUDGE_SCHEMA_FIELDS.join(", ")}). ` +
      `Update JUDGE_OUTPUT_FIELD_GUARD in auto-merge-eligibility-schema.ts.`,
  );
});

// ---------------------------------------------------------------------------
// Drift guard: schema block is substituted in the judge prompt template
// ---------------------------------------------------------------------------

test("drift guard: judge prompt template substitutes schema_block and includes all fields", () => {
  const rendered = buildJudgePrompt({
    prDiffSummary: "test",
    fileList: "- src/test.ts",
    reviewVerdict: "approved",
    ciStatus: "PASS",
    evidenceMetadata: "run-id: x",
    issueScope: "test issue",
  });

  assert.doesNotMatch(
    rendered,
    /\{\{\s*schema_block\s*\}\}/,
    "{{schema_block}} placeholder must be substituted before the prompt is sent",
  );

  for (const field of ELIGIBILITY_JUDGE_SCHEMA_FIELDS) {
    assert.ok(
      rendered.includes(`"${field}"`),
      `rendered prompt is missing schema field "${field}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Drift guard: template uses {{schema_block}} placeholder, not a literal copy
// ---------------------------------------------------------------------------

test("drift guard: prompt template uses {{schema_block}} placeholder, not embedded literal", () => {
  const templateText = readFileSync(
    join(__dirname, "../scripts/prompts/auto_merge_eligibility_judge.md"),
    "utf-8",
  );
  assert.match(
    templateText,
    /\{\{\s*schema_block\s*\}\}/,
    "auto_merge_eligibility_judge.md must contain {{schema_block}} placeholder",
  );
  assert.ok(
    !templateText.includes(ELIGIBILITY_JUDGE_SCHEMA_BLOCK),
    "template must not embed the schema block literally — use {{schema_block}} instead",
  );
});

// ---------------------------------------------------------------------------
// Config schema: auto_merge_eligibility block validation
// ---------------------------------------------------------------------------

// Helper: run validateConfig with an injected YAML string and a fake git root
async function validateYaml(yaml: string) {
  const { validateConfig } = await import("../scripts/config.ts");
  return validateConfig("/fake/repo", {
    findGitRoot: () => "/fake/repo",
    readFile: (p: string) => (p.includes("pipeline.yml") ? yaml : null),
  });
}

test("config schema: auto_merge_eligibility block accepts valid keys", async () => {
  const yaml = `auto_merge_eligibility:
  enabled: true
  max_diff_lines: 200
  max_files: 5
  deny_paths:
    - "**/secret/**"
  allow_paths:
    - "src/**"
  min_confidence: 0.9
`;
  const result = await validateYaml(yaml);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`);
});

test("config schema: unknown key in auto_merge_eligibility block is rejected", async () => {
  const yaml = `auto_merge_eligibility:
  auto_approve: true
`;
  const result = await validateYaml(yaml);
  assert.equal(result.valid, false);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.ok(
    errors.some((d) => d.message.includes("auto_approve") || d.message.includes("Unrecognized")),
    `expected unrecognized key error, got: ${JSON.stringify(errors)}`,
  );
});

test("config schema: min_confidence out of range (1.5) is rejected", async () => {
  const yaml = `auto_merge_eligibility:
  min_confidence: 1.5
`;
  const result = await validateYaml(yaml);
  assert.equal(result.valid, false);
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  assert.ok(
    errors.some((d) => d.path.includes("min_confidence") || d.message.toLowerCase().includes("min_confidence")),
    `expected min_confidence error, got: ${JSON.stringify(errors)}`,
  );
});

test("config schema: omitted block defaults to enabled=false", async () => {
  const { DEFAULT_CONFIG } = await import("../scripts/types.ts");
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.enabled, false);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.max_diff_lines, 300);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.max_files, 10);
  assert.equal(DEFAULT_CONFIG.auto_merge_eligibility.min_confidence, 0.8);
  assert.deepEqual(DEFAULT_CONFIG.auto_merge_eligibility.deny_paths, []);
  assert.deepEqual(DEFAULT_CONFIG.auto_merge_eligibility.allow_paths, []);
});
