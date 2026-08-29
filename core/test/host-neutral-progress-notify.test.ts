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
  TRAIN_MATERIAL_KINDS,
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
  assert.match(src, /\| claude \| claude_monitor_push \| Monitor, PushNotification \|/);
  assert.match(src, /scripts\/material-filter\.mjs/);
  assert.match(src, /Notify only material events through the active host row/);
});

test("Codex host notify map uses chat/status and never requires PushNotification", () => {
  const src = read(CODEX_SKILL);
  assert.match(src, /Host notify map/i);
  assert.match(src, /\| codex \| codex_chat_status \| chat, status \|/);
  assert.match(src, /scripts\/material-filter\.mjs/);
  assert.ok(
    !/\bmust call `?PushNotification`|\bhard-require[s]? `?PushNotification`/i.test(src),
    "Codex packaging must not hard-require PushNotification",
  );
  assert.match(src, /does not hard-require\nanother host's tools/);
});

test("Grok-consumed path documents monitor without PushNotification hard-require", () => {
  const src = read(CLAUDE_SKILL);
  assert.match(src, /\| grok \| grok_monitor_lines \| monitor \|/);
  assert.doesNotMatch(src, /must call PushNotification on Grok/i);
  assert.match(src, /material-filter/);
});

test("durable docs list required advance, loop, and train material kinds", () => {
  const concepts = read(path.join(repoRoot, "docs/concepts.md"));
  for (const kind of ADVANCE_MATERIAL_KINDS) {
    assert.ok(concepts.includes(kind), `concepts missing advance kind ${kind}`);
  }
  for (const kind of TRAIN_MATERIAL_KINDS) {
    assert.ok(concepts.includes(kind), `concepts missing train kind ${kind}`);
  }
  for (const kind of LOOP_MATERIAL_KINDS) {
    assert.ok(concepts.includes(kind), `concepts missing loop kind ${kind}`);
  }
});

test("durable docs re-arm until terminal and cross-link #725 and #611", () => {
  const concepts = read(path.join(repoRoot, "docs/concepts.md"));
  assert.match(concepts, /#725/);
  assert.match(concepts, /#611/);
  assert.match(concepts, /Reattach an interrupted follow/i);
});

test("durable dual-follow guidance names material filter on both streams", () => {
  const concepts = read(path.join(repoRoot, "docs/concepts.md"));
  assert.match(concepts, /material filter/i);
  assert.match(concepts, /dual-follow that loop stream/i);
});

test("guard bites: Grok path hard-requiring PushNotification without monitor fails", () => {
  const bad = `
#### Host notify map
On Grok you must call PushNotification for every stage bubble.
There is no monitor substitute.
`;
  const hasPushHardRequire =
    /must call `?PushNotification`|must call PushNotification/i.test(bad);
  const hasGrokMonitor = /host `monitor`|Host `monitor`/i.test(bad);
  assert.ok(hasPushHardRequire && !hasGrokMonitor, "precondition: synthetic is bad");
  const src = read(CLAUDE_SKILL);
  assert.match(src, /\| grok \| grok_monitor_lines \| monitor \|/);
});

test("train skill follow uses logs plus material-filter, not stdout grep", () => {
  const concepts = read(path.join(repoRoot, "docs/concepts.md"));
  assert.match(concepts, /train_run_handoff/);
  assert.match(concepts, /logs <train-run-id> --events --follow/);
  assert.match(concepts, /material filter/);
  assert.match(concepts, /train_loop_linked/);
  assert.doesNotMatch(concepts, /tail -F \| grep/);
  for (const skill of [read(CLAUDE_SKILL), read(CODEX_SKILL)]) {
    assert.match(skill, /scripts\/material-filter\.mjs/);
    assert.doesNotMatch(skill, /tail -F \| grep/);
  }
});

test("guard bites: material kind list drift from shared constant fails", () => {
  const concepts = read(path.join(repoRoot, "docs/concepts.md"));
  assert.throws(
    () => {
      for (const kind of [...ADVANCE_MATERIAL_KINDS, "not_a_real_kind_xyz"]) {
        assert.ok(concepts.includes(kind), `missing ${kind}`);
      }
    },
    (err: unknown) => err instanceof assert.AssertionError,
  );
});
