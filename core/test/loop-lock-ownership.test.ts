// #668 pre-merge: lock ownership must be exact numeric PID (+ real parent chain),
// never unanchored string/grep prefix matching.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLiveOwnedLoopLock,
  isLockPidOwnedByLauncher,
  isSameProcessInstance,
  parseLockPid,
} from "../scripts/loop/lock-ownership.ts";

test("parseLockPid: integer pid field", () => {
  assert.equal(parseLockPid(JSON.stringify({ pid: 12345, engine: "claude" })), 12345);
});

test("parseLockPid: digit-string pid field", () => {
  assert.equal(parseLockPid(JSON.stringify({ pid: "99" })), 99);
});

test("parseLockPid: rejects float, empty, zero, negative, missing", () => {
  assert.equal(parseLockPid(JSON.stringify({ pid: 1.5 })), null);
  assert.equal(parseLockPid(JSON.stringify({ pid: "" })), null);
  assert.equal(parseLockPid(JSON.stringify({ pid: 0 })), null);
  assert.equal(parseLockPid(JSON.stringify({ pid: -1 })), null);
  assert.equal(parseLockPid(JSON.stringify({})), null);
  assert.equal(parseLockPid("not-json"), null);
  assert.equal(parseLockPid(JSON.stringify({ pid: "12abc" })), null);
});

test("isLockPidOwnedByLauncher: exact match", () => {
  assert.equal(isLockPidOwnedByLauncher(123, 123, () => null), true);
});

test("isLockPidOwnedByLauncher: 123 must NOT match lock pid 12345 (prefix regression)", () => {
  // The broken skill used: grep "\"pid\":$LOOP_PID" which matched 123 inside 12345.
  const parents = new Map<number, number>([[12345, 1]]);
  assert.equal(
    isLockPidOwnedByLauncher(12345, 123, (p) => parents.get(p) ?? null),
    false,
    "launcher 123 must not own lock pid 12345",
  );
  assert.equal(
    isLockPidOwnedByLauncher(123, 12345, (p) => parents.get(p) ?? null),
    false,
    "launcher 12345 must not own unrelated lock pid 123 without ancestry",
  );
});

test("isLockPidOwnedByLauncher: descendant of launcher is owned (child supervisor)", () => {
  // tree: 1 <- 100 (launcher) <- 200 (child wrapper) <- 300 (lock holder)
  const parents = new Map<number, number>([
    [300, 200],
    [200, 100],
    [100, 1],
  ]);
  assert.equal(
    isLockPidOwnedByLauncher(300, 100, (p) => parents.get(p) ?? null),
    true,
  );
  assert.equal(
    isLockPidOwnedByLauncher(200, 100, (p) => parents.get(p) ?? null),
    true,
  );
});

test("isLockPidOwnedByLauncher: sibling / unrelated branch is not owned", () => {
  // 1 <- 100 (launcher); 1 <- 400 (other); 400 <- 500 (lock)
  const parents = new Map<number, number>([
    [500, 400],
    [400, 1],
    [100, 1],
  ]);
  assert.equal(
    isLockPidOwnedByLauncher(500, 100, (p) => parents.get(p) ?? null),
    false,
  );
});

test("isLockPidOwnedByLauncher: cycle in parentOf does not hang", () => {
  const parents = new Map<number, number>([
    [10, 11],
    [11, 10],
  ]);
  assert.equal(
    isLockPidOwnedByLauncher(10, 99, (p) => parents.get(p) ?? null),
    false,
  );
});

test("isSameProcessInstance: matching starttime", () => {
  assert.equal(
    isSameProcessInstance(42, "999", (p) => (p === 42 ? "999" : null)),
    true,
  );
});

test("isSameProcessInstance: PID reuse — same pid, different starttime → false", () => {
  // Launcher had starttime 100; after exit PID 42 is reused with starttime 200.
  assert.equal(
    isSameProcessInstance(42, "100", (p) => (p === 42 ? "200" : null)),
    false,
  );
});

test("isSameProcessInstance: dead/missing process → false", () => {
  assert.equal(isSameProcessInstance(42, "100", () => null), false);
});

test("isLiveOwnedLoopLock: accepts descendant while launcher instance is stable", () => {
  const parents = new Map<number, number>([
    [300, 100],
    [100, 1],
  ]);
  const start = new Map<number, string>([
    [100, "birth-A"],
    [300, "birth-child"],
  ]);
  assert.equal(
    isLiveOwnedLoopLock({
      lockPid: 300,
      launcherPid: 100,
      launcherStartTime: "birth-A",
      parentOf: (p) => parents.get(p) ?? null,
      getStartTime: (p) => start.get(p) ?? null,
    }),
    true,
  );
});

test("isLiveOwnedLoopLock: PID reuse of launcher rejects even if lock parent chain looks ok", () => {
  // Original launcher 100 / birth-A exited; PID 100 reused as birth-B; lock held by 300→100.
  const parents = new Map<number, number>([
    [300, 100],
    [100, 1],
  ]);
  const start = new Map<number, string>([
    [100, "birth-B"], // reused
    [300, "birth-child"],
  ]);
  assert.equal(
    isLiveOwnedLoopLock({
      lockPid: 300,
      launcherPid: 100,
      launcherStartTime: "birth-A", // captured at real launch
      parentOf: (p) => parents.get(p) ?? null,
      getStartTime: (p) => start.get(p) ?? null,
    }),
    false,
    "must not attach after launcher PID was recycled",
  );
});
