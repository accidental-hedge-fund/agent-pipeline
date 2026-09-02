// Shared worker-identity probe (#1332). Injected evidence only — no real
// network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWorkerLiveness,
  parseHeartbeatAt,
  parseProcessIdentityMarker,
  processIdentityMatches,
  WORKER_HEARTBEAT_STALE_MS,
  type WorkerIdentityEvidence,
} from "../scripts/worker-identity.ts";

const NOW = new Date("2026-08-29T12:00:00.000Z");

function evidence(over: Partial<WorkerIdentityEvidence> = {}): WorkerIdentityEvidence {
  return {
    now: NOW,
    recorded: { pid: 4242, boot_id: "boot-1", started_at: "2026-08-29T11:59:00.000Z" },
    observed: {
      pid: 4242,
      boot_id: "boot-1",
      started_at: "2026-08-29T11:59:00.000Z",
      heartbeat_at: "2026-08-29T11:59:55.000Z",
    },
    pidAlive: true,
    ...over,
  };
}

test("dead pid is not-live", () => {
  const result = classifyWorkerLiveness(evidence({ pidAlive: false }));
  assert.equal(result.status, "not-live");
  assert.equal(result.reason, "dead_pid");
});

test("PID reuse without matching start/boot is not-live", () => {
  const result = classifyWorkerLiveness(evidence({
    observed: {
      pid: 4242,
      boot_id: "boot-other",
      started_at: "2026-08-29T12:00:00.000Z",
      heartbeat_at: "2026-08-29T11:59:55.000Z",
    },
    pidAlive: true,
  }));
  assert.equal(result.status, "not-live");
  assert.equal(result.reason, "pid_reuse");
});

test("stale heartbeat is not-live", () => {
  const result = classifyWorkerLiveness(evidence({
    observed: {
      pid: 4242,
      boot_id: "boot-1",
      started_at: "2026-08-29T11:59:00.000Z",
      heartbeat_at: "2026-08-29T11:59:00.000Z",
    },
    now: new Date("2026-08-29T12:00:31.000Z"),
  }));
  assert.equal(result.status, "not-live");
  assert.equal(result.reason, "stale_heartbeat");
});

test("missing heartbeat is not-live", () => {
  const result = classifyWorkerLiveness(evidence({
    observed: {
      pid: 4242,
      boot_id: "boot-1",
      started_at: "2026-08-29T11:59:00.000Z",
      heartbeat_at: "",
    },
  }));
  assert.equal(result.status, "not-live");
  assert.equal(result.reason, "missing_heartbeat");
});

test("unreadable identity is unknown", () => {
  const result = classifyWorkerLiveness(evidence({ observed: "unreadable" }));
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "unreadable_identity");
});

test("fresh heartbeat with live pid is live", () => {
  const result = classifyWorkerLiveness(evidence());
  assert.equal(result.status, "live");
  assert.equal(result.reason, "live");
});

test("future heartbeat beyond slack is malformed", () => {
  const parsed = parseHeartbeatAt("2026-08-29T12:00:02.000Z", NOW);
  assert.equal(parsed.kind, "malformed");
});

test("heartbeat stale threshold is the engine invariant", () => {
  assert.equal(WORKER_HEARTBEAT_STALE_MS, 30_000);
});

test("parseProcessIdentityMarker reads pid and starttime", () => {
  assert.deepEqual(parseProcessIdentityMarker("4242 12345"), { pid: 4242, starttime: "12345" });
  assert.deepEqual(parseProcessIdentityMarker("4242"), { pid: 4242, starttime: null });
  assert.equal(parseProcessIdentityMarker(""), null);
});

test("processIdentityMatches rejects PID reuse", () => {
  assert.equal(
    processIdentityMatches({ pid: 7, starttime: "aaa" }, { pid: 7, starttime: "bbb" }),
    false,
  );
  assert.equal(
    processIdentityMatches({ pid: 7, starttime: "aaa" }, { pid: 7, starttime: "aaa" }),
    true,
  );
  assert.equal(
    processIdentityMatches({ pid: 7, starttime: null }, { pid: 7, starttime: "aaa" }),
    false,
  );
});
