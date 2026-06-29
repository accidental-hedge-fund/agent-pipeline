You are a senior engineer planning the implementation of a GitHub issue for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}{{context_snapshot}}

{{carry_forward_context}}

## Research first (before drafting)

Before writing the plan, read the files most directly in scope for this issue — the modules, tests, and call sites you expect to touch — and identify the patterns they establish (naming, error handling, dependency-injection seams, test structure, CI-facing checks). You have full repo read access; use it. The conventions excerpt above is a summary, not a substitute for reading the actual code. Ground the plan in what this repo already does, not generic best practice. If a file you expected to read does not exist, note that and continue — do not block.

## Task

Generate a detailed implementation plan. Structure your response as:

### Files to modify/create
- List each file path and what changes are needed

### Approach
1-2 paragraphs describing the implementation strategy. Cite at least one concrete pattern from the repo files you read — name the file and the pattern — and explain how this plan follows it. Do not substitute generic advice for a real pattern in the codebase.

### Acceptance criteria
- A checkable list (`- [ ]`) of the observable outcomes that make this issue done.
- Each item MUST be falsifiable: a concrete, verifiable behavior or artifact (e.g. "running `X` produces `Y`", "calling `f()` with `…` returns `…`"), not a restatement of the approach or an implementation step.
- These criteria are the target the implementation must hit and the natural input to the eval gate.

### Test strategy
- What tests to add or modify
- Edge cases to cover
- How to verify correctness

### Risk assessment
- What could go wrong
- Rollback plan if needed
- Any areas of the codebase that are especially sensitive

### Scope
One of: small (1-3 files, <50 lines changed), medium (3-8 files, 50-200 lines), large (8+ files, 200+ lines)

Be specific about file paths and function names. Reference existing patterns in the codebase where applicable.
