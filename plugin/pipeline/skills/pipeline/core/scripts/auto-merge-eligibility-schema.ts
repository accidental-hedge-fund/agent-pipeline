// Single source of truth for the eligibility judge JSON schema (#306).
//
// The judge prompt (`auto_merge_eligibility_judge.md`) references this block
// via `{{schema_block}}`; the gate stage substitutes ELIGIBILITY_JUDGE_SCHEMA_BLOCK
// before the prompt is sent. `substitute()` throws on an unfilled placeholder,
// so a missing substitution is a hard error rather than a literal token in the
// prompt. The drift guard test (auto-merge-eligibility-schema.test.ts) fails if
// the block diverges from the EligibilityJudgeOutput interface in types.ts.

import type { EligibilityJudgeOutput } from "./types.ts";

// The JSON body the judge is told to return. Field names and order MUST match
// EligibilityJudgeOutput in types.ts; the drift guard test fails if they diverge.
// No leading/trailing newline so substitution into the fenced block is clean.
export const ELIGIBILITY_JUDGE_SCHEMA_BLOCK = `{
    "scope_size": "tiny" | "small" | "medium" | "large",
    "blast_radius": "low" | "medium" | "high",
    "semantic_risk": "mechanical" | "localized_behavior" | "cross_cutting_behavior",
    "reversibility": "trivial" | "normal" | "painful",
    "confidence": <0.0-1.0>,
    "reasons": ["<supporting evidence for the classification>"],
    "denial_reasons": ["<reason the judge recommends needs-human, or empty array if eligible>"]
}`;

// Compile-time exhaustiveness guard: a `Record` keyed by every emitted field of
// EligibilityJudgeOutput. Adding a field to the interface (missing key → type
// error) or removing one (excess key → type error) forces this file to update,
// keeping the type side and the schema block honest in any TypeScript-aware editor.
const JUDGE_OUTPUT_FIELD_GUARD: Record<keyof EligibilityJudgeOutput, true> = {
  scope_size: true,
  blast_radius: true,
  semantic_risk: true,
  reversibility: true,
  confidence: true,
  reasons: true,
  denial_reasons: true,
};

// Runtime field manifest the drift guard test compares against the field names
// parsed out of ELIGIBILITY_JUDGE_SCHEMA_BLOCK. Derived from the typed guard
// above so the two cannot drift from each other.
export const ELIGIBILITY_JUDGE_SCHEMA_FIELDS = Object.keys(JUDGE_OUTPUT_FIELD_GUARD);
