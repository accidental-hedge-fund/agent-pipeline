## Purpose

Defines deterministic proof that the packaged Pipeline launcher and its public command routes preserve typed fault ownership before a release may create remote FRG fixtures.

## ADDED Requirements

### Requirement: Qualification SHALL execute the staged installed launcher

Candidate qualification SHALL spawn the staged installed `pipeline` launcher as a child process for numeric drive, `single`, `loop`, `train`, `merge`, merge queue, `ship`, and every supervised disposition in the operation inventory. A registry lookup, direct helper call, test filename, or generated test title SHALL NOT count as installed-CLI execution. Qualification SHALL use a closed, secret-free probe mode that performs no network, GitHub mutation, git mutation, model call, release, merge, or deployment.

#### Scenario: Simulator-only coverage fails

- **WHEN** the claimed installed-CLI layer only resolves command registry entries and calls an in-process fault simulator
- **THEN** qualification SHALL fail
- **AND** no installed-CLI executed row SHALL be emitted

#### Scenario: Public routes cross the launcher boundary

- **WHEN** candidate qualification passes
- **THEN** every required public or supervised operation SHALL have been invoked through the staged installed launcher
- **AND** the evidence SHALL identify the exact argv route and observed child-process result
- **AND** the complete staged candidate core suite SHALL have exited successfully

### Requirement: Qualification SHALL inject and observe faults at the process boundary

The qualifier SHALL exercise every required operation/fault route through actual child process behavior or a structured durable-state probe. It SHALL observe nonzero exit, signal, timeout, malformed output, partial state, observer failure, and other declared fault classes without trusting the child to declare its own pass. The parent SHALL derive typed outcomes, require ownership retention, and reject false-human, ownerless-terminal, supervisor-STOP, unauthorized-mutation, or replayed-side-effect observations. A failure in any route SHALL block the qualification artifact even when that route is not part of the smaller representative row set credited by FRG.

#### Scenario: Process death is parent-observed

- **WHEN** a qualification child exits nonzero, receives a signal, or exceeds its timeout
- **THEN** the parent qualifier SHALL observe that process result directly
- **AND** the child SHALL NOT self-attest the row as passed

#### Scenario: Unsafe disposition fails qualification

- **WHEN** any case produces false human authority, an ownerless terminal, terminal supervisor STOP, unauthorized mutation, or a replayed side effect
- **THEN** the qualification artifact SHALL record that row as failed
- **AND** release preparation SHALL remain blocked

### Requirement: Qualification evidence SHALL be exact-candidate bound and tamper evident

Qualification SHALL write one canonical artifact containing schema version, candidate SHA, launcher identity, matrix version, bounded proof for every required operation/fault route, successful complete-suite proof, one concretely observed representative result for every required lifecycle-class/coverage-layer pair, and a deterministic content digest. Consumers SHALL validate the digest, exact candidate SHA, complete proof and representative sets, allowed values, expected typed terminals, successful proof process status, and absence of duplicates before producing executed matrix rows. Missing, stale, malformed, partial, duplicate, or digest-mismatched evidence SHALL receive no coverage. A common supervisor observation SHALL NOT be expanded into synthetic per-operation executed rows.

#### Scenario: Exact artifact produces rows

- **WHEN** a complete artifact has a valid digest, successful route/suite proofs, and candidate SHA `C`
- **THEN** its passing cases SHALL produce binder-valid installed-CLI executed rows for `C`
- **AND** those rows SHALL retain their operation, fault, entrypoint, host, layer, lifecycle class, and observed terminal
- **AND** the emitted rows SHALL be limited to the closed lifecycle-class/coverage-layer representative set

#### Scenario: Stale or fabricated artifact fails

- **WHEN** an artifact names another SHA, omits a required proof or representative, duplicates evidence, records an unsuccessful proof process, changes content after digesting, or contains a row not emitted by launcher qualification
- **THEN** the artifact SHALL be rejected in full
- **AND** FRG SHALL report missing candidate qualification
