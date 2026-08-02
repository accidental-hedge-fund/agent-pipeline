## ADDED Requirements

### Requirement: Pipeline-internal commit classification SHALL live in a neutral module

The pipeline SHALL define `isPipelineInternalCommit` and the subject prefixes/patterns it depends on in a neutral module under `core/scripts/` (for example `pipeline-commits.ts`) that is not a stage module. That module SHALL NOT import from `stages/pre_merge`, `stages/shipcheck`, `stages/visual`, or other stage handlers. Pre-merge SHA-gate logic, shipcheck post-verdict revalidation, visual-publish classification, and unit tests SHALL obtain classification from that neutral module (directly or via a re-export that does not force later stages to import earlier stages).

#### Scenario: Classifier is importable without loading pre_merge or shipcheck

- **WHEN** a test or module imports `isPipelineInternalCommit` from the neutral pipeline-commits module
- **THEN** the import SHALL succeed without importing `stages/pre_merge.ts` or `stages/shipcheck.ts`
- **AND** the neutral module source SHALL contain no import whose specifier resolves to a `stages/` path

#### Scenario: Shipcheck does not import pre_merge for classification

- **WHEN** `stages/shipcheck.ts` is inspected for imports
- **THEN** it SHALL NOT import values or types from `./pre_merge.ts` / `pre_merge` for `isPipelineInternalCommit` or related classification constants
- **AND** a regression test SHALL fail if such an import is reintroduced

---

### Requirement: Pipeline-internal classification SHALL match the tested canonical set

`isPipelineInternalCommit(messageHeadline)` SHALL return true if and only if the headline is pipeline-internal under the following rules (the current tested runtime contract):

1. The headline starts with the OpenSpec archive prefix `chore: archive OpenSpec change(s) for #`; or
2. The headline exactly matches the visual-gate artifact-publish subject: the visual publish prefix followed by one or more digits and nothing else.

The classifier SHALL return false for docs-update subjects, auto-format subjects (`chore: auto-format (#…)`), pre-merge auto-fix subjects, salvage subjects, and ordinary developer/fix/feat/chore subjects. A developer commit that merely *starts with* the visual publish wording but continues with additional text SHALL NOT be classified as pipeline-internal.

#### Scenario: OpenSpec archive commit is internal

- **WHEN** `isPipelineInternalCommit` is called with `chore: archive OpenSpec change(s) for #16`
- **THEN** it SHALL return true

#### Scenario: Exact visual publish commit is internal

- **WHEN** `isPipelineInternalCommit` is called with `chore: publish visual-gate evidence for #16`
- **THEN** it SHALL return true

#### Scenario: Developer commit starting with publish wording is not internal

- **WHEN** `isPipelineInternalCommit` is called with `chore: publish visual-gate evidence for #463 and also refactor auth`
- **THEN** it SHALL return false

#### Scenario: Docs, auto-format, and auto-fix are not internal

- **WHEN** `isPipelineInternalCommit` is called with any of:
  - `docs: update documentation for #16`
  - `chore: auto-format (#182)`
  - a subject beginning with `fix: pre-merge auto-fix`
- **THEN** each call SHALL return false

#### Scenario: Only-internal commits keep a prior verdict current

- **WHEN** every commit since a recorded review or shipcheck SHA is classified pipeline-internal under this rule
- **THEN** the SHA gate / shipcheck revalidation SHALL treat the prior verdict as still current for the internal-commit exemption
- **AND** SHALL NOT treat that exemption as approval to skip unresolved blocking-key checks that the living gate already requires

---

### Requirement: Classification constants SHALL be single-sourced with producers

The OpenSpec archive prefix string and the visual publish subject prefix (and the exact-match pattern derived from it) SHALL each have a single definition used by both producers (archive step, visual publish commit) and the classifier. Producers MAY import the prefix from the neutral module; the classifier MUST NOT hardcode a divergent second copy that can drift from the producer.

#### Scenario: Visual publish subject and classifier agree

- **WHEN** the visual-gate stage authors a publish commit using the prescribed publish subject for issue N
- **THEN** `isPipelineInternalCommit` applied to that exact subject SHALL return true
- **AND** both the authoring prefix and the classifier pattern SHALL resolve to the same single-sourced prefix definition

#### Scenario: Archive subject and classifier agree

- **WHEN** the pre-merge OpenSpec archive step authors a commit whose subject starts with the archive prefix for issue N
- **THEN** `isPipelineInternalCommit` applied to that subject SHALL return true
- **AND** the archive authoring path and the classifier SHALL share the same prefix constant

---

### Requirement: Classifier extraction SHALL preserve biting unit tests

The test suite SHALL continue to assert archive, visual publish (positive and near-miss), docs, auto-format, and auto-fix classification cases. Tests MAY import `isPipelineInternalCommit` from the neutral module (preferred) or from a thin re-export; they SHALL fail if classification regresses for any of those cases.

#### Scenario: Near-miss visual publish test still bites

- **WHEN** a regression test calls `isPipelineInternalCommit` with a subject that starts with the publish prefix but includes trailing text
- **THEN** the assertion that the result is false SHALL fail if the classifier is loosened to prefix-only matching
