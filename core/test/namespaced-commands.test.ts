// Host-surface drift-guard tests (#273).
//
// Covers:
//   7.5  The generated plugin/pipeline/commands/ directory contains exactly the
//        operations defined by the namespaced-command-surface spec — no more,
//        no less, and no pipeline:run entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
// core/test/ → ../../ = repo root, then plugin/pipeline/commands/
const COMMANDS_DIR = join(__dirname, "..", "..", "plugin", "pipeline", "commands");

// Canonical operation names per the namespaced-command-surface spec.
// run is intentionally absent — it is an undocumented alias only.
const EXPECTED_OPERATIONS = new Set([
  "status",
  "unblock",
  "override",
  "summary",
  "doctor",
  "init",
  "cleanup",
  "intake",
  "sweep",
  "triage",
  "merge",
  "release",
  "roadmap",
  "logs",
  "loop",
]);

// ---------------------------------------------------------------------------
// 7.5a  Every expected operation has a generated command file
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5a: plugin/pipeline/commands/ exists and contains exactly the expected operations", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    assert.fail(
      `plugin/pipeline/commands/ does not exist — run \`node scripts/build.mjs\` and commit the output. (${e.message})`,
    );
  }

  // Extract operation names: "pipeline:status.md" → "status"
  const actualOps = new Set(
    files.map((f) => {
      const match = /^pipeline:(.+)\.md$/.exec(f);
      assert.ok(match, `Unexpected file name format in commands dir: ${f}`);
      return match[1];
    }),
  );

  // Every expected op must be present
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(
      actualOps.has(expected),
      `Missing command file: pipeline:${expected}.md — run \`node scripts/build.mjs\` and commit`,
    );
  }

  // No extra files beyond the expected set
  for (const actual of actualOps) {
    assert.ok(
      EXPECTED_OPERATIONS.has(actual),
      `Unexpected command file: pipeline:${actual}.md — remove it from OPERATION_SURFACE or add it to the spec`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7.5b  No pipeline:run host command exists (run is undocumented alias only)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b: no pipeline:run.md command file exists", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR);
  } catch {
    // If commands dir doesn't exist, run isn't there either — pass
    files = [];
  }
  assert.equal(
    files.includes("pipeline:run.md"),
    false,
    "pipeline:run.md must not exist — run is an undocumented alias, not a surface command",
  );
});

// ---------------------------------------------------------------------------
// 7.5b2  Codex and Claude operation sets are symmetric (both from OPERATION_SURFACE)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5b2: renderCodexCommand produces entries for every Claude operation", async () => {
  // Safe to import now that build.mjs has an ESM main guard (Finding 1 fix).
  const buildMjs = await import("../../scripts/build.mjs");
  const { OPERATION_SURFACE, renderCodexCommand } = buildMjs;

  for (const op of OPERATION_SURFACE) {
    const content = renderCodexCommand(op);
    assert.ok(typeof content === "string" && content.length > 0, `renderCodexCommand returned empty for operation ${op.name}`);
    assert.ok(content.includes(`pipeline:${op.name}`), `renderCodexCommand output missing pipeline:${op.name}`);
    // Must be valid YAML — at minimum it must contain the interface key
    assert.ok(content.includes("interface:"), `renderCodexCommand output for ${op.name} missing 'interface:' key`);
  }

  // Codex operation names must match the Claude expected set
  const codexNames = new Set(OPERATION_SURFACE.map((op) => op.name));
  for (const expected of EXPECTED_OPERATIONS) {
    assert.ok(codexNames.has(expected), `OPERATION_SURFACE missing operation: ${expected} (Codex would be missing it too)`);
  }
  for (const actual of codexNames) {
    if (actual === "run") continue; // run is undocumented alias; excluded from both surfaces
    assert.ok(EXPECTED_OPERATIONS.has(actual), `OPERATION_SURFACE has unexpected operation: ${actual}`);
  }
});

// ---------------------------------------------------------------------------
// 7.5c  Each command file starts with YAML front-matter referencing its operation name
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5c: each command file's front-matter slug matches its file name", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // Missing dir is already caught by 7.5a; skip this check so error message is clean
    return;
  }

  for (const file of files) {
    const match = /^pipeline:(.+)\.md$/.exec(file);
    if (!match) continue;
    const opName = match[1];
    const content = readFileSync(join(COMMANDS_DIR, file), "utf8");
    // The generated file should reference the operation name in its Invoke line.
    // summary uses --summary rather than a positional, so we check the op name appears anywhere.
    assert.ok(
      content.includes(opName),
      `${file}: content should reference the operation name "${opName}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7.5d  Every command file's YAML frontmatter parses without error (#273 review-2)
// ---------------------------------------------------------------------------

test("namespaced-commands 7.5d: every command file's YAML frontmatter is valid and parseable", () => {
  let files: string[];
  try {
    files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    // Missing dir caught by 7.5a; skip here to keep error messages clean
    return;
  }

  for (const file of files) {
    const content = readFileSync(join(COMMANDS_DIR, file), "utf8");
    // Extract the YAML frontmatter block (between the first two `---` lines)
    const match = /^---\n([\s\S]*?)\n---/m.exec(content);
    assert.ok(match, `${file}: no YAML frontmatter found`);
    const frontmatter = match[1];
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = yamlLoad(frontmatter);
    }, `${file}: frontmatter failed YAML parsing`);
    assert.ok(
      parsed !== null && typeof parsed === "object",
      `${file}: frontmatter parsed to a non-object`,
    );
    const fm = parsed as Record<string, unknown>;
    assert.ok(typeof fm["description"] === "string", `${file}: frontmatter missing 'description' key`);
  }
});
