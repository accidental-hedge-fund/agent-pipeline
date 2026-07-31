// #770 loop live-advance coexistence — pure probe/classifier unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ACTIVE_RUN_STORE_MAX_AGE_MS,
  isCoexistenceFailureEvidence,
  isConcurrentHolderEvidence,
  isNonFatalMidStageExit,
  isLockFileLive,
  isNonTerminalLinkageFresh,
  eventsTextIsTerminal,
  resolveLinkageTerminalState,
  findActiveRunStoreForIssue,
  findWrapperPidForIssue,
  livePidFromIdentityMarker,
  parseProcessIdentityText,
  probeLiveAdvance,
} from "../scripts/loop/live-advance.ts";
import { LOCK_ACQUIRED_FILE, formatProcessIdentityMarker } from "../scripts/detach.ts";
import { classifyDispatchOutcome } from "../scripts/pipeline.ts";
import { normalizeLoopOutcome } from "../scripts/loop-execution-contract.ts";

test("isCoexistenceFailureEvidence: lock / already-running / install-in-progress", () => {
  assert.equal(isCoexistenceFailureEvidence("pipeline: issue #675 is already running"), true);
  assert.equal(isCoexistenceFailureEvidence("Pipeline lock held by another process for #597"), true);
  assert.equal(isCoexistenceFailureEvidence("an install/update is in progress — starting now risks"), true);
  assert.equal(isCoexistenceFailureEvidence("TypeError: cannot read"), false);
  assert.equal(isCoexistenceFailureEvidence(null), false);
});

test("isNonFatalMidStageExit: only coexistence evidence, not bare skipped/waiting (#770 929fc0ac)", () => {
  const skippedOnly = [
    JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" }),
  ].join("\n");
  assert.equal(
    isNonFatalMidStageExit(skippedOnly, ["pipeline:pre-merge"]),
    false,
    "generic skipped mid-stage must not be coexistence",
  );
  const withLock = skippedOnly + "\n" + "pipeline: issue #675 is already running";
  assert.equal(
    isNonFatalMidStageExit(withLock, ["pipeline:pre-merge"]),
    true,
  );
});

test("classifyDispatchOutcome: lock evidence → coexistence_wait; bare skipped → failed (#770 929fc0ac)", () => {
  const skippedOnly = [
    JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" }),
  ].join("\n");
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:pre-merge"], state: "open" }, null, skippedOnly),
    "failed",
    "skipped/waiting alone must not mask a genuine crash as coexistence",
  );
  assert.equal(
    classifyDispatchOutcome(
      { labels: ["pipeline:pre-merge"], state: "open" },
      null,
      "pipeline: issue #675 is already running (.lock-failed)",
    ),
    "coexistence_wait",
  );
  assert.equal(normalizeLoopOutcome("coexistence_wait"), "coexistence_wait");
});

test("classifyDispatchOutcome: still maps plain open mid-stage without events to failed", () => {
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:review-1"], state: "open" }),
    "failed",
  );
});

test("eventsTextIsTerminal / resolveLinkageTerminalState", () => {
  assert.equal(eventsTextIsTerminal(null), false);
  assert.equal(
    eventsTextIsTerminal(JSON.stringify({ type: "stage_start", stage: "review" })),
    false,
  );
  assert.equal(
    eventsTextIsTerminal(
      [
        JSON.stringify({ type: "stage_start", stage: "review" }),
        JSON.stringify({ type: "run_complete", final_state: "review" }),
      ].join("\n"),
    ),
    true,
  );

  // Unresolvable without path/repo → null
  assert.equal(
    resolveLinkageTerminalState({ pipeline_run_id: "1-x" }),
    null,
  );

  // Injectable reader: non-terminal
  assert.equal(
    resolveLinkageTerminalState(
      { pipeline_run_id: "1-x", events: "/fake/events.jsonl" },
      { readText: () => JSON.stringify({ type: "stage_start", stage: "fix" }) },
    ),
    false,
  );
  // Injectable reader: terminal
  assert.equal(
    resolveLinkageTerminalState(
      { pipeline_run_id: "1-x", events: "/fake/events.jsonl" },
      { readText: () => JSON.stringify({ type: "run_complete" }) },
    ),
    true,
  );
});

test("probeLiveAdvance: lock file with live PID → live lock_held", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  fs.writeFileSync(lockPath, String(process.pid));
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    lockPathForTest: lockPath,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "lock_held");
    assert.equal(r.holder_pid, process.pid);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: dead PID lock → not live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  // PID 1 may be live on some systems; use a high unused pid unlikely to exist
  fs.writeFileSync(lockPath, "999999999");
  const held = isLockFileLive(lockPath);
  // If somehow live, skip assertion body
  if (!held.live) {
    const r = probeLiveAdvance({
      domain: "test",
      issueNumber: 770,
      lockPathForTest: lockPath,
    });
    assert.equal(r.live, false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: knownLinkage non-terminal + fresh → live loop_linkage (#770 dcfb0878)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-2026-01-01T00-00-00-000Z" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770"),
    resolveLinkageTerminal: () => false,
    isLinkageFresh: () => true,
  });
  assert.equal(r.live, true);
  if (r.live) assert.equal(r.evidence, "loop_linkage");
});

