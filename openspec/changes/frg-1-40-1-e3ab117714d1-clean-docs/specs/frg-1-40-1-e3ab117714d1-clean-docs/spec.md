## Purpose

Defines the synthetic clean-docs Factory Reliability Gate fixture for pack run
`frg-1.40.1-e3ab117714d1` and Pipeline release `1.40.1`. The capability covers
run-scoped fixture identity and the ordinary Pipeline lifecycle evidence that
the FRG controller observes after implementation.

## ADDED Requirements

### Requirement: The run-scoped clean-docs fixture SHALL name release 1.40.1

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json`. That fixture
SHALL parse as JSON. Its `release_version` field SHALL equal the literal
string `1.40.1`.

#### Scenario: Fixture exists with the exact release value

- **WHEN** `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json` is
  read and parsed as JSON
- **THEN** the parsed object SHALL have `release_version` equal to `1.40.1`

### Requirement: The run-scoped unit test SHALL assert the fixture release value

The repository SHALL contain an executable Node unit test at
`core/test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts`. That test SHALL
read only
`core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json`, parse it, and
assert that `release_version` equals the literal string `1.40.1`. The test
SHALL fail when that fixture's `release_version` is not `1.40.1`.

#### Scenario: Targeted test command passes against the fixture

- **WHEN** `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts`
  is run against the fixture with `release_version` `1.40.1`
- **THEN** the command SHALL exit 0

#### Scenario: Changed release value fails the test

- **WHEN** the fixture's `release_version` is changed to a value other than
  `1.40.1`
- **AND** the same targeted test command is run
- **THEN** the test SHALL fail

#### Scenario: Full CI gate passes

- **WHEN** `npm run ci` is run from the repository root after the fixture and
  test exist
- **THEN** the command SHALL exit 0

### Requirement: The product diff SHALL stay inside this fixture's run-scoped paths

The product diff for this issue SHALL be limited to
`core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json`,
`core/test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts`, and this issue's
OpenSpec change `openspec/changes/frg-1-40-1-e3ab117714d1-clean-docs/` (and,
after archive, `openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`).
The change SHALL NOT edit production behavior, classifiers, recovery recipes,
gates, or controllers. The change SHALL NOT edit another run's fixtures or
another issue's OpenSpec change. The only living-spec destination owned by
this fixture SHALL be `openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`.

#### Scenario: Foreign production or fixture paths are absent

- **WHEN** the product diff for this issue is inspected
- **THEN** it SHALL contain no production behavior files
- **AND** it SHALL contain no fixture or test files owned by another FRG pack
  run
- **AND** it SHALL contain no OpenSpec change owned by another issue

### Requirement: The fixture issue SHALL traverse the ordinary Pipeline lifecycle

The issue SHALL receive normal issue-readiness admission, planning, plan
review, implementation, and review. Factory-gate labels SHALL NOT grant a
label-only bypass or reduced rigor. These obligations are controller-owned
lifecycle evidence. They SHALL NOT be copied into `tasks.md` as implementer
checklist items.

#### Scenario: Ordinary admission and review apply

- **WHEN** this fixture issue is admitted and advanced
- **THEN** it SHALL pass ordinary issue-readiness admission
- **AND** it SHALL receive planning, plan review, implementation, and review
- **AND** factory-gate labels SHALL NOT skip those stages

### Requirement: Pre-merge SHALL archive this issue's OpenSpec change only

If planning created this OpenSpec change, pre-merge SHALL archive
`openspec/changes/frg-1-40-1-e3ab117714d1-clean-docs/` into
`openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`. After archive,
the repository SHALL leave no foreign active OpenSpec change. `tasks.md`
SHALL list only implementer-owned work and verification that can finish
before that archive. These obligations are controller-owned lifecycle
evidence.

#### Scenario: Archive lands on the exact-pair living spec

- **WHEN** pre-merge archives this issue's OpenSpec change
- **THEN** the archived living spec SHALL be
  `openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`
- **AND** no foreign active OpenSpec change SHALL remain

### Requirement: The Pipeline SHALL stop at ready-to-deploy without merge or deploy

The full Pipeline SHALL reach `pipeline:ready-to-deploy` for this issue.
Advance SHALL NOT merge or deploy. After the FRG records the run, the FRG
controller SHALL close the pull request and issue without merge. These
obligations are controller-owned lifecycle evidence. They SHALL NOT be
copied into `tasks.md` as implementer checklist items.

#### Scenario: Ready-to-deploy is the advance stop

- **WHEN** the ordinary Pipeline completes this fixture issue
- **THEN** the issue SHALL carry `pipeline:ready-to-deploy`
- **AND** advance SHALL NOT merge the pull request
- **AND** advance SHALL NOT deploy

#### Scenario: FRG controller closes without merge

- **WHEN** the FRG controller has recorded the run for this fixture
- **THEN** it SHALL close the pull request without merge
- **AND** it SHALL close the issue without merge
