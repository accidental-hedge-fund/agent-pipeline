## ADDED Requirements

### Requirement: Existing clean fake-issue templates SHALL have deterministic admission coverage

The `factory-gate-v1` pack SHALL retain exactly its existing `clean-docs` and `clean-openspec` fake-issue templates for this package. Deterministic validation SHALL render both manifest-scoped templates, prove their declared run-scoped fixture and test paths use the supplied pack-run identity, and prove every rendered OpenSpec change path uses one normalized identifier accepted by OpenSpec. Validation SHALL preserve the existing division between implementer-owned pre-archive work and controller-owned future lifecycle evidence and SHALL require no live fixture execution.

#### Scenario: Both manifest templates render their scoped paths

- **WHEN** the checked-in `factory-gate-v1` manifest and templates are loaded with deterministic release and pack-run inputs
- **THEN** validation SHALL exercise both `clean-docs` and `clean-openspec`
- **AND** each rendered body SHALL name its own `core/test/fixtures/frg/<pack-run-id>/<template-id>.json` path
- **AND** each rendered body SHALL name its own `core/test/frg-<pack-run-id>-<template-id>.test.ts` path
- **AND** no unresolved template placeholder SHALL remain

#### Scenario: Rendered OpenSpec identifiers satisfy the existing naming contract

- **WHEN** either existing template renders an `openspec/changes/<change-id>/` path
- **THEN** every occurrence in that rendered issue SHALL use the same non-empty lowercase kebab-case identifier
- **AND** the identifier SHALL satisfy the existing OpenSpec length limit and deterministic normalization contract

#### Scenario: Identifier normalization is stable for punctuation and long run ids

- **WHEN** deterministic validation renders the templates with pack-run ids containing uppercase characters, punctuation, repeated separators, or values long enough to require truncation
- **THEN** each resulting OpenSpec change identifier SHALL remain valid, deterministic, and bounded
- **AND** distinct template identities SHALL remain represented in their scoped change ids

#### Scenario: Lifecycle ownership remains separated

- **WHEN** either fake-issue template is validated for later ordinary-pipeline use
- **THEN** fixture creation, executable test creation, and pre-archive verification SHALL remain implementer-owned work
- **AND** OpenSpec archive, ready-to-deploy observation, non-merge cleanup, and other future controller observations SHALL remain outside the implementer's `tasks.md`

#### Scenario: Package one adds no live fixture

- **WHEN** this change is implemented and verified
- **THEN** validation SHALL operate on the two checked-in template assets and injected deterministic inputs
- **AND** SHALL NOT create, dispatch, merge, close, or otherwise mutate a live fake issue or pull request