test("probeLiveAdvance: knownLinkage terminal → not live from linkage (#770 ce4794fb)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-2026-01-01T00-00-00-000Z" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-term"),
    resolveLinkageTerminal: () => true,
  });
  assert.equal(r.live, false, "terminal linked advance must not block re-admission");
});

test("probeLiveAdvance: unresolvable linkage alone is not live", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-missing" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-unres"),
    resolveLinkageTerminal: () => null,
  });
  assert.equal(r.live, false);
});

test("probeLiveAdvance: aged non-terminal linkage is not live (#770 12e4c0fd)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-crash-old" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-aged-link"),
    resolveLinkageTerminal: () => false,
    isLinkageFresh: () => false,
  });
  assert.equal(r.live, false, "stale crash linkage must not count as live forever");
});

test("probeLiveAdvance: ignored pipeline_run_id skips own linkage/store (#770 12e4c0fd)", () => {
  const ownId = "675-just-crashed";
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 675,
    knownLinkage: { pipeline_run_id: ownId },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-ignore"),
    resolveLinkageTerminal: () => false,
    isLinkageFresh: () => true,
    findActiveRunStore: () => ({ pipeline_run_id: ownId, events_path: "/tmp/e.jsonl" }),
    ignorePipelineRunIds: [ownId],
  });
  assert.equal(r.live, false, "failed attempt's own artifacts must not satisfy live probe alone");
});

test("isConcurrentHolderEvidence: only lock_held / wrapper_pid", () => {
  assert.equal(isConcurrentHolderEvidence("lock_held"), true);
  assert.equal(isConcurrentHolderEvidence("wrapper_pid"), true);
  assert.equal(isConcurrentHolderEvidence("loop_linkage"), false);
  assert.equal(isConcurrentHolderEvidence("active_run_store"), false);
  assert.equal(isConcurrentHolderEvidence(undefined), false);
});

test("probeLiveAdvance: active_run_store evidence (#770 dcfb0878)", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 675,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-store"),
    findActiveRunStore: (n) =>
      n === 675
        ? { pipeline_run_id: "675-active", events_path: "/tmp/e.jsonl" }
        : null,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "active_run_store");
    assert.equal(r.pipeline_run_id, "675-active");
  }
});

test("probeLiveAdvance: wrapper_pid evidence", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-wrap"),
    findWrapperPid: () => process.pid,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "wrapper_pid");
    assert.equal(r.holder_pid, process.pid);
  }
});

