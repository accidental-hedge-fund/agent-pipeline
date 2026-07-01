You are implementing a GitHub issue for {{domain_name}}, {{domain_description}}.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}

## Implementation Plan

{{plan}}
{{spec_context}}
## Instructions

1. Read this repo's conventions file (`CLAUDE.md` or `AGENTS.md`, depending on your host) for the full conventions — an excerpt is already included above.
2. Implement the plan above. Write clean, well-tested code appropriate to the repo stack.
3. Reuse existing repo patterns for routing, shared utilities, schema changes, tests, and CI-facing checks instead of inventing parallel paths.
4. Write or update tests that cover the new or changed behavior, focusing on the smallest relevant suites for the touched surfaces.
5. Run the relevant formatter, typecheck, and test commands already used by this repo's CI for the files you changed.
6. Commit all changes with a descriptive message referencing #{{issue_number}}.
   Append these two git trailers to the bottom of every commit message, after a
   blank line (standard git trailer format):

       Issue: #{{issue_number}}
       Pipeline-Run: {{pipeline_run_id}}
7. Do NOT push — the pipeline handles pushing after review.
{{docs_instruction}}
## Important
- Keep changes minimal and focused on the issue scope.
- Do not make migrations, infra changes, or product-scope expansions unless the issue/plan actually calls for them.
- If you encounter a blocker that prevents completion, describe it clearly in your final output.
- **Injectable-dep rule:** Any new code path that calls an external CLI or API (`gh`, `git`, network, auth) MUST go through an injectable dep — never call the module-level function directly when a seam already exists on the `Deps` type. If no seam exists, add one. Tests that only pass because local auth is active are NOT passing tests — they will fail in CI. Every new test must cover the unauthenticated/no-network path and prove it fails without the injected fake.
