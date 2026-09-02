// Pack-loop liveness classifier (#1296). Injected evidence only — no real
// network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PACK_LOOP_HEARTBEAT_CADENCE_MS,
  PACK_LOOP_HEARTBEAT_STALE_MS,
  classifyPackLoopLiveness,
  packLoopHeartbeatCadenceMs,
  packLoopHeartbeatStaleMs,
  parseHeartbeatAt,
  type PackLoopLivenessEvidence,
} from "../scripts/loop/pack-loop-liveness.ts";
import type { DurableLoopRunHandoff } from "../scripts/loop/handoff.ts";
import type { LoopSupervisorProcess } from "../scripts/loop/types.ts";

const LOOP_ID = "loop-pack-1296";
const SHA = "a".repeat(40);
const NOW = new Date("2026-08-29T12:00:00.000Z");

function handoff(over: Partial<DurableLoopRunHandoff> = {}): DurableLoopRunHandoff {
  return {
    schema_version: "1",
    kind: "loop_run_handoff",
    run_id: LOOP_ID,
    run_dir: `/state/runs/${LOOP_ID}`,
    events: `/state/runs/${LOOP_ID}/events.jsonl`,
    engine: "claude",
    resumed: false,
    selector: null,
    candidate_sha: SHA,
    supervisor: { pid: 4242, boot_id: "boot-1", started_at: "2026-08-29T11:59:00.000Z", token: "tok" },
    ...over,
  };
}

function supervisor(over: Partial<LoopSupervisorProcess> = {}): LoopSupervisorProcess {
  return {
    run_id: LOOP_ID,
    engine: "claude",
    pid: 4242,
    hostname: "host",
    boot_id: "boot-1",
    started_at: "2026-08-29T11:59:00.000Z",
    heartbeat_at: "2026-08-29T11:59:55.000Z",
    token: "tok",
    consecutive_no_progress: 0,
    ...over,
  };
}

function evidence(over: Partial<PackLoopLivenessEvidence> = {}): PackLoopLivenessEvidence {
  return {
    loopRunId: LOOP_ID,
    now: NOW,
    handoff: handoff(),
    supervisor: supervisor(),
    lockPidAlive: true,
    candidateSha: SHA,
    ...over,
  };
}

test("dead pid plus open ledger is not live", () => {
  const status = classifyPackLoopLiveness(evidence({ lockPidAlive: false }));
  assert.notEqual(status.status, "live");
  assert.equal(status.status, "not-live");
  assert.equal(status.reason, "dead_pid");
  assert.notEqual(status.status, "failed");
});

test("non-terminal ledger without a live worker is not-live, not verified completion", () => {
  const status = classifyPackLoopLiveness(evidence({
    lockPidAlive: false,
    supervisor: supervisor({ heartbeat_at: "2026-08-29T11:59:55.000Z" }),
  }));
  assert.equal(status.status, "not-live");
  assert.notEqual(status.reason, "live");
  assert.notEqual(status.status, "failed");
});

test("never-dispatched non-terminal ledger is not live", () => {
  const status = classifyPackLoopLiveness(evidence({
    handoff: null,
    lockPidAlive: false,
    supervisor: null,
  }));
  assert.notEqual(status.status, "live");
  assert.equal(status.reason, "no_handoff");
});

test("stale heartbeat is not live", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: supervisor({ heartbeat_at: "2026-08-29T11:59:00.000Z" }),
    now: new Date("2026-08-29T12:00:31.000Z"),
  }));
  assert.notEqual(status.status, "live");
  assert.equal(status.reason, "stale_heartbeat");
});

test("missing heartbeat after acknowledgement is not live", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: supervisor({ heartbeat_at: "" }),
  }));
  assert.notEqual(status.status, "live");
  assert.equal(status.reason, "missing_heartbeat");
});

test("PID reuse without matching start/boot is not live", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: supervisor({ boot_id: "boot-other", started_at: "2026-08-29T12:00:00.000Z" }),
    lockPidAlive: true,
  }));
  assert.notEqual(status.status, "live");
  assert.equal(status.reason, "pid_reuse");
});

test("unreadable identity is unknown inside the observation window", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: "unreadable",
    observationDeadline: "2026-08-29T12:00:30.000Z",
    now: new Date("2026-08-29T12:00:00.000Z"),
  }));
  assert.equal(status.status, "unknown");
  assert.equal(status.reason, "unreadable_identity");
});

test("unreadable identity fails closed after the observation window", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: "unreadable",
    observationDeadline: "2026-08-29T11:59:00.000Z",
    now: NOW,
  }));
  assert.equal(status.status, "failed");
  assert.equal(status.reason, "unreadable_identity");
});

test("unreadable identity without a deadline stays unknown", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: "unreadable",
  }));
  assert.equal(status.status, "unknown");
});

test("malformed heartbeat is unreadable identity", () => {
  const status = classifyPackLoopLiveness(evidence({
    supervisor: supervisor({ heartbeat_at: "not-a-date" }),
    observationDeadline: "2026-08-29T12:00:30.000Z",
  }));
  assert.equal(status.status, "unknown");
});

test("future heartbeat beyond 1s slack is malformed", () => {
  const parsed = parseHeartbeatAt("2026-08-29T12:00:02.000Z", NOW);
  assert.equal(parsed.kind, "malformed");
});

test("acknowledged live process with fresh heartbeat is live", () => {
  const status = classifyPackLoopLiveness(evidence());
  assert.equal(status.status, "live");
  assert.equal(status.reason, "live");
});

test("repository config cannot weaken heartbeat invariants", () => {
  assert.equal(packLoopHeartbeatCadenceMs(60_000), PACK_LOOP_HEARTBEAT_CADENCE_MS);
  assert.equal(packLoopHeartbeatStaleMs(120_000), PACK_LOOP_HEARTBEAT_STALE_MS);
  assert.equal(packLoopHeartbeatCadenceMs(1_000), 1_000);
  assert.equal(packLoopHeartbeatStaleMs(5_000), 5_000);
});
