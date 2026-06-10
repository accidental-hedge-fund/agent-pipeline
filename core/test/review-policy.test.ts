// Unit tests for the review severity policy + audited overrides (#17).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEVERITY_ORDER,
  severityRank,
  findingKey,
  partitionFindings,
  extractOverrides,
  isValidFindingKey,
  overrideComment,
  parseOverrideArg,
  type ReviewPolicy,
} from "../scripts/review-policy.ts";
import type { ReviewFinding } from "../scripts/types.ts";

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    severity: "high",
    title: "Something is wrong",
    body: "details",
    confidence: 0.9,
    recommendation: "fix it",
    ...over,
  };
}

const DEFAULT_POLICY: ReviewPolicy = { block_threshold: "low", min_confidence: 0 };

// ---------------------------------------------------------------------------
// severityRank
// ---------------------------------------------------------------------------

test("severityRank: orders low < medium < high < critical", () => {
  assert.ok(severityRank("low") < severityRank("medium"));
  assert.ok(severityRank("medium") < severityRank("high"));
  assert.ok(severityRank("high") < severityRank("critical"));
  assert.deepEqual([...SEVERITY_ORDER], ["low", "medium", "high", "critical"]);
});

test("severityRank: unknown severity is treated as medium (never silently lowest)", () => {
  assert.equal(severityRank("bogus"), severityRank("medium"));
  assert.equal(severityRank(""), severityRank("medium"));
});

// ---------------------------------------------------------------------------
// findingKey — stable, content-addressed
// ---------------------------------------------------------------------------

test("findingKey: 8 lowercase hex chars", () => {
  const k = findingKey(finding());
  assert.match(k, /^[0-9a-f]{8}$/);
});

test("findingKey: stable for identical severity|file|title (survives re-review)", () => {
  const a = findingKey(finding({ severity: "medium", file: "x.ts", title: "T" }));
  const b = findingKey(finding({ severity: "medium", file: "x.ts", title: "T", body: "different body", confidence: 0.1 }));
  assert.equal(a, b, "key must not depend on body/confidence — only severity|file|title");
});

test("findingKey: differs when title, file, or severity differ", () => {
  const base = finding({ severity: "high", file: "x.ts", title: "T" });
  assert.notEqual(findingKey(base), findingKey({ ...base, title: "T2" }));
  assert.notEqual(findingKey(base), findingKey({ ...base, file: "y.ts" }));
  assert.notEqual(findingKey(base), findingKey({ ...base, severity: "low" }));
});

// ---------------------------------------------------------------------------
// partitionFindings
// ---------------------------------------------------------------------------

test("partition: default policy (low/0) blocks on every finding", () => {
  const p = partitionFindings(
    [finding({ severity: "low" }), finding({ severity: "critical" })],
    DEFAULT_POLICY,
  );
  assert.equal(p.blocking.length, 2);
  assert.equal(p.advisory.length, 0);
  assert.equal(p.overridden.length, 0);
});

test("partition: threshold 'high' makes medium/low advisory, high/critical blocking", () => {
  const policy: ReviewPolicy = { block_threshold: "high", min_confidence: 0 };
  const p = partitionFindings(
    [
      finding({ severity: "low", title: "lo" }),
      finding({ severity: "medium", title: "me" }),
      finding({ severity: "high", title: "hi" }),
      finding({ severity: "critical", title: "cr" }),
    ],
    policy,
  );
  assert.deepEqual(p.blocking.map((f) => f.severity), ["high", "critical"]);
  assert.deepEqual(p.advisory.map((a) => a.finding.severity), ["low", "medium"]);
});

test("partition: min_confidence routes a low-confidence high finding to advisory", () => {
  const policy: ReviewPolicy = { block_threshold: "low", min_confidence: 0.8 };
  const p = partitionFindings(
    [finding({ severity: "high", confidence: 0.5, title: "shaky" }), finding({ severity: "high", confidence: 0.95, title: "sure" })],
    policy,
  );
  assert.deepEqual(p.blocking.map((f) => f.title), ["sure"]);
  assert.deepEqual(p.advisory.map((a) => a.finding.title), ["shaky"]);
  assert.match(p.advisory[0].reason, /confidence 0\.5 below 0\.8/);
});

