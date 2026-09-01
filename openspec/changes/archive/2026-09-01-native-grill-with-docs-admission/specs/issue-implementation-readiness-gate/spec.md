## MODIFIED Requirements

### Requirement: Triage to ready SHALL be an admission request, not a bypass of the gate

After grill or an author writes a proposed body, `pipeline triage <N> --stage ready` and `pipeline grill` ready promotion SHALL remain admission requests. Those commands SHALL NOT invoke the issue-implementation-readiness gate model. They SHALL still be subject to the Decisions-artifact validator specified by `grill-then-ready-refinement` before any ready label write. When the ready label is set, the next pickup SHALL re-fetch and SHALL require a `ready` verdict from this gate before any worktree or delivery harness starts. An unchanged body that this gate previously rejected SHALL reuse `needs_spec` and return the issue to `pipeline:needs-spec`. #1238 owned comments SHALL remain verdict evidence. They SHALL NOT replace the issue body as the specification.

#### Scenario: Fresh body must pass before delivery

- **WHEN** grill updates the issue body and promotes `pipeline:ready`
- **AND** the Decisions-artifact validator permits the ready label write
- **AND** the next pickup evaluates the new body as `ready`
- **THEN** delivery MAY start
- **AND** grill itself SHALL NOT have invoked the gate model

#### Scenario: Unchanged body after triage is not a bypass

- **WHEN** an issue at `pipeline:needs-spec` is triaged to `pipeline:ready` without a body change
- **AND** the next pickup runs while the gate is enabled
- **THEN** the gate SHALL reuse `needs_spec`
- **AND** SHALL move the issue back to `pipeline:needs-spec`
- **AND** SHALL NOT create a worktree

#### Scenario: Grill-ready is not a pickup bypass

- **WHEN** grill or `--stage ready` has set `pipeline:ready` after a complete Decisions artifact
- **AND** a pickup path runs with `issue_readiness.enabled` true
- **THEN** this gate SHALL still evaluate the freshly fetched title and body
- **AND** SHALL NOT skip that evaluation because a Decisions artifact is present
