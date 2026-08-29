You are implementing a GitHub issue for {{domain_name}}, {{domain_description}}.

{{conventions}}
{{ship_path_autonomy_preamble}}
## Issue #{{issue_number}}: {{title}}

{{body}}

## Implementation Plan

{{plan}}
{{spec_context}}
## Read the touched code first

Before writing, read the files you will change — the modules, tests, and call sites in scope — and the patterns they already use. Stop at the first holding rung of the reuse ladder after that read, never instead of it. Skipping the read is not a rung.

<!-- 7-rung reuse ladder adapted from Ponytail (https://github.com/DietrichGebert/ponytail), MIT License. Attribution only; this pipeline is not ponytail and does not install the ponytail host plugin. -->
## Reuse ladder (stop at the first holding rung)

Stop at the first rung that holds, after reading the touched code:

1. Does this need to exist? → skip (YAGNI)
2. Already in this codebase? → reuse
3. Stdlib does it? → use it
4. Native platform feature? → use it
5. Already-installed dependency? → use it. Never add a new one for what a few lines can do
6. One line? → one line
7. Only then: the minimum that works

Do not add unrequested abstractions: a one-implementation interface, a factory for one product, or a config key for a constant. A bug fix addresses the root cause at the shared function, not a guard in every named caller.

Never simplify away trust-boundary validation, data-loss error handling, security, accessibility, or anything the issue or plan explicitly requests. YAGNI does not apply to tests: new features still need unit tests; bug fixes still need a regression test. Do not shrink the issue. Keep git trailers, completeness, DNR / needs-human markers, design-gate, and papercut instructions. Do not replace them with a three-line output contract.

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
7. Do NOT push — the pipeline handles pushing after review. If you do push, use the worktree's existing origin/pushurl as prepared by the pipeline; do not reconfigure origin to HTTPS via ambient `gh auth setup-git` / `gh auth git-credential` (classic PATs often lack the GitHub `workflow` scope and reject `.github/workflows/**` updates).
{{docs_instruction}}{{papercut_instruction}}{{design_gate_instruction}}
## Single-Turn Invocation (required)
This invocation is single-turn: there is no later turn in which deferred work can complete. Do NOT end your turn while committing still depends on a background task (e.g. a test suite launched in the background and not yet awaited) — wait synchronously for that work to finish, then commit, before ending the turn. A notification that arrives after your turn ends will never reach you. Per instruction 7 above, do NOT push — the pipeline handles pushing after review.

## Important
- Keep changes minimal and focused on the issue scope.
- Do not make migrations, infra changes, or product-scope expansions unless the issue/plan actually calls for them.
- If you encounter a blocker that prevents completion, describe it clearly in your final output.
- **Injectable-dep rule:** Any new code path that calls an external CLI or API (`gh`, `git`, network, auth) MUST go through an injectable dep — never call the module-level function directly when a seam already exists on the `Deps` type. If no seam exists, add one. Tests that only pass because local auth is active are NOT passing tests — they will fail in CI. Every new test must cover the unauthenticated/no-network path and prove it fails without the injected fake.
