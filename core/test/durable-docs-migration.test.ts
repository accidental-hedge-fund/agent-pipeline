// Offline drift guard: durable docs carry the essay content that left the
// generated one-pager (#1049). Compares docs to code constants, not snapshots.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_CONTRACT } from "../scripts/artifact-ignore.ts";
import { validateConfig } from "../scripts/config.ts";
import { BUILTIN_ADAPTER_NAMES } from "../scripts/harness-adapters/registry.ts";
import { RELEASE_PLAN_ROW_SHAPE } from "../scripts/stages/release.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const CONCEPTS = join(repoRoot, "docs/concepts.md");
const PACKAGING = join(repoRoot, "docs/packaging.md");
const README = join(repoRoot, "README.md");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("durable docs name every loop selector and resume exclusivity", () => {
  const concepts = read(CONCEPTS);
  for (const flag of [
    "--milestone",
    "--label",
    "--range",
    "--roadmap-slice",
  ]) {
    assert.ok(concepts.includes(flag), `concepts missing loop selector ${flag}`);
  }
  assert.match(concepts, /explicit issue list/);
  assert.match(concepts, /mutually exclusive with `--resume`/);
});

test("durable docs cover login and stage assignment for every built-in adapter", () => {
  const concepts = read(CONCEPTS);
  assert.deepEqual([...BUILTIN_ADAPTER_NAMES], ["claude", "codex", "grok", "opencode", "pi"]);
  assert.match(concepts, /Run `claude` once to complete login/);
  assert.match(concepts, /`codex login`/);
  assert.match(concepts, /`grok login`/);
  assert.match(concepts, /`opencode auth login`/);
  assert.match(concepts, /Run `pi` once and complete `\/login`/);
  assert.match(concepts, /harnesses: \{ implementer: claude \}/);
  assert.match(concepts, /harnesses: \{ reviewer: codex \}/);
  assert.match(concepts, /harnesses: \{ implementer: grok \}/);
  assert.match(concepts, /harnesses: \{ implementer: opencode \}/);
  assert.match(concepts, /harnesses: \{ implementer: pi \}/);
  assert.doesNotMatch(concepts, /stage_executors: \{ implementing: grok-impl \}/);
  assert.match(concepts, /effort levels are not comparable across harnesses/);
  for (const name of BUILTIN_ADAPTER_NAMES) {
    assert.ok(concepts.includes(`\`${name}\``), `concepts missing adapter ${name}`);
  }
  const grokYaml = concepts.match(
    /```yaml\n(harnesses:\n  implementer: grok\n  reviewer: codex\n)```/,
  );
  assert.ok(grokYaml, "concepts must include a schema-valid grok harness YAML fence");
  const parsed = validateConfig("/fake-repo", {
    findGitRoot: () => "/fake-repo",
    readFile: (fp: string) => (fp.endsWith("pipeline.yml") ? grokYaml[1]! : null),
    harnesses: { implementer: "grok", reviewer: "codex" },
  });
  assert.equal(parsed.valid, true, parsed.diagnostics.map((d) => d.message).join("; "));
  assert.equal(parsed.diagnostics.some((d) => d.severity === "error"), false);
});

test("durable docs match ARTIFACT_CONTRACT inventory and release-plan row shape", () => {
  const concepts = read(CONCEPTS);
  for (const entry of ARTIFACT_CONTRACT) {
    const listed = entry.isFile
      ? `.agent-pipeline/${entry.name}`
      : `.agent-pipeline/${entry.name}/`;
    assert.ok(concepts.includes(listed), `concepts missing artifact ${listed}`);
  }
  assert.match(concepts, /Columns: Release, Bump, Theme, Issues, Why/);
  assert.match(concepts, /\| \*\*vX\.Y\.Z\*\* \| bump \| theme \| issues \| why \|/);
  assert.match(concepts, /\| \*\(none\)\* \|/);
  assert.ok(
    RELEASE_PLAN_ROW_SHAPE.includes("| **vX.Y.Z** |"),
    "code row shape must keep the unshipped Release cell",
  );
});

test("durable docs name native-goal ownership, summary fields, filter rationale, and Grok fallback", () => {
  const concepts = read(CONCEPTS);
  const packaging = read(PACKAGING);
  assert.match(concepts, /does not detect whether native goal mode is active/);
  assert.match(concepts, /does not invoke or re-enter that mode/);
  assert.match(concepts, /does not control the native goal session's lifecycle/);
  assert.match(concepts, /neither ends that session nor merges/);
  assert.match(concepts, /starting-to-ending stage/);
  assert.match(concepts, /elapsed time or transitions when available/);
  assert.match(concepts, /operator-authorized merge next step/);
  assert.match(concepts, /fixture transitions for unrelated issue numbers/);
  assert.match(concepts, /auto-stop a host Monitor/);
  assert.match(concepts, /suppresses heartbeats/);
  assert.match(concepts, /discover the run by contract/);
  assert.match(concepts, /Do not treat the first newly published basename as ownership/);
  assert.match(concepts, /A top-level `advance_run_handoff` is not the canonical identity/);
  assert.match(packaging, /Portable fallback is stdout material lines/);
  assert.match(packaging, /Do not require Claude `PushNotification` on Grok/);
});

test("README assigns SKILL regeneration to build.mjs only", () => {
  const readme = read(README);
  assert.match(readme, /sole writer: regenerate four host SKILLs/);
  assert.match(readme, /regenerate docs\/cli\.md, docs\/config\.md, CHANGELOG\.md \(not host SKILLs\)/);
  assert.match(readme, /`build\.mjs` is the sole SKILL writer/);
  assert.doesNotMatch(readme, /generate-docs\.mjs.*SKILL tables/);
  assert.doesNotMatch(readme, /after editing hosts\/claude/);
});
