// Commit traceability trailers (#20): the run-id format and the direct-commit
// trailer appender. These are the two pure pieces every commit the pipeline
// writes directly depends on; the stage code feeds real commit messages through
// `withTrailers`, so asserting its output here covers the docs-update,
// openspec-archive, and openspec-init commit sites.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_TRAILER_KEY,
  RUN_TRAILER_KEY,
  makePipelineRunId,
  withTrailers,
} from "../scripts/traceability.ts";

// ---------------------------------------------------------------------------
// makePipelineRunId — format `<number>/<YYYY-MM-DDTHH:MM:SSZ>` (task 4.2)
// ---------------------------------------------------------------------------

test("makePipelineRunId: format is <issue>/<UTC-ISO seconds-precision Z>", () => {
  const id = makePipelineRunId(42, new Date("2026-06-08T14:32:00.000Z"));
  assert.equal(id, "42/2026-06-08T14:32:00Z");
  assert.match(id, /^\d+\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("makePipelineRunId: drops sub-second precision", () => {
  const id = makePipelineRunId(7, new Date("2026-01-02T03:04:05.987Z"));
  assert.equal(id, "7/2026-01-02T03:04:05Z");
  assert.doesNotMatch(id, /\./);
});

test("makePipelineRunId: embeds the issue number as the prefix", () => {
  const id = makePipelineRunId(123, new Date("2026-06-08T00:00:00.000Z"));
  assert.ok(id.startsWith("123/"), `expected issue-number prefix, got ${id}`);
});

test("makePipelineRunId: default clock still yields the documented shape", () => {
  // No injected Date → uses the real clock; only the shape is asserted.
  assert.match(makePipelineRunId(1), /^1\/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

// ---------------------------------------------------------------------------
// withTrailers — direct-commit message stamping (task 4.1)
// ---------------------------------------------------------------------------

test("withTrailers: appends Issue and Pipeline-Run trailers", () => {
  const msg = withTrailers("docs: update documentation for #20", 20, "20/2026-06-08T14:32:00Z");
  assert.match(msg, /Issue: #20/);
  assert.match(msg, /Pipeline-Run: 20\/2026-06-08T14:32:00Z/);
});

test("withTrailers: trailers are separated from the subject by a blank line", () => {
  const msg = withTrailers("chore: archive OpenSpec change(s) for #20", 20, "20/2026-06-08T14:32:00Z");
  const lines = msg.split("\n");
  assert.equal(lines[0], "chore: archive OpenSpec change(s) for #20");
  assert.equal(lines[1], "", "a blank line must separate the body from the trailers");
  assert.equal(lines[2], "Issue: #20");
  assert.equal(lines[3], "Pipeline-Run: 20/2026-06-08T14:32:00Z");
});

test("withTrailers: the original message is preserved verbatim as the subject", () => {
  const base = "chore: openspec init for #20";
  const msg = withTrailers(base, 20, "20/2026-06-08T14:32:00Z");
  assert.ok(msg.startsWith(base), "subject must be unchanged");
});

test("withTrailers: a run id from makePipelineRunId round-trips into the message", () => {
  const runId = makePipelineRunId(99, new Date("2026-12-31T23:59:59.500Z"));
  const msg = withTrailers("docs: update documentation for #99", 99, runId);
  assert.match(msg, /Pipeline-Run: 99\/2026-12-31T23:59:59Z/);
});

test("withTrailers: uses the exported trailer key constants", () => {
  const msg = withTrailers("subject", 5, "5/2026-06-08T14:32:00Z");
  assert.ok(msg.includes(`${ISSUE_TRAILER_KEY}: #5`));
  assert.ok(msg.includes(`${RUN_TRAILER_KEY}: 5/2026-06-08T14:32:00Z`));
});
