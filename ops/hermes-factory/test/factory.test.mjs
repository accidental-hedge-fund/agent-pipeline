import assert from "node:assert/strict";
import test from "node:test";
import { controlReceiptPath, flushTerminalNotices, makeRuntime } from "../factory.mjs";
import { config, NOW, validated } from "./helpers.mjs";

test("control receipts are scoped to one grant fingerprint", () => {
  const machine = config();
  const first = controlReceiptPath(machine, "a".repeat(64));
  const next = controlReceiptPath(machine, "b".repeat(64));
  assert.equal(first, `/state/control.json.${"a".repeat(64)}`);
  assert.notEqual(first, next);
  assert.throws(() => controlReceiptPath(machine, "not-a-fingerprint"), /fingerprint/);
});

test("a stale control receipt from one grant cannot stop the next grant", async () => {
  const machine = config();
  const next = validated({}, {
    auth: { message_id: "c".repeat(64), thread_id: "c".repeat(64), created_at: 1786190460 },
    grant: { nonce: "release-1.32.1-run-002", issued_at: "2026-08-08T12:01:00.000Z" },
  });
  const reads = [];
  const runtime = await makeRuntime(
    machine,
    next,
    {},
    { notices: {} },
    { notification: {} },
    {
      // Freeze time to the fixture NOW so wall-clock past expires_at cannot
      // false-fail this unit test (grant expires_at is relative to NOW).
      now: () => NOW,
      readFile: async (path) => {
        reads.push(path);
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    },
  );
  assert.equal(await runtime.getStopReason(), null);
  assert.deepEqual(reads, [controlReceiptPath(machine, next.fingerprint)]);
});

test("getStopReason reports grant expired when injected now is past expires_at", async () => {
  const machine = config();
  const next = validated({}, {
    auth: { message_id: "d".repeat(64), thread_id: "d".repeat(64), created_at: 1786190460 },
    grant: { nonce: "release-1.32.1-run-003", issued_at: "2026-08-08T12:01:00.000Z" },
  });
  const runtime = await makeRuntime(
    machine,
    next,
    {},
    { notices: {} },
    { notification: {} },
    {
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    },
  );
  assert.equal(await runtime.getStopReason(), "grant expired");
});

test("terminal replay flushes pending notices without starting controller work", async () => {
  let flushes = 0;
  assert.equal(await flushTerminalNotices({ status: "completed" }, { async flushPending() { flushes += 1; return { pending: 0 }; } }), true);
  assert.equal(await flushTerminalNotices({ status: "running" }, { async flushPending() { flushes += 1; return { pending: 0 }; } }), false);
  assert.equal(flushes, 1);
  await assert.rejects(
    flushTerminalNotices({ status: "failed" }, { async flushPending() { return { pending: 1 }; } }),
    /must retry delivery/,
  );
});
