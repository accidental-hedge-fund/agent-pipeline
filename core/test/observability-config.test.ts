// Repository-only opt-in configuration for the provider-neutral file exporter.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";
import {
  buildConfigTemplate,
  generateConfigSchema,
  resolveConfig,
  syncConfig,
  validateConfig,
  type ValidateConfigDeps,
} from "../scripts/config.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

const harnesses = "harnesses:\n  implementer: grok\n  reviewer: codex\n";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-observability-config-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function deps(content: string): ValidateConfigDeps {
  return {
    findGitRoot: () => "/fake-repo",
    readFile: (file) => file.endsWith("pipeline.yml") ? harnesses + content : null,
    harnesses: { implementer: "grok", reviewer: "codex" },
  };
}

// Match existing config.test.ts: fake gh makes resolution exercise real YAML
// loading and default merging without contacting GitHub.
function resolve(content: string) {
  const repo = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, ".github"));
  fs.writeFileSync(path.join(repo, ".github", "pipeline.yml"), harnesses + content);
  const bin = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho acme/observability-config\n", { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  try {
    return resolveConfig({ repoPath: repo });
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

test("observability resolves disabled defaults when absent or empty", () => {
  for (const content of ["", "observability: {}\n", "observability:\n  exporter: {}\n"]) {
    assert.deepEqual(resolve(content).observability, DEFAULT_CONFIG.observability);
  }
  assert.deepEqual(DEFAULT_CONFIG.observability, {
    enabled: false,
    exporter: { type: "file", directory: "~/.local/state/agent-pipeline/observability" },
  });
});

test("observability partial blocks merge exporter defaults without enabling implicitly", () => {
  assert.deepEqual(resolve("observability:\n  enabled: true\n").observability, {
    ...DEFAULT_CONFIG.observability,
    enabled: true,
  });
  assert.deepEqual(resolve("observability:\n  exporter:\n    directory: /var/spool/pipeline\n").observability, {
    enabled: false,
    exporter: { type: "file", directory: "/var/spool/pipeline" },
  });
  assert.deepEqual(resolve("observability:\n  enabled: true\n  exporter:\n    directory: ~/pipeline-spool\n").observability, {
    enabled: true,
    exporter: { type: "file", directory: "~/pipeline-spool" },
  });
  assert.equal(DEFAULT_CONFIG.observability.enabled, false);
  assert.equal(DEFAULT_CONFIG.observability.exporter.directory, "~/.local/state/agent-pipeline/observability");
});

test("observability is independent of papercuts and cannot be enabled by environment", () => {
  const overrides = {
    AI_OBSERVABILITY_ENABLED: "1",
    AGENT_OBSERVABILITY_ENABLED: "true",
    PIPELINE_OBSERVABILITY_ENABLED: "true",
    AGENT_OBSERVABILITY_HOME: "/ignored/host-config",
    PIPELINE_OBSERVABILITY_DIRECTORY: "/ignored/spool",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    assert.deepEqual(resolve("papercuts:\n  enabled: true\n").observability, DEFAULT_CONFIG.observability);
    assert.deepEqual(resolve("observability:\n  enabled: false\n").observability, DEFAULT_CONFIG.observability);
    const config = resolve("observability:\n  enabled: true\n");
    assert.equal(config.observability.enabled, true);
    assert.equal(config.papercuts.enabled, false);
    assert.equal(config.observability.exporter.directory, DEFAULT_CONFIG.observability.exporter.directory);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const directory of ["/var/spool/pipeline", "~/pipeline-spool", "/path with spaces/spool"]) {
  test(`observability accepts explicit file spool directory ${directory}`, () => {
    const result = validateConfig("/fake-repo", deps(yaml.dump({ observability: { enabled: true, exporter: { type: "file", directory } } })));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  });
}

for (const [label, config, field] of [
  ["empty directory", { exporter: { directory: "" } }, "directory"],
  ["relative directory", { exporter: { directory: "./spool" } }, "directory"],
  ["bare tilde", { exporter: { directory: "~" } }, "directory"],
  ["environment directory", { exporter: { directory: "$HOME/spool" } }, "directory"],
  ["newline directory", { exporter: { directory: "/spool\nextra" } }, "directory"],
  ["NUL directory", { exporter: { directory: "/spool\0extra" } }, "directory"],
  ["wrong enabled type", { enabled: "true" }, "enabled"],
  ["unsupported exporter", { exporter: { type: "langfuse" } }, "type"],
  ["unknown root key", { endpoint: "https://example.invalid" }, "endpoint"],
  ["unknown exporter key", { exporter: { api_key: "not-a-secret" } }, "api_key"],
] as const) {
  test(`observability rejects ${label} with a field diagnostic`, () => {
    const result = validateConfig("/fake-repo", deps(yaml.dump({ observability: config })));
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => `${item.path} ${item.message}`.includes(field)), JSON.stringify(result.diagnostics));
  });
}

test("observability schema and init template document all settings and disabled defaults", () => {
  const schema = generateConfigSchema() as any;
  const block = schema.properties.observability;
  assert.equal(block.additionalProperties, false);
  assert.equal(block.properties.exporter.additionalProperties, false);
  assert.equal(block.properties.exporter.properties.type.const, "file");
  assert.equal(block.properties.exporter.properties.directory.minLength, 1);
  const template = buildConfigTemplate();
  const commented = template.split("\n\n").find((part) => part.startsWith("# observability:"));
  assert.ok(commented);
  assert.match(commented, /SECURITY:/);
  const active = commented.split("\n").map((line) => line.replace(/^# ?/, "")).join("\n");
  assert.deepEqual((yaml.load(active) as any).observability, DEFAULT_CONFIG.observability);
  assert.equal(validateConfig("/fake-repo", deps(active)).valid, true);
});

test("config sync preserves explicit observability YAML and does not enable absent settings", () => {
  const existing = "observability: # operator-controlled\n  enabled: true\n  exporter:\n    directory: ~/custom-spool\n";
  const synced = syncConfig("/fake-repo", {}, deps(existing));
  assert.equal(synced.ok, true, JSON.stringify(synced.diagnostics));
  assert.ok(synced.candidate?.includes(existing));
  assert.deepEqual((yaml.load(synced.candidate!) as any).observability, {
    enabled: true,
    exporter: { directory: "~/custom-spool" },
  });
  const absent = syncConfig("/fake-repo", {}, deps(""));
  assert.equal(absent.ok, true, JSON.stringify(absent.diagnostics));
  assert.equal((yaml.load(absent.candidate!) as any).observability, undefined);
  assert.match(absent.candidate!, /^# observability:/m);
});
