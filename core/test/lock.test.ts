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
  setLivePlanningMarker,
  clearLivePlanningMarker,
  livePlanningMarkerPath,
  PipelineLock,
  issueRunLockPath,
  domainLockPath,
  withLock,
  isIssueRunLockHeldByParent,
  ISSUE_RUN_LOCK_HELD_ENV,
  issueRunLockHeldToken,
  formatProcessIdentityMarker,
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
// setLivePlanningMarker is atomic (no empty-file window)
// ---------------------------------------------------------------------------

test("setLivePlanningMarker: marker always has valid PID content after call", () => {
  setLivePlanningMarker(REPO, ISSUE);
  const content = fs.readFileSync(markerPath(), "utf8").trim();
  const pid = Number.parseInt(content, 10);
  assert.ok(Number.isFinite(pid) && pid > 0, `marker must have valid PID after set, got: '${content}'`);
  assert.equal(pid, process.pid);
});

test("setLivePlanningMarker: overwrites existing marker atomically", () => {
  // Simulate a prior PID in the marker
  fs.writeFileSync(markerPath(), "12345");
  setLivePlanningMarker(REPO, ISSUE);
  const content = fs.readFileSync(markerPath(), "utf8").trim();
  assert.equal(content, String(process.pid), "setLivePlanningMarker must overwrite with current PID");
});

// ---------------------------------------------------------------------------
// clearLivePlanningMarker is a no-op when marker is absent
// ---------------------------------------------------------------------------

test("clearLivePlanningMarker: no-op when marker is absent", () => {
  assert.doesNotThrow(() => clearLivePlanningMarker(REPO, ISSUE));
});

// ---------------------------------------------------------------------------
// Issue-run lock API (#634) — domain+issue identity, dual-entry, non-collision
// ---------------------------------------------------------------------------

function uniqueDomain(label: string): string {
  return `t634-${label}-${process.pid}-${Date.now().toString(36)}`;
}

function cleanupLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

test("issueRunLockPath: encodes domain and issue, never issue-only", () => {
  const a = issueRunLockPath("repo-a", 42);
  const b = issueRunLockPath("repo-b", 42);
  assert.equal(a, "/tmp/pipeline-repo-a-42.lock");
  assert.equal(b, "/tmp/pipeline-repo-b-42.lock");
  assert.notEqual(a, b);
  assert.ok(!a.endsWith("/42.lock") || a.includes("repo-a"));
  // Prove issue-only construction would collide — the shared helper must not.
  const issueOnly = "/tmp/pipeline-42.lock";
  assert.notEqual(a, issueOnly);
  assert.notEqual(b, issueOnly);
});

test("issueRunLockPath: rejects empty domain / non-positive issue", () => {
  assert.throws(() => issueRunLockPath("", 1), /domain/);
  assert.throws(() => issueRunLockPath("d", 0), /issueNumber/);
  assert.throws(() => issueRunLockPath("d", -1), /issueNumber/);
});

test("domainLockPath: legacy domain-wide path omits issue", () => {
  assert.equal(domainLockPath("myrepo"), "/tmp/pipeline-myrepo.lock");
});

test("#634 cross-domain non-collision: same issue number under two domains can both hold", () => {
  const dA = uniqueDomain("a");
  const dB = uniqueDomain("b");
  const lockA = new PipelineLock({ domain: dA, issueNumber: 42 });
  const lockB = new PipelineLock({ domain: dB, issueNumber: 42 });
  try {
    assert.equal(lockA.acquire(), true, "repo-a #42 should acquire");
    assert.equal(lockB.acquire(), true, "repo-b #42 must not collide with repo-a");
    assert.notEqual(lockA.path, lockB.path);
    // Issue-only path would be a single file — both holds prove we are not that.
    assert.ok(fs.existsSync(lockA.path));
    assert.ok(fs.existsSync(lockB.path));
  } finally {
    lockA.release();
    lockB.release();
    cleanupLock(lockA.path);
    cleanupLock(lockB.path);
  }
});

