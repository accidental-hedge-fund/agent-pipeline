# scoped-autonomous-factory-operations Specification

## Purpose

This capability formerly described a shipped Hermes/Buzz grant factory under
`ops/hermes-factory`. That pilot was removed from the product tree. The
requirements below record the **current** product rule: no second control plane
in-repo; external supervisors map authenticated intent into the Pipeline CLI;
integrate trains and ship lifecycle decisions belong in agent-pipeline.

## Requirements

### Requirement: The repository SHALL NOT ship a Hermes factory control plane

The repository SHALL NOT include an `ops/hermes-factory` (or equivalent) package
that implements a durable grant journal, systemd factory action bus, or
wrapper-local hybrid FRG attestor as a product surface. External supervisors MAY
invoke explicit Pipeline CLI coordinator commands with a bounded authorization
document. They SHALL NOT be required to install a second durable scheduler from
this repository.

#### Scenario: Product tree has no factory ops package

- **WHEN** a clean checkout of the default branch is inspected
- **THEN** it SHALL NOT contain `ops/hermes-factory`
- **AND** the default `npm run ci` script SHALL NOT invoke a hermes-factory test suite

#### Scenario: Ordinary CLI behavior is unchanged by removal

- **WHEN** an operator runs `pipeline advance`, `pipeline single`, or `pipeline loop` without a merge command
- **THEN** those commands SHALL still stop at `pipeline:ready-to-deploy`
- **AND** they SHALL NOT merge pull requests

---

### Requirement: Merge authority SHALL remain loop-isolated and not repository configuration

Merging SHALL use only loop-isolated, operator-authorized surfaces (`pipeline merge`,
`pipeline merge-queue --apply`, and any later explicit train-merge surface). The
repository configuration schema SHALL reject `auto_merge` and factory-authority
keys. `.github/pipeline.yml` SHALL NOT authorize merges.

#### Scenario: Config cannot enable unattended merge

- **WHEN** a repository sets `auto_merge` or a factory-authority key in `.github/pipeline.yml`
- **THEN** strict configuration validation SHALL reject the unknown key

#### Scenario: External supervisor uses Pipeline-owned merge surfaces

- **WHEN** an external supervisor needs to merge a ready-to-deploy issue PR
- **THEN** it SHALL invoke `pipeline merge`, merge-queue apply, or the authorized
  `pipeline ship` coordinator that composes those Pipeline-owned gates
- **AND** it SHALL NOT gain merge authority from repository configuration alone

---

### Requirement: Ship authority SHALL be authenticated, immutable, event-bound, and expiring

The explicit `pipeline ship` surface SHALL require `--authorization
<absolute-json>`. A trusted channel adapter SHALL authenticate the signed Buzz
event before it writes that document and SHALL sign the canonical document with
its Ed25519 admission key. Pipeline SHALL verify that signature against a
root-owned machine-local public key. Pipeline SHALL NOT implement a second
Buzz/Nostr client or claim that the admission signature replaces transport
verification. Pipeline SHALL validate that the document is immutable for the run, unexpired, and bound
to the exact event identity, repository, base, milestone, release version,
sender, channel, and thread requested by the command. It SHALL persist a stable
fingerprint of those fields with the ship state.

Repository configuration, chat prose outside the authenticated event, a display
name, or a later message SHALL NOT widen that authority. An expired, malformed,
untrusted, or mismatched document SHALL fail before any mutation. A replay of
the same authenticated event and coordinates SHALL reconcile the existing ship
run rather than start a second run.

#### Scenario: Exact signed event authorizes one ship

- **WHEN** the trusted adapter accepts a signed Buzz event for repository R,
  base B, milestone M, and version V and invokes `pipeline ship` with its bound
  authorization document
- **THEN** Pipeline SHALL record the event identity and authorization
  fingerprint before the first mutation
- **AND** every later ship phase SHALL remain bound to R, B, M, and V

#### Scenario: Expired or mismatched authority fails closed

- **WHEN** the authorization is expired or any command coordinate differs from
  its repository, base, milestone, or version binding
- **THEN** `pipeline ship` SHALL exit non-zero before train, merge, release, or
  promotion mutation

#### Scenario: Event replay is idempotent

- **WHEN** the same authenticated event is delivered again with the same ship
  coordinates
- **THEN** the adapter and Pipeline SHALL return or resume the existing run
- **AND** they SHALL NOT create a second train, release PR, or merge mutation

#### Scenario: Transport authentication stays at the gateway boundary

- **WHEN** Pipeline reads the authorization document
- **THEN** it SHALL validate the trusted adapter's event-bound envelope, scope,
  fingerprint, Ed25519 signature, and expiry
- **AND** it SHALL NOT add a parallel relay client or accept an unauthenticated
  caller assertion as signature proof
