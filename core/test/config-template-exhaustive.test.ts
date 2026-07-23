// Guarding tests for #504: the `pipeline init` / `config sync` template must be
// an exhaustive, accurate, self-documenting representation of the config schema.
//
// Three invariants are enforced here, each proven to bite:
//   1. Drift: every property PartialConfigSchema accepts (top-level + nested)
//      must be documented somewhere in the rendered template (active or
//      commented-out).
//   2. Defaults parity: documented defaults for keys DEFAULT_CONFIG defines
//      must match DEFAULT_CONFIG exactly, not a hand-typed placeholder.
//   3. Security notes: the enumerated opt-in security-sensitive option classes
//      must carry a "SECURITY:" note in the rendered template.
//   4. Round-trip: uncommenting any single documented opt-in example (for the
//      keys #504 added) must yield a schema-valid config via resolveConfig.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { buildConfigTemplate, generateConfigSchema } from "../scripts/config.ts";
import { CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT } from "../scripts/issue-context-snapshot.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cfg-template-test-"));

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function makeFakeGhBin(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
case "$1" in
  repo) echo "${repoSlug}"; exit 0;;
  label) if [[ "$2" == "list" ]]; then echo "[]"; exit 0; fi; exit 0;;
  *) exit 0;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

// ---------------------------------------------------------------------------
// 1. Recursive schema-to-template drift test
// ---------------------------------------------------------------------------

