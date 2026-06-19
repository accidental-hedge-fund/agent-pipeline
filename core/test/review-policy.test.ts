// Unit tests for the review severity policy + audited overrides (#17, #229).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEVERITY_ORDER,
  severityRank,
  findingKey,
  lineBucket,
  normalizeFile,
  normalizeTitle,
  findingPayloadFingerprint,
  partitionFindings,
  extractOverrides,
  extractScopedOverrides,
  isValidFindingKey,
  overrideComment,
  scopedOverrideComment,
  parseOverrideArg,
  SPEC_DIVERGENCE_CATEGORY,
  categoryMarker,
  reviewCommentFlagsSpecDivergence,
  type ReviewPolicy,
  type ScopedOverride,
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
// findingKey — stable finding identity (#144): location-addressed, title-stable
// ---------------------------------------------------------------------------

test("findingKey: 8 lowercase hex chars", () => {
  const k = findingKey(finding());
  assert.match(k, /^[0-9a-f]{8}$/);
});

test("findingKey: key ignores body/confidence (survives re-review)", () => {
  const a = findingKey(finding({ severity: "medium", file: "x.ts", title: "T", line_start: 12 }));
  const b = findingKey(finding({ severity: "medium", file: "x.ts", title: "T", line_start: 12, body: "different body", confidence: 0.1 }));
  assert.equal(a, b, "key must not depend on body/confidence");
});

// --- lineBucket / normalize helpers ---

test("lineBucket: fixed 5-line partition; 0 when absent/falsy", () => {
  assert.equal(lineBucket(1), 1);
  assert.equal(lineBucket(5), 1);
  assert.equal(lineBucket(6), 6);
  assert.equal(lineBucket(10), 6);
  assert.equal(lineBucket(46), 46);
  assert.equal(lineBucket(50), 46);
  assert.equal(lineBucket(undefined), 0);
  assert.equal(lineBucket(0), 0);
});

test("normalizeFile: lowercases the path", () => {
  assert.equal(normalizeFile("Core/Scripts/Review.ts"), "core/scripts/review.ts");
  assert.equal(normalizeFile(undefined), "");
});

test("normalizeTitle: strips markdown emphasis, edge punctuation/ellipsis, collapses ws", () => {
  assert.equal(normalizeTitle("**Can** still `starve`…"), "can still starve");
  assert.equal(normalizeTitle("…can _starve_."), "can starve");
  assert.equal(normalizeTitle("Later   sections  starve"), "later sections starve");
  assert.equal(normalizeTitle(undefined), "");
});

// --- location-based primary key: stable under title rewording (the #144 fix) ---

test("findingKey: same severity+file+line band, different titles → same key", () => {
  // Lines 43 and 46 fall in the same 5-line band (41–45 vs 46–50)? 43→band 41, 46→band 46.
  // Use 43 and 44 which share band 41–45, plus 46/48 which share 46–50.
  const a = findingKey(finding({ severity: "high", file: "x.ts", title: "can starve", line_start: 46 }));
  const b = findingKey(finding({ severity: "high", file: "x.ts", title: "can still starve", line_start: 48 }));
  assert.equal(a, b, "title rewording within the same line band must not change the key");
});

test("findingKey: line drift within the same bucket → same key", () => {
  // 46..50 all map to bucket 46.
  const keys = [46, 47, 48, 49, 50].map((l) =>
    findingKey(finding({ severity: "high", file: "x.ts", title: "T", line_start: l })),
  );
  assert.equal(new Set(keys).size, 1, "all lines in one 5-line band share a key");
});

test("findingKey: different 5-line bands → different keys (specificity)", () => {
  const a = findingKey(finding({ severity: "high", file: "x.ts", title: "T", line_start: 5 }));
  const b = findingKey(finding({ severity: "high", file: "x.ts", title: "T", line_start: 6 }));
  assert.notEqual(a, b, "lines 5 and 6 straddle a band boundary → different keys");
});

