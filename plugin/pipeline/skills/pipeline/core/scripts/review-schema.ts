// Single source of truth for the review verdict JSON schema (#56).
//
// The reviewer prompts (`review_standard.md`, `review_adversarial.md`) used to
// hand-copy this JSON block verbatim, independent of the `ReviewFinding` /
// `ReviewVerdict` types that `parseStructuredVerdict` actually reads. When the
// copies drifted, the reviewer emitted a shape the parser silently dropped —
// findings disappear → `needs-attention/0` → blocked run (the failure class
// fixed in #45/#50/#52/#54). This file makes the block exist in exactly one
// place and adds a drift guard (see review-schema.test.ts).
//
// The prompts reference it through a `{{schema_block}}` placeholder; the prompt
// builders in `prompts/index.ts` substitute `REVIEW_VERDICT_SCHEMA_BLOCK` for
// that placeholder before the prompt is sent. `substitute()` throws on an
// unfilled placeholder, so a missing substitution is a hard error rather than a
// prompt that reaches the reviewer with a literal `{{schema_block}}` token.

import type { ReviewFinding, ReviewVerdict, ShipcheckVerdict, ShipcheckCriterion } from "./types.ts";

// The JSON body the reviewer is told to return. Field names and nesting order
// MUST match `ReviewFinding` / `ReviewVerdict`; the drift guard test fails if
// they diverge. No leading/trailing newline so substitution into the fenced
// block in the `.md` files is byte-for-byte identical to the former hand-copy.
export const REVIEW_VERDICT_SCHEMA_BLOCK = `{
    "verdict": "approve" or "needs-attention",
    "summary": "<terse ship/no-ship assessment>",
    "findings": [
        {
            "severity": "critical" | "high" | "medium" | "low",
            "title": "<short title>",
            "body": "<what's wrong and why it matters>",
            "file": "<relative file path>",
            "line_start": <int>,
            "line_end": <int>,
            "confidence": <0.0-1.0>,
            "recommendation": "<concrete fix>",
            "category": "<optional: spec-divergence|correctness|security|...>",
            "blocking": true | false
        }
    ],
    "next_steps": ["<action item>"]
}`;

// Compile-time exhaustiveness guards: a `Record` keyed by every emitted field of
// each interface. Adding a field to `ReviewFinding` / `ReviewVerdict` (missing
// key → type error) or removing one (excess key → type error) forces this file
// to be updated, which keeps the type side and the schema block honest in any
// TypeScript-aware editor. `commitSha` is excluded from the verdict side: it is
// stamped by the review stage from the PR head, never emitted by the reviewer
// (see `ReviewVerdict` in types.ts), so it must NOT appear in the schema block.
const FINDING_FIELD_GUARD: Record<keyof ReviewFinding, true> = {
  severity: true,
  title: true,
  body: true,
  file: true,
  line_start: true,
  line_end: true,
  confidence: true,
  recommendation: true,
  category: true,
  blocking: true,
};
const VERDICT_FIELD_GUARD: Record<Exclude<keyof ReviewVerdict, "commitSha">, true> = {
  verdict: true,
  summary: true,
  findings: true,
  next_steps: true,
};

// Runtime field manifest the drift guard test compares against the field names
// parsed out of `REVIEW_VERDICT_SCHEMA_BLOCK`. Derived from the typed guards
// above so the two cannot drift from each other; insertion order matches the
// block for readability.
export const REVIEW_SCHEMA_FIELDS = {
  verdict: Object.keys(VERDICT_FIELD_GUARD),
  finding: Object.keys(FINDING_FIELD_GUARD),
};

// ---------------------------------------------------------------------------
// Shipcheck verdict schema (#148) — single source of truth for the shipcheck-gate
// reviewer prompt. Mirrors the pattern above: schema block + typed guard +
// field manifest, all three kept in sync.
// ---------------------------------------------------------------------------

export const SHIPCHECK_VERDICT_SCHEMA_BLOCK = `{
    "verdict": "pass" | "partial" | "fail",
    "summary": "<one-line acceptance assessment>",
    "criteria": [
        {
            "criterion": "<rubric criterion name>",
            "result": "pass" | "fail" | "na",
            "note": "<brief explanation>"
        }
    ]
}`;

const SHIPCHECK_CRITERION_FIELD_GUARD: Record<keyof ShipcheckCriterion, true> = {
  criterion: true,
  result: true,
  note: true,
};
const SHIPCHECK_VERDICT_FIELD_GUARD: Record<keyof ShipcheckVerdict, true> = {
  verdict: true,
  summary: true,
  criteria: true,
};

export const SHIPCHECK_SCHEMA_FIELDS = {
  verdict: Object.keys(SHIPCHECK_VERDICT_FIELD_GUARD),
  criterion: Object.keys(SHIPCHECK_CRITERION_FIELD_GUARD),
};
