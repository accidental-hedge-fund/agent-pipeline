## ADDED Requirements

### Requirement: The `loop` operation SHALL use long-running packaging, not the shared fast template

The single-source operation list used by `scripts/build.mjs` SHALL classify the
`loop` operation so that `renderClaudeCommand` does not apply the shared
“Run synchronously (completes in seconds). No background process or Monitor
needed.” template to multi-item drive/resume packaging. Other true-fast
operations (`status`, `doctor`, `cleanup`, and peers that remain seconds-long)
SHALL continue to use that template.

#### Scenario: Loop is not rendered with the fast template

- **WHEN** `renderClaudeCommand` is invoked for the `loop` operation
- **THEN** the result SHALL NOT include the shared fast-template sentence that
  claims seconds-only completion and forbids Monitor
- **AND** the result SHALL include a long-running or event-follow orchestration
  note (or a pointer to host skill loop orchestration)

#### Scenario: True-fast peers still use the fast template

- **WHEN** `renderClaudeCommand` is invoked for a true-fast operation such as
  `status` or `doctor`
- **THEN** the result MAY still include the shared seconds-only / no-Monitor
  template