test("findingKey: different severities at same location → different keys (specificity)", () => {
  const base = finding({ severity: "high", file: "x.ts", title: "T", line_start: 12 });
  assert.notEqual(findingKey(base), findingKey({ ...base, severity: "critical" }));
});

test("findingKey: different files at same line band → different keys (specificity)", () => {
  const base = finding({ severity: "high", file: "x.ts", title: "T", line_start: 12 });
  assert.notEqual(findingKey(base), findingKey({ ...base, file: "y.ts" }));
});

// --- fallback when line_start is absent: normalized-title key ---

test("findingKey: absent line_start → normalized-title fallback absorbs markdown/case", () => {
  const a = findingKey(finding({ severity: "high", file: "x.ts", title: "**can** starve" }));
  const b = findingKey(finding({ severity: "high", file: "x.ts", title: "can starve" }));
  assert.equal(a, b, "without a line, markdown/case differences must normalize to the same key");
});

test("findingKey: absent line_start → semantically different titles → different keys", () => {
  const a = findingKey(finding({ severity: "high", file: "x.ts", title: "missing auth check" }));
  const b = findingKey(finding({ severity: "high", file: "x.ts", title: "slow loop" }));
  assert.notEqual(a, b, "distinct normalized titles must produce distinct keys");
});

test("findingKey: line_start=0 falls back to the title path (not bucket 0)", () => {
  const a = findingKey(finding({ severity: "high", file: "x.ts", title: "auth", line_start: 0 }));
  const b = findingKey(finding({ severity: "high", file: "x.ts", title: "loop", line_start: 0 }));
  assert.notEqual(a, b, "line_start=0 must use the title fallback, distinguishing titles");
});

// --- #144 regression: reworded title + small line shift keeps the override applying ---

