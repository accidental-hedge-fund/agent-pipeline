// Drift guard: stage-inventory surfaces must match code STAGES / TERMINAL_STAGES (#626).
//
// Surfaces under guard:
//   - README.md
//   - hosts/claude/SKILL.md, hosts/codex/SKILL.md
//   - openspec/project.md
//   - living openspec/specs/pipeline-state-machine/spec.md
//
// No network, git, or subprocess — local file reads + code constants only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGES, TERMINAL_STAGES } from "../scripts/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** Stages that host SKILL diagrams historically omitted and must name. */
const REQUIRED_HOST_STAGES = [
  "plan-review",
  "design-gate",
  "visual-gate",
  "needs-human",
] as const;

function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Numeric "N-stage" claims in operator/docs surfaces (not archive history). */
export function extractStageCounts(text: string): number[] {
  const counts: number[] = [];
  const re = /\b(\d+)-stage\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    counts.push(Number(m[1]));
  }
  return counts;
}

/** Assert every stated N-stage count equals STAGES.length. */
export function assertStageCountsMatch(text: string, label: string, expected = STAGES.length): void {
  const counts = extractStageCounts(text);
  for (const n of counts) {
    assert.equal(
      n,
      expected,
      `${label}: stated "${n}-stage" must equal STAGES.length (${expected})`,
    );
  }
}

/** Stages named with backticks in a STAGES-order scenario THEN line. */
export function extractStagedOrderTokens(stagesOrderBlock: string): string[] {
  const tokens: string[] = [];
  const re = /`([a-z0-9-]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stagesOrderBlock)) !== null) {
    tokens.push(m[1]);
  }
  return tokens;
}

/**
 * Pull the STAGES-order scenario body from living (or delta) pipeline-state-machine text.
 * Returns null when the scenario heading is absent.
 */
export function extractStagesOrderScenario(specText: string): string | null {
  const heading = "#### Scenario: STAGES order";
  const start = specText.indexOf(heading);
  if (start < 0) return null;
  const rest = specText.slice(start + heading.length);
  const next = rest.search(/\n#### |\n### /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Terminal requirement section for membership checks.
 * Accepts the renamed dual-terminal title or legacy singleton title (legacy must fail membership).
 */
export function extractTerminalRequirement(specText: string): string | null {
  const dual = "### Requirement: Terminal stages are ready-to-deploy and needs-human";
  const single = "### Requirement: Terminal stage is ready-to-deploy";
  let start = specText.indexOf(dual);
  let headingLen = dual.length;
  if (start < 0) {
    start = specText.indexOf(single);
    headingLen = single.length;
  }
  if (start < 0) return null;
  const rest = specText.slice(start + headingLen);
  const next = rest.search(/\n### /);
  return next < 0 ? rest : rest.slice(0, next);
}

export function assertHostSkillInventory(text: string, label: string): void {
  for (const stage of REQUIRED_HOST_STAGES) {
    assert.ok(
      text.includes(stage),
      `${label}: state-machine inventory must name \`${stage}\``,
    );
  }
  assertStageCountsMatch(text, label);
}

export function assertLivingSpineInventory(specText: string, label: string): void {
  const orderBlock = extractStagesOrderScenario(specText);
  assert.ok(orderBlock, `${label}: missing #### Scenario: STAGES order`);

  // The THEN line lists the full ordered inventory in backticks.
  const thenLine = orderBlock!
    .split("\n")
    .find((l) => l.includes("**THEN**") && l.includes("list, in order"));
  assert.ok(thenLine, `${label}: STAGES order scenario missing THEN list line`);

  const listed = extractStagedOrderTokens(thenLine!);
  // Filter to stage-like tokens that appear in STAGES (THEN also may mention other backtick words — keep order of STAGES members only).
  const listedStages = listed.filter((t) => (STAGES as readonly string[]).includes(t));
  // Deduplicate preserving order (THEN may repeat names in AND clauses on same line — unlikely).
  const uniqueListed = [...new Set(listedStages)];
  assert.deepEqual(
    uniqueListed,
    [...STAGES],
    `${label}: STAGES-order list must match code STAGES membership and order`,
  );

  for (const stage of STAGES) {
    assert.ok(
      orderBlock!.includes(`\`${stage}\``),
      `${label}: STAGES-order scenario must include \`${stage}\``,
    );
  }

  const terminalBlock = extractTerminalRequirement(specText);
  assert.ok(terminalBlock, `${label}: missing terminal stages requirement`);
  assert.ok(
    terminalBlock!.includes("ready-to-deploy"),
    `${label}: terminal requirement must mention ready-to-deploy`,
  );
  assert.ok(
    terminalBlock!.includes("needs-human"),
    `${label}: terminal requirement must mention needs-human`,
  );
  assert.ok(
    /TERMINAL_STAGES/.test(terminalBlock!),
    `${label}: terminal requirement must name TERMINAL_STAGES`,
  );
  // Reject legacy singleton wording that remains as the whole claim.
  assert.ok(
    !/SHALL contain exactly `ready-to-deploy`\./.test(terminalBlock!),
    `${label}: terminal requirement must not claim singleton ready-to-deploy only`,
  );
}

// ---------------------------------------------------------------------------
// Code pins (runtime SSOT unchanged by this capability)
// ---------------------------------------------------------------------------

