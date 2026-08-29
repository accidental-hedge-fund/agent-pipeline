// Drift guard: durable docs carry the operator-owned native `/goal`
// bootstrap sequence (#514 / #1049). Generated SKILLs stay compact.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const CONCEPTS = path.join(repoRoot, "docs/concepts.md");

function bootstrapSection(source: string, label: string): string {
  const match = source.match(/### Native `\/goal` bootstrap[\s\S]*?(?=\n### |\n## |\n*$)/);
  assert.ok(match, `${label}: expected a native /goal bootstrap subsection`);
  return match[0];
}

test("durable docs document /goal then pipeline loop bootstrap", () => {
  const section = bootstrapSection(fs.readFileSync(CONCEPTS, "utf8"), "concepts");
  const goalIndex = section.indexOf("`/goal`");
  const loopIndex = section.indexOf("`pipeline loop");
  assert.ok(goalIndex !== -1, "bootstrap section must mention `/goal`");
  assert.ok(loopIndex !== -1, "bootstrap section must mention `pipeline loop`");
  assert.ok(goalIndex < loopIndex, "bootstrap must document /goal before pipeline loop");
  assert.match(section, /does not invoke `\/goal` itself/i);
  assert.match(section, /does not end the native `\/goal` session/i);
  assert.doesNotMatch(section, /(?:\/|\$)pipeline:loop/);
});

test("generated host SKILLs omit the /goal bootstrap essay", () => {
  for (const host of ["claude", "codex", "grok", "opencode"] as const) {
    const skill = fs.readFileSync(path.join(repoRoot, "hosts", host, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /Bootstrapping a durable run/);
    assert.doesNotMatch(skill, /(?:\/|\$)pipeline:loop/);
  }
});