test("#144 regression: override survives a reworded title AND a ±2-line shift", () => {
  // Round N: a high finding at line 46, title T1, gets an operator override.
  const roundN = finding({ severity: "high", file: "core/scripts/profile.ts", title: "Later compact sections can starve", line_start: 46 });
  const key = findingKey(roundN);
  const overrides = new Map([[key, "deferred-#150"]]);

  // Round N+1: the reviewer re-emits the same issue at line 48 (same 46–50 band)
  // with a reworded title — under the OLD severity|file|title algorithm this minted
  // a new key and the override lapsed; under #144 it keeps the same key.
  const roundNPlus1 = finding({ severity: "high", file: "core/scripts/profile.ts", title: "Later compact sections can still starve", line_start: 48 });
  assert.equal(findingKey(roundNPlus1), key, "reworded + shifted finding must keep the same key");

  const p = partitionFindings([roundNPlus1], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.blocking.length, 0, "the override must still apply → not blocking");
  assert.equal(p.overridden.length, 1);
  assert.equal(p.overridden[0].key, key);
  assert.equal(p.overridden[0].disposition, "deferred-#150");
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

test("partition: ambiguous override (two distinct findings share the same key) — neither is suppressed (#144)", () => {
  // Two HIGH findings in the same 5-line bucket (46–50) produce the same key.
  // An override recorded against that key cannot safely disposition both
  // distinct issues, so the override is withheld and both findings remain blocking.
  const f1 = finding({ severity: "high", file: "x.ts", title: "can starve", line_start: 46 });
  const f2 = finding({ severity: "high", file: "x.ts", title: "missing null check", line_start: 48 });
  assert.equal(findingKey(f1), findingKey(f2), "precondition: same bucket → same key");
  const sharedKey = findingKey(f1);
  const overrides = new Map([[sharedKey, "rejected"]]);
  const p = partitionFindings([f1, f2], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.overridden.length, 0, "ambiguous override must not suppress any finding");
  assert.equal(p.blocking.length, 2, "both findings remain blocking");
});

test("partition: exact-duplicate same-key findings — override applies (not ambiguous)", () => {
  // If the reviewer emits the same finding twice (identical severity/file/line/title),
  // the raw count is 2 but the distinct-title count is 1 — not ambiguous.
  // The override must still apply; before the fix the count-only guard withheld it.
  const f = finding({ severity: "high", file: "x.ts", title: "can starve", line_start: 46 });
  const dup = { ...f };
  const key = findingKey(f);
  const overrides = new Map([[key, "rejected"]]);
  const p = partitionFindings([f, dup], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.blocking.length, 0, "exact duplicate is not a distinct candidate — override must apply");
  assert.equal(p.overridden.length, 2, "both copies go to overridden");
});

test("partition: advisory-confidence duplicate shares key with blocker — override still applies to blocker", () => {
  // A high blocking finding (confidence 0.9) and a high low-confidence advisory (0.3)
  // land in the same 5-line bucket → same key. The advisory finding is not a blocking
  // candidate, so the distinct count is 1 and the override must not be withheld.
  const policy: ReviewPolicy = { block_threshold: "low", min_confidence: 0.8 };
  const blocker = finding({ severity: "high", file: "x.ts", title: "can starve", line_start: 46, confidence: 0.9 });
  const advisory = finding({ severity: "high", file: "x.ts", title: "can still starve", line_start: 48, confidence: 0.3 });
  assert.equal(findingKey(blocker), findingKey(advisory), "precondition: same bucket → same key");
  const key = findingKey(blocker);
  const overrides = new Map([[key, "rejected"]]);
  const p = partitionFindings([blocker, advisory], policy, overrides);
  assert.equal(p.blocking.length, 0, "override applies to the single blocking candidate");
  assert.equal(p.overridden.length, 1, "blocker is overridden");
  assert.equal(p.advisory.length, 1, "low-confidence finding remains advisory");
});

test("partition: same key + same normalized title but materially different bodies — override withheld, both stay blocking (#144 round-3)", () => {
  // The review-ceiling finding: title-only distinctness collapsed two genuinely
  // different findings (same severity/file/5-line band → same key; titles equal
  // after normalize — "Missing guard" vs "**Missing guard**") into one override,
  // letting a real blocker advance. Distinctness must use the full payload, so two
  // findings that differ only in body/recommendation/line are NOT collapsed.
  const f1 = finding({ severity: "high", file: "x.ts", title: "Missing guard", line_start: 46, body: "the foo path lacks a null check", recommendation: "guard foo" });
  const f2 = finding({ severity: "high", file: "x.ts", title: "**Missing guard**", line_start: 48, body: "the bar path lacks a bounds check", recommendation: "guard bar" });
  assert.equal(findingKey(f1), findingKey(f2), "precondition: same bucket → same key");
  assert.equal(normalizeTitle(f1.title), normalizeTitle(f2.title), "precondition: same normalized title");
  const overrides = new Map([[findingKey(f1), "rejected"]]);
  const p = partitionFindings([f1, f2], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.overridden.length, 0, "materially different findings must not collapse under one override");
  assert.equal(p.blocking.length, 2, "both genuinely distinct blockers remain blocking");
});

test("findingPayloadFingerprint: collapses exact-duplicate payloads, distinguishes different body/recommendation/line", () => {
  const base = finding({ severity: "high", file: "x.ts", title: "Missing guard", line_start: 46, body: "foo", recommendation: "fix foo" });
  assert.equal(findingPayloadFingerprint(base), findingPayloadFingerprint({ ...base }), "exact duplicate → same fingerprint");
  assert.equal(findingPayloadFingerprint(base), findingPayloadFingerprint({ ...base, title: "**Missing guard**" }), "title markdown/case normalized away");
  assert.notEqual(findingPayloadFingerprint(base), findingPayloadFingerprint({ ...base, body: "bar" }), "different body → different fingerprint");
  assert.notEqual(findingPayloadFingerprint(base), findingPayloadFingerprint({ ...base, recommendation: "fix bar" }), "different recommendation → different fingerprint");
  assert.notEqual(findingPayloadFingerprint(base), findingPayloadFingerprint({ ...base, line_start: 48 }), "different line → different fingerprint");
  // Omitted line_end means the single line line_start — must not diverge from explicit.
  assert.equal(
    findingPayloadFingerprint({ ...base, line_end: undefined }),
    findingPayloadFingerprint({ ...base, line_end: base.line_start }),
    "omitted line_end equals explicit single-line line_end",
  );
});

test("partition: exact-duplicate differing only by omitted vs explicit single-line line_end — override applies (#144 round-4)", () => {
  // The review-ceiling finding: the raw range fingerprint made `{46}` ("46-") and
  // `{46, line_end: 46}` ("46-46") distinct, so a verdict that merely duplicated the
  // same single-line finding read as ambiguous and withheld the override. With the
  // normalized range they collapse and the override applies.
  const f = finding({ severity: "high", file: "x.ts", title: "boom", line_start: 46 });
  const dup = { ...f, line_end: 46 };
  assert.equal(findingKey(f), findingKey(dup), "precondition: same key");
  const overrides = new Map([[findingKey(f), "rejected"]]);
  const p = partitionFindings([f, dup], { block_threshold: "low", min_confidence: 0 }, overrides);
  assert.equal(p.blocking.length, 0, "duplicate single-line finding is not a distinct candidate — override applies");
  assert.equal(p.overridden.length, 2, "both copies go to overridden");
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

// ---- structured spec-divergence marker (#106) ----

test("reviewCommentFlagsSpecDivergence: matches the emitted marker, not prose", () => {
  const withMarker = `### Findings\n\n**1. [HIGH] x** ${categoryMarker(SPEC_DIVERGENCE_CATEGORY)}`;
  assert.equal(reviewCommentFlagsSpecDivergence(withMarker), true);

  // Prose that *describes* divergence but carries no marker must NOT match.
  const prose = "The code diverges from the spec and is inconsistent with the requirement.";
  assert.equal(reviewCommentFlagsSpecDivergence(prose), false);

  // A different category marker must not match.
  assert.equal(reviewCommentFlagsSpecDivergence(`x ${categoryMarker("correctness")}`), false);
  assert.equal(reviewCommentFlagsSpecDivergence(""), false);
});

test("categoryMarker: single-sources the exact emitted token", () => {
  assert.equal(categoryMarker(SPEC_DIVERGENCE_CATEGORY), "`category: spec-divergence`");
});

// ---------------------------------------------------------------------------
// Scoped overrides (#229)
// ---------------------------------------------------------------------------

// ---- 6.1: parseOverrideArg — scope type parsing ----

test("parseOverrideArg: category scope parses to kind=scope with normalized value", () => {
  const r = parseOverrideArg("category:rollback-safety: deferred #90");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.kind, "scope");
  if (r.kind !== "scope") return;
  assert.equal(r.scopeType, "category");
  assert.equal(r.scopeValue, "rollback-safety");
  assert.equal(r.disposition, "deferred-#90");
  assert.equal(r.reason, "deferred #90");
});

test("parseOverrideArg: file scope parses to kind=scope", () => {
  const r = parseOverrideArg("file:src-tauri/src/repo.rs: deferred #90");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.kind, "scope");
  if (r.kind !== "scope") return;
  assert.equal(r.scopeType, "file");
  assert.equal(r.scopeValue, "src-tauri/src/repo.rs");
  assert.equal(r.disposition, "deferred-#90");
});

test("parseOverrideArg: category scope value is normalized to lowercase", () => {
  const r = parseOverrideArg("category:Rollback-Safety: rejected — handled");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  if (r.kind !== "scope") return;
  assert.equal(r.scopeValue, "rollback-safety");
  assert.equal(r.disposition, "rejected");
});

test("parseOverrideArg: bare 8-hex key still parses to kind=key (backward compat)", () => {
  const r = parseOverrideArg("a1b2c3d4: rejected — false positive");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.kind, "key");
  if (r.kind !== "key") return;
  assert.equal(r.key, "a1b2c3d4");
  assert.equal(r.disposition, "rejected");
});

test("parseOverrideArg: rejects empty scope value (category: with no name)", () => {
  // "category: reason" — the ": " separator is found but the value before it is empty
  // after trim (actually " reason" has no ": " so it errors on no-separator).
  // Either way it must fail.
  const r = parseOverrideArg("category:: reason");
  assert.ok("error" in r, "empty scope value must be rejected");
});

test("parseOverrideArg: rejects missing reason separator in scoped arg", () => {
  // "category:name" with no ": " separating value from reason
  const r = parseOverrideArg("category:rollback-safety");
  assert.ok("error" in r, "scope arg without ': <reason>' must be rejected");
});

test("parseOverrideArg: rejects empty reason in scoped arg", () => {
  // "category:name:   " — value is present but reason is blank after trim
  // Parsing: rest = "name:   ", sep at index 4 (colon-space "e:  " no...).
  // Actually "name:   " contains ": " at index 4 → value = "name", reason = "  ".trim() = "" → error
  const r = parseOverrideArg("category:rollback-safety:   ");
  assert.ok("error" in r, "empty reason must be rejected");
});

// ---- 6.2: partitionFindings — category scope ----

test("partitionFindings: category scope overrides all matching findings regardless of key", () => {
  // Two HIGH findings with category "rollback-safety", different keys.
  const f1 = finding({ severity: "high", title: "missing rollback A", file: "a.ts", line_start: 1, category: "rollback-safety" });
  const f2 = finding({ severity: "high", title: "missing rollback B", file: "b.ts", line_start: 1, category: "rollback-safety" });
  assert.notEqual(findingKey(f1), findingKey(f2), "precondition: different keys");

  const scopes: ScopedOverride[] = [{ type: "category", value: "rollback-safety", disposition: "deferred-#90", reason: "deferred #90" }];
  const p = partitionFindings([f1, f2], DEFAULT_POLICY, new Map(), scopes);

  assert.equal(p.blocking.length, 0, "no findings should block");
  assert.equal(p.overridden.length, 2, "both findings should be overridden");
  assert.ok(p.overridden.every((e) => e.kind === "scope"), "entries are kind=scope");
  assert.ok(p.overridden.every((e) => e.kind === "scope" && e.scopeType === "category" && e.scopeValue === "rollback-safety"), "scope info preserved");
});

test("partitionFindings: category scope does not affect non-matching category", () => {
  const f1 = finding({ severity: "high", title: "rollback missing", category: "rollback-safety" });
  const f2 = finding({ severity: "high", title: "auth missing", category: "security" });
  const scopes: ScopedOverride[] = [{ type: "category", value: "rollback-safety", disposition: "rejected", reason: "handled" }];
  const p = partitionFindings([f1, f2], DEFAULT_POLICY, new Map(), scopes);

  assert.equal(p.overridden.length, 1);
  assert.equal(p.overridden[0].kind === "scope" && p.overridden[0].scopeValue, "rollback-safety");
  assert.equal(p.blocking.length, 1, "security finding still blocks");
  assert.equal(p.blocking[0].category, "security");
});

test("partitionFindings: category scope ignores findings without a category", () => {
  const f = finding({ severity: "high", title: "no category" }); // no category field
  const scopes: ScopedOverride[] = [{ type: "category", value: "rollback-safety", disposition: "rejected", reason: "handled" }];
  const p = partitionFindings([f], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 0, "finding without category must not match");
  assert.equal(p.blocking.length, 1);
});

// ---- 6.3: partitionFindings — file scope ----

test("partitionFindings: file scope matches exact path", () => {
  const f = finding({ severity: "high", title: "T", file: "src/repo.rs" });
  const scopes: ScopedOverride[] = [{ type: "file", value: "src/repo.rs", disposition: "rejected", reason: "handled" }];
  const p = partitionFindings([f], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 1);
  assert.equal(p.blocking.length, 0);
});

test("partitionFindings: file scope matches directory prefix (directory-boundary-aware)", () => {
  const f1 = finding({ severity: "high", title: "A", file: "src-tauri/src/repo.rs" });
  const f2 = finding({ severity: "high", title: "B", file: "src-tauri/src/lib.rs" });
  const scopes: ScopedOverride[] = [{ type: "file", value: "src-tauri/src", disposition: "deferred-#90", reason: "deferred #90" }];
  const p = partitionFindings([f1, f2], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 2, "both files under the prefix should match");
  assert.equal(p.blocking.length, 0);
});

test("partitionFindings: file scope respects directory boundary — non-boundary prefix does NOT match", () => {
  // scope "src/repo" must NOT match "src/report.rs" (starts with "src/repo" but not "src/repo/")
  const f = finding({ severity: "high", title: "T", file: "src/report.rs" });
  const scopes: ScopedOverride[] = [{ type: "file", value: "src/repo", disposition: "rejected", reason: "handled" }];
  const p = partitionFindings([f], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 0, "non-boundary prefix match must not override");
  assert.equal(p.blocking.length, 1, "finding should still block normally");
});

test("partitionFindings: file scope ignores findings without a file", () => {
  const f = finding({ severity: "high", title: "no file" }); // no file field
  const scopes: ScopedOverride[] = [{ type: "file", value: "src/repo.rs", disposition: "rejected", reason: "handled" }];
  const p = partitionFindings([f], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 0, "finding without file must not match");
  assert.equal(p.blocking.length, 1);
});

// ---- 6.4: key-independence across a simulated re-review ----

test("partitionFindings: scoped override survives key drift across a simulated re-review", () => {
  // Round N: finding with key K1, category "rollback-safety".
  const roundNFinding = finding({ severity: "high", title: "rollback issue A", file: "x.ts", line_start: 10, category: "rollback-safety" });
  // Round N+1: reviewer re-emits the SAME concern at a different line band → new key K2.
  const roundNPlus1Finding = finding({ severity: "high", title: "rollback issue A — rephrased", file: "x.ts", line_start: 100, category: "rollback-safety" });
  assert.notEqual(findingKey(roundNFinding), findingKey(roundNPlus1Finding), "precondition: key drift between rounds");

  // The scoped override remains active regardless of key drift.
  const scopes: ScopedOverride[] = [{ type: "category", value: "rollback-safety", disposition: "deferred-#90", reason: "deferred #90" }];
  const pN = partitionFindings([roundNFinding], DEFAULT_POLICY, new Map(), scopes);
  const pN1 = partitionFindings([roundNPlus1Finding], DEFAULT_POLICY, new Map(), scopes);

  assert.equal(pN.overridden.length, 1, "round N: scope overrides finding with old key");
  assert.equal(pN1.overridden.length, 1, "round N+1: scope still overrides finding with new (drifted) key");
  assert.equal(pN1.blocking.length, 0, "round N+1: no blocker despite key drift");
});

// ---- 6.5: ambiguity-guard bypass ----

test("partitionFindings: scope overrides bypass the per-key ambiguity guard", () => {
  // Two materially distinct findings in the same 5-line bucket → same key.
  // A KEY override would be withheld by the ambiguity guard (two distinct blocking candidates).
  // A SCOPE override must override both — it is explicitly intended to match more than one.
  const f1 = finding({ severity: "high", file: "x.ts", title: "missing rollback check A", line_start: 46, body: "body A", category: "rollback-safety" });
  const f2 = finding({ severity: "high", file: "x.ts", title: "missing rollback check B", line_start: 48, body: "body B", category: "rollback-safety" });
  assert.equal(findingKey(f1), findingKey(f2), "precondition: same key (ambiguous for key override)");

  // Key override withheld by ambiguity guard:
  const keyOverrides = new Map([[findingKey(f1), "rejected"]]);
  const pKey = partitionFindings([f1, f2], DEFAULT_POLICY, keyOverrides);
  assert.equal(pKey.overridden.length, 0, "key override must be withheld for ambiguous findings");
  assert.equal(pKey.blocking.length, 2, "both remain blocking under key override");

  // Scope override bypasses the guard and overrides both:
  const scopes: ScopedOverride[] = [{ type: "category", value: "rollback-safety", disposition: "rejected", reason: "handled" }];
  const pScope = partitionFindings([f1, f2], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(pScope.overridden.length, 2, "scope must override both findings (bypass ambiguity guard)");
  assert.equal(pScope.blocking.length, 0, "no finding should block");
});

// ---- 6.6: sentinel round-trip ----

test("scopedOverrideComment round-trips through extractScopedOverrides", () => {
  const body = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "deferred-#90",
    reason: "deferred #90 — tracked in follow-up",
    stage: "review-2",
    timestamp: "2026-06-19T00:00:00Z",
  });

  // Verify human-readable fields are in the body.
  assert.match(body, /Scope.*category:rollback-safety/);
  assert.match(body, /deferred #90 — tracked in follow-up/);

  // Round-trip: extraction recovers the scope including the human reason (#229 fix).
  const scopes = extractScopedOverrides([{ body }]);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].type, "category");
  assert.equal(scopes[0].value, "rollback-safety");
  assert.equal(scopes[0].disposition, "deferred-#90");
  assert.equal(scopes[0].reason, "deferred #90 — tracked in follow-up", "reason must round-trip through sentinel");
});