test("findActiveRunStoreForIssue: non-terminal run dir is active; terminal is not", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-repo-"));
  const runs = path.join(repo, ".agent-pipeline", "runs");
  const activeId = "42-2026-01-01T00-00-00-000Z";
  const doneId = "42-2026-01-02T00-00-00-000Z";
  fs.mkdirSync(path.join(runs, activeId), { recursive: true });
  fs.mkdirSync(path.join(runs, doneId), { recursive: true });
  fs.writeFileSync(
    path.join(runs, activeId, "events.jsonl"),
    JSON.stringify({ type: "stage_start", stage: "review", at: "t" }) + "\n",
  );
  fs.writeFileSync(
    path.join(runs, doneId, "events.jsonl"),
    [
      JSON.stringify({ type: "stage_start", stage: "review", at: "t" }),
      JSON.stringify({ type: "run_complete", final_state: "review", at: "t2" }),
    ].join("\n") + "\n",
  );
  // Newer doneId must not shadow; findActive skips terminal and finds active
  // (mtime: touch done after active so newest is terminal)
  const newer = Date.now();
  fs.utimesSync(path.join(runs, doneId), newer / 1000, newer / 1000);
  fs.utimesSync(path.join(runs, activeId), (newer - 10_000) / 1000, (newer - 10_000) / 1000);
  fs.utimesSync(path.join(runs, activeId, "events.jsonl"), (newer - 10_000) / 1000, (newer - 10_000) / 1000);

  const found = findActiveRunStoreForIssue(repo, 42, { nowMs: newer });
  assert.ok(found, "expected a non-terminal run");
  assert.equal(found!.pipeline_run_id, activeId);

  // Issue with only terminal runs → null
  assert.equal(findActiveRunStoreForIssue(repo, 99, { nowMs: newer }), null);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("findActiveRunStoreForIssue / default probe: stale non-terminal crash store is not live (#770 b48730b7)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-stale-"));
  const runs = path.join(repo, ".agent-pipeline", "runs");
  const crashId = "770-2026-01-01T00-00-00-000Z";
  fs.mkdirSync(path.join(runs, crashId), { recursive: true });
  const eventsPath = path.join(runs, crashId, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({ type: "stage_start", stage: "fix", at: "t" }) + "\n",
  );
  // Crash left non-terminal events hours ago — no live lock / wrapper.
  const now = Date.now();
  const old = now - ACTIVE_RUN_STORE_MAX_AGE_MS - 60_000;
  fs.utimesSync(path.join(runs, crashId), old / 1000, old / 1000);
  fs.utimesSync(eventsPath, old / 1000, old / 1000);

  assert.equal(
    findActiveRunStoreForIssue(repo, 770, { nowMs: now }),
    null,
    "stale crash store must not count as active",
  );

  // Default production path (repoDir only, no injectable findActiveRunStore):
  // must report not-live so genuine re-dispatch / defect classification remain possible.
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    repoDir: repo,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-stale"),
    nowMs: now,
  });
  assert.equal(r.live, false, "default probe must not treat stale crash store as live forever");

  // Aged non-terminal linkage (same crash store) must also not be live.
  const linked = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    repoDir: repo,
    knownLinkage: { pipeline_run_id: crashId, events: eventsPath },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-stale-link"),
    nowMs: now,
  });
  assert.equal(linked.live, false, "aged linked crash artifact must not be live");
  assert.equal(
    isNonTerminalLinkageFresh(
      { pipeline_run_id: crashId, events: eventsPath },
      { nowMs: now, statMtimeMs: () => old },
    ),
    false,
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test("default probe: fresh crashed linked advance ignored without concurrent holder (#770 12e4c0fd)", () => {
  // Production-shaped: fresh non-terminal events + knownLinkage, no lock/wrapper.
  // Pass-2 ignores the own run id so the crash artifact cannot force coexistence.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-fresh-crash-"));
  const runs = path.join(repo, ".agent-pipeline", "runs");
  const crashId = "770-fresh-crash";
  fs.mkdirSync(path.join(runs, crashId), { recursive: true });
  const eventsPath = path.join(runs, crashId, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({ type: "stage_start", stage: "fix", at: "t" }) + "\n",
  );
  const now = Date.now();
  fs.utimesSync(path.join(runs, crashId), now / 1000, now / 1000);
  fs.utimesSync(eventsPath, now / 1000, now / 1000);

  // Without ignore: fresh linkage still looks live (pre-dispatch attach path).
  const withoutIgnore = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    repoDir: repo,
    knownLinkage: { pipeline_run_id: crashId, events: eventsPath },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-fresh-crash"),
    nowMs: now,
  });
  assert.equal(withoutIgnore.live, true);
  if (withoutIgnore.live) assert.equal(withoutIgnore.evidence, "loop_linkage");

  // Pass-2 shape: ignore the failed attempt's own run id → not live without lock/wrapper.
  const pass2 = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    repoDir: repo,
    knownLinkage: { pipeline_run_id: crashId, events: eventsPath },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-fresh-crash2"),
    ignorePipelineRunIds: [crashId],
    nowMs: now,
  });
  assert.equal(
    pass2.live,
    false,
    "failed attempt's own fresh crash store must not satisfy Pass-2 coexistence alone",
  );
  assert.equal(isConcurrentHolderEvidence(pass2.live ? pass2.evidence : undefined), false);

  fs.rmSync(repo, { recursive: true, force: true });
});

test("findActiveRunStoreForIssue: fresh non-terminal store is still active within freshness bound", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-fresh-"));
  const runs = path.join(repo, ".agent-pipeline", "runs");
  const activeId = "770-fresh-run";
  fs.mkdirSync(path.join(runs, activeId), { recursive: true });
  const eventsPath = path.join(runs, activeId, "events.jsonl");
  fs.writeFileSync(
    eventsPath,
    JSON.stringify({ type: "stage_start", stage: "review", at: "t" }) + "\n",
  );
  const now = Date.now();
  fs.utimesSync(path.join(runs, activeId), now / 1000, now / 1000);
  fs.utimesSync(eventsPath, now / 1000, now / 1000);

  const found = findActiveRunStoreForIssue(repo, 770, { nowMs: now });
  assert.ok(found);
  assert.equal(found!.pipeline_run_id, activeId);

  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    repoDir: repo,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-fresh"),
  });
  assert.equal(r.live, true);
  if (r.live) assert.equal(r.evidence, "active_run_store");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("parseProcessIdentityText / livePidFromIdentityMarker: require starttime", () => {
  assert.deepEqual(parseProcessIdentityText("42 birth-A"), { pid: 42, starttime: "birth-A" });
  assert.deepEqual(
    parseProcessIdentityText("99 Wed Jul 31 12:00:00 2026"),
    { pid: 99, starttime: "Wed Jul 31 12:00:00 2026" },
  );
  assert.equal(parseProcessIdentityText("42"), null, "bare PID is not verifiable identity");
  assert.equal(parseProcessIdentityText(null), null);

  assert.equal(
    livePidFromIdentityMarker("42 birth-A", {
      isPidAlive: (p) => p === 42,
      getStartTime: (p) => (p === 42 ? "birth-A" : null),
    }),
    42,
  );
  assert.equal(
    livePidFromIdentityMarker("42 birth-A", {
      isPidAlive: (p) => p === 42,
      getStartTime: (p) => (p === 42 ? "birth-B" : null),
    }),
    null,
    "PID reuse (different starttime) must be non-live",
  );
  assert.equal(
    livePidFromIdentityMarker("42", {
      isPidAlive: () => true,
      getStartTime: () => "anything",
    }),
    null,
    "unsentinelled bare-PID marker must not count as live",
  );
});

