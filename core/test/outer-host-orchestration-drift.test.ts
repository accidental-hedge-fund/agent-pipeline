// Drift guards: shared orchestration must consume outer-host capabilities
// without host-name lifecycle branching (#784), and must retain reattach /
// cancelled-wait-is-not-terminal language.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  requiresReattachAfterCancelledWait,
  resolveMaterialNotifySurface,
  selectLifecycleSteps,
  _resetOuterHostRegistryForTests,
  ensureBuiltinOuterHostsRegistered,
  allOuterHosts,
  resolveOuterHost,
} from "../scripts/outer-hosts/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const SHARED_ORCH_SOURCES = [
  "core/scripts/outer-hosts/orchestration.ts",
  "core/scripts/outer-hosts/index.ts",
  "core/scripts/discovery.ts",
];

const HOST_SKILLS = [
  "hosts/claude/SKILL.md",
  "hosts/codex/SKILL.md",
  "hosts/grok/SKILL.md",
  "hosts/opencode/SKILL.md",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

test("shared orchestration modules have no host-name lifecycle switch as extension path", () => {
  // Ban patterns that re-encode lifecycle dispatch as host id equality.
  const banned = [
    /if\s*\(\s*host\s*===\s*["']claude["']\s*\)/,
    /if\s*\(\s*hostId\s*===\s*["']claude["']\s*\)/,
    /host\s*===\s*["']codex["'].*PushNotification/,
    /switch\s*\(\s*host\s*\)/,
  ];
  for (const rel of SHARED_ORCH_SOURCES) {
    const src = read(rel);
    for (const re of banned) {
      assert.ok(
        !re.test(src),
        `${rel} must not contain host-name lifecycle branch matching ${re}`,
      );
    }
  }
});

test("capability-driven notify resolution does not require host-name table", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  const claude = resolveOuterHost("claude")!;
  const codex = resolveOuterHost("codex")!;
  const grok = resolveOuterHost("grok")!;
  // Surfaces come from mapping fields, not if (id === …).
  assert.equal(resolveMaterialNotifySurface(claude), "claude_monitor_push");
  assert.equal(resolveMaterialNotifySurface(codex), "codex_chat_status");
  assert.equal(resolveMaterialNotifySurface(grok), "grok_monitor_lines");
  for (const host of allOuterHosts()) {
    const steps = selectLifecycleSteps(host);
    assert.ok(steps.some((s) => s.id === "material_progress_notify"));
    assert.ok(steps.some((s) => s.id === "reattach_after_cancel"));
  }
});

test("host skills retain reattach and cancelled-wait-is-not-terminal language", () => {
  for (const rel of HOST_SKILLS) {
    const src = read(rel);
    assert.match(
      src,
      /cancelled|Re-arm|re-attach|reattach/i,
      `${rel} must document reattach after cancelled wait`,
    );
    assert.match(
      src,
      /not\s*(?:\*\*)?\s*a\s*(?:\*\*)?\s*terminal|is not a terminal|never.*terminal|non-terminal|must \*\*not\*\* be treated as/i,
      `${rel} must say cancelled wait is not terminal`,
    );
  }
});

test("host skills document outer-host capability / notify map without hard-requiring Claude tools for all hosts", () => {
  const codex = read("hosts/codex/SKILL.md");
  assert.match(codex, /Host notify map|outer-host|material.?progress/i);
  assert.ok(
    !/\bmust call `?PushNotification`|\bhard-require[s]? `?PushNotification`/i.test(codex),
    "Codex skill must not hard-require PushNotification",
  );
  // Shared contract reference for #784.
  const claude = read("hosts/claude/SKILL.md");
  assert.match(
    claude,
    /outer-host|Outer-host|material_progress_notify|lifecycle capability/i,
  );
});

test("requiresReattachAfterCancelledWait true for all complete built-ins", () => {
  _resetOuterHostRegistryForTests();
  ensureBuiltinOuterHostsRegistered(repoRoot);
  for (const host of allOuterHosts()) {
    assert.equal(requiresReattachAfterCancelledWait(host), true, host.id);
  }
});
