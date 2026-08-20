## MODIFIED Requirements

### Requirement: Ship-end composers SHALL execute the candidate engine

A ship-end composer (Tugboat, the installed `pipeline-ship-playbook` launcher, or in-engine `pipeline ship`) SHALL invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `pipeline release finish`, and `pipeline release ensure-tag` using the **candidate** engine after train is complete or resumed complete. In-engine `pipeline ship` SHALL also run `ensureAnnotatedReleaseTag` on that candidate (the same helper `release ensure-tag` wraps). Tugboat SHALL NOT invoke `git tag` or `gh release create`. Tugboat SHALL still invoke candidate `release ensure-tag` after a merged release and before publication wait. The candidate engine SHALL be the control checkout at the Factory Reliability Gate (FRG)-bound `integrated_candidate.git_sha`, or an explicit candidate install of that same SHA. Identity SHALL be that exact 40-hex SHA. The composer SHALL NOT use the previous production-pin CLI (`$PIPELINE` / `~/.local/bin/pipeline` when that binary is the last promoted pin and its source SHA differs from the candidate) for those verbs.

Train `--merge` and implementer / review harnesses for the train items themselves SHALL continue to execute the production pin. The composer SHALL fail closed before those ship-end verbs if it cannot resolve a candidate engine whose identity matches the SHA being released.

This requirement does not authorize `--skip-frg` as the ship path. It does not authorize auto-promote before GitHub Release publication. It does not reclassify pinned-track production or dogfood loops as the candidate.

#### Scenario: Post-train release uses the candidate CLI

- **WHEN** train is complete for version `1.39.5`
- **AND** the production pin CLI reports version `1.39.4`
- **AND** the FRG-bound candidate SHA is `C` whose tree contains a `release.ts` fix
- **THEN** the composer SHALL invoke `pipeline release 1.39.5` (and `factory-release prepare`) via the candidate engine at SHA `C`
- **AND** it SHALL NOT invoke those verbs via the `1.39.4` production-pin binary

#### Scenario: Train stays on the production pin

- **WHEN** Tugboat or `pipeline ship` starts train `--merge` for milestone `v1.39.5`
- **AND** the production pin is `1.39.4`
- **THEN** train SHALL execute the production-pin CLI
- **AND** implementer and review harnesses for those train items SHALL NOT switch to the unpromoted candidate

#### Scenario: Unresolvable candidate fails closed before ship-end

- **WHEN** train is complete
- **AND** the composer cannot resolve a control checkout or candidate install whose identity matches the FRG-bound SHA
- **THEN** the composer SHALL fail the ship-end phase
- **AND** it SHALL NOT fall back to the previous production-pin CLI for `factory-release prepare`, `pipeline release`, `release finish`, or in-engine tag

#### Scenario: Next identical pin-behind-candidate fault needs no new mole

- **WHEN** a later ship has production pin `X.Y.Z` and candidate SHA `C` at `X.Y.Z+1`
- **AND** train has merged a ship-end fix into that candidate
- **THEN** the same composer SHALL invoke ship-end verbs on the candidate engine at `C`
- **AND** that ship SHALL be able to open the release PR with the candidate `release.ts` in the running CLI
- **AND** the fault SHALL NOT require a new path-local mole issue

## ADDED Requirements

### Requirement: Tugboat skipping candidate ensure-tag SHALL fail the ship-end identity class

A ship-end composer that can merge a release pull request SHALL invoke candidate `release ensure-tag` (or in-process `ensureAnnotatedReleaseTag`) after that merge. "Tugboat SHALL NOT invoke `git tag`" SHALL NOT be treated as permission to skip `release ensure-tag`. A doctor or unit check SHALL fail when Tugboat's post-finish path still goes to `wait-release` without that CLI verb while ship-end tools are in use.

#### Scenario: Tugboat post-finish path without ensure-tag fails the check

- **WHEN** an automated ship-end check inspects Tugboat
- **AND** the post-`release finish` path has no candidate `release ensure-tag`
- **THEN** the check SHALL fail
- **AND** remediation SHALL name candidate `pipeline release ensure-tag <X.Y.Z> <mergeCommitOid>`
