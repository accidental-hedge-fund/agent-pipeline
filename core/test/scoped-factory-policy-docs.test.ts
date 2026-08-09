// Drift guards for advance/merge authority and the removal of the Hermes factory pilot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";
import { COMMAND_DOCS } from "../scripts/command-docs.ts";
import { generateConfigSchema } from "../scripts/config.ts";
import { renderConfigMarkdown } from "../scripts/docs-generate.ts";
import { STAGES } from "../scripts/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function read(relPath: string): string {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function assertMergeIsolation(source: string, label: string): void {
  assert.match(source, /ready-to-deploy/i, `${label}: must name the advance terminal`);
  assert.match(source, /never (?:invoke(?:s)? )?(?:a )?merge/i, `${label}: advance must never merge`);
  assert.match(source, /loop-isolated|operator-authorized/i, `${label}: must name loop-isolated/operator-authorized merge`);
  assert.match(source, /does not ship a Hermes\/Buzz factory|does not ship a factory grant control plane|does not ship a Hermes\/Buzz factory control plane/i, `${label}: must deny shipping the grant factory`);
  assert.match(source, /not\s+`?(?:repository\s+configuration|\.github\/pipeline\.yml)/i, `${label}: repository config must not grant authority`);
  assert.match(source, /auto_merge/i, `${label}: must forbid auto_merge`);
  assert.match(source, /merge stage/i, `${label}: must forbid a merge stage`);
}

test("golden rules keep advance isolated and deny a shipped factory plane", () => {
  for (const relPath of ["AGENTS.md", "CLAUDE.md"]) {
    const source = read(relPath);
    assertMergeIsolation(source, relPath);
    assert.match(source, /merge-queue`?[\s\S]{0,80}dry-run\s+by default/i);
  }
});

test("README and concepts describe CLI composition without a grant factory", () => {
  const readme = read("README.md");
  assert.match(readme, /ordinary advance path does \*\*not\*\* merge/i);
  assert.match(
    readme,
    /does \*\*not\*\* ship a Hermes\/Buzz(?:\/Slack)? factory|does not ship a Hermes\/Buzz(?:\/Slack)? factory/i,
  );
  assert.match(readme, /docs\/supervisor\.md|supervisor contract/i);
  assert.match(readme, /examples\/supervisor/);
  assert.match(readme, /cannot authorize\s+merges/i);
  assert.match(readme, /cannot set `auto_merge`/i);
  assert.match(readme, /`grok-4\.5`, with no Grok model fallback/i);
  assert.match(readme, /factory-simplification-plan\.md/);

  const concepts = read("docs/concepts.md");
  assert.match(concepts, /External supervisors \(compose the CLI\)/);
  assert.match(concepts, /does not ship a Hermes\/Buzz(?:\/Slack)?\s+factory control\s+plane/i);
  assert.match(concepts, /supervisor\.md/);
  assert.match(concepts, /exactly `grok-4\.5`/i);
  assert.match(concepts, /no Grok fallback/i);
});

test("all host skills keep merge loop-isolated without a grant factory", () => {
  for (const relPath of [
    "hosts/claude/SKILL.md",
    "hosts/codex/SKILL.md",
    "hosts/opencode/SKILL.md",
  ]) {
    const source = read(relPath);
    assertMergeIsolation(source, relPath);
    assert.match(source, /merge-queue`? is dry-run by default/i);
    assert.match(source, /only `grok-4\.5`, with no Grok fallback/i);
  }
});

test("command copy names operator authority and keeps dry-run default", () => {
  assert.match(COMMAND_DOCS.merge.summary, /operator-authorized/i);
  assert.match(COMMAND_DOCS.merge.summary, /never called by the advance loop/i);
  assert.doesNotMatch(COMMAND_DOCS.merge.summary, /human-only/i);
  assert.match(COMMAND_DOCS["merge-queue"].summary, /operator-authorized/i);
  assert.match(COMMAND_DOCS["merge-queue"].summary, /dry-run by default/i);

  const readyCopy = read("core/scripts/stages/deploy_ready.ts");
  assert.match(readyCopy, /advance path stops here/i);
  assert.match(readyCopy, /operator-authorized merge command/i);
  assert.doesNotMatch(readyCopy, /push the merge button/i);

  const buildSource = read("scripts/build.mjs");
  assert.match(buildSource, /Operator-authorized squash merge/i);
  assert.match(buildSource, /Operator-authorized sequential merge/i);
  assert.doesNotMatch(buildSource, /Human-only squash merge|Human-gated sequential merge/i);

  for (const relPath of [
    "core/scripts/stages/intake.ts",
    "core/scripts/stages/sweep.ts",
    "core/scripts/roadmap/writeback.ts",
  ]) {
    const source = read(relPath);
    assert.match(source, /advance path never merges/i, `${relPath}: must isolate advance`);
    assert.match(source, /operator-authorized merge surface/i, `${relPath}: must name authority`);
    assert.doesNotMatch(source, /human owns this button/i, `${relPath}: stale merge copy`);
  }
});

test("repository config has no merge or factory authority key and stages have no merge", () => {
  const schema = generateConfigSchema() as {
    properties?: Record<string, unknown>;
  };
  const properties = schema.properties ?? {};
  for (const forbidden of [
    "auto_merge",
    "factory_authority",
    "factory_grant",
    "deployment_grant",
    "scoped_factory",
  ]) {
    assert.equal(forbidden in properties, false, `${forbidden} must not enter repository config`);
  }
  assert.equal(STAGES.includes("merge" as never), false, "the state machine must not gain a merge stage");

  const rendered = renderConfigMarkdown({ schema });
  assert.match(rendered, /Merge authority is not repository configuration and cannot be set here/i);
  assert.ok(!rendered.includes("### `auto_merge`"));
});

test("the repository does not ship the Hermes factory pilot package", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "ops/hermes-factory")), false);
  const pkg = JSON.parse(read("package.json")) as {
    files?: string[];
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.files?.includes("ops"), false, "package files must not ship ops/");
  assert.equal("ci:ops" in (pkg.scripts ?? {}), false, "ci:ops must be removed");
  assert.doesNotMatch(pkg.scripts?.ci ?? "", /ci:ops/, "default ci must not call ci:ops");
});

test("the repository factory profile pins only grok-4.5 for Grok roles", () => {
  const source = read(".github/pipeline.yml");
  const parsed = yaml.load(source) as {
    harnesses?: { implementer?: string; reviewer?: string };
    models?: { planning?: string; implementing?: string; fix?: string; intake?: string; sweep?: string };
  };
  assert.equal(parsed.harnesses?.implementer, "grok");
  assert.equal(parsed.harnesses?.reviewer, "codex");
  assert.deepEqual(
    [
      parsed.models?.planning,
      parsed.models?.implementing,
      parsed.models?.fix,
      parsed.models?.intake,
      parsed.models?.sweep,
    ],
    ["grok-4.5", "grok-4.5", "grok-4.5", "grok-4.5", "grok-4.5"],
  );
  assert.doesNotMatch(source, /grok-(?!4\.5\b)[\w.-]+/i, "no other Grok model may be configured");
});