test("stage-inventory-ssot: code STAGES length and membership are the pre-change truth", () => {
  assert.equal(STAGES.length, 16);
  assert.deepEqual([...STAGES], [
    "backlog",
    "ready",
    "planning",
    "plan-review",
    "implementing",
    "design-gate",
    "review-1",
    "fix-1",
    "review-2",
    "fix-2",
    "pre-merge",
    "visual-gate",
    "eval-gate",
    "shipcheck-gate",
    "ready-to-deploy",
    "needs-human",
  ]);
  assert.equal(TERMINAL_STAGES.size, 2);
  assert.ok(TERMINAL_STAGES.has("ready-to-deploy"));
  assert.ok(TERMINAL_STAGES.has("needs-human"));
});

// ---------------------------------------------------------------------------
// Live surfaces
// ---------------------------------------------------------------------------

test("stage-inventory-ssot: README stage-count matches STAGES.length", () => {
  const text = readRepoFile("README.md");
  assertStageCountsMatch(text, "README.md");
  assert.ok(
    text.includes("needs-human"),
    "README.md: terminal/park outcomes must mention needs-human",
  );
});

test("stage-inventory-ssot: openspec/project.md stage-count matches STAGES.length", () => {
  const text = readRepoFile("openspec/project.md");
  assertStageCountsMatch(text, "openspec/project.md");
  assert.ok(
    !/\b11-stage\b/.test(text),
    "openspec/project.md must not claim an 11-stage machine",
  );
  assert.ok(
    text.includes("needs-human"),
    "openspec/project.md must mention needs-human in inventory language",
  );
});

test("stage-inventory-ssot: Claude host SKILL documents full inventory", () => {
  assertHostSkillInventory(readRepoFile("hosts/claude/SKILL.md"), "hosts/claude/SKILL.md");
});

test("stage-inventory-ssot: Codex host SKILL documents full inventory", () => {
  assertHostSkillInventory(readRepoFile("hosts/codex/SKILL.md"), "hosts/codex/SKILL.md");
});

test("stage-inventory-ssot: host inventories stay stage-symmetric", () => {
  const claude = readRepoFile("hosts/claude/SKILL.md");
  const codex = readRepoFile("hosts/codex/SKILL.md");
  for (const stage of REQUIRED_HOST_STAGES) {
    assert.ok(claude.includes(stage), `claude missing ${stage}`);
    assert.ok(codex.includes(stage), `codex missing ${stage}`);
  }
  assert.deepEqual(
    extractStageCounts(claude),
    extractStageCounts(codex),
    "Claude and Codex host SKILLs must state the same N-stage counts",
  );
});

test("stage-inventory-ssot: living pipeline-state-machine spine matches STAGES / TERMINAL_STAGES", () => {
  assertLivingSpineInventory(
    readRepoFile("openspec/specs/pipeline-state-machine/spec.md"),
    "living pipeline-state-machine",
  );
});

// ---------------------------------------------------------------------------
// Bite checks (pure helpers — prove the guard fails on drifted input)
// ---------------------------------------------------------------------------

test("stage-inventory-ssot bite: under-count N-stage fails", () => {
  assert.throws(
    () => assertStageCountsMatch("through a 15-stage state machine", "synthetic"),
    /15-stage.*must equal STAGES\.length \(16\)/,
  );
});

test("stage-inventory-ssot bite: host omitting plan-review fails", () => {
  const drifted = [
    "through a 16-stage label-driven state machine",
    "design-gate",
    "visual-gate",
    "needs-human",
    // plan-review intentionally omitted
  ].join("\n");
  assert.throws(
    () => assertHostSkillInventory(drifted, "synthetic-host"),
    /must name `plan-review`/,
  );
});

test("stage-inventory-ssot bite: STAGES-order omitting needs-human fails", () => {
  const drifted = `
#### Scenario: STAGES order
- **WHEN** the \`STAGES\` constant is inspected
- **THEN** it SHALL list, in order: \`backlog\`, \`ready\`, \`planning\`, \`plan-review\`, \`implementing\`, \`design-gate\`, \`review-1\`, \`fix-1\`, \`review-2\`, \`fix-2\`, \`pre-merge\`, \`visual-gate\`, \`eval-gate\`, \`shipcheck-gate\`, \`ready-to-deploy\`

### Requirement: Terminal stages are ready-to-deploy and needs-human
\`TERMINAL_STAGES\` SHALL be exactly the set {\`ready-to-deploy\`, \`needs-human\`}.
`;
  assert.throws(
    () => assertLivingSpineInventory(drifted, "synthetic-spine"),
    /STAGES-order list must match code STAGES/,
  );
});

test("stage-inventory-ssot bite: singleton terminal requirement fails", () => {
  const order = STAGES.map((s) => `\`${s}\``).join(", ");
  const drifted = `
#### Scenario: STAGES order
- **WHEN** the \`STAGES\` constant is inspected
- **THEN** it SHALL list, in order: ${order}

### Requirement: Terminal stage is ready-to-deploy
\`TERMINAL_STAGES\` SHALL contain exactly \`ready-to-deploy\`. When an issue reaches it, the run finalizes.
`;
  assert.throws(
    () => assertLivingSpineInventory(drifted, "synthetic-spine"),
    /must mention needs-human|singleton ready-to-deploy/,
  );
});

// I/O contract: this module only uses readFileSync + type imports — no network,
// git, or subprocess. Enforced by construction (see file imports above).