test("partition: an override moves a blocking finding to overridden regardless of severity", () => {
  const f = finding({ severity: "critical", file: "x.ts", title: "boom" });
  const overrides = new Map([[findingKey(f), "rejected"]]);
  const p = partitionFindings([f], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.blocking.length, 0);
  assert.equal(p.overridden.length, 1);
  assert.equal(p.overridden[0].disposition, "rejected");
  assert.equal(p.overridden[0].key, findingKey(f));
});

// ---------------------------------------------------------------------------
// extractOverrides — sentinel round-trip
// ---------------------------------------------------------------------------

test("extractOverrides: reads pipeline-override sentinels (key → disposition)", () => {
  const comments = [
    { body: "## Pipeline: Finding override\n\nstuff\n\n<!-- pipeline-override: a1b2c3d4 rejected -->" },
    { body: "unrelated comment" },
    { body: "<!-- pipeline-override: 99887766 deferred-#85 -->" },
  ];
  const m = extractOverrides(comments);
  assert.equal(m.get("a1b2c3d4"), "rejected");
  assert.equal(m.get("99887766"), "deferred-#85");
  assert.equal(m.size, 2);
});

test("extractOverrides: a later override for the same key wins", () => {
  const comments = [
    { body: "<!-- pipeline-override: a1b2c3d4 rejected -->" },
    { body: "<!-- pipeline-override: a1b2c3d4 deferred-#85 -->" },
  ];
  assert.equal(extractOverrides(comments).get("a1b2c3d4"), "deferred-#85");
});

test("extractOverrides: ignores prose mentions and malformed sentinels", () => {
  const comments = [
    { body: "I think override a1b2c3d4 should apply" }, // not a sentinel
    { body: "<!-- pipeline-override: SHORT rejected -->" }, // bad key
    { body: "<!-- pipeline-override: a1b2c3d4 -->" }, // missing disposition
  ];
  assert.equal(extractOverrides(comments).size, 0);
});

test("overrideComment round-trips through extractOverrides", () => {
  const body = overrideComment({
    key: "deadbeef",
    disposition: "rejected",
    reason: "false positive — regex already handles readonly",
    stage: "review-2",
    timestamp: "2026-06-09T00:00:00Z",
  });
  const m = extractOverrides([{ body }]);
  assert.equal(m.get("deadbeef"), "rejected");
  assert.match(body, /false positive/);
  assert.match(body, /\*\*Disposition\*\*: rejected/);
});

// ---------------------------------------------------------------------------
// isValidFindingKey + parseOverrideArg
// ---------------------------------------------------------------------------

test("isValidFindingKey: 8 hex only", () => {
  assert.ok(isValidFindingKey("a1b2c3d4"));
  assert.ok(!isValidFindingKey("A1B2C3D4")); // uppercase not accepted by gate regex
  assert.ok(!isValidFindingKey("a1b2c3"));
  assert.ok(!isValidFindingKey("a1b2c3d4e"));
  assert.ok(!isValidFindingKey("zzzzzzzz"));
});

test("parseOverrideArg: valid 'key: reason' with default rejected disposition", () => {
  const r = parseOverrideArg("a1b2c3d4: this is a false positive");
  assert.ok(!("error" in r));
  if (!("error" in r)) {
    assert.equal(r.key, "a1b2c3d4");
    assert.equal(r.disposition, "rejected");
    assert.equal(r.reason, "this is a false positive");
  }
});

test("parseOverrideArg: 'deferred #85' disposition is detected and normalized", () => {
  const r = parseOverrideArg("a1b2c3d4: deferred #85 — out of scope for this issue");
  assert.ok(!("error" in r));
  if (!("error" in r)) assert.equal(r.disposition, "deferred-#85");
});

test("parseOverrideArg: leading 'rejected' keeps rejected disposition", () => {
  const r = parseOverrideArg("a1b2c3d4: rejected — regex already handles this");
  assert.ok(!("error" in r) && r.disposition === "rejected");
});

test("parseOverrideArg: key is lowercased before validation", () => {
  const r = parseOverrideArg("A1B2C3D4: reason");
  assert.ok(!("error" in r) && r.key === "a1b2c3d4");
});

test("parseOverrideArg: errors on missing colon, bad key, empty reason", () => {
  assert.ok("error" in parseOverrideArg("a1b2c3d4 no colon here"));
  assert.ok("error" in parseOverrideArg("nothex: reason"));
  assert.ok("error" in parseOverrideArg("a1b2c3d4:   "));
});
