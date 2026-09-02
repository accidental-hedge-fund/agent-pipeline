## ADDED Requirements

### Requirement: Generated CLI docs SHALL agree with command-form dispositions

The CLI reference generator SHALL emit `docs/cli.md` from `COMMAND_REGISTRY`, co-located documentation metadata, and `OPERATION_SURFACE` without contradicting the executable command-form inventory. `OPERATION_SURFACE` SHALL remain the host SKILL catalog and SHALL NOT be presented as the complete command-form inventory. Generated usage SHALL list documented dry-run, apply, and status forms so that a `read-only` dry-run or status form is not described as a mutating drive. Host SKILL tables SHALL stay byte-identical across Claude, Codex, Grok, and OpenCode and SHALL use `pipeline <verb>` invocations.

#### Scenario: Dry-run usage matches read-only disposition

- **WHEN** a command form is classified `read-only` as a documented `--dry-run`
- **THEN** generated `docs/cli.md` SHALL include that `--dry-run` usage
- **AND** SHALL NOT describe that invocation as starting a durable run or merging

#### Scenario: Host catalog is not the complete inventory

- **WHEN** the generator writes host SKILL tables from `OPERATION_SURFACE`
- **THEN** those tables MAY omit dispatch-only or hidden keywords
- **AND** `docs/cli.md` SHALL still list documented registry commands
- **AND** omitted host-table verbs that exist in `COMMAND_REGISTRY` SHALL still have inventory forms

#### Scenario: Status sub-verb is not numeric advance

- **WHEN** generated docs list `ship status` or `grill status`
- **THEN** those lines SHALL match the `read-only` status form
- **AND** SHALL NOT treat `status` as an advance issue number
