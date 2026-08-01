// Template pinning (#450): prompt templates are read once at module init and
// pinned in memory; a template file rewritten on disk mid-process must never
// reach a subsequently-built prompt. Regression coverage for the mid-run
// skill-update race (fix.md gaining a new placeholder like {{reviewed_sha}}
// while the running process still had old code — lyric-utils#651).

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetTemplateSnapshotForTests,
  buildFixPrompt,
  getTemplateSnapshot,
  _testing,
} from "../scripts/prompts/index.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prompts");
const fixMdPath = join(promptsDir, "fix.md");

function dummyConfig(): PipelineConfig {
  return {
    domain: "acme",
    repo: "acme/widget",
    repo_dir: "/tmp/does-not-exist-prompt-snapshot-test",
    base_branch: "main",
    worktree_root: ".worktrees",
    max_concurrent_worktrees: 5,
    auto_recovery_max_retries: 2,
    implementation_timeout: 1200,
    review_timeout: 1200,
    fix_timeout: 1200,
    ci_timeout: 900,
    ci_poll_interval: 30,
    harnesses: { implementer: "codex", reviewer: "claude" },
    models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet" },
    openspec: { enabled: "auto", bootstrap: false },
    last30days: { enabled: false, timeout: 600 },
    steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
    domain_name: "Widget",
    domain_description: "the example widget service",
  };
}

function fixArgs(overrides: Partial<Parameters<typeof buildFixPrompt>[0]> = {}) {
  return {
    cfg: dummyConfig(),
    issueNumber: 651,
    title: "some fix round",
    reviewFindings: "finding text",
    fixRound: 1 as const,
    pipelineRunId: "651/2026-07-08T16-55-10-737Z",
    reviewedSha: "abc123def456",
    ...overrides,
  };
}

test("templates are read eagerly at module init, before any prompt is built", () => {
  const snapshot = getTemplateSnapshot();
  assert.ok("fix" in snapshot, "the pinned snapshot must already contain fix.md");
  assert.ok(snapshot.fix.length > 0);
});

test("a fix.md rewrite after snapshot population does not change buildFixPrompt output and raises no error", () => {
  // The rewrite targets a temp COPY of the prompts dir, never the real one:
  // test files run as concurrent processes, and a sibling process (e.g.
  // prompt-loader.test.ts) module-inits its own pinned snapshot from the real
  // directory — a mid-test poison write there races that init read and fails
  // the sibling with "Unfilled prompt placeholder(s)" (main CI run
  // 30710446502). The pinning guarantee is identical against the copy: the
  // snapshot is populated once from real files, then the on-disk rewrite must
  // never reach a subsequently-built prompt.
  const realFixMdBefore = readFileSync(fixMdPath, "utf8");
  const tmpPromptsDir = mkdtempSync(join(tmpdir(), "prompt-snapshot-"));
  const readTmpTemplates = () => {
    const snapshot: Record<string, string> = {};
    for (const name of readdirSync(tmpPromptsDir)) {
      if (name.endsWith(".md")) snapshot[name.slice(0, -".md".length)] = readFileSync(join(tmpPromptsDir, name), "utf8");
    }
    return snapshot;
  };
  try {
    for (const name of readdirSync(promptsDir)) {
      if (name.endsWith(".md")) copyFileSync(join(promptsDir, name), join(tmpPromptsDir, name));
    }
    __resetTemplateSnapshotForTests(readTmpTemplates);
    const before = buildFixPrompt(fixArgs());
    // Simulate an update landing mid-run: rewrite fix.md with a NEW
    // placeholder the current buildFixPrompt does not supply. If loadTemplate
    // ever fell back to a filesystem read, the very next build would throw
    // "Unfilled prompt placeholder(s)".
    const tmpFixMdPath = join(tmpPromptsDir, "fix.md");
    writeFileSync(tmpFixMdPath, `${readFileSync(tmpFixMdPath, "utf8")}\n\nBrand new field: {{totally_unsupplied_placeholder}}\n`);
    const after = buildFixPrompt(fixArgs());
    assert.equal(after, before);
  } finally {
    __resetTemplateSnapshotForTests();
    rmSync(tmpPromptsDir, { recursive: true, force: true });
  }
  // Tripwire: this test must never touch the real template other processes
  // pin from — not even transiently (the old restore-in-finally still left a
  // poison window a concurrent module init could read).
  assert.equal(readFileSync(fixMdPath, "utf8"), realFixMdBefore, "the real fix.md must remain untouched");
});

test("no filesystem read occurs during prompt building — only at snapshot population", () => {
  let reads = 0;
  __resetTemplateSnapshotForTests(() => {
    reads++;
    return { fix: "static fix template body with no placeholders at all" };
  });
  try {
    assert.equal(reads, 1, "populating the snapshot invokes the seam exactly once");
    for (let i = 0; i < 5; i++) {
      buildFixPrompt(fixArgs());
    }
    assert.equal(reads, 1, "build*Prompt must not invoke the template-read seam again");
  } finally {
    __resetTemplateSnapshotForTests();
  }
});

test("unknown template names throw and never fall back to a filesystem read", () => {
  assert.throws(
    () => _testing.loadTemplate("does-not-exist-anywhere"),
    /Unknown prompt template "does-not-exist-anywhere"/,
  );
});

test("__resetTemplateSnapshotForTests with no seam re-reads the real templates on disk", () => {
  __resetTemplateSnapshotForTests(() => ({ fix: "fake" }));
  assert.equal(getTemplateSnapshot().fix, "fake");
  __resetTemplateSnapshotForTests();
  assert.notEqual(getTemplateSnapshot().fix, "fake");
  assert.ok(getTemplateSnapshot().fix.includes("{{issue_number}}") || getTemplateSnapshot().fix.length > 0);
});
