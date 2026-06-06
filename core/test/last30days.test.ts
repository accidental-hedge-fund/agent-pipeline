// last30days wrapper tests — pure unit (no skill / Python required).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractBrief, hasSignal, isEnabled, skillDir } from "../scripts/last30days.ts";

test("isEnabled: reads cfg.last30days.enabled", () => {
  assert.equal(isEnabled({ last30days: { enabled: true, timeout: 600 } }), true);
  assert.equal(isEnabled({ last30days: { enabled: false, timeout: 600 } }), false);
});

test("extractBrief: pulls the evidence block and the stats footer", () => {
  const stdout = [
    "noise before",
    "<!-- EVIDENCE FOR SYNTHESIS -->",
    "## Ranked Evidence Clusters",
    "### 1. Big news (score 9, 12 items, sources: X, Reddit)",
    "<!-- END EVIDENCE FOR SYNTHESIS -->",
    "---",
    "✅ All agents reported back!",
    "🌐 Reddit: 12 items | 🐦 X: 8 items | 📺 YouTube: 3 items",
  ].join("\n");
  const { brief, stats } = extractBrief(stdout);
  assert.match(brief, /Ranked Evidence Clusters/);
  assert.match(brief, /Big news/);
  assert.doesNotMatch(brief, /noise before/);
  assert.match(stats, /Reddit: 12 items/);
});

test("extractBrief: empty when markers absent", () => {
  const { brief, stats } = extractBrief("just some text\nno markers here");
  assert.equal(brief, "");
  assert.equal(stats, "");
});

test("hasSignal: true for a cluster block, false for empty/thin", () => {
  assert.equal(hasSignal("## Ranked Evidence Clusters\n### 1. Thing (score 5)"), true);
  assert.equal(hasSignal(""), false);
  assert.equal(hasSignal("   "), false);
});

test("skillDir: resolves LAST30DAYS_SKILL_DIR when it contains the script", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l30-"));
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "scripts", "last30days.py"), "# stub");
  const prev = process.env.LAST30DAYS_SKILL_DIR;
  process.env.LAST30DAYS_SKILL_DIR = tmp;
  try {
    assert.equal(skillDir(), tmp);
  } finally {
    if (prev === undefined) delete process.env.LAST30DAYS_SKILL_DIR;
    else process.env.LAST30DAYS_SKILL_DIR = prev;
  }
});
