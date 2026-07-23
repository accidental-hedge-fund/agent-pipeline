// Drift guard: both host SKILL docs must carry the operator-owned native
// `/goal` bootstrap sequence with the correct per-host command token and the
// required non-claim / host-owned-completion statements (#514). Reads the
// checked-in host docs directly — no network, git, or subprocess call.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const CLAUDE_DOC_PATH = path.join(repoRoot, "hosts/claude/SKILL.md");
const CODEX_DOC_PATH = path.join(repoRoot, "hosts/codex/SKILL.md");

function bootstrapSection(source, label) {
  const match = source.match(
    /#### Bootstrapping a durable run:[\s\S]*?once a run reports done\./,
  );
  assert.ok(match, `${label}: expected a "Bootstrapping a durable run" subsection`);
  return match[0];
}

function assertOrderedBootstrap(section, loopToken, label) {
  const goalIndex = section.indexOf("`/goal`");
  const loopIndex = section.indexOf(`\`${loopToken}`);
  assert.ok(goalIndex !== -1, `${label}: bootstrap section must mention \`/goal\``);
  assert.ok(loopIndex !== -1, `${label}: bootstrap section must mention \`${loopToken}\``);
  assert.ok(
    goalIndex < loopIndex,
    `${label}: bootstrap must document /goal before ${loopToken}`,
  );
}

function assertNonClaims(section, label) {
  const flat = section.replace(/\*\*/g, "").replace(/\s+/g, " ");

  assert.match(
    flat,
    /does not detect/,
    `${label}: bootstrap must disclaim host \`/goal\` state detection`,
  );
  assert.match(
    flat,
    /does not (?:invoke|itself invoke) or re-enter/,
    `${label}: bootstrap must disclaim recursive \`/goal\` invocation`,
  );
  assert.match(
    flat,
    /does not control the native `\/goal` session's lifecycle/,
    `${label}: bootstrap must disclaim native lifecycle control`,
  );
  assert.match(
    flat,
    /(?:host\/user action|host or operator)/,
    `${label}: bootstrap must place native completion with the host/operator`,
  );
  assert.match(
    flat,
    /neither ends the `\/goal` session nor merges/,
    `${label}: bootstrap must state the skill neither ends the session nor merges`,
  );
}

test("Claude host doc documents /goal then /pipeline:loop bootstrap", () => {
  const source = fs.readFileSync(CLAUDE_DOC_PATH, "utf8");
  const section = bootstrapSection(source, "claude");
  assertOrderedBootstrap(section, "/pipeline:loop", "claude");
  assertNonClaims(section, "claude");
});

test("Codex host doc documents /goal then $pipeline:loop bootstrap", () => {
  const source = fs.readFileSync(CODEX_DOC_PATH, "utf8");
  const section = bootstrapSection(source, "codex");
  assertOrderedBootstrap(section, "$pipeline:loop", "codex");
  assertNonClaims(section, "codex");
});

test("host bootstrap sections stay symmetric and use only their own command token", () => {
  const claudeSection = bootstrapSection(fs.readFileSync(CLAUDE_DOC_PATH, "utf8"), "claude");
  const codexSection = bootstrapSection(fs.readFileSync(CODEX_DOC_PATH, "utf8"), "codex");

  assert.ok(
    !claudeSection.includes("$pipeline:loop"),
    "claude bootstrap section must not reference Codex's $pipeline:loop token",
  );
  assert.ok(
    !codexSection.includes("/pipeline:loop"),
    "codex bootstrap section must not reference Claude's /pipeline:loop token",
  );
});
