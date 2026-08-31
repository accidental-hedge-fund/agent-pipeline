## ADDED Requirements

### Requirement: Generated CLI reference SHALL publish executable `handoff` verb grammar

Command-docs metadata for the `handoff` registry keyword SHALL describe the executable operator grammar for `list`, `show`, `answer`, `reject`, and `supersede`. Generated `docs/cli.md` SHALL include those forms as complete `pipeline …` usage alternatives. The published grammar SHALL name the real flags used by dispatch, including `--filter-status` for list, and SHALL NOT present `--status` as a handoff list filter. The published grammar SHALL NOT document a module-invocation workaround as the operator path.

#### Scenario: Each documented verb has an executable usage alternative

- **WHEN** the CLI reference generator runs against current command-docs
- **THEN** `docs/cli.md` SHALL include complete `pipeline handoff list`, `pipeline handoff show <handoff-id>`, `pipeline handoff answer <handoff-id>`, `pipeline handoff reject <handoff-id>`, and `pipeline handoff supersede <handoff-id>` usage alternatives

#### Scenario: Docs name executable flags, not a workaround

- **WHEN** an operator reads the generated `handoff` usage in `docs/cli.md`
- **THEN** the text SHALL NOT instruct the operator to invoke the handoff module directly
- **AND** list-filter usage SHALL name `--filter-status`, not `--status`
