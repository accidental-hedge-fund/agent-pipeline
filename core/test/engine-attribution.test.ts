// #763: discovery-channel vocabulary, commit SHA resolution, marker round-trip,
// inheritance, and sanitization survival.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_FILE_DISCOVERY_CHANNEL,
  DEFAULT_LIVE_RUN_CHANNEL,
  DISCOVERY_CHANNELS,
  buildEventAttributionFields,
  formatAttributionMarkers,
  formatDiscoveryChannelMarker,
  formatEngineMarker,
  isDiscoveryChannel,
  normalizeDiscoveryChannel,
  parseDiscoveryChannelMarker,
  parseDiscoveryChannelLoose,
  parseEngineMarker,
  resolveEngineCommitSha,
  resolveEventAttribution,
  runLevelDiscoveryChannel,
  snapshotEngineStamp,
} from "../scripts/engine-attribution.ts";
import { redactSecrets, sanitize } from "../scripts/artifact-sanitize.ts";

test("DiscoveryChannel closed set has exactly four members", () => {
  assert.deepEqual([...DISCOVERY_CHANNELS].sort(), [
    "live-run",
    "manual",
    "papercut-autofile",
    "review-batch",
  ].sort());
  assert.equal(DISCOVERY_CHANNELS.length, 4);
  for (const ch of DISCOVERY_CHANNELS) {
    assert.equal(isDiscoveryChannel(ch), true);
  }
  assert.equal(isDiscoveryChannel("batch"), false);
  assert.equal(isDiscoveryChannel("papercut"), false);
  assert.equal(normalizeDiscoveryChannel("live-run"), "live-run");
  assert.equal(normalizeDiscoveryChannel("nope"), null);
  assert.equal(parseDiscoveryChannelLoose("garbage"), null);
  assert.equal(DEFAULT_LIVE_RUN_CHANNEL, "live-run");
  assert.equal(AUTO_FILE_DISCOVERY_CHANNEL, "papercut-autofile");
});

test("resolveEngineCommitSha never invents a SHA and uses injected deps", () => {
  let calls = 0;
  const sha = resolveEngineCommitSha("/opt/core", {
    isDirectory: () => true,
    revParseHead: (cwd) => {
      calls++;
      if (cwd === "/opt/core") return null;
      if (cwd === "/opt") return "abc123def4567890abc123def4567890abc123de";
      return null;
    },
  });
  assert.equal(sha, "abc123def4567890abc123def4567890abc123de");
  assert.ok(calls >= 1);

  const missing = resolveEngineCommitSha("/not-a-dir", {
    isDirectory: () => false,
    revParseHead: () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(missing, null);

  const fail = resolveEngineCommitSha("/opt/core", {
    isDirectory: () => true,
    revParseHead: () => null,
  });
  assert.equal(fail, null);
});

test("engine and discovery markers round-trip", () => {
  const engine = formatEngineMarker({ version: "1.31.0", commit_sha: "deadbeef" });
  assert.equal(engine, "<!-- pipeline:engine version=1.31.0 sha=deadbeef -->");
  assert.deepEqual(parseEngineMarker(engine), { version: "1.31.0", commit_sha: "deadbeef" });

  const ch = formatDiscoveryChannelMarker("papercut-autofile");
  assert.equal(ch, "<!-- pipeline:discovery-channel papercut-autofile -->");
  assert.equal(parseDiscoveryChannelMarker(ch), "papercut-autofile");

  const block = formatAttributionMarkers({
    version: "1.31.0",
    commit_sha: null,
    discovery_channel: "live-run",
  });
  assert.match(block, /sha=unknown/);
  assert.match(block, /discovery-channel live-run/);
  assert.equal(parseEngineMarker(block)?.commit_sha, "unknown");
});

test("attribution markers survive sanitization denylist on adjacent free text", () => {
  const markers = formatAttributionMarkers({
    version: "1.0.0",
    commit_sha: "abc1234",
    discovery_channel: "papercut-autofile",
  });
  const body = [
    "<!-- pipeline:papercut-auto-filed -->",
    markers,
    "",
    "Evidence: Authorization: Bearer supersecrettokenvalue123",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ].join("\n");
  const cleaned = sanitize(redactSecrets(body));
  // Markers are HTML comments without secret-shaped spans — must survive.
  assert.match(cleaned, /pipeline:engine version=1\.0\.0 sha=abc1234/);
  assert.match(cleaned, /pipeline:discovery-channel papercut-autofile/);
  assert.match(cleaned, /pipeline:papercut-auto-filed/);
});

test("resolveEventAttribution inherits from run.json and does not invent live-run without default", () => {
  const inherited = resolveEventAttribution(
    { type: "human_intervention", kind: "human-risk-override" },
    { version: "1.30.0", commit_sha: "aaa111" },
    DEFAULT_LIVE_RUN_CHANNEL,
  );
  assert.equal(inherited.engine_version, "1.30.0");
  assert.equal(inherited.engine_commit_sha, "aaa111");
  assert.equal(inherited.discovery_channel, "live-run");

  const inline = resolveEventAttribution(
    {
      engine_version: "9.9.9",
      engine_commit_sha: "bbb222",
      discovery_channel: "review-batch",
    },
    { version: "1.0.0", commit_sha: "ignored" },
    DEFAULT_LIVE_RUN_CHANNEL,
  );
  assert.equal(inline.engine_version, "9.9.9");
  assert.equal(inline.discovery_channel, "review-batch");

  const historical = resolveEventAttribution(
    { type: "human_intervention" },
    null,
    null,
  );
  assert.equal(historical.discovery_channel, null);
  assert.equal(historical.missing_attribution, true);

  // Default runDefaultChannel is null — engine identity alone does not invent live-run.
  const engineOnly = resolveEventAttribution(
    { type: "human_intervention" },
    { version: "1.28.0", commit_sha: "ccc333" },
  );
  assert.equal(engineOnly.engine_version, "1.28.0");
  assert.equal(engineOnly.discovery_channel, null);
  assert.equal(engineOnly.missing_attribution, false); // version present
});

test("runLevelDiscoveryChannel requires explicit stamp; engine.version is not a channel", () => {
  assert.equal(runLevelDiscoveryChannel(null), null);
  assert.equal(runLevelDiscoveryChannel({ engine: { version: "1.0.0" } }), null);
  assert.equal(
    runLevelDiscoveryChannel({ discovery_channel: "live-run", engine: { version: "1.0.0" } }),
    "live-run",
  );
  assert.equal(runLevelDiscoveryChannel({ discovery_channel: "garbage" }), null);
});

test("buildEventAttributionFields and snapshotEngineStamp are explicit on unresolved", () => {
  const fields = buildEventAttributionFields({
    version: "1.2.3",
    commit_sha: null,
    discovery_channel: "live-run",
  });
  assert.equal(fields.engine_version, "1.2.3");
  assert.equal(fields.engine_commit_sha, null);
  assert.equal(fields.discovery_channel, "live-run");

  const stamp = snapshotEngineStamp({ version: null, commit_sha: null });
  assert.equal(stamp.version, "unknown");
  assert.equal(stamp.commit_sha, "unknown");
});
