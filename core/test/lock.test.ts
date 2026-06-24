// Filesystem-level tests for tryAcquireLivePlanningMarker (#271).
//
// These tests write to /tmp (the actual marker path) to verify the atomic
// O_CREAT|O_EXCL semantics and stale-marker reclamation. No network, git, or
// subprocess calls.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  tryAcquireLivePlanningMarker,
  clearLivePlanningMarker,
  livePlanningMarkerPath,
} from "../scripts/lock.ts";

const REPO = "test-owner/tryacquire-test";
const ISSUE = 9999;

function markerPath(): string {
  return livePlanningMarkerPath(REPO, ISSUE);
}

function cleanupPath(): string {
  return markerPath() + ".cleanup";
}

afterEach(() => {
  for (const p of [markerPath(), cleanupPath()]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Happy path: marker absent → claim succeeds
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: absent marker → returns true and writes PID", () => {
  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, true, "should acquire when marker is absent");
  const written = fs.readFileSync(markerPath(), "utf8").trim();
  assert.equal(written, String(process.pid), "marker should contain current PID");
});

// ---------------------------------------------------------------------------
// Marker held by live process → returns false
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: live marker (current PID) → returns false", () => {
  // Write the current process's PID — it is provably alive.
  fs.writeFileSync(markerPath(), String(process.pid));
  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, false, "should not acquire when a live process holds the marker");
});

// ---------------------------------------------------------------------------
// Stale marker (invalid PID) → reclaimed, returns true
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: stale marker (invalid PID 0) → reclaimed, returns true", () => {
  // PID 0 is never a valid process PID; isLivePlanningActive treats it as dead.
  fs.writeFileSync(markerPath(), "0");
  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, true, "should reclaim a stale marker");
  const written = fs.readFileSync(markerPath(), "utf8").trim();
  assert.equal(written, String(process.pid), "marker should be overwritten with current PID");
});

// ---------------------------------------------------------------------------
// Stale cleanup lock (invalid PID) → reclaimed so main marker can be reclaimed
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: stale cleanup lock + stale marker → reclaims both, returns true", () => {
  // Stale main marker
  fs.writeFileSync(markerPath(), "0");
  // Stale cleanup lock (invalid PID)
  fs.writeFileSync(cleanupPath(), "0");

  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, true, "should reclaim stale cleanup lock and stale marker");
  const written = fs.readFileSync(markerPath(), "utf8").trim();
  assert.equal(written, String(process.pid), "marker should contain current PID after reclaim");
  assert.equal(fs.existsSync(cleanupPath()), false, "cleanup lock should be removed after reclaim");
});

// ---------------------------------------------------------------------------
// Live cleanup lock → returns false (another process is reclaiming)
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: live cleanup lock → returns false", () => {
  // Stale main marker
  fs.writeFileSync(markerPath(), "0");
  // Cleanup lock held by a live process (current PID)
  fs.writeFileSync(cleanupPath(), String(process.pid));

  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, false, "should wait when another process holds the cleanup lock");
});

// ---------------------------------------------------------------------------
// Atomic publication: marker is never visible as empty (#271 pre-merge finding)
//
// tryExclCreate uses writeFile-to-temp + hardlink so that any process that
// observes the marker path (via EEXIST) always reads the full PID content.
// No concurrent reader can see an empty/unparseable marker and treat it as
// stale, then unlink the just-acquired file.
// ---------------------------------------------------------------------------

test("tryAcquireLivePlanningMarker: marker file always has valid PID content when visible", () => {
  // Acquire the marker, then immediately read back the content. There must be
  // no window where the file exists but the PID is absent or unparseable.
  const result = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(result, true, "should acquire when marker is absent");
  const content = fs.readFileSync(markerPath(), "utf8").trim();
  const pid = Number.parseInt(content, 10);
  assert.ok(Number.isFinite(pid) && pid > 0, `marker must contain a valid PID immediately, got: '${content}'`);
  assert.equal(pid, process.pid, "marker PID should match current process");
});

test("tryAcquireLivePlanningMarker: second acquire attempt on live marker returns false", () => {
  // First acquire
  const first = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(first, true, "first acquire should succeed");
  // Second acquire while first is live (current PID is alive)
  const second = tryAcquireLivePlanningMarker(REPO, ISSUE);
  assert.equal(second, false, "second acquire with live marker must return false");
  // Marker still held by first caller (PID unchanged)
  const content = fs.readFileSync(markerPath(), "utf8").trim();
  assert.equal(content, String(process.pid), "marker PID must not be overwritten by losing caller");
});

// ---------------------------------------------------------------------------
// clearLivePlanningMarker is a no-op when marker is absent
// ---------------------------------------------------------------------------

test("clearLivePlanningMarker: no-op when marker is absent", () => {
  assert.doesNotThrow(() => clearLivePlanningMarker(REPO, ISSUE));
});
