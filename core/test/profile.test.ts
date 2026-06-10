// Profile loader tests (#93): the repo ships exactly two profiles (claude,
// codex), both prompt-harness; unknown names (including the removed openclaw)
// and companion review modes are rejected at load time.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProfile } from "../scripts/profile.ts";

test("loadProfile: claude profile loads with profile-relative harness roles", () => {
  const profile = loadProfile("claude");
  assert.equal(profile.name, "claude");
  assert.equal(profile.invocation, "/pipeline");
  assert.deepEqual(profile.harnesses, { implementer: "claude", reviewer: "codex" });
  assert.equal(profile.reviewMode, "prompt-harness");
});

test("loadProfile: codex profile loads with inverted harness roles", () => {
  const profile = loadProfile("codex");
  assert.equal(profile.name, "codex");
  assert.deepEqual(profile.harnesses, { implementer: "codex", reviewer: "claude" });
  assert.equal(profile.reviewMode, "prompt-harness");
});

test("loadProfile: openclaw was removed — unknown profile throws", () => {
  assert.throws(() => loadProfile("openclaw"), /Unknown pipeline profile 'openclaw'/);
});

test("loadProfile: only claude and codex profiles ship", () => {
  const profilesDir = path.resolve(import.meta.dirname, "..", "profiles");
  const shipped = fs.readdirSync(profilesDir).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(shipped, ["claude.json", "codex.json"]);
});

test("loadProfile: a companion reviewMode is rejected at load time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-profile-test-"));
  fs.writeFileSync(
    path.join(dir, "legacy.json"),
    JSON.stringify({
      name: "legacy",
      displayName: "Legacy",
      invocation: "/pipeline",
      harnesses: { implementer: "claude", reviewer: "codex" },
      reviewMode: "codex-companion",
      markerFooter: "*x*",
      implementationReadyMessage: "ready",
      conventionsDefault: "CLAUDE.md",
    }),
  );
  try {
    assert.throws(
      () => loadProfile("legacy", dir),
      /reviewMode 'codex-companion' is not supported \(only "prompt-harness"\)/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
