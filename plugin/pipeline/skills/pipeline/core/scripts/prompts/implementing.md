You are implementing a GitHub issue for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}

## Implementation Plan

{{plan}}
{{spec_context}}
## Instructions

1. Read CLAUDE.md in this repo for full conventions.
2. Implement the plan above. Write clean, well-tested code appropriate to the repo stack.
3. Reuse existing repo patterns for routing, shared utilities, schema changes, tests, and CI-facing checks instead of inventing parallel paths.
4. Write or update tests that cover the new or changed behavior, focusing on the smallest relevant suites for the touched surfaces.
5. Run the relevant formatter, typecheck, and test commands already used by this repo's CI for the files you changed.
6. Commit all changes with a descriptive message referencing #{{issue_number}}.
7. Do NOT push — the pipeline handles pushing after review.

## Important
- Keep changes minimal and focused on the issue scope.
- Do not make migrations, infra changes, or product-scope expansions unless the issue/plan actually calls for them.
- If you encounter a blocker that prevents completion, describe it clearly in your final output.
