## ADDED Requirements

### Requirement: Gate-fix prompts SHALL declare the invocation single-turn

The gate-fix prompt templates `test_fix.md`, `eval_fix.md`, and `visual_fix.md` SHALL each state
that the harness invocation is single-turn: there is no subsequent turn in which deferred work can
complete. Each SHALL instruct the harness to run its gate command in the foreground and never end its
turn while committing depends on a background task (for example a test/eval/visual gate command
launched in the background and not yet awaited), and to wait synchronously for such a task rather than
deferring to a notification it will never receive. Consistent with these stages committing but not
pushing (the pipeline handles pushing), the discipline SHALL apply to committing only and SHALL NOT
direct the harness to push. Every existing placeholder and instruction in each prompt SHALL remain
intact.

#### Scenario: Each gate-fix prompt contains the single-turn discipline

- **WHEN** the prompt templates are loaded
- **THEN** `test_fix.md`, `eval_fix.md`, and `visual_fix.md` SHALL each contain text stating the
  invocation is single-turn
- **AND** SHALL each forbid ending the turn while a commit depends on a background task
- **AND** SHALL each direct the harness to wait synchronously for such work and run the gate command
  in the foreground

#### Scenario: Gate-fix discipline is drift-guarded

- **WHEN** the single-turn discipline text is removed from `test_fix.md`, `eval_fix.md`, or
  `visual_fix.md`
- **THEN** a `prompt-loader.test.ts` assertion SHALL fail

#### Scenario: Rendered gate-fix prompts still satisfy existing placeholder contracts

- **WHEN** a gate-fix prompt is rendered for an attempt
- **THEN** every existing placeholder (for example `{{command}}`, `{{attempt}}`, `{{max_attempts}}`,
  `{{issue_number}}`, `{{pipeline_run_id}}`) SHALL still be substituted
- **AND** the existing commit-message and trailer instructions SHALL remain present
