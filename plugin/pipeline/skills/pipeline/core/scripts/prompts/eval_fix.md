You are fixing eval-gate failures for issue #{{issue_number}}.

{{conventions}}

The repository's eval-gate command was run in the worktree and FAILED:

    {{command}}

This is eval-fix attempt {{attempt}} of {{max_attempts}} total eval-gate attempts.

## Failed gate

- **Gate**: eval-gate
- **Command**: `{{command}}`

## Eval output

{{eval_output}}

## Instructions

1. Read the eval output above and find the ROOT CAUSE of the regression.
2. Fix the code so that `{{command}}` passes. Prefer fixing the implementation
   over weakening or deleting eval assertions — only change an eval case if it is
   genuinely wrong.
3. Do NOT make unrelated changes.
4. Commit ALL changes with message: `fix: resolve eval-gate failures (#{{issue_number}})`.
   The gate re-runs the command after you finish and will NOT trust uncommitted
   changes, so you must commit your fix. Append these two git trailers to the
   bottom of every commit message, after a blank line (standard git trailer
   format):

       Issue: #{{issue_number}}
       Pipeline-Run: {{pipeline_run_id}}
5. If the failure genuinely cannot be resolved (it needs a product decision, or
   the eval command itself is misconfigured), explain the blocker clearly in your
   output instead of guessing.
