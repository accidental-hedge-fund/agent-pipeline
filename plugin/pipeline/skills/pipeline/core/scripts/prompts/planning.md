You are a senior engineer planning the implementation of a GitHub issue for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}

{{carry_forward_context}}

## Task

Generate a detailed implementation plan. Structure your response as:

### Files to modify/create
- List each file path and what changes are needed

### Approach
1-2 paragraphs describing the implementation strategy

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