test("findWrapperPidForIssue: live .lock-acquired without sentinel (#770 956d20df)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-wrap-"));
  const issue = 675;
  const runDir = path.join(home, ".pipeline", "runs", String(issue), "2026-07-31_run1");
  fs.mkdirSync(runDir, { recursive: true });
  const start = "start-live-1";
  fs.writeFileSync(
    path.join(runDir, LOCK_ACQUIRED_FILE),
    formatProcessIdentityMarker(process.pid, () => start),
  );

  const pid = findWrapperPidForIssue(issue, {
    homedir: home,
    isPidAlive: (p) => p === process.pid,
    getStartTime: (p) => (p === process.pid ? start : null),
  });
  assert.equal(pid, process.pid);

  // Completed detach (sentinel present) must not count.
  fs.writeFileSync(path.join(runDir, "sentinel.json"), JSON.stringify({ exitCode: 0 }));
  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: () => true,
      getStartTime: () => start,
    }),
    null,
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test("findWrapperPidForIssue: live detach issue lock", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-dlock-"));
  const issue = 42;
  const issueDir = path.join(home, ".pipeline", "runs", String(issue));
  fs.mkdirSync(issueDir, { recursive: true });
  const start = "start-lock-1";
  fs.writeFileSync(path.join(issueDir, ".lock"), formatProcessIdentityMarker(process.pid, () => start));

  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: (p) => p === process.pid,
      getStartTime: (p) => (p === process.pid ? start : null),
    }),
    process.pid,
  );
  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: () => false,
      getStartTime: () => start,
    }),
    null,
    "dead lock PID must not count",
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test("findWrapperPidForIssue: stale non-sentinel marker with reused PID is not live (#770 eff1796b)", () => {
  // Wrapper killed before sentinel.json leaves .lock-acquired; OS reuses the PID
  // for an unrelated process. Without starttime verification this would return
  // wrapper_pid and strand redispatch until watchdog/pause.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-reuse-"));
  const issue = 770;
  const runDir = path.join(home, ".pipeline", "runs", String(issue), "crashed-no-sentinel");
  fs.mkdirSync(runDir, { recursive: true });
  const recycledPid = 4242;
  fs.writeFileSync(
    path.join(runDir, LOCK_ACQUIRED_FILE),
    formatProcessIdentityMarker(recycledPid, () => "birth-original"),
  );

  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: (p) => p === recycledPid, // kill -0 succeeds on the new process
      getStartTime: (p) => (p === recycledPid ? "birth-reused" : null),
    }),
    null,
    "reused PID with mismatched starttime must not suppress redispatch",
  );

  // Bare PID-only legacy/crash marker (no starttime token) is also non-live.
  fs.writeFileSync(path.join(runDir, LOCK_ACQUIRED_FILE), String(recycledPid));
  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: () => true,
      getStartTime: () => "birth-reused",
    }),
    null,
    "unverifiable bare-PID marker must not count as live identity",
  );

  // Matching starttime still counts as live (control).
  fs.writeFileSync(
    path.join(runDir, LOCK_ACQUIRED_FILE),
    formatProcessIdentityMarker(recycledPid, () => "birth-original"),
  );
  assert.equal(
    findWrapperPidForIssue(issue, {
      homedir: home,
      isPidAlive: (p) => p === recycledPid,
      getStartTime: (p) => (p === recycledPid ? "birth-original" : null),
    }),
    recycledPid,
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test("probeLiveAdvance: production-shaped wiring with findWrapperPid (#770 956d20df)", () => {
  // Mirrors defaultRunLoopEngine: repoDir + domain + findWrapperPid, no full probe override.
  const r = probeLiveAdvance({
    domain: "agent-pipeline",
    issueNumber: 675,
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770-prod-wrap"),
    findWrapperPid: () => process.pid,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "wrapper_pid");
    assert.equal(r.holder_pid, process.pid);
  }
});