test("extractScopedOverrides: later sentinel for the same scope wins", () => {
  const first = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "deferred-#90",
    reason: "first",
    stage: "review-1",
    timestamp: "2026-06-19T00:00:00Z",
  });
  const second = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "rejected",
    reason: "later revision",
    stage: "review-2",
    timestamp: "2026-06-19T01:00:00Z",
  });

  const scopes = extractScopedOverrides([{ body: first }, { body: second }]);
  assert.equal(scopes.length, 1, "later sentinel for same scope wins — still one entry");
  assert.equal(scopes[0].disposition, "rejected", "later disposition wins");
  assert.equal(scopes[0].reason, "later revision", "later reason wins");
});

test("extractScopedOverrides: backward-compat — old sentinel without reason falls back to disposition token", () => {
  // Old-format sentinel (no " | reason"): reason should equal the disposition token.
  // Must be wrapped in the controlled heading (scopedOverrideComment always generated it).
  const oldSentinel =
    "## Pipeline: Scope override\n\n" +
    "<!-- pipeline-override-scope: category:rollback-safety deferred-#90 -->";
  const scopes = extractScopedOverrides([{ body: oldSentinel }]);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].disposition, "deferred-#90");
  assert.equal(scopes[0].reason, "deferred-#90", "old sentinel: reason falls back to disposition token");
});

