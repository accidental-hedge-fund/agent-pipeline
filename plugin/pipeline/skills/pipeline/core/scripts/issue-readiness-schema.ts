// Single source of truth for the issue-implementation-readiness admission
// verdict JSON schema (#1238).
//
// The admission prompt (`issue_readiness.md`) references this block via
// `{{schema_block}}`. The builder substitutes ISSUE_READINESS_SCHEMA_BLOCK
// before the prompt is sent. `substitute()` throws on an unfilled placeholder.

import type { IssueReadinessVerdict } from "./types.ts";

export const ISSUE_READINESS_SCHEMA_BLOCK = `{
    "verdict": "ready" | "needs_spec",
    "deficiencies": ["<concrete missing or contradictory requirement, empty when ready>"],
    "proposed_body": "<revised issue body with Summary, User story, Acceptance criteria, Out of scope, and Open questions; empty string when ready>"
}`;

const VERDICT_FIELD_GUARD: Record<keyof IssueReadinessVerdict, true> = {
  verdict: true,
  deficiencies: true,
  proposed_body: true,
};

export const ISSUE_READINESS_SCHEMA_FIELDS = Object.keys(VERDICT_FIELD_GUARD);