test("#634 same domain+issue is exclusive (second acquire rejected)", () => {
  const d = uniqueDomain("same");
  const first = new PipelineLock({ domain: d, issueNumber: 10 });
  const second = new PipelineLock({ domain: d, issueNumber: 10 });
  try {
    assert.equal(first.acquire(), true);
    assert.equal(second.acquire(), false, "live holder must block second exclusive acquire");
  } finally {
    first.release();
    cleanupLock(first.path);
  }
});

test("#634 different issues under one domain remain concurrent", () => {
  const d = uniqueDomain("diff");
  const lock10 = new PipelineLock({ domain: d, issueNumber: 10 });
  const lock11 = new PipelineLock({ domain: d, issueNumber: 11 });
  try {
    assert.equal(lock10.acquire(), true);
    assert.equal(lock11.acquire(), true, "different issues must not serialize");
  } finally {
    lock10.release();
    lock11.release();
    cleanupLock(lock10.path);
    cleanupLock(lock11.path);
  }
});

test("#634 dual-entry: advance holder blocks detach-style acquire for same key", async () => {
  const d = uniqueDomain("adv");
  const advance = new PipelineLock({ domain: d, issueNumber: 99 });
  try {
    assert.equal(advance.acquire(), true);
    const detach = new PipelineLock({ domain: d, issueNumber: 99 });
    assert.equal(detach.acquire(), false, "detach must see advance holder");
    await assert.rejects(
      () => detach.acquireWithTimeout(50),
      /already running/,
    );
  } finally {
    advance.release();
    cleanupLock(advance.path);
  }
});

test("#634 dual-entry: detach holder blocks withLock (foreground advance) for same key", async () => {
  const d = uniqueDomain("det");
  const detach = new PipelineLock({ domain: d, issueNumber: 88 });
  try {
    assert.equal(detach.acquire(), true);
    await assert.rejects(
      () => withLock(d, async () => "should-not-run", 88),
      /Pipeline lock held/,
    );
  } finally {
    detach.release();
    cleanupLock(detach.path);
  }
});

test("#634 withLock skips re-acquire when parent wrapper holds issue-run lock", async () => {
  const d = uniqueDomain("nest");
  const parent = new PipelineLock({ domain: d, issueNumber: 55 });
  const prev = process.env[ISSUE_RUN_LOCK_HELD_ENV];
  try {
    assert.equal(parent.acquire(), true);
    process.env[ISSUE_RUN_LOCK_HELD_ENV] = issueRunLockHeldToken(d, 55);
    assert.equal(isIssueRunLockHeldByParent(d, 55), true);
    const result = await withLock(d, async () => "nested-ok", 55);
    assert.equal(result, "nested-ok");
    // Parent still holds the file
    assert.ok(fs.existsSync(parent.path));
  } finally {
    if (prev === undefined) delete process.env[ISSUE_RUN_LOCK_HELD_ENV];
    else process.env[ISSUE_RUN_LOCK_HELD_ENV] = prev;
    parent.release();
    cleanupLock(parent.path);
  }
});

test("#634 issue-run lock marker prefers pid+starttime when available", () => {
  const d = uniqueDomain("mark");
  const lock = new PipelineLock({
    domain: d,
    issueNumber: 1,
    formatMarker: (pid) => formatProcessIdentityMarker(pid, () => "99999"),
  });
  try {
    assert.equal(lock.acquire(), true);
    const body = fs.readFileSync(lock.path, "utf8").trim();
    assert.equal(body, `${process.pid} 99999`);
  } finally {
    lock.release();
    cleanupLock(lock.path);
  }
});

test("#634 domain-wide lock (no issue) still uses bare path", () => {
  const d = uniqueDomain("wide");
  const lock = new PipelineLock({ domain: d });
  try {
    assert.equal(lock.path, domainLockPath(d));
    assert.equal(lock.acquire(), true);
    const body = fs.readFileSync(lock.path, "utf8").trim();
    assert.equal(body, String(process.pid), "domain-wide marker stays bare PID");
  } finally {
    lock.release();
    cleanupLock(lock.path);
  }
});
