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
  "pre-code-attestation",
  "design-gate",
  "visual-gate",
  "needs-human",
] as const;

const STAGE_SET = new Set<string>(STAGES as readonly string[]);

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

/**
 * Collect canonical STAGES tokens from text in first-seen order.
 * Matches backtick-wrapped stage names (incl. `pipeline:<stage>`) and bare
 * whole-token occurrences of any STAGES member (diagram lines like
 * `backlog → ready → planning`). Longest-first so `ready-to-deploy` wins over `ready`.
 */
export function extractCanonicalStageTokens(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const sorted = [...STAGES].sort((a, b) => b.length - a.length);
  const alt = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(
    "(?:`(?:pipeline:)?(" + alt + ")`|(?:^|[^a-z0-9-])(" + alt + ")(?=[^a-z0-9-]|$))",
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tok = m[1] ?? m[2];
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      found.push(tok);
    }
  }
  return found;
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

/**
 * Extract the declared TERMINAL_STAGES membership from a terminal requirement section.
 * Prefers an "exactly the set {…}" brace list; falls back to backtick stage tokens
 * that are STAGES members appearing after the first TERMINAL_STAGES mention.
 */
export function extractTerminalSetMembers(terminalBlock: string): string[] {
  // Brace set: exactly the set {`a`, `b`} or `{a, b}` (whole-set backticks allowed)
  const setMatch = terminalBlock.match(
    /exactly the set\s*`?\{([^}]+)\}`?/i,
  );
  if (setMatch) {
    const inner = setMatch[1];
    const members: string[] = [];
    const pieceRe = /`([a-z0-9-]+)`|([a-z0-9-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = pieceRe.exec(inner)) !== null) {
      const tok = m[1] ?? m[2];
      if (tok) members.push(tok);
    }
    return members;
  }

  // Scenario-style: "contain exactly `ready-to-deploy` and `needs-human`"
  const termIdx = terminalBlock.search(/TERMINAL_STAGES/);
  const scope = termIdx >= 0 ? terminalBlock.slice(termIdx) : terminalBlock;
  // Limit to the first non-scenario paragraph block to avoid collecting every
  // stage name mentioned later in scenarios (e.g. "reaches ready-to-deploy").
  const firstParagraph = scope.split(/\n\n/)[0] ?? scope;
  const members: string[] = [];
  const re = /`([a-z0-9-]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(firstParagraph)) !== null) {
    if (STAGE_SET.has(m[1]) && !members.includes(m[1])) {
      members.push(m[1]);
    }
  }
  return members;
}

/** Assert declared terminal set equals code TERMINAL_STAGES exactly. */
export function assertTerminalSetExact(terminalBlock: string, label: string): void {
  const declared = extractTerminalSetMembers(terminalBlock);
  const expected = [...TERMINAL_STAGES].sort();
  const actual = [...new Set(declared)].sort();
  assert.deepEqual(
    actual,
    expected,
    `${label}: TERMINAL_STAGES declaration must be exactly {${expected.join(", ")}} (got {${actual.join(", ")}})`,
  );
}

/**
 * Extract the host SKILL "## State machine" section (through the next ## heading).
 * Returns null when the section heading is absent.
 */
export function extractStateMachineSection(text: string): string | null {
  const heading = "## State machine";
  const start = text.indexOf(heading);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Assert every STAGES member appears in the bounded state-machine inventory
 * (diagram / section), not merely somewhere else in the host file.
 */
export function assertStateMachineInventory(
  section: string,
  label: string,
  expected: readonly string[] = STAGES,
): void {
  const tokens = extractCanonicalStageTokens(section);
  const present = new Set(tokens);
  for (const stage of expected) {
    assert.ok(
      present.has(stage),
      `${label}: state-machine inventory must name \`${stage}\` (section tokens: ${tokens.join(", ") || "(none)"})`,
    );
  }
}

/**
 * When the primary blurb / lead inventory contains a stage list (arrow chain),
 * every STAGES member must appear as a token in that inventory surface.
 */
