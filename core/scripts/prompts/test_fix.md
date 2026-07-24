You are fixing failing tests/build for issue #{{issue_number}}.

{{conventions}}

The repository's own test/build command was run in the worktree and FAILED:

    {{command}}

This is fix attempt {{attempt}} of {{max_attempts}}.

## Failure output

{{test_output}}

## Instructions

1. Read the failure output above and find the ROOT CAUSE of the failure.
2. Fix the code so that `{{command}}` passes. Prefer fixing the implementation
   over weakening or deleting tests — only change a test if it is genuinely wrong.
3. Do NOT make unrelated changes.
4. Commit ALL changes with message: `fix: resolve test/build failures (#{{issue_number}})`.
   The gate re-runs the command after you finish and will NOT trust uncommitted
   changes, so you must commit your fix. Append these two git trailers to the
   bottom of every commit message, after a blank line (standard git trailer
   format):

       Issue: #{{issue_number}}
       Pipeline-Run: {{pipeline_run_id}}
5. If the failure genuinely cannot be resolved (it needs a product decision, or
   the command itself is misconfigured), explain the blocker clearly in your
   output instead of guessing.

## Single-Turn Invocation (required)
This invocation is single-turn: there is no later turn in which deferred work can complete. Run `{{command}}` synchronously in the foreground — do NOT launch it in the background and end your turn waiting for a notification; no notification will ever arrive in this environment. Do NOT end your turn while committing still depends on a background task — wait synchronously for the command to finish, then commit, before ending the turn.