/** Recursively collect every dotted property path a JSON Schema node accepts. */
function collectSchemaPaths(node: unknown, prefix: string): string[] {
  const paths: string[] = [];
  if (!node || typeof node !== "object") return paths;
  const n = node as Record<string, unknown>;
  if (n.properties && typeof n.properties === "object") {
    for (const [key, child] of Object.entries(n.properties as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${key}` : key;
      paths.push(p);
      paths.push(...collectSchemaPaths(child, p));
    }
  }
  if (n.items) paths.push(...collectSchemaPaths(n.items, prefix));
  if (Array.isArray(n.anyOf)) {
    for (const variant of n.anyOf) paths.push(...collectSchemaPaths(variant, prefix));
  }
  return paths;
}

/** Recursively extract every dotted key path documented (active or commented) in the template. */
function extractDocumentedPaths(template: string): Set<string> {
  const paths = new Set<string>();
  const stack: { indent: number; key: string }[] = [];
  for (const rawLine of template.split("\n")) {
    let line = rawLine;
    let indent = 0;
    while (line[0] === " ") {
      line = line.slice(1);
      indent++;
    }
    if (line[0] === "#") {
      line = line.slice(1);
      if (line[0] === " ") line = line.slice(1);
      let extra = 0;
      while (line[0] === " ") {
        line = line.slice(1);
        extra++;
      }
      indent += extra;
    }
    if (line.startsWith("- ")) {
      line = line.slice(2);
      indent += 2;
    }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):/);
    if (!m) continue;
    const key = m[1];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const fullPath = [...stack.map((s) => s.key), key].join(".");
    paths.add(fullPath);
    stack.push({ indent, key });
  }
  return paths;
}

test("drift: every PartialConfigSchema property path is documented in the init template", () => {
  const schema = generateConfigSchema();
  const allPaths = collectSchemaPaths(schema, "");
  assert.ok(allPaths.length > 40, `expected a large recursive path set, got ${allPaths.length}`);

  const template = buildConfigTemplate();
  const documented = extractDocumentedPaths(template);

  const missing = allPaths.filter((p) => !documented.has(p));
  assert.deepEqual(missing, [], `undocumented schema paths in init template: ${missing.join(", ")}`);
});

test("drift test bites: removing a key's documentation lines surfaces as undocumented", () => {
  const schema = generateConfigSchema();
  const allPaths = collectSchemaPaths(schema, "");

  const template = buildConfigTemplate();
  // Simulate someone deleting the context_snapshot documentation entirely.
  const mutilated = template
    .split("\n")
    .filter((l) => !l.includes("context_snapshot") && !l.includes("max_chars"))
    .join("\n");
  const documented = extractDocumentedPaths(mutilated);

  const missing = allPaths.filter((p) => !documented.has(p));
  assert.ok(missing.includes("context_snapshot"), "removing context_snapshot lines must surface as undocumented");
  assert.ok(missing.includes("context_snapshot.max_chars"), "removing max_chars lines must surface as undocumented");
});

// ---------------------------------------------------------------------------
// 2. Defaults-parity tests
// ---------------------------------------------------------------------------

test("defaults-parity: design_gate commented defaults match DEFAULT_CONFIG.design_gate", () => {
  const template = buildConfigTemplate();
  const d = DEFAULT_CONFIG.design_gate;
  assert.match(template, new RegExp(`#\\s*enabled: ${d.enabled} #`));
  assert.match(template, new RegExp(`#\\s*max_rounds: ${d.max_rounds} #`));
  assert.match(template, new RegExp(`#\\s*block_threshold: ${d.block_threshold} #`));
  assert.match(template, new RegExp(`#\\s*min_confidence: ${d.min_confidence} #`));
  assert.match(template, new RegExp(`#\\s*max_decisions: ${d.limits.max_decisions} #`));
  assert.match(template, new RegExp(`#\\s*max_field_chars: ${d.limits.max_field_chars} #`));
  assert.match(template, new RegExp(`#\\s*max_artifact_bytes: ${d.limits.max_artifact_bytes} #`));
});

test("defaults-parity: auto_merge_eligibility commented defaults match DEFAULT_CONFIG.auto_merge_eligibility", () => {
  const template = buildConfigTemplate();
  const d = DEFAULT_CONFIG.auto_merge_eligibility;
  assert.match(template, new RegExp(`#\\s*enabled: ${d.enabled} #`));
  assert.match(template, new RegExp(`#\\s*max_diff_lines: ${d.max_diff_lines} #`));
  assert.match(template, new RegExp(`#\\s*max_files: ${d.max_files} #`));
  assert.match(template, new RegExp(`#\\s*min_confidence: ${d.min_confidence} #`));
});

test("defaults-parity: context_snapshot documented absence-default matches the real runtime constant", () => {
  const template = buildConfigTemplate();
  assert.match(
    template,
    new RegExp(`max_chars: ${CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT}`),
    "documented context_snapshot default must match issue-context-snapshot.ts's CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT",
  );
});

test("defaults-parity: opt-in gate keys with no DEFAULT_CONFIG entry are documented as absent, not a placeholder value", () => {
  const template = buildConfigTemplate();
  for (const key of ["roadmap", "sweep", "queue", "trusted_override_actors", "context_snapshot"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key),
      false,
      `test assumption broken: DEFAULT_CONFIG now defines ${key} — update its render block to show the real default`,
    );
    assert.match(template, new RegExp(`#\\s*${key}:`), `${key} must appear as a commented opt-in example when absent`);
  }
});

// ---------------------------------------------------------------------------
// 3. Security-note presence test
// ---------------------------------------------------------------------------

test("security-notes: every enumerated opt-in security-sensitive class carries a SECURITY note", () => {
  const template = buildConfigTemplate();
  const blocks = template.split(/\n\n+/);
  const classes = [
    "trusted_override_actors",
    "executors",
    "setup_command",
    "build_command",
    "format_gate",
    "event_sink",
    "harness_sandbox",
    "auto_loop",
    "auto_merge_eligibility",
  ];
  for (const key of classes) {
    const block = blocks.find((b) => new RegExp(`^#?\\s*${key}:`, "m").test(b.split("\n")[0]));
    assert.ok(block, `expected a template block for ${key}`);
    assert.match(block!, /SECURITY:/, `${key} block must carry a SECURITY note`);
  }
});

// ---------------------------------------------------------------------------
// 4. Opening-claim accuracy test
// ---------------------------------------------------------------------------

test("opening claim: the template no longer asserts the false 'every key shown at default' coverage claim", () => {
  const template = buildConfigTemplate();
  assert.doesNotMatch(
    template,
    /Every key is shown at its current default value/,
    "the opening claim must not assert blanket default-value coverage that the file does not provide",
  );
});

// ---------------------------------------------------------------------------
// 5. Round-trip: uncommenting each #504-added documented example is schema-valid
// ---------------------------------------------------------------------------

/** Same indent-normalization as extractDocumentedPaths, exposed for block extraction. */
function logicalIndent(rawLine: string): { indent: number; rest: string } {
  let line = rawLine;
  let indent = 0;
  while (line[0] === " ") {
    line = line.slice(1);
    indent++;
  }
  if (line[0] === "#") {
    line = line.slice(1);
    if (line[0] === " ") line = line.slice(1);
    let extra = 0;
    while (line[0] === " ") {
      line = line.slice(1);
      extra++;
    }
    indent += extra;
  }
  return { indent, rest: line };
}

/** Extract the full commented example for `key` — its header line plus every
 *  more-indented continuation line, stopping at the next top-level key or a blank line. */
function extractCommentedBlock(template: string, key: string): string {
  const lines = template.split("\n");
  const headerIdx = lines.findIndex((l) => {
    if (!l.trimStart().startsWith("#")) return false;
    const { indent, rest } = logicalIndent(l);
    return indent === 0 && new RegExp(`^${key}:`).test(rest);
  });
  assert.notEqual(headerIdx, -1, `expected a commented block for ${key} in the fresh scaffold`);
  const collected = [lines[headerIdx]];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break;
    const { indent, rest } = logicalIndent(line);
    if (indent === 0 && /^[A-Za-z_][A-Za-z0-9_]*:/.test(rest)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

/** Uncomment only the structural (key: value / list-item) lines of a commented
 *  block; pure-prose continuation lines (explanatory comments) stay commented,
 *  exactly as an operator uncommenting a documented example would leave them. */
function uncomment(block: string): string {
  return block
    .split("\n")
    .map((line) => {
      const { indent, rest } = logicalIndent(line);
      const isStructural = /^[A-Za-z_][A-Za-z0-9_]*:/.test(rest) || rest.startsWith("- ");
      if (!isStructural) return line;
      return " ".repeat(indent) + rest;
    })
    .join("\n");
}

const ADDED_KEYS = [
  "repo",
  "domain_name",
  "domain_description",
  "conventions_md_path",
  "design_gate",
  "roadmap",
  "sweep",
  "queue",
  "trusted_override_actors",
  "auto_merge_eligibility",
  "context_snapshot",
];

for (const key of ADDED_KEYS) {
  test(`round-trip: uncommenting the documented ${key} example yields a schema-valid config`, async () => {
    const template = buildConfigTemplate();
    const block = extractCommentedBlock(template, key);
    const uncommented = uncomment(block);

    const repo = makeTempRepo();
    const binDir = makeFakeGhBin("acme/uncomment-test");
    fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".github", "pipeline.yml"), `${uncommented}\n`, "utf8");

    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;
    try {
      const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}-${key}`);
      assert.doesNotThrow(() => cfgMod.resolveConfig({ repoPath: repo }), `uncommented ${key} example must be schema-valid`);
    } finally {
      process.env.PATH = oldPath;
    }
  });
}
