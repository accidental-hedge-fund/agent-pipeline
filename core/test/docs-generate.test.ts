// Unit tests for docs generators (#597). Pure transforms only — no network/git/subprocess.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applySkillCommandTable,
  buildGeneratedArtifacts,
  CLI_BEGIN_MARKER,
  CLI_END_MARKER,
  compareSemverDesc,
  normalizeTrailingNewline,
  parseGitTagListLines,
  renderChangelogMarkdown,
  renderCliMarkdown,
  renderConfigMarkdown,
  renderSkillCommandTable,
  replaceMarkedRegion,
  type ChangelogRelease,
  type JsonSchemaNode,
} from "../scripts/docs-generate.ts";
import {
  COMMAND_DOCS,
  listDocumentedCommands,
  type CommandDoc,
} from "../scripts/command-docs.ts";
import { COMMAND_REGISTRY, lookupCommand, validateFlags } from "../scripts/command-registry.ts";
import { OPERATION_SURFACE } from "../scripts/operation-surface.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_REGISTRY = {
  advance: { needsIssueNumber: true },
  status: { needsIssueNumber: true },
  papercut: { needsIssueNumber: false },
  "not-in-docs": { needsIssueNumber: false },
};

const FIXTURE_DOCS: Record<string, CommandDoc> = {
  advance: {
    summary: "Drive one issue",
    usage: "N",
    documented: true,
    section: "advance",
  },
  status: {
    summary: "Show status",
    usage: "status <n>",
    documented: true,
    section: "lifecycle",
  },
  papercut: {
    summary: "Hidden agent surface",
    usage: "papercut",
    documented: false,
    section: "other",
  },
  // not-in-docs intentionally omitted → treated as undocumented
};

