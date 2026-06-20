// Unit tests for GhMetricsCollector (#257).
// No real gh subprocess calls — all I/O is mocked or purely in-memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GhMetricsCollector } from "../scripts/gh.ts";

// ---------------------------------------------------------------------------
// call_count and total_ms
// ---------------------------------------------------------------------------

test("GhMetricsCollector: record() increments call_count on each invocation", () => {
  const c = new GhMetricsCollector();
  c.record("issue view", 10);
  c.record("pr create", 20);
  c.record("label add", 30);
  assert.equal(c.summary().call_count, 3);
});

test("GhMetricsCollector: record() accumulates total_ms", () => {
  const c = new GhMetricsCollector();
  c.record("issue view", 10);
  c.record("pr create", 25);
  assert.equal(c.summary().total_ms, 35);
});

// ---------------------------------------------------------------------------
// zero-call baseline
// ---------------------------------------------------------------------------

test("GhMetricsCollector: summary() with zero records returns all-zero values", () => {
  const c = new GhMetricsCollector();
  const s = c.summary();
  assert.equal(s.call_count, 0);
  assert.equal(s.total_ms, 0);
  assert.equal(s.p50_ms, 0);
  assert.equal(s.p95_ms, 0);
  assert.deepEqual(s.slowest_calls, []);
});

// ---------------------------------------------------------------------------
// p50 / p95 percentile computation
// ---------------------------------------------------------------------------

// Spec scenario: [10,20,30,40,50,60,70,80,90,100] → p50=55, p95=95
test("GhMetricsCollector: p50_ms and p95_ms computed correctly over a known 10-sample set", () => {
  const c = new GhMetricsCollector();
  for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    c.record("issue view", ms);
  }
  const s = c.summary();
  assert.equal(s.p50_ms, 55, "p50 of [10..100] (10 values) must be 55");
  assert.equal(s.p95_ms, 95, "p95 of [10..100] (10 values) must be 95");
});

test("GhMetricsCollector: p50_ms for a single record equals that record's elapsed_ms", () => {
  const c = new GhMetricsCollector();
  c.record("api graphql", 42);
  const s = c.summary();
  assert.equal(s.p50_ms, 42);
  assert.equal(s.p95_ms, 42);
});

test("GhMetricsCollector: p50_ms for two records is their average", () => {
  const c = new GhMetricsCollector();
  c.record("issue view", 10);
  c.record("pr list", 20);
  // position = 0.5*(2-1) = 0.5; sorted=[10,20]; result=10+0.5*10=15
  assert.equal(c.summary().p50_ms, 15);
});

// ---------------------------------------------------------------------------
// slowest_calls: capped at 5, ordered descending, category only (no raw args)
// ---------------------------------------------------------------------------

test("GhMetricsCollector: slowest_calls capped at 5, ordered by elapsed_ms descending", () => {
  const c = new GhMetricsCollector();
  const calls = [
    { category: "issue view", ms: 10 },
    { category: "pr create", ms: 300 },
    { category: "label add", ms: 50 },
    { category: "api graphql", ms: 200 },
    { category: "pr diff", ms: 100 },
    { category: "pr checks", ms: 400 },
    { category: "issue edit", ms: 150 },
  ];
  for (const { category, ms } of calls) {
    c.record(category, ms);
  }
  const s = c.summary();
  assert.equal(s.slowest_calls.length, 5, "slowest_calls must contain at most 5 entries");
  // Must be ordered descending
  for (let i = 0; i < s.slowest_calls.length - 1; i++) {
    assert.ok(
      s.slowest_calls[i].elapsed_ms >= s.slowest_calls[i + 1].elapsed_ms,
      "slowest_calls must be ordered by elapsed_ms descending",
    );
  }
  // Top entry must be the slowest overall (400ms)
  assert.equal(s.slowest_calls[0].elapsed_ms, 400);
  assert.equal(s.slowest_calls[0].category, "pr checks");
});

test("GhMetricsCollector: slowest_calls entries contain only category and elapsed_ms (no raw args)", () => {
  const c = new GhMetricsCollector();
  // category is first-two-args only; raw body/flags must not leak into slowest_calls
  c.record("issue view", 50); // simulates args like ["issue","view","42","--json","labels"]
  c.record("api graphql", 100);
  const s = c.summary();
  for (const entry of s.slowest_calls) {
    const keys = Object.keys(entry);
    assert.deepEqual(keys.sort(), ["category", "elapsed_ms"], "entry must have exactly category and elapsed_ms");
  }
});

// ---------------------------------------------------------------------------
// category derivation: first-two-args only
// ---------------------------------------------------------------------------

test("GhMetricsCollector: category passed to record() is first-two-args join (callers' responsibility)", () => {
  const c = new GhMetricsCollector();
  // The caller (ghRun) passes args.slice(0,2).join(" "); we verify the collector
  // stores it verbatim without further truncation.
  c.record("api graphql", 80);
  c.record("issue view", 40);
  const s = c.summary();
  const categories = s.slowest_calls.map((e) => e.category);
  assert.ok(categories.includes("api graphql"));
  assert.ok(categories.includes("issue view"));
});

// ---------------------------------------------------------------------------
// summary() immutability: repeated calls return consistent snapshots
// ---------------------------------------------------------------------------

test("GhMetricsCollector: summary() returns consistent data across multiple calls", () => {
  const c = new GhMetricsCollector();
  c.record("pr list", 100);
  c.record("issue view", 200);
  const s1 = c.summary();
  const s2 = c.summary();
  assert.deepEqual(s1, s2, "summary() must be deterministic across repeated calls");
});
