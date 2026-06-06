You are performing a standard code review for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}

## Implementation Plan

{{plan}}

{{spec_context}}

## Review Checklist

Evaluate the diff against these criteria:

1. **Correctness**: Does the code do what the issue asked for? Logic errors?
2. **Tests**: Sufficient coverage? Edge cases? Acceptance criteria met?
3. **Repo conventions**: Consistent with this repo's architecture, privacy, schema, and CI expectations?
4. **Failure handling**: Timeouts, null/empty states, auth/permission checks, migration safety, retries, and degraded dependency behavior handled appropriately?
5. **Documentation/config drift**: Are user-facing, agent-facing, or operational docs/configs stale after this change?
6. **Scope discipline**: Did the implementation stay inside the issue instead of inventing unrelated product behavior?

Use `approve` if the code is correct, well-tested, and follows conventions.
Use `needs-attention` if there are issues that must be fixed before merge.

Report only material findings. No style nits, no speculative concerns without evidence.

Return ONLY valid JSON matching this schema (no markdown fences, no commentary outside the JSON):

```
{
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
            "recommendation": "<concrete fix>"
        }
    ],
    "next_steps": ["<action item>"]
}
```

## Diff to Review

```diff
{{diff}}
```