export function assertReadmeInventoryCoverage(text: string, label: string): void {
  // Lead blurb is the first strong-paragraph after the title (through first blank line after **agent-pipeline**).
  const leadMatch = text.match(/\*\*agent-pipeline\*\*[^\n]*(?:\n[^\n#][^\n]*)*/);
  const surface = leadMatch ? leadMatch[0] : text.slice(0, 800);
  // Only enforce full membership when the surface looks like an ordered inventory list.
  if (!/→/.test(surface) && !/->/.test(surface)) {
    // Still require needs-human when terminal outcomes are discussed in the file.
    assert.ok(
      text.includes("needs-human"),
      `${label}: terminal/park outcomes must mention needs-human`,
    );
    return;
  }
  const tokens = extractCanonicalStageTokens(surface);
  const present = new Set(tokens);
  for (const stage of STAGES) {
    assert.ok(
      present.has(stage),
      `${label}: inventory list must name \`${stage}\` (found: ${tokens.join(", ") || "(none)"})`,
    );
  }
}

export function assertHostSkillInventory(text: string, label: string): void {
  assertStageCountsMatch(text, label);

  const section = extractStateMachineSection(text);
  assert.ok(section, `${label}: missing ## State machine section`);

  // Section-bounded inventory: every STAGES member must appear in the diagram/section.
  assertStateMachineInventory(section!, label);

  // Keep the historical required-stage pin as an explicit secondary check
  // (message remains useful when only those four drift).
  for (const stage of REQUIRED_HOST_STAGES) {
    assert.ok(
      section!.includes(stage),
      `${label}: state-machine inventory must name \`${stage}\``,
    );
  }
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
    /TERMINAL_STAGES/.test(terminalBlock!),
    `${label}: terminal requirement must name TERMINAL_STAGES`,
  );
  // Reject legacy singleton wording that remains as the whole claim.
  assert.ok(
    !/SHALL contain exactly `ready-to-deploy`\./.test(terminalBlock!),
    `${label}: terminal requirement must not claim singleton ready-to-deploy only`,
  );
  // Exact membership — not merely "both names appear somewhere".
  assertTerminalSetExact(terminalBlock!, label);
}

// ---------------------------------------------------------------------------
// Code pins (runtime SSOT unchanged by this capability)
// ---------------------------------------------------------------------------

test("stage-inventory-ssot: code STAGES length and membership are the inventory truth", () => {
  assert.equal(STAGES.length, 17);
  assert.deepEqual([...STAGES], [
    "backlog",
    "ready",
    "planning",
    "plan-review",
    "pre-code-attestation",
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

test("stage-inventory-ssot: README stage-count and inventory match STAGES", () => {
  const text = readRepoFile("README.md");
  assertStageCountsMatch(text, "README.md");
  assertReadmeInventoryCoverage(text, "README.md");
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
  const claudeSection = extractStateMachineSection(claude);
  const codexSection = extractStateMachineSection(codex);
  assert.ok(claudeSection, "claude missing state-machine section");
  assert.ok(codexSection, "codex missing state-machine section");
  assert.deepEqual(
    extractCanonicalStageTokens(claudeSection!).sort(),
    extractCanonicalStageTokens(codexSection!).sort(),
    "Claude and Codex state-machine sections must document the same stage membership",
  );
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
  const under = STAGES.length - 1;
  assert.throws(
    () => assertStageCountsMatch(`through a ${under}-stage state machine`, "synthetic"),
    new RegExp(`${under}-stage.*must equal STAGES\\.length \\(${STAGES.length}\\)`),
  );
});

test("stage-inventory-ssot bite: host omitting plan-review fails", () => {
  const drifted = [
    "## State machine",
    `through a ${STAGES.length}-stage label-driven state machine`,
    "```",
    "backlog → ready → planning → pre-code-attestation → implementing → design-gate",
    "→ review-1 → fix-1 → review-2 → fix-2",
    "→ pre-merge → visual-gate → eval-gate → shipcheck-gate",
    "→ ready-to-deploy",
    "```",
    "→ needs-human",
    // plan-review intentionally omitted from the section
  ].join("\n");
  assert.throws(
    () => assertHostSkillInventory(drifted, "synthetic-host"),
    /must name `plan-review`/,
  );
});

test("stage-inventory-ssot bite: diagram-only omission fails even when stage appears elsewhere", () => {
  // plan-review is mentioned outside ## State machine but dropped from the diagram section.
  const drifted = [
    "Elsewhere in the skill: plan-review is a real stage.",
    "",
    "## State machine",
    `through a ${STAGES.length}-stage label-driven state machine`,
    "```",
    "backlog → ready → planning → pre-code-attestation → implementing → design-gate",
    "→ review-1 → fix-1 → review-2 → fix-2",
    "→ pre-merge → visual-gate → eval-gate → shipcheck-gate",
    "→ ready-to-deploy",
    "```",
    "→ needs-human",
    "",
    "## Modes",
    "unrelated",
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
    /TERMINAL_STAGES declaration must be exactly|singleton ready-to-deploy/,
  );
});

test("stage-inventory-ssot bite: extra terminal member fails", () => {
  const order = STAGES.map((s) => `\`${s}\``).join(", ");
  const drifted = `
#### Scenario: STAGES order
- **WHEN** the \`STAGES\` constant is inspected
- **THEN** it SHALL list, in order: ${order}

### Requirement: Terminal stages are ready-to-deploy and needs-human
\`TERMINAL_STAGES\` SHALL be exactly the set {\`ready-to-deploy\`, \`needs-human\`, \`backlog\`}. Both members stop the advance loop.
`;
  assert.throws(
    () => assertLivingSpineInventory(drifted, "synthetic-spine"),
    /TERMINAL_STAGES declaration must be exactly/,
  );
});

test("stage-inventory-ssot bite: README inventory omitting review-1 fails", () => {
  const drifted = [
    "# agent-pipeline",
    "",
    `**agent-pipeline** is a label-driven GitHub issue pipeline that advances an issue from backlog to \`pipeline:ready-to-deploy\` through a ${STAGES.length}-stage state machine — backlog → ready → planning → plan-review → pre-code-attestation → implementing → design-gate → review → fix → pre-merge → visual-gate → eval-gate → shipcheck-gate → ready-to-deploy, with \`needs-human\` as the terminal park off-ramp.`,
  ].join("\n");
  assert.throws(
    () => assertReadmeInventoryCoverage(drifted, "synthetic-readme"),
    /must name `review-1`/,
  );
});

// I/O contract: this module only uses readFileSync + type imports — no network,
// git, or subprocess. Enforced by construction (see file imports above).
