// Drift guard for the issue-implementation-readiness verdict schema (#1238).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISSUE_READINESS_SCHEMA_BLOCK,
  ISSUE_READINESS_SCHEMA_FIELDS,
} from "../scripts/issue-readiness-schema.ts";
import { buildIssueReadinessPrompt } from "../scripts/prompts/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesSrc = readFileSync(join(__dirname, "../scripts/types.ts"), "utf-8");

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

test("drift guard: ISSUE_READINESS_SCHEMA_BLOCK fields match IssueReadinessVerdict", () => {
  const fromInterface = parseInterfaceFields(typesSrc, "IssueReadinessVerdict");
  const fromBlock = parseSchemaBlockTopLevelFields(ISSUE_READINESS_SCHEMA_BLOCK);
  assert.deepEqual(fromBlock.sort(), fromInterface.sort());
  assert.deepEqual([...ISSUE_READINESS_SCHEMA_FIELDS].sort(), fromInterface.sort());
});

test("drift guard: issue_readiness prompt embeds the schema block", () => {
  const prompt = buildIssueReadinessPrompt({
    title: "Add retry",
    body: "Need retries.",
    labels: ["pipeline:ready"],
  });
  assert.ok(prompt.includes(ISSUE_READINESS_SCHEMA_BLOCK));
  assert.equal(prompt.includes("{{schema_block}}"), false);
});
