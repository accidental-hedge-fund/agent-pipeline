// Drift guard (#626): stage inventory prose on living OpenSpec, host SKILLs,
// README, and openspec/project.md must match code STAGES / TERMINAL_STAGES.
// Reads checked-in files only — no network, git, or subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, TERMINAL_STAGES } from "../scripts/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const LIVING_SPINE = path.join(repoRoot, "openspec/specs/pipeline-state-machine/spec.md");
const CLAUDE_SKILL = path.join(repoRoot, "hosts/claude/SKILL.md");
const CODEX_SKILL = path.join(repoRoot, "hosts/codex/SKILL.md");
const README = path.join(repoRoot, "README.md");
const PROJECT_MD = path.join(repoRoot, "openspec/project.md");

const EXPECTED_COUNT = STAGES.length;
const EXPECTED_ORDER = [...STAGES];
const EXPECTED_TERMINALS = ["ready-to-deploy", "needs-human"] as const;

function read(relOrAbs: string): string {
  return fs.readFileSync(relOrAbs, "utf8");
}

/** Extract the STAGES-order scenario's ordered stage list from living spine. */
function extractLivingStagesOrder(source: string): string[] {
  const match = source.match(
    /#### Scenario: STAGES order[\s\S]*?- \*\*THEN\*\* it SHALL list, in order: ([^\n]+)/,
  );
  assert.ok(
    match,
    "living pipeline-state-machine: missing STAGES-order scenario list line",
  );
  return match[1]
    .split(",")
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

/** Host SKILL state-machine inventory section (diagram + nearby intro). */
function skillStateMachineSection(source: string, label: string): string {
  const match = source.match(/## State machine\n([\s\S]*?)(?=\n## )/);
  assert.ok(match, `${label}: expected a "## State machine" section`);
  // Include the intro blurb that sits just above the section (count language).
  const introStart = source.lastIndexOf("\n", match.index! - 2);
  const head = source.slice(Math.max(0, introStart - 400), match.index!);
  return head + match[0];
}

function assertStageCountLanguage(source: string, surface: string): void {
  // Inventory-intro form: "N-stage" / "N-stage state machine" / "N-stage label-driven"
  const counts = [...source.matchAll(/\b(\d+)-stage\b/g)].map((m) => Number(m[1]));
  assert.ok(
    counts.length > 0,
    `${surface}: expected at least one "N-stage" count claim near the inventory intro`,
  );
  for (const n of counts) {
    assert.equal(
      n,
      EXPECTED_COUNT,
      `${surface}: stage-count language claims ${n}-stage but STAGES.length is ${EXPECTED_COUNT}`,
    );
  }
}

/** True when `stage` appears as its own token (not a substring of another stage). */
function hasStageToken(text: string, stage: string): boolean {
  const escaped = stage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`).test(text);
}

function assertSkillCoversAllStages(section: string, label: string): void {
  for (const stage of STAGES) {
    assert.ok(
      hasStageToken(section, stage),
      `${label}: state-machine inventory missing stage "${stage}" from STAGES`,
    );
  }
}

test("code TERMINAL_STAGES membership is the dual-terminal authority", () => {
  const actual = [...TERMINAL_STAGES].sort();
  const expected = [...EXPECTED_TERMINALS].sort();
  assert.deepEqual(
    actual,
    expected,
    `TERMINAL_STAGES must be exactly {${EXPECTED_TERMINALS.join(", ")}}`,
  );
});

test("living STAGES-order scenario lists every STAGES member in code order", () => {
  const listed = extractLivingStagesOrder(read(LIVING_SPINE));
  assert.deepEqual(
    listed,
    EXPECTED_ORDER,
    `living STAGES-order scenario must equal code STAGES (got ${listed.join(", ")})`,
  );
});

test("living terminal requirement is dual-terminal, not ready-to-deploy alone", () => {
  const source = read(LIVING_SPINE);

  assert.match(
    source,
    /### Requirement: Terminal stages are ready-to-deploy and needs-human/,
    "living spine: terminal requirement title must name both terminals",
  );
  assert.match(
    source,
    /`TERMINAL_STAGES` SHALL contain exactly `ready-to-deploy` and `needs-human`/,
    "living spine: TERMINAL_STAGES membership claim must list both terminals",
  );
  assert.doesNotMatch(
    source,
    /`TERMINAL_STAGES` SHALL contain exactly `ready-to-deploy`\./,
    "living spine: must not claim TERMINAL_STAGES is exactly ready-to-deploy alone",
  );
  assert.doesNotMatch(
    source,
    /### Requirement: Terminal stage is ready-to-deploy/,
    "living spine: must not keep the single-terminal requirement title",
  );

  for (const terminal of EXPECTED_TERMINALS) {
    assert.ok(
      source.includes(`\`${terminal}\``),
      `living spine: terminal requirement surface must mention \`${terminal}\``,
    );
  }
});

test("hosts/claude/SKILL.md inventory covers STAGES and count language", () => {
  const source = read(CLAUDE_SKILL);
  // Count language lives in the skill intro immediately above State machine.
  const intro = source.slice(0, source.indexOf("## State machine") + 200);
  assertStageCountLanguage(intro, "hosts/claude/SKILL.md");
  assertSkillCoversAllStages(skillStateMachineSection(source, "claude"), "hosts/claude/SKILL.md");
});

test("hosts/codex/SKILL.md inventory covers STAGES and count language", () => {
  const source = read(CODEX_SKILL);
  const intro = source.slice(0, source.indexOf("## State machine") + 200);
  assertStageCountLanguage(intro, "hosts/codex/SKILL.md");
  assertSkillCoversAllStages(skillStateMachineSection(source, "codex"), "hosts/codex/SKILL.md");
});

test("README.md primary inventory blurb matches STAGES count and stage tokens", () => {
  const source = read(README);
  // Primary inventory blurb is the opening paragraph under # agent-pipeline.
  const firstParagraph = source.split(/\n\n/)[1] ?? source.slice(0, 800);
  assertStageCountLanguage(firstParagraph, "README.md primary inventory blurb");
  // When the blurb enumerates stages (arrow list), every STAGES member must appear
  // by exact token — abbreviated "review"/"fix" must not stand in for review-1/fix-1/…
  if (/→/.test(firstParagraph)) {
    for (const stage of STAGES) {
      assert.ok(
        hasStageToken(firstParagraph, stage),
        `README.md primary inventory blurb missing stage "${stage}" from STAGES`,
      );
    }
  }
});

test("openspec/project.md purpose blurb stage-count matches STAGES.length", () => {
  const source = read(PROJECT_MD);
  const purpose = source.match(/## Purpose\n([\s\S]*?)(?=\n## )/)?.[1] ?? source.slice(0, 600);
  assertStageCountLanguage(purpose, "openspec/project.md purpose blurb");
});
