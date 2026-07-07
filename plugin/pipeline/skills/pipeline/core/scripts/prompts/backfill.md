You are analyzing the accepted behavior of a software repository to produce a graded list of candidate legacy requirements for OpenSpec backfill.

## Context

Repository: {{repo_context}}

## Living specification inventory

The following requirements are already covered in the living specs under `openspec/specs/`. These represent the current contract and MUST NOT be duplicated or weakened.

{{living_spec_inventory}}

## Evidence corpus

The following evidence comes from the repository's tests, documentation, code, and merged commit history. Use it to identify user-visible behaviors that are accepted but not yet represented in the living specs.

{{evidence_corpus}}

## Task

Enumerate candidate legacy behaviors that:
1. Are user-visible (a maintainer or end-user would notice if they changed)
2. Are demonstrated as accepted by the evidence (not merely accidental implementation details)
3. Are NOT already covered by a living requirement above

For each candidate, produce a structured entry with:
- **behavior**: a concise statement of the user-visible behavior (one sentence, active voice)
- **provenance**: at least one concrete evidence reference (test name, doc section, code path, or merged commit) that demonstrates this behavior is accepted
- **evidence_grade**: one of `sufficient` (concrete, unambiguous evidence), `conflicting` (evidence sources disagree or contradicts a living requirement), or `uncertain` (weak, inferred, or missing evidence)
- **conflicts_with**: if `evidence_grade` is `conflicting`, name the living requirement or evidence source it conflicts with (otherwise `null`)

## Output format

Return a JSON array of candidate objects. Do NOT include any explanatory text outside the JSON.

```json
[
  {
    "behavior": "<one-sentence user-visible behavior description>",
    "provenance": "<concrete evidence reference: test name, doc section, code path, or commit SHA/message>",
    "evidence_grade": "sufficient" | "conflicting" | "uncertain",
    "conflicts_with": "<living requirement name or null>"
  }
]
```

## Guidelines

- Only include behaviors that a user or maintainer would observe externally. Internal implementation details that have no observable effect are NOT candidates.
- A behavior with no concrete provenance (no test, no doc, no code path you can cite) MUST be graded `uncertain`.
- A behavior that contradicts or weakens a living requirement MUST be graded `conflicting` with `conflicts_with` set.
- Be exhaustive but precise: better to grade something `uncertain` than to invent provenance.
- Do NOT include behaviors already present in the living spec inventory above.
- Return ONLY the JSON array. No preamble, no explanation.
