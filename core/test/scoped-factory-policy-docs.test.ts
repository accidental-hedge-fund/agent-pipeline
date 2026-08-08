// Drift guards for the scoped external factory authority boundary.

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

function assertGrantBoundary(source: string, label: string): void {
  assert.match(source, /ready-to-deploy/i, `${label}: must name the advance terminal`);
  assert.match(source, /never (?:invoke(?:s)? )?(?:a )?merge/i, `${label}: advance must never merge`);
  assert.match(source, /disabled(?:-by-default)? (?:external )?deployment wrapper|disabled-by-default deployment wrapper/i, `${label}: wrapper must be disabled by default`);
  assert.match(source, /authenticated, immutable, expiring/i, `${label}: grant properties must stay explicit`);
  assert.match(source, /machine-local/i, `${label}: grant must remain machine-local`);
  assert.match(source, /not\s+`?(?:repository\s+configuration|\.github\/pipeline\.yml)/i, `${label}: repository config must not grant authority`);
  assert.match(source, /auto_merge/i, `${label}: must forbid auto_merge`);
  assert.match(source, /merge stage/i, `${label}: must forbid a merge stage`);
}

test("golden rules keep advance isolated and describe only the scoped delegate", () => {
  for (const relPath of ["AGENTS.md", "CLAUDE.md"]) {
    const source = read(relPath);
    assertGrantBoundary(source, relPath);
    assert.match(source, /does not validate Buzz events or\s+deployment grants/is);
    assert.match(source, /merge-queue`?[\s\S]{0,80}dry-run\s+by default/i);
  }
});

test("README and concepts distinguish ordinary use from the opt-in factory", () => {
  const readme = read("README.md");
  assert.match(readme, /ordinary advance path does \*\*not\*\* merge/i);
  assert.match(readme, /opt-in and disabled by default/i);
  assert.match(readme, /repository,\s*base branch,\s*release version,\s*ordered issue list,\s*permitted actions,\s*and expiry/is);
  assert.match(readme, /does not add an MCP server,\s+a public\s+factory API, an `auto_merge` setting, or a merge stage/i);
  assert.match(readme, /`grok-4\.5`, with no Grok model fallback/i);

  const concepts = read("docs/concepts.md");
  assert.match(concepts, /Scoped external factory grants \(optional, default off\)/);
  assert.match(concepts, /wrapper[\s\S]{0,180}validates/i);
  assert.match(concepts, /`pipeline merge` does not read or validate Buzz events or\s+deployment\s+grants/i);
  assert.match(concepts, /exactly `grok-4\.5`/i);
  assert.match(concepts, /no Grok fallback/i);
});

test("all host skills assign grant validation to the wrapper", () => {
  for (const relPath of [
    "hosts/claude/SKILL.md",
    "hosts/codex/SKILL.md",
    "hosts/opencode/SKILL.md",
  ]) {
    const source = read(relPath);
    assertGrantBoundary(source, relPath);
    assert.match(source, /deployment wrapper, not either merge command|merge`? does not validate Buzz events or deployment grants/is);
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
  assert.match(rendered, /Machine-local deployment grants are outside this schema and cannot be set here/i);
  assert.ok(!rendered.includes("### `auto_merge`"));
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
