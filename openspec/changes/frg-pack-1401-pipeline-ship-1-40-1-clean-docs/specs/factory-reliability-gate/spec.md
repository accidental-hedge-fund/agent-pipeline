## ADDED Requirements

### Requirement: Release 1.40.1 clean-docs fixture SHALL prove its run-scoped identity through the ordinary Pipeline lifecycle

The `pack-1401-pipeline-ship-1.40.1` clean-docs fixture SHALL exist only at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and SHALL declare `release_version` exactly `1.40.1`. The executable test at `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts` SHALL read only that fixture and SHALL assert the literal release value so a changed release value fails the test. This conformance instance SHALL NOT change production behavior or introduce a production classifier, recovery recipe, gate, controller, merge, deployment, or manual lifecycle-state operation.

#### Scenario: Exact release identity passes

- **WHEN** the run-scoped fixture contains `release_version` equal to `1.40.1`
- **THEN** the exact run-scoped executable test SHALL pass
- **AND** the focused test command and repository-wide CI gate SHALL execute that assertion without network, git, or subprocess I/O from the unit test

#### Scenario: Changed release identity fails

- **WHEN** the fixture's `release_version` differs from the literal `1.40.1`
- **THEN** the exact run-scoped executable test SHALL fail
- **AND** no other run's fixture SHALL be consulted as a fallback

#### Scenario: Fixture traverses ordinary rigor

- **WHEN** Pipeline processes issue #1537 as the clean-docs conformance instance
- **THEN** controller evidence SHALL show ordinary issue-readiness admission, planning, plan review, implementation, and review
- **AND** no issue-number, label-only, or reduced-rigor bypass SHALL satisfy those stages

#### Scenario: OpenSpec archive remains controller-owned evidence

- **WHEN** OpenSpec planning creates this issue's change and implementation verification is complete
- **THEN** pre-merge SHALL archive this issue's change and leave no foreign active change
- **AND** the archive observation SHALL remain controller-owned lifecycle evidence outside the pre-archive implementation checklist

#### Scenario: Ready-to-deploy stops before merge

- **WHEN** the full Pipeline finishes the conformance instance
- **THEN** controller evidence SHALL show `pipeline:ready-to-deploy`
- **AND** advance SHALL NOT merge or deploy

#### Scenario: Controller records and cleans up without merge

- **WHEN** FRG records the completed conformance run
- **THEN** the FRG controller SHALL close the pull request and issue without merge
- **AND** that future cleanup observation SHALL remain outside the pre-archive implementation checklist