test("extractScopedOverrides: file scope sentinel round-trips", () => {
  const body = scopedOverrideComment({
    scopeType: "file",
    scopeValue: "src-tauri/src/repo.rs",
    disposition: "deferred-#90",
    reason: "deferred",
    stage: "needs-human",
    timestamp: "2026-06-19T00:00:00Z",
  });
  const scopes = extractScopedOverrides([{ body }]);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].type, "file");
  assert.equal(scopes[0].value, "src-tauri/src/repo.rs");
});

test("extractScopedOverrides: file scope with space in path round-trips (#229 Finding 2)", () => {
  // Regression: \S+ in the sentinel regex silently truncated paths with spaces.
  // scopedOverrideComment now percent-encodes the scope value; extractScopedOverrides decodes.
  const body = scopedOverrideComment({
    scopeType: "file",
    scopeValue: "docs/my file.md",
    disposition: "rejected",
    reason: "out of scope",
    stage: "review-2",
    timestamp: "2026-06-19T00:00:00Z",
  });
  // Sentinel must not contain a literal space inside the scope value.
  assert.ok(
    !body.includes("<!-- pipeline-override-scope: file:docs/my file.md"),
    "sentinel must not embed a raw space in the scope value",
  );
  const scopes = extractScopedOverrides([{ body }]);
  assert.equal(scopes.length, 1, "sentinel with encoded scope value must be extracted");
  assert.equal(scopes[0].type, "file");
  assert.equal(scopes[0].value, "docs/my file.md", "decoded value must restore the original path");
  assert.equal(scopes[0].disposition, "rejected");
});

