// Config schema for planning_facts (#1300). Uses fake gh like config.test.ts;
// no real GitHub network.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import {
  buildConfigTemplate,
  parseTrustedPlanningFactsBlock,
  resolvePlanningFactsConfig,
} from "../scripts/config.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pf-cfg-"));
const COMPLETE_HARNESSES = "harnesses:\n  implementer: grok\n  reviewer: codex\n";

function withRequiredHarnesses(content: string): string {
  if (/(?:^|\n)harnesses:/m.test(content)) return content;
  const trimmed = content.endsWith("\n") || content.length === 0 ? content : `${content}\n`;
  return `${trimmed}${COMPLETE_HARNESSES}`;
}

function makeFakeRepo(content: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), withRequiredHarnesses(content));
  return dir;
}

function makeFakeGh(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "${repoSlug}"\n`);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

async function resolve(repo: string) {
  const { resolveConfig } = await import(`../scripts/config.ts?pf=${Date.now()}-${Math.random()}`);
  return resolveConfig({ repoPath: repo });
}

const VALID_PROVIDER = `planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/pipeline/planning-facts/alembic-head
      required: true
      facts:
        alembic_head: string
`;

test("resolveConfig: absent planning_facts equals empty providers", async () => {
  const repo = makeFakeRepo(`base_branch: main\n`);
  const binDir = makeFakeGh("acme/pf-absent");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = await resolve(repo);
    assert.deepEqual(cfg.planning_facts.providers, []);
    assert.equal(cfg.planning_facts.timeout_ms, DEFAULT_CONFIG.planning_facts.timeout_ms);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: valid provider is accepted", async () => {
  const repo = makeFakeRepo(VALID_PROVIDER);
  const binDir = makeFakeGh("acme/pf-valid");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfg = await resolve(repo);
    assert.equal(cfg.planning_facts.providers.length, 1);
    assert.equal(cfg.planning_facts.providers[0].id, "alembic-head");
    assert.equal(cfg.planning_facts.providers[0].executable, "scripts/pipeline/planning-facts/alembic-head");
    assert.equal(cfg.planning_facts.providers[0].required, true);
    assert.equal(cfg.planning_facts.providers[0].facts.alembic_head, "string");
    assert.deepEqual(cfg.planning_facts.providers[0].args, []);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown key under planning_facts is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:\n  auto_detect: true\n`);
  const binDir = makeFakeGh("acme/pf-unk");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*auto_detect/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: absolute executable is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: x
      executable: /usr/bin/python
      required: true
      facts:
        a: string
`);
  const binDir = makeFakeGh("acme/pf-abs");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*executable/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: parent-escaping executable is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: x
      executable: scripts/../../outside
      required: true
      facts:
        a: string
`);
  const binDir = makeFakeGh("acme/pf-dotdot");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*executable/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: empty facts is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: x
      executable: scripts/p
      required: true
      facts: {}
`);
  const binDir = makeFakeGh("acme/pf-empty-facts");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*facts/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: ceiling above pipeline max is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers: []
  timeout_ms: 20000
`);
  const binDir = makeFakeGh("acme/pf-ceil");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*timeout_ms/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: duplicate provider ids are rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: alembic-head
      executable: scripts/a
      required: true
      facts:
        a: string
    - id: alembic-head
      executable: scripts/b
      required: true
      facts:
        b: string
`);
  const binDir = makeFakeGh("acme/pf-dup-id");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*alembic-head/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: duplicate fact ids across providers are rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: a
      executable: scripts/a
      required: true
      facts:
        alembic_head: string
    - id: b
      executable: scripts/b
      required: true
      facts:
        alembic_head: string
`);
  const binDir = makeFakeGh("acme/pf-dup-fact");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid.*alembic_head/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: facts type object is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: a
      executable: scripts/a
      required: true
      facts:
        alembic_head: object
`);
  const binDir = makeFakeGh("acme/pf-obj");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: facts type null is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: a
      executable: scripts/a
      required: true
      facts:
        alembic_head: null
`);
  const binDir = makeFakeGh("acme/pf-null");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: unknown fact type name is rejected", async () => {
  const repo = makeFakeRepo(`planning_facts:
  providers:
    - id: a
      executable: scripts/a
      required: true
      facts:
        alembic_head: datetime
`);
  const binDir = makeFakeGh("acme/pf-unk-type");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await assert.rejects(() => resolve(repo), /Invalid/s);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("init scaffold documents planning_facts as empty-by-default and round-trips with zero providers", async () => {
  const template = buildConfigTemplate();
  assert.match(template, /planning_facts:/);
  assert.match(template, /providers:/);
  assert.match(template, /empty providers \(default\)/i);

  const repo = makeFakeRepo("");
  const binDir = makeFakeGh("acme/pf-scaffold");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const yaml = buildConfigTemplate();
    fs.writeFileSync(path.join(repo, ".github", "pipeline.yml"), withRequiredHarnesses(yaml));
    const cfg = await resolve(repo);
    assert.deepEqual(cfg.planning_facts.providers, []);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("parseTrustedPlanningFactsBlock: omitted key is empty providers", () => {
  const parsed = parseTrustedPlanningFactsBlock("harnesses:\n  implementer: grok\n  reviewer: codex\n");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.config.providers, []);
});

test("parseTrustedPlanningFactsBlock: empty providers list is a no-op config", () => {
  const parsed = parseTrustedPlanningFactsBlock("planning_facts:\n  providers: []\n");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.config.providers, []);
});

test("resolvePlanningFactsConfig: absent raw uses pipeline ceiling defaults", () => {
  const cfg = resolvePlanningFactsConfig(undefined);
  assert.deepEqual(cfg, DEFAULT_CONFIG.planning_facts);
});
