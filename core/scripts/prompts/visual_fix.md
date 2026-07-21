You are fixing visual-gate failures for issue #{{issue_number}}.

{{conventions}}

The repository's visual-gate (E2E/visual) command was run in the worktree and FAILED:

    {{command}}

This is visual-fix attempt {{attempt}} of {{max_attempts}} total visual-gate attempts.

## Failed gate

- **Gate**: visual-gate
- **Command**: `{{command}}`

## Visual gate output

{{visual_output}}

## Captured artifacts

{{artifacts}}

## Instructions

1. Read the output above and find the ROOT CAUSE of the regression. If artifact
   paths are listed above, open them in the worktree to see what actually
   rendered (screenshots, diffs, traces).
2. Fix the code so that `{{command}}` passes. Prefer fixing the implementation
   over weakening or deleting visual/E2E assertions — only change a check if it
   is genuinely wrong.
3. Do NOT make unrelated changes.
4. Commit ALL changes with message: `fix: resolve visual-gate failures (#{{issue_number}})`.
   The gate re-runs the command after you finish and will NOT trust uncommitted
   changes, so you must commit your fix. Append these two git trailers to the
   bottom of every commit message, after a blank line (standard git trailer
   format):

       Issue: #{{issue_number}}
       Pipeline-Run: {{pipeline_run_id}}
5. If the failure genuinely cannot be resolved (it needs a product/design
   decision, or the visual command itself is misconfigured), explain the
   blocker clearly in your output instead of guessing.