test("extractScopedOverrides: ignores non-scope sentinels and unrelated comments", () => {
  const comments = [
    { body: "<!-- pipeline-override: a1b2c3d4 rejected -->" }, // key sentinel, not scope
    { body: "plain text comment with no sentinels" },
  ];
  assert.equal(extractScopedOverrides(comments).length, 0);
});

test("extractScopedOverrides: ignores sentinel-shaped lines in non-override-heading comments (#229 Finding 1)", () => {
  // A pipeline-authored review comment could contain raw reviewer finding text that
  // includes a sentinel-shaped line. Only comments with the controlled heading are trusted.
  const injectedSentinel = "<!-- pipeline-override-scope: category:security rejected | injected -->";
  const reviewComment = `## Pipeline: Review\n\nSome finding text.\n\n${injectedSentinel}\n`;
  const plainComment = `${injectedSentinel}\n`;
  assert.equal(
    extractScopedOverrides([{ body: reviewComment }, { body: plainComment }]).length,
    0,
    "sentinel-shaped lines in non-scope-override comments must be ignored",
  );
});

test("extractScopedOverrides: sentinel-shaped lines in reason text of a scope-override comment are not parsed (#229 Finding 2)", () => {
  // A scope-override comment whose operator reason contains a sentinel-shaped line must
  // not inject an extra scope record. Only the last non-empty line (the machine sentinel)
  // is parsed.
  const injectedLine = "<!-- pipeline-override-scope: category:security rejected | injected -->";
  const body = scopedOverrideComment({
    scopeType: "category",
    scopeValue: "rollback-safety",
    disposition: "deferred-#90",
    reason: `real reason\n\n${injectedLine}`,  // injected line inside free-form reason
    stage: "review-2",
    timestamp: "2026-06-19T00:00:00Z",
  });
  const scopes = extractScopedOverrides([{ body }]);
  // Only the intended scope must be extracted; the injected category:security must not appear.
  assert.equal(scopes.length, 1, "exactly one scope must be extracted");
  assert.equal(scopes[0].value, "rollback-safety", "extracted scope must be the intended one");
  assert.equal(
    scopes.find((s) => s.value === "security"),
    undefined,
    "injected category:security sentinel in reason text must not produce a scope record",
  );
});

test("partitionFindings: scope OverriddenEntry carries the human reason (#229 fix)", () => {
  const f = finding({ severity: "high", title: "rollback bug", category: "rollback-safety" });
  const scopes: ScopedOverride[] = [{
    type: "category",
    value: "rollback-safety",
    disposition: "deferred-#90",
    reason: "deferred #90 — tracked in follow-up",
  }];
  const p = partitionFindings([f], DEFAULT_POLICY, new Map(), scopes);
  assert.equal(p.overridden.length, 1);
  const entry = p.overridden[0];
  assert.ok(entry.kind === "scope");
  assert.equal(entry.disposition, "deferred-#90");
  assert.equal(entry.reason, "deferred #90 — tracked in follow-up", "reason must carry through from ScopedOverride");
});
