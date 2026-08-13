import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDisputedRunAttributions,
  buildAttributionFromSignal,
  inferRunFromTemporalProximity,
  parseCommitTrailers,
  resolveRunFromTrailer,
  type RunIdentity,
} from "../scripts/outcomes/linkage.ts";

const SHA = "c".repeat(40);

const runs: RunIdentity[] = [
  {
    run_id: "42-2026-06-08T14-32-00-000Z",
    issue: 42,
    pr: 99,
    started_at: "2026-06-08T14:32:00Z",
  },
  {
    run_id: "42-2026-06-09T10-00-00-000Z",
    issue: 42,
    pr: 100,
    started_at: "2026-06-09T10:00:00Z",
  },
];

test("parseCommitTrailers extracts Issue and Pipeline-Run", () => {
  const msg = "fix: thing\n\nIssue: #42\nPipeline-Run: 42/2026-06-08T14:32:00Z\n";
  const t = parseCommitTrailers(msg);
  assert.equal(t.issue, 42);
  assert.equal(t.pipeline_run, "42/2026-06-08T14:32:00Z");
});

test("trailer to run resolution is observed authority", () => {
  const { attribution, diagnostic } = resolveRunFromTrailer(
    "42/2026-06-08T14:32:00Z",
    runs,
  );
  assert.ok(attribution);
  assert.equal(attribution.target_type, "run");
  assert.equal(attribution.target_id, "42-2026-06-08T14-32-00-000Z");
  assert.equal(attribution.method, "trailer");
  assert.equal(attribution.authority, "observed");
  assert.equal(diagnostic, null);
});

test("unresolved trailer returns diagnostic without throw", () => {
  const { attribution, diagnostic } = resolveRunFromTrailer(
    "999/2026-01-01T00:00:00Z",
    runs,
  );
  assert.equal(attribution, null);
  assert.equal(diagnostic, "trailer_run_absent");
});

test("temporal co-occurrence alone is inferred", () => {
  const { attribution, diagnostic } = inferRunFromTemporalProximity({
    signal_at: "2026-06-09T18:00:00Z",
    issue: 42,
    runs: [runs[1]],
  });
  assert.ok(attribution);
  assert.equal(attribution.authority, "inferred");
  assert.equal(attribution.method, "heuristic");
  assert.equal(diagnostic, "temporal_join_only");
});

test("multi-target linkage is allowed", () => {
  const result = buildAttributionFromSignal({
    commit_message: "Issue: #42\nPipeline-Run: 42/2026-06-08T14:32:00Z\n",
    merge_sha: SHA,
    pr_number: 99,
    component_ids: ["core/scripts/outcomes", "core/test"],
    runs,
  });
  const types = result.attribution.map((a) => a.target_type).sort();
  assert.ok(types.includes("run"));
  assert.ok(types.includes("commit"));
  assert.ok(types.includes("pr"));
  assert.ok(types.includes("issue"));
  assert.equal(result.attribution.filter((a) => a.target_type === "component").length, 2);
});

test("missing run link is explicit when PR present", () => {
  const result = buildAttributionFromSignal({
    pr_number: 7,
    merge_sha: SHA,
    runs: [],
  });
  assert.ok(result.attribution.some((a) => a.target_type === "pr"));
  assert.equal(
    result.attribution.some((a) => a.target_type === "run"),
    false,
  );
});

test("invented identity is forbidden for commit", () => {
  const result = buildAttributionFromSignal({
    merge_sha: "notasha",
    runs: [],
  });
  assert.equal(result.attribution.some((a) => a.target_type === "commit"), false);
  assert.ok(result.linkage_diagnostics.includes("missing_commit_sha"));
});

test("disputed keeps both run attributions", () => {
  const a = {
    target_type: "run" as const,
    target_id: "run-a",
    method: "adapter" as const,
    authority: "observed" as const,
    confidence: 1,
  };
  const b = {
    target_type: "run" as const,
    target_id: "run-b",
    method: "adapter" as const,
    authority: "inferred" as const,
    confidence: 0.4,
  };
  const { attribution, observation_state } = applyDisputedRunAttributions([a], [b]);
  assert.equal(attribution.length, 2);
  assert.equal(observation_state, "disputed");
  assert.ok(attribution.every((x) => x.disputed === true));
});
