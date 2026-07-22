# single-turn-harness-discipline Specification

## Purpose
TBD - created by archiving change fix-stage-harness-crash-retry. Update Purpose after archive.
## Requirements
### Requirement: Implement and fix prompts SHALL declare the invocation single-turn

The `implementing.md` and `fix.md` prompt templates SHALL state that the harness invocation is
single-turn: there is no subsequent turn in which deferred work can complete. Each prompt SHALL
instruct the harness never to end its turn while required work depends on a background task, and
to wait synchronously for such a task instead of deferring to a notification it will never
receive. `fix.md` SHALL apply this to both committing and pushing, consistent with the fix stage
pushing its own commits. `implementing.md` SHALL apply this to committing only, consistent with
its existing instruction that the implementing stage does not push — the pipeline pushes after
review.

#### Scenario: Both prompts contain the single-turn discipline

- **WHEN** the prompt templates are loaded
- **THEN** `implementing.md` and `fix.md` SHALL each contain text stating the invocation is
  single-turn
- **AND** `fix.md` SHALL forbid ending the turn with commit or push pending on a background task
- **AND** `implementing.md` SHALL forbid ending the turn with commit pending on a background task,
  without directing it to push
- **AND** SHALL each direct the harness to wait synchronously for such work

#### Scenario: Discipline is drift-guarded

- **WHEN** the single-turn discipline text is removed from either prompt
- **THEN** a `prompt-loader.test.ts` assertion SHALL fail

#### Scenario: Rendered prompts still satisfy existing placeholder contracts

- **WHEN** the fix prompt is rendered for a round
- **THEN** every existing placeholder SHALL still be substituted and the existing surgical-fix and
  safety-scope discipline text SHALL remain present

