// Unit tests for docs generators (#597).
// Pure transforms only — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCliInventory,
  renderCliReferenceMarkdown,
  renderSkillCommandTable,
  replaceSkillGeneratedRegion,
  renderConfigReferenceMarkdown,
  renderChangelogMarkdown,
  SKILL_CLI_BEGIN,
  SKILL_CLI_END,
  type CliDocInventoryEntry,
  type JsonSchemaNode,
  type ChangelogRelease,
} from "../scripts/docs-generate.ts";
import { COMMAND_DOCS, isDocumentedCommand } from "../scripts/command-docs.ts";
import { COMMAND_REGISTRY, lookupCommand, validateFlags } from "../scripts/command-registry.ts";

// ---------------------------------------------------------------------------
// CLI inventory
// ---------------------------------------------------------------------------

test("docs-generate: documented command appears with summary and usage", () => {
  const inv = buildCliInventory(
    { status: {}, run: {} },
    {
      status: { summary: "Status of issue N", usage: "status <N>", documented: true },
      run: { summary: "Legacy", usage: "run <N>", documented: false },
    },
  );
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.keyword, "status");
  assert.match(inv[0]!.summary, /Status/);
  assert.match(inv[0]!.usage, /status/);
});

test("docs-generate: hidden registry keyword is omitted", () => {
  const inv = buildCliInventory(
    { advance: {}, run: {}, papercut: {} },
    {
      advance: { summary: "Advance", usage: "N", documented: true },
      run: { summary: "Legacy", usage: "run <N>", documented: false },
      papercut: { summary: "Hidden", usage: "papercut", documented: false },
    },
  );
  const keys = inv.map((e) => e.keyword);
  assert.deepEqual(keys, ["advance"]);
  assert.ok(!keys.includes("run"));
  assert.ok(!keys.includes("papercut"));
});

test("docs-generate: generator does not invent commands", () => {
  const inv = buildCliInventory(
    { doctor: {} },
    {
      doctor: { summary: "Preflight", usage: "doctor" },
      // Present in docs but absent from registry — must not appear.
      invented: { summary: "Nope", usage: "invented" },
    } as Record<string, { summary: string; usage: string }>,
  );
  assert.deepEqual(
    inv.map((e) => e.keyword),
    ["doctor"],
  );
});

test("docs-generate: live inventory omits run and papercut", () => {
  const inv = buildCliInventory();
  const keys = new Set(inv.map((e) => e.keyword));
  assert.ok(keys.has("status"));
  assert.ok(keys.has("doctor"));
  assert.ok(keys.has("advance"));
  assert.ok(!keys.has("run"));
  assert.ok(!keys.has("papercut"));
  for (const e of inv) {
    assert.ok(e.summary.trim().length > 0, `${e.keyword} needs summary`);
    assert.ok(e.usage.trim().length > 0, `${e.keyword} needs usage`);
    assert.ok(e.keyword in COMMAND_REGISTRY);
  }
});

test("docs-generate: renderCliReferenceMarkdown includes documented, omits hidden", () => {
  const inv: CliDocInventoryEntry[] = [
    { keyword: "status", summary: "Read status", usage: "status <N>" },
  ];
  const md = renderCliReferenceMarkdown(inv);
  assert.match(md, /status <N>/);
  assert.match(md, /Read status/);
  assert.doesNotMatch(md, /`run` as a recommended/);
});

test("docs-generate: both hosts list the same keywords; tokens differ", () => {
  const inv = buildCliInventory(
    { status: {}, doctor: {} },
    {
      status: { summary: "Status", usage: "status <N>" },
      doctor: { summary: "Doctor", usage: "doctor" },
    },
  );
  const claude = renderSkillCommandTable("/pipeline", inv);
  const codex = renderSkillCommandTable("$pipeline", inv);
  assert.match(claude, /\/pipeline:status/);
  assert.match(codex, /\$pipeline:status/);
  assert.doesNotMatch(claude, /\$pipeline/);
  assert.doesNotMatch(codex, /\/pipeline/);
  // Same command keywords present.
  assert.match(claude, /status/);
  assert.match(codex, /status/);
  assert.match(claude, /doctor/);
  assert.match(codex, /doctor/);
});

