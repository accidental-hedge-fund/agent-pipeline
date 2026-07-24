# local-execution-adapter Specification

## Purpose
TBD - created by archiving change orchestration-execution-boundary. Update Purpose after archive.
## Requirements
### Requirement: Local in-process execution is the default adapter to the protocol

The pipeline SHALL implement its existing in-process/local execution path as the default adapter to
the control↔execution protocol, satisfying the same `WorkAssignment` / `ProgressEvent` /
`ArtifactManifest` / `WorkResult` contract as any remote adapter. The local adapter SHALL be the
reference implementation and SHALL exist before any remote transport is introduced.

#### Scenario: Local adapter satisfies the full contract

- **WHEN** the control plane issues a `WorkAssignment` with no remote execution configured
- **THEN** the local adapter SHALL execute it in-process through the existing harness/worktree path
- **AND** it SHALL return a `WorkResult` and `ArtifactManifest` conforming to the same protocol as a remote worker

#### Scenario: Remote transport reuses the same contract

- **WHEN** a remote transport is later added as a second adapter
- **THEN** it SHALL satisfy the same envelope contract the local adapter satisfies
- **AND** the orchestration workflow definition SHALL NOT change to accommodate it

### Requirement: Local mode remains the default with no service or mandatory network

The local execution adapter SHALL remain the default execution mode: it SHALL require no running
service, SHALL preserve existing CLI behavior and configuration, and SHALL introduce no mandatory
network dependency. With no execution configuration present, the pipeline's observable behavior SHALL
be identical to today's local run.

#### Scenario: No execution config means unchanged behavior

- **WHEN** a repository has no execution/worker configuration
- **THEN** the pipeline SHALL run every stage through the local adapter exactly as it does today
- **AND** it SHALL require no service and no network dependency to do so

#### Scenario: Existing CLI behavior is preserved

- **WHEN** an operator runs the pipeline as they do today
- **THEN** the CLI surface and configuration SHALL behave unchanged
- **AND** no new mandatory flag or service SHALL be required

### Requirement: One workflow definition runs unchanged across execution modes

The same decision-complete pipeline workflow SHALL run unchanged against local/in-process, remote
private-network VM, and Kubernetes-backed execution modes, with the control plane's lifecycle and
policy decisions identical across modes. The choice of execution adapter SHALL NOT alter which stages
run, in what order, or how gates are evaluated.

#### Scenario: Identical control-plane decisions across three modes

- **WHEN** the same workflow is driven through the local, remote-VM, and Kubernetes adapters
- **THEN** the control plane SHALL make the same lifecycle and policy decisions in each mode
- **AND** the workflow definition SHALL be identical across all three

