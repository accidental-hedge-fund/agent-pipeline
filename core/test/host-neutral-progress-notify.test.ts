// Drift guards for host-neutral progress notify (#742).
// Reads checked-in host skill packaging + shared material-filter constants.
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADVANCE_MATERIAL_KINDS,
  LOOP_MATERIAL_KINDS,
} from "../scripts/material-filter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const CLAUDE_SKILL = path.join(repoRoot, "hosts/claude/SKILL.md");
const CODEX_SKILL = path.join(repoRoot, "hosts/codex/SKILL.md");
const MATERIAL_FILTER_SRC = path.join(
  repoRoot,
  "core/scripts/material-filter.ts",
);
const MATERIAL_FILTER_LAUNCHER = path.join(
  repoRoot,
  "hosts/_shared/material-filter.mjs",
);

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Section from a heading through the next same-or-higher-level heading. */
function sectionFrom(source: string, headingRe: RegExp): string {
  const start = source.search(headingRe);
  assert.ok(start !== -1, `expected heading ${headingRe}`);
  const from = source.slice(start);
  // Next #### under the same parent, or ### boundary.
  const next = from.slice(1).search(/\n#{2,4} /);
  return next === -1 ? from : from.slice(0, next + 1);
}

test("shared material filter module is present", () => {
  assert.ok(fs.existsSync(MATERIAL_FILTER_SRC), "material-filter.ts must exist");
  assert.ok(
    fs.existsSync(MATERIAL_FILTER_LAUNCHER),
    "installed-path launcher hosts/_shared/material-filter.mjs must exist",
  );
});

test("Claude host documents material notify map entry (Monitor + PushNotification)", () => {
  const src = read(CLAUDE_SKILL);
  assert.match(src, /Host notify map/i, "Claude skill must have host notify map");
  assert.match(src, /PushNotification/, "Claude map entry may name PushNotification");
  assert.match(
    src,
    /scripts\/material-filter\.mjs/,
    "Claude skill must name the installed material-filter.mjs path",
  );
  assert.match(
    src,
    /must notify via the host map/i,
    "shared notify step must be host-map based",
  );
});

test("Codex host notify map uses chat/status and never requires PushNotification", () => {
  const src = read(CODEX_SKILL);
  assert.match(src, /Host notify map/i, "Codex skill must have host notify map");
  assert.match(
    src,
    /chat\/status|concise chat/i,
    "Codex map must name chat/status surface",
  );
  assert.match(
    src,
    /scripts\/material-filter\.mjs/,
    "Codex skill must name the installed material-filter.mjs path",
  );
  // Codex must not list PushNotification as a required tool.
  // (Allow disclaimers like "never requires Claude PushNotification".)
  assert.ok(
    !/\bmust call `?PushNotification`|\bhard-require[s]? `?PushNotification`|\brequired tool.*PushNotification/i.test(
      src,
    ),
    "Codex packaging must not hard-require PushNotification",
  );
  assert.match(
    src,
    /never requires Claude `PushNotification`|never Claude `PushNotification`|never require Claude `PushNotification`/i,
    "Codex must explicitly disclaim Claude PushNotification",
  );
});

test("Grok-consumed path (Claude overlay) documents monitor substitute without PushNotification hard-require", () => {
  // Until first-class --host grok (#731), Grok loads the Claude skill path.
  const src = read(CLAUDE_SKILL);
  assert.match(src, /Grok substitute/i, "Claude overlay must include Grok substitute");
  assert.match(
    src,
    /host `monitor`|Host `monitor`/i,
    "Grok substitute must name host monitor",
  );
  assert.match(
    src,
    /Never\*\* require Claude `PushNotification`|Never`? require Claude `PushNotification`|do \*\*not\*\* call\s+`PushNotification` on Grok|Do \*\*not\*\* call\s+`PushNotification` on Grok/i,
    "Grok path must not hard-require PushNotification",
  );
  assert.match(src, /material-filter/, "Grok path must reference material filter");
});

test("Claude and Codex share required advance material kinds", () => {
  const claude = read(CLAUDE_SKILL);
  const codex = read(CODEX_SKILL);
  for (const kind of ADVANCE_MATERIAL_KINDS) {
    assert.ok(
      claude.includes(kind),
      `Claude skill missing advance material kind ${kind}`,
    );
    assert.ok(
      codex.includes(kind),
      `Codex skill missing advance material kind ${kind}`,
    );
  }
});

test("Claude and Codex share required loop material kinds", () => {
  const claude = read(CLAUDE_SKILL);
  const codex = read(CODEX_SKILL);
  for (const kind of LOOP_MATERIAL_KINDS) {
    assert.ok(
      claude.includes(kind),
      `Claude skill missing loop material kind ${kind}`,
    );
    assert.ok(
      codex.includes(kind),
      `Codex skill missing loop material kind ${kind}`,
    );
  }
});

test("§4 / §4b document re-arm until terminal and cross-link #725 and #611", () => {
  for (const { label, p } of [
    { label: "claude", p: CLAUDE_SKILL },
    { label: "codex", p: CODEX_SKILL },
  ]) {
    const src = read(p);
    assert.match(src, /#725/, `${label}: must cross-link #725 (re-attach)`);
    assert.match(src, /#611/, `${label}: must cross-link #611 (dual-follow density)`);
    assert.match(
      src,
      /[Rr]e-arm/,
      `${label}: must document re-arm after follow interrupt`,
    );
    assert.match(
      src,
      /does \*\*not\*\* replace #611|#742\) does \*\*not\*\* replace/,
      `${label}: must not claim #742 replaces #611/#725`,
    );
  }
});

test("dual-follow guidance prefers material filter on both streams", () => {
  for (const { label, p } of [
    { label: "claude", p: CLAUDE_SKILL },
    { label: "codex", p: CODEX_SKILL },
  ]) {
    const src = read(p);
    const dual = sectionFrom(
      src,
      /#### d\.\s+Dual-follow:/i,
    );
    assert.match(
      dual,
      /material-filter|material filter/i,
      `${label}: dual-follow must name material filter`,
    );
    assert.match(
      dual,
      /both.*streams|material filter on \*\*both\*\*|both\*\* streams/i,
      `${label}: dual-follow must apply material filter to both streams`,
    );
  }
});

test("guard bites: Grok path hard-requiring PushNotification without monitor fails", () => {
  // Synthetic bad packaging that would ship on a Grok-consumed path.
  const bad = `
#### Host notify map
On Grok you must call PushNotification for every stage bubble.
There is no monitor substitute.
`;
  const hasPushHardRequire =
    /must call `?PushNotification`|must call PushNotification/i.test(bad);
  const hasGrokMonitor = /host `monitor`|Host `monitor`/i.test(bad);
  assert.ok(hasPushHardRequire && !hasGrokMonitor, "precondition: synthetic is bad");
  // The real Claude skill must pass the inverse (monitor present + no Grok hard-require).
  const src = read(CLAUDE_SKILL);
  assert.ok(
    /Grok substitute/i.test(src) && /monitor/i.test(src),
    "live Claude skill must keep Grok monitor substitute",
  );
});

test("guard bites: material kind list drift from shared constant fails", () => {
  const src = read(CLAUDE_SKILL);
  // Prove the assertion would fail if a required kind were dropped from skill text.
  assert.throws(
    () => {
      for (const kind of [...ADVANCE_MATERIAL_KINDS, "not_a_real_kind_xyz"]) {
        assert.ok(src.includes(kind), `missing ${kind}`);
      }
    },
    (err: unknown) => err instanceof assert.AssertionError,
  );
});
