// Tests for deterministic head/tail bounding (#536, eval-trajectory-artifacts
// task 2.2). Pure functions — no fs/network/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { boundItems, boundText, mergeTruncations, DEFAULT_TRAJECTORY_CEILINGS } from "../scripts/evals/trajectory/bound.ts";

test("boundItems: within ceilings — untruncated, all items retained", () => {
  const items = ["a", "b", "c"];
  const result = boundItems(items, { maxEvents: 10, maxBytes: 10_000 }, (s) => s);
  assert.deepEqual(result.items, items);
  assert.equal(result.truncation.status, "none");
  assert.equal(result.truncation.dropped_event_count, 0);
  assert.equal(result.truncation.dropped_byte_count, 0);
});

test("boundItems: over event ceiling — deterministic head/tail retention, middle dropped", () => {
  const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
  const result = boundItems(items, { maxEvents: 4, maxBytes: 10_000 }, (s) => s);
  assert.equal(result.items.length, 4);
  assert.deepEqual(result.items, ["item-0", "item-1", "item-8", "item-9"]);
  assert.equal(result.truncation.status, "truncated");
  assert.equal(result.truncation.dropped_event_count, 6);
  assert.ok(result.truncation.dropped_byte_count > 0);
});

test("boundItems: over byte ceiling with few items — trims from the middle outward", () => {
  const items = ["x".repeat(100), "y".repeat(100), "z".repeat(100)];
  const result = boundItems(items, { maxEvents: 100, maxBytes: 150 }, (s) => s);
  assert.ok(result.items.length < 3);
  assert.equal(result.truncation.status, "truncated");
  assert.ok(result.truncation.dropped_event_count > 0);
});

test("boundItems: bounding the same input twice yields byte-identical output", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ i, text: "x".repeat(50) }));
  const ceilings = { maxEvents: 10, maxBytes: 500 };
  const serialize = (x: unknown) => JSON.stringify(x);
  const first = boundItems(items, ceilings, serialize);
  const second = boundItems(items, ceilings, serialize);
  assert.deepEqual(first, second);
});

test("boundText: within ceiling — untruncated", () => {
  const result = boundText("hello world", 1000);
  assert.equal(result.text, "hello world");
  assert.equal(result.truncation.status, "none");
});

test("boundText: over ceiling — deterministic head/tail retention with drop accounting", () => {
  const text = "A".repeat(50) + "B".repeat(50) + "C".repeat(50);
  const result = boundText(text, 60);
  assert.equal(result.truncation.status, "truncated");
  assert.ok(result.truncation.dropped_byte_count > 0);
  assert.ok(result.text.startsWith("A"));
  assert.ok(result.text.endsWith("C".repeat(30)) || result.text.includes("C"));
});

test("boundText: truncating the same input twice is byte-identical", () => {
  const text = "Z".repeat(1000);
  const first = boundText(text, 100);
  const second = boundText(text, 100);
  assert.deepEqual(first, second);
});

test("mergeTruncations: any truncated part marks the merged result truncated, counts sum", () => {
  const merged = mergeTruncations([
    { status: "none", dropped_event_count: 0, dropped_byte_count: 0 },
    { status: "truncated", dropped_event_count: 2, dropped_byte_count: 20 },
    { status: "truncated", dropped_event_count: 3, dropped_byte_count: 30 },
  ]);
  assert.equal(merged.status, "truncated");
  assert.equal(merged.dropped_event_count, 5);
  assert.equal(merged.dropped_byte_count, 50);
});

test("mergeTruncations: all-none parts merge to none with zero counts", () => {
  const merged = mergeTruncations([
    { status: "none", dropped_event_count: 0, dropped_byte_count: 0 },
    { status: "none", dropped_event_count: 0, dropped_byte_count: 0 },
  ]);
  assert.equal(merged.status, "none");
  assert.equal(merged.dropped_event_count, 0);
});

test("DEFAULT_TRAJECTORY_CEILINGS is a sane, positive default", () => {
  assert.ok(DEFAULT_TRAJECTORY_CEILINGS.maxEvents > 0);
  assert.ok(DEFAULT_TRAJECTORY_CEILINGS.maxBytes > 0);
});
