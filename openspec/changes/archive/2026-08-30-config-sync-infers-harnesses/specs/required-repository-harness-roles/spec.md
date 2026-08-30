## MODIFIED Requirements

### Requirement: Missing or partial repository harness policy SHALL fail closed before work

Configuration resolution for execution SHALL fail when the file is absent, when the `harnesses` block is absent, or when either `harnesses.implementer` or `harnesses.reviewer` is absent. The failure SHALL occur before a worktree is created or removed, before any GitHub mutation, and before any harness invocation. The diagnostic SHALL name the missing file or key and SHALL state that the active profile does not select live workers. The diagnostic for a missing file SHALL direct the operator to `pipeline init` and to set both role keys. The diagnostic for a missing `harnesses` block or a missing role key SHALL name `pipeline config sync`.

#### Scenario: Missing file fails before work

- **WHEN** the resolved git root has no `.github/pipeline.yml`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic that names the missing file and `pipeline init`
- **AND** no worktree operation, GitHub mutation, or harness invocation SHALL have occurred

#### Scenario: Missing harnesses block fails closed

- **WHEN** `.github/pipeline.yml` exists and has no `harnesses:` block
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer` and `harnesses.reviewer`
- **AND** the diagnostic SHALL state that the active profile does not fill live workers
- **AND** the diagnostic SHALL name `pipeline config sync`

#### Scenario: Implementer omitted fails closed

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `reviewer: codex`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.implementer`
- **AND** the diagnostic SHALL name `pipeline config sync`
- **AND** the resolved reviewer SHALL NOT be taken from the active profile as a substitute

#### Scenario: Reviewer omitted fails closed

- **WHEN** `.github/pipeline.yml` sets `harnesses:` with only `implementer: grok`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.reviewer`
- **AND** the diagnostic SHALL name `pipeline config sync`

#### Scenario: review_harness without harnesses.reviewer is partial policy

- **WHEN** `.github/pipeline.yml` sets `review_harness: codex` and omits `harnesses.reviewer`
- **AND** an execution command resolves configuration
- **THEN** resolution SHALL fail with a diagnostic naming `harnesses.reviewer`
- **AND** `review_harness` SHALL NOT substitute for the missing key
- **AND** the diagnostic SHALL name `pipeline config sync`

## ADDED Requirements

### Requirement: The engine repository SHALL ship and CI-validate both harness roles

This repository's `.github/pipeline.yml` SHALL contain uncommented `harnesses.implementer` and `harnesses.reviewer` keys. `npm run ci` SHALL run `pipeline config validate` (or `validateConfig`) against that live file and SHALL fail when any diagnostic has `severity: "error"`.

#### Scenario: Engine pipeline.yml declares both roles

- **WHEN** this repository's `.github/pipeline.yml` is read
- **THEN** it SHALL contain uncommented `harnesses.implementer` and `harnesses.reviewer`

#### Scenario: CI validate fails on an invalid engine config

- **WHEN** `npm run ci` runs
- **AND** this repository's `.github/pipeline.yml` is invalid or omits a required harness role
- **THEN** the CI gate SHALL fail