test("docs-generate: replaceSkillGeneratedRegion is regenerable", () => {
  const original = [
    "## Modes",
    "",
    SKILL_CLI_BEGIN,
    "old content",
    SKILL_CLI_END,
    "",
    "after",
  ].join("\n");
  const next = replaceSkillGeneratedRegion(original, "```\n/pipeline:status <N>\n```");
  assert.ok(next !== null);
  assert.match(next!, /\/pipeline:status/);
  assert.doesNotMatch(next!, /old content/);
  assert.match(next!, /after/);
  // Second replace still works.
  const again = replaceSkillGeneratedRegion(next!, "```\n/pipeline:doctor\n```");
  assert.match(again!, /\/pipeline:doctor/);
});

// ---------------------------------------------------------------------------
// Doc metadata does not change dispatch
// ---------------------------------------------------------------------------

test("docs-generate: doc metadata does not change validateFlags / lookupCommand", () => {
  assert.equal(lookupCommand("123"), COMMAND_REGISTRY.advance);
  assert.equal(lookupCommand("status"), COMMAND_REGISTRY.status);
  const entry = COMMAND_REGISTRY.doctor;
  const fakeCmd = {
    options: [{ attributeName: () => "json" }, { attributeName: () => "detach" }],
    getOptionValueSource(key: string) {
      return key === "detach" ? "cli" : undefined;
    },
  };
  const bad = validateFlags(entry, fakeCmd);
  assert.ok(bad.includes("detach"));
  // Ensure docs map presence does not affect isDocumented for run.
  assert.equal(isDocumentedCommand("run"), false);
  assert.ok("run" in COMMAND_REGISTRY);
  assert.ok("run" in COMMAND_DOCS);
});

// ---------------------------------------------------------------------------
// Config reference
// ---------------------------------------------------------------------------

test("docs-generate: config top-level keys appear with descriptions", () => {
  const schema: JsonSchemaNode = {
    type: "object",
    properties: {
      base_branch: {
        type: "string",
        description: "Branch that PRs target and worktrees branch from.",
      },
      review_policy: {
        type: "object",
        description: "Controls which review findings block progression vs. merely advise.",
        properties: {
          block_threshold: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Findings at or above this severity block progression.",
          },
        },
      },
      steps: {
        type: "object",
        description: "Toggle optional pipeline steps on or off.",
      },
      eval_gate: {
        type: "object",
        description: "Run the repo's eval harness after pre-merge.",
        properties: {
          mode: {
            type: "string",
            enum: ["gate", "advisory"],
            description: "gate: block on failure; advisory: record result and advance.",
          },
        },
      },
    },
  };
  const md = renderConfigReferenceMarkdown(schema);
  assert.match(md, /`base_branch`/);
  assert.match(md, /Branch that PRs target/);
  assert.match(md, /`review_policy`/);
  assert.match(md, /`steps`/);
  assert.match(md, /`eval_gate`/);
  // Enum surfaces
  assert.match(md, /"critical"/);
  assert.match(md, /"advisory"/);
  // Rejected key not documented as valid
  assert.doesNotMatch(md, /## `auto_merge`/);
  assert.doesNotMatch(md, /### `auto_merge`/);
});

test("docs-generate: auto_merge key in schema is skipped", () => {
  const schema: JsonSchemaNode = {
    type: "object",
    properties: {
      base_branch: { type: "string", description: "Base branch." },
      auto_merge: { type: "boolean", description: "Should not appear as supported." },
    },
  };
  const md = renderConfigReferenceMarkdown(schema);
  assert.match(md, /base_branch/);
  // Must not document auto_merge as a supported key heading (preamble may mention it as rejected).
  assert.doesNotMatch(md, /### `auto_merge`/);
  assert.doesNotMatch(md, /#### `auto_merge`/);
});

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

test("docs-generate: changelog transform uses fixtures only", () => {
  const releases: ChangelogRelease[] = [
    { version: "1.0.0", date: "2026-06-10", body: "First release." },
    { version: "1.2.0", date: "2026-06-15", body: "Second minor." },
  ];
  const md = renderChangelogMarkdown(releases);
  // Newest first
  const i12 = md.indexOf("## [1.2.0]");
  const i10 = md.indexOf("## [1.0.0]");
  assert.ok(i12 >= 0 && i10 > i12);
  assert.match(md, /First release/);
  assert.match(md, /Second minor/);
});

test("docs-generate: changelog empty body is bounded", () => {
  const md = renderChangelogMarkdown([{ version: "0.1.0", body: "" }]);
  assert.match(md, /## \[0\.1\.0\]/);
  assert.match(md, /no tag body/);
});
