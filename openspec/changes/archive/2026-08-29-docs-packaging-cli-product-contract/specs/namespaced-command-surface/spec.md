## ADDED Requirements

### Requirement: Host command entries SHALL be documented as CLI shims, not the product surface

Operator and contributor packaging docs SHALL describe each `pipeline:<command>` host entry as a shim that execs the `pipeline` CLI. Those docs SHALL NOT present a `/pipeline:*` slash-command pack as the product or as a required install surface. This requirement SHALL NOT delete generated host command files in this slice. Deletion of `plugin/` and stop of `/pipeline:*` file emission remain issues #1050 and #1048.

#### Scenario: Packaging docs reclassify slash commands

- **WHEN** a reader opens `docs/packaging.md`
- **THEN** the page SHALL state that a `/pipeline:*` slash-command pack is not required as the product
- **AND** it SHALL describe such entries as optional shims that exec the CLI

#### Scenario: Generated host command files still exist in this slice

- **WHEN** this documentation change is implemented
- **THEN** existing generated `pipeline:<command>` host entries MAY still be present
- **AND** this slice SHALL NOT delete those files
