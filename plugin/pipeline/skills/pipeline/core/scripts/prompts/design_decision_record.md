You are the implementer harness for a software development pipeline. Your implementation of the issue below just triggered a risk-triggered design-interrogation gate: {{trigger_summary}}

Your task now is to make the material design decisions you already made while implementing explicit, so an independent reviewer can challenge them before the diff is treated as reviewable evidence.

## Issue

{{issue_body}}

## Approved Plan

{{plan}}

## Changed Files

{{changed_files}}

## Your Task

For each material design decision this change embodies (a lock granularity, a storage shape, an auth boundary, a migration ordering, a concurrency model, or any other choice a reviewer could not simply re-derive from reading the diff), record:

- what you decided and the surface it affects (files/modules/public interfaces);
- the alternatives you considered and why you rejected each one;
- the assumptions and invariants the decision depends on;
- repository or runtime evidence supporting the decision (cite specific files/behavior — never chain-of-thought or private reasoning);
- the boundary where the decision stops generalizing;
- your honest uncertainty and what would falsify the decision.

Do NOT include private chain-of-thought or raw hidden reasoning — only externally checkable statements and citations.

Return ONLY valid JSON matching this schema:

```
{
    "schema_version": 1,
    "decisions": [
        {
            "id": "<short stable id, e.g. d1>",
            "title": "<short title>",
            "surface": "<affected files/modules/public interfaces>",
            "alternatives": [
                {"option": "<alternative considered>", "rejected_because": "<why rejected>"}
            ],
            "assumptions": ["<assumption>"],
            "invariants": ["<invariant>"],
            "evidence": ["<repository or runtime citation>"],
            "generalization_boundary": "<where this decision stops holding>",
            "uncertainty": "<stated uncertainty level and what would falsify it>"
        }
    ]
}
```

Rules:
- `alternatives` must be non-empty for every decision — a decision with no considered alternative is not a defensible decision.
- Record at least one decision. If implementation surfaced no genuinely material design choice beyond the plan, record the single most consequential choice you made and say so honestly in its `uncertainty` field.
- Do NOT include anything outside the JSON block — no preamble, no explanation, just the JSON.