const FIXTURE_SCHEMA: JsonSchemaNode = {
  type: "object",
  properties: {
    base_branch: {
      type: "string",
      description: "Branch that PRs target and worktrees branch from.",
    },
    review_policy: {
      type: "object",
      description: "Which review findings block progression.",
      properties: {
        block_threshold: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Findings below this severity advise rather than block.",
        },
        min_confidence: {
          type: "number",
          description: "Findings below this confidence advise rather than block.",
        },
      },
    },
    steps: {
      type: "object",
      description: "Toggle optional pipeline steps on or off.",
      properties: {
        plan_review: { type: "boolean", description: "Cross-harness plan review." },
      },
    },
    eval_gate: {
      type: "object",
      description: "Eval gate settings.",
      properties: {
        mode: {
          type: "string",
          enum: ["gate", "advisory"],
          description: "Whether failures block or only advise.",
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// command-docs / registry coupling
// ---------------------------------------------------------------------------

describe("command-docs metadata", () => {
  test("every documented COMMAND_DOCS keyword exists in COMMAND_REGISTRY", () => {
    for (const [kw, doc] of Object.entries(COMMAND_DOCS)) {
      if (!doc.documented) continue;
      assert.ok(
        kw in COMMAND_REGISTRY,
        `documented keyword "${kw}" missing from COMMAND_REGISTRY`,
      );
      assert.ok(doc.summary.trim().length > 0, `${kw} summary empty`);
      assert.ok(doc.usage.trim().length > 0, `${kw} usage empty`);
    }
  });

  test("train usage lists --dry-run (#1275)", () => {
    const doc = COMMAND_DOCS.train;
    assert.equal(doc.documented, true);
    assert.equal(
      doc.usage,
      "train --milestone <m>|--issues <n,n> [--merge] [--json] [--dry-run]",
    );
  });

  test("ship documents exact run and read-only status forms", () => {
    const doc = COMMAND_DOCS.ship;
    assert.equal(doc.documented, true);
    assert.equal(
      doc.usage,
      "ship --milestone vX.Y.Z [--json] | ship status --milestone vX.Y.Z [--json]",
    );
    assert.doesNotMatch(doc.usage, /--authorization|--for /);
  });

  test("papercut is marked undocumented", () => {
    assert.equal(COMMAND_DOCS.papercut?.documented, false);
    const listed = listDocumentedCommands().map((c) => c.keyword);
    assert.ok(!listed.includes("papercut"));
  });

  test("legacy run alias remains dispatchable but is absent from documentation", () => {
    assert.ok(lookupCommand("run"), "legacy run alias must remain registered");
    assert.equal(COMMAND_DOCS.run?.documented, false);
    const listed = listDocumentedCommands().map((c) => c.keyword);
    assert.ok(!listed.includes("run"));
  });

  test("OPERATION_SURFACE drives the default CLI and SKILL catalog", () => {
    const status = OPERATION_SURFACE.find((op) => op.name === "status");
    assert.ok(status);
    const mutableStatus = status as { desc: string };
    const original = mutableStatus.desc;
    const marker = "catalog-driven status marker";
    try {
      mutableStatus.desc = marker;
      assert.match(renderCliMarkdown(), new RegExp(marker));
      assert.match(renderSkillCommandTable({ hostToken: "/pipeline" }), new RegExp(marker));
    } finally {
      mutableStatus.desc = original;
    }
  });

  test("doc metadata does not change flag validation", () => {
    const entry = lookupCommand("status");
    assert.ok(entry);
    const cmd = {
      options: [{ attributeName: () => "json" }, { attributeName: () => "detach" }],
      getOptionValueSource: (k: string) => (k === "detach" ? "cli" : undefined),
    };
    // detach is not in status allowlist → still rejected
    assert.deepEqual(validateFlags(entry!, cmd), ["detach"]);
  });
});

// ---------------------------------------------------------------------------
// CLI markdown
// ---------------------------------------------------------------------------

describe("renderCliMarkdown", () => {
  test("documented command appears with usage and summary", () => {
    const md = renderCliMarkdown({
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    assert.match(md, /#### `status`/);
    assert.match(md, /pipeline status <n>/);
    assert.match(md, /Show status/);
    assert.match(md, /#### `advance`/);
  });

  test("hidden registry keyword is omitted", () => {
    const md = renderCliMarkdown({
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    assert.ok(!md.includes("papercut"), "papercut must not appear");
    assert.ok(!md.includes("not-in-docs"), "undocumented missing meta must not invent entry");
  });

  test("generator does not invent commands absent from registry", () => {
    const md = renderCliMarkdown({
      registry: FIXTURE_REGISTRY,
      docs: {
        ...FIXTURE_DOCS,
        ghost: {
          summary: "Should never appear",
          usage: "ghost",
          documented: true,
        },
      },
    });
    assert.ok(!md.includes("ghost"));
  });
});

// ---------------------------------------------------------------------------
// SKILL tables
// ---------------------------------------------------------------------------

describe("renderSkillCommandTable", () => {
  test("both hosts list the same documented commands; token differs", () => {
    const claude = renderSkillCommandTable({
      hostToken: "/pipeline",
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    const codex = renderSkillCommandTable({
      hostToken: "$pipeline",
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    assert.match(claude, /\/pipeline status <n>/);
    assert.match(codex, /\$pipeline status <n>/);
    assert.ok(!claude.includes("$pipeline"));
    assert.ok(!codex.includes("/pipeline status"));
    assert.ok(!claude.includes("papercut"));
    assert.ok(!codex.includes("papercut"));
  });

  test("replaceMarkedRegion rewrites only the generated block", () => {
    const src = [
      "# Skill",
      "",
      "## Modes",
      "",
      CLI_BEGIN_MARKER,
      "old body",
      CLI_END_MARKER,
      "",
      "## Setup",
      "keep me",
      "",
    ].join("\n");
    const out = applySkillCommandTable(src, "/pipeline", {
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    assert.ok(out.includes("## Setup\nkeep me"));
    assert.ok(out.includes(CLI_BEGIN_MARKER));
    assert.ok(out.includes(CLI_END_MARKER));
    assert.ok(out.includes("/pipeline status <n>"));
    assert.ok(!out.includes("old body"));
  });

  test("replaceMarkedRegion throws when markers missing", () => {
    assert.throws(
      () => replaceMarkedRegion("no markers", CLI_BEGIN_MARKER, CLI_END_MARKER, "x"),
      /markers not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Config markdown
// ---------------------------------------------------------------------------

describe("renderConfigMarkdown", () => {
  test("top-level keys appear with descriptions", () => {
    const md = renderConfigMarkdown({ schema: FIXTURE_SCHEMA });
    assert.match(md, /### `base_branch`/);
    assert.match(md, /Branch that PRs target/);
    assert.match(md, /### `review_policy`/);
    assert.match(md, /### `steps`/);
    assert.match(md, /### `eval_gate`/);
  });

  test("enum-typed fields surface allowed values", () => {
    const md = renderConfigMarkdown({ schema: FIXTURE_SCHEMA });
    assert.match(md, /block_threshold/);
    assert.match(md, /`critical`/);
    assert.match(md, /`high`/);
    assert.match(md, /`medium`/);
    assert.match(md, /`low`/);
    assert.match(md, /eval_gate\.mode|`mode`/);
    assert.match(md, /`gate`/);
    assert.match(md, /`advisory`/);
  });

  test("rejected keys such as auto_merge are not documented as valid keys", () => {
    const md = renderConfigMarkdown({ schema: FIXTURE_SCHEMA });
    // Banner may mention auto_merge as an example of a rejected key; the key
    // itself must not appear as a documented heading.
    assert.ok(!md.includes("### `auto_merge`"));
    assert.ok(!md.includes("#### `auto_merge`"));
  });
});

// ---------------------------------------------------------------------------
// CHANGELOG
// ---------------------------------------------------------------------------

describe("renderChangelogMarkdown", () => {
  test("bounded per-version sections from fixtures", () => {
    const releases: ChangelogRelease[] = [
      { version: "1.0.0", date: "2026-06-10", subject: "v1.0.0 — first release" },
      { version: "1.2.0", date: "2026-06-15", subject: "v1.2.0 — reviewer pluggability" },
    ];
    const md = renderChangelogMarkdown(releases);
    assert.match(md, /## \[1\.2\.0\] - 2026-06-15/);
    assert.match(md, /## \[1\.0\.0\] - 2026-06-10/);
    // Newest first
    assert.ok(md.indexOf("1.2.0") < md.indexOf("1.0.0"));
    assert.match(md, /reviewer pluggability/);
  });

  test("parseGitTagListLines is pure and filters non-semver tags", () => {
    const stdout = [
      "v1.2.0|2026-06-15|v1.2.0 — reviewer pluggability",
      "not-a-version|2026-01-01|ignore",
      "v1.0.0|2026-06-10|first",
      "",
    ].join("\n");
    const rels = parseGitTagListLines(stdout);
    assert.equal(rels.length, 2);
    assert.equal(rels[0]!.version, "1.2.0");
    assert.equal(rels[1]!.version, "1.0.0");
  });

  test("compareSemverDesc orders newest first", () => {
    assert.ok(compareSemverDesc("1.0.0", "1.2.0") > 0);
    assert.ok(compareSemverDesc("1.10.0", "1.9.1") < 0);
  });
});

// ---------------------------------------------------------------------------
// Artifact assembly + staleness shape
// ---------------------------------------------------------------------------

describe("buildGeneratedArtifacts", () => {
  test("produces cli, config, changelog; skill only when sources provided", () => {
    const skill = [
      "header",
      CLI_BEGIN_MARKER,
      "old",
      CLI_END_MARKER,
      "footer",
    ].join("\n");
    const arts = buildGeneratedArtifacts({
      skillClaude: skill,
      skillCodex: skill,
      skillOmp: skill,
      skillOpencode: skill,
      configSchema: FIXTURE_SCHEMA,
      changelogReleases: [{ version: "1.0.0", date: "2026-06-10", subject: "first" }],
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    const paths = arts.map((a) => a.relPath).sort();
    assert.deepEqual(paths, [
      "CHANGELOG.md",
      "docs/cli.md",
      "docs/config.md",
      "hosts/claude/SKILL.md",
      "hosts/codex/SKILL.md",
      "hosts/omp/SKILL.md",
      "hosts/opencode/SKILL.md",
    ]);
    const cli = arts.find((a) => a.relPath === "docs/cli.md")!.content;
    assert.match(cli, /status/);
    assert.ok(!cli.includes("papercut"));
    for (const relPath of [
      "hosts/claude/SKILL.md",
      "hosts/codex/SKILL.md",
      "hosts/omp/SKILL.md",
      "hosts/opencode/SKILL.md",
    ]) {
      const content = arts.find((artifact) => artifact.relPath === relPath)!.content;
      assert.match(content, /status/);
      assert.ok(!content.includes("papercut"));
    }
  });

  test("staleness bite: corrupted content differs from fresh generation", () => {
    const fresh = renderCliMarkdown({
      registry: FIXTURE_REGISTRY,
      docs: FIXTURE_DOCS,
    });
    const corrupted = fresh.replace("Show status", "HAND EDITED");
    assert.notEqual(
      normalizeTrailingNewline(corrupted),
      normalizeTrailingNewline(fresh),
    );
  });
});
