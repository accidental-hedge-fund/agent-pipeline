## MODIFIED Requirements

### Requirement: Triage to ready SHALL be an admission request, not a bypass of the gate

After an author applies a proposed body, `pipeline triage <N> --stage ready` SHALL remain the re-admission request. That command SHALL NOT invoke the issue-implementation-readiness gate model. It SHALL still be subject to the Decisions-artifact validator specified by `grill-then-ready-refinement` before any ready label write. When the ready label is set, the next pickup SHALL re-fetch and SHALL require a `ready` verdict from this gate before any worktree or delivery harness starts. An unchanged body that this gate previously rejected SHALL reuse `needs_spec` and return the issue to `pipeline:needs-spec`. #1238 owned comments SHALL remain verdict evidence. They SHALL NOT replace the issue body as the specification.

#### Scenario: Fresh body must pass before delivery

- **WHEN** an author updates the issue body and runs `pipeline triage N --stage ready`
- **AND** the Decisions-artifact validator permits the ready label write
- **AND** the next pickup evaluates the new body as `ready`
- **THEN** delivery MAY start
- **AND** triage itself SHALL NOT have invoked the gate model

#### Scenario: Unchanged body after triage is not a bypass

- **WHEN** an issue at `pipeline:needs-spec` is triaged to `pipeline:ready` without a body change
- **AND** the next pickup runs while the gate is enabled
- **THEN** the gate SHALL reuse `needs_spec`
- **AND** SHALL move the issue back to `pipeline:needs-spec`
- **AND** SHALL NOT create a worktree

#### Scenario: Grill-ready is not a pickup bypass

- **WHEN** `--stage ready` has set `pipeline:ready` after a complete Decisions artifact
- **AND** a pickup path runs with `issue_readiness.enabled` true
- **THEN** this gate SHALL still evaluate the freshly fetched title and body
- **AND** SHALL NOT skip that evaluation because a Decisions artifact is present
