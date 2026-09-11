## Purpose

Records the 1.40.1 exact-candidate FRG clean-docs fixture identity and the ordinary Pipeline lifecycle the FRG controller later observes.

## ADDED Requirements

### Requirement: The run-scoped clean-docs fixture SHALL name release 1.40.1

The JSON fixture at `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json` SHALL set `release_version` to the literal string `1.40.1`.

#### Scenario: Fixture stores the exact release value

- **WHEN** the JSON fixture at `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json` is parsed
- **THEN** `release_version` SHALL equal `1.40.1`

### Requirement: The run-scoped unit test SHALL fail when the fixture release value changes

The executable Node unit test at `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` SHALL read only that exact fixture, parse it, and assert the literal release value `1.40.1`. The test SHALL fail if that value changes.

#### Scenario: Matching release value passes

- **WHEN** the fixture `release_version` is `1.40.1`
- **AND** the test is run with `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts`
- **THEN** the test SHALL exit 0

#### Scenario: Changed release value fails

- **WHEN** the fixture `release_version` is any value other than `1.40.1`
- **AND** the same test command is run
- **THEN** the test SHALL fail

### Requirement: The product diff SHALL stay inside this fixture's run-scoped paths

The product diff SHALL include only `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json`, `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts`, and this issue's OpenSpec change under `openspec/changes/frg-1-40-1-0672994e898c-r2-clean-docs/` plus its exact-pair living spec `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-docs/spec.md`. The change SHALL NOT edit production behavior, classifiers, recovery recipes, gates, controllers, another run's fixtures, or another issue's OpenSpec change.

#### Scenario: Out-of-scope production files stay untouched

- **WHEN** the implementer completes this fixture
- **THEN** no production script, classifier, recovery recipe, gate, or controller file SHALL be part of the product diff
- **AND** no fixture or test owned by another pack run SHALL be edited

### Requirement: This fixture SHALL traverse the ordinary Pipeline lifecycle without reduced rigor

The ordinary Pipeline SHALL admit, plan, review the plan, implement, and review this issue with the same readiness and review rigor as any other issue. Factory-gate labels SHALL NOT grant a label-only bypass. Advance SHALL stop at `pipeline:ready-to-deploy` and SHALL NOT merge or deploy. After the FRG records the run, the FRG controller SHALL close the pull request and issue without merge. If planning created this OpenSpec change, pre-merge SHALL archive it and SHALL leave no foreign active change. The only living-spec destination owned by this fixture SHALL be `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-docs/spec.md`.

#### Scenario: Ordinary admission and review keep full rigor

- **WHEN** this issue enters issue-readiness, planning, plan review, implementation, and review
- **THEN** the Pipeline SHALL use the ordinary stages and review gates
- **AND** it SHALL NOT skip those stages because the issue is a synthetic FRG fixture

#### Scenario: Pre-merge archives only this issue's change

- **WHEN** pre-merge archives OpenSpec state for this issue
- **THEN** this change `frg-1-40-1-0672994e898c-r2-clean-docs` SHALL be archived
- **AND** no foreign active OpenSpec change SHALL remain
- **AND** the living spec SHALL be `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-docs/spec.md`

#### Scenario: Ready-to-deploy does not merge

- **WHEN** the full Pipeline reaches `pipeline:ready-to-deploy`
- **THEN** advance SHALL NOT merge the pull request
- **AND** advance SHALL NOT deploy

#### Scenario: FRG controller closes without merge

- **WHEN** the FRG records the completed clean-docs run
- **THEN** the FRG controller SHALL close the pull request and issue
- **AND** it SHALL NOT merge the pull request
