## Purpose

Defines the shared ship-end class law: after train-complete, Factory Reliability Gate (FRG) pack, release prepare, release finish, and tag SHALL execute the candidate engine bound to the SHA being released, not the previous production pin, and a doctor or unit check SHALL fail when the invoked CLI or playbook identity does not match that candidate.

## ADDED Requirements

### Requirement: Ship-end composers SHALL execute the candidate engine

A ship-end composer (Tugboat, the installed `pipeline-ship-playbook` copy, or in-engine `pipeline ship`) SHALL invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `pipeline release finish`, and any composer-invoked tag using the **candidate** engine after train is complete or resumed complete. The candidate engine SHALL be the control checkout at the Factory Reliability Gate (FRG)-bound `integrated_candidate.git_sha`, or an explicit candidate install of that same SHA. The composer SHALL NOT use the previous production-pin CLI (`$PIPELINE` / `~/.local/bin/pipeline` when that binary is the last promoted pin and its version or source SHA differs from the candidate) for those verbs.

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
- **AND** it SHALL NOT fall back to the previous production-pin CLI for `factory-release prepare`, `pipeline release`, `release finish`, or tag

#### Scenario: Next identical pin-behind-candidate fault needs no new mole

- **WHEN** a later ship has production pin `X.Y.Z` and candidate SHA `C` at `X.Y.Z+1`
- **AND** train has merged a ship-end fix into that candidate
- **THEN** the same composer SHALL invoke ship-end verbs on the candidate engine at `C`
- **AND** that ship SHALL be able to open the release PR with the candidate `release.ts` in the running CLI
- **AND** the fault SHALL NOT require a new path-local mole issue

### Requirement: Installed ship playbook SHALL match the candidate composer or yield to the repo script

When an installed `pipeline-ship-playbook` (or equivalent documented install path) is used for ship-end, its content digest SHALL match `examples/supervisor/shell/tugboat.sh` at the candidate SHA being released. Alternatively, the composer SHALL exec the repo script from `REPO_DIR` (`$REPO_DIR/examples/supervisor/shell/tugboat.sh`) and SHALL NOT use a divergent installed playbook for those phases. Marker-only presence SHALL NOT count as parity.

#### Scenario: Stale installed playbook fails when used for ship-end

- **WHEN** `~/.local/bin/pipeline-ship-playbook` exists
- **AND** its content digest differs from candidate `examples/supervisor/shell/tugboat.sh`
- **AND** the ship uses that installed playbook for FRG pack, release, finish, or tag
- **THEN** the ship-end identity check SHALL fail
- **AND** remediation SHALL name refresh from the candidate repo script or exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`

#### Scenario: Repo script from REPO_DIR is an accepted composer

- **WHEN** the ship execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh` as the composer
- **AND** it does not invoke a divergent `~/.local/bin/pipeline-ship-playbook` for ship-end
- **THEN** the playbook-digest check SHALL accept that posture
- **AND** ship-end `$PIPELINE` (or equivalent) SHALL still be the candidate engine

### Requirement: Doctor or unit check SHALL fail on ship-end identity mismatch

A unit test or `pipeline doctor` check SHALL fail when ship-end tools are used for release, FRG pack, or tag and either of the following is true:

1. The invoked ship-end CLI `--version` or source identity does not match the candidate SHA (or the candidate package version bound to that SHA) being released.
2. The installed playbook digest does not match candidate `examples/supervisor/shell/tugboat.sh` and the composer is not execing the repo script from `REPO_DIR`.

Absence of those tools (hosts that do not run thin ship or in-engine ship-end) SHALL skip the check. The check SHALL be hermetic in unit tests (injected version strings, digests, and SHA). It SHALL NOT start a live ship, network call, or subprocess release.

#### Scenario: Production-pin CLI used for release fails the check

- **WHEN** the check evaluates a ship-end invocation whose CLI `--version` is `1.39.4`
- **AND** the candidate SHA being released reports version `1.39.5` (or source SHA ≠ that CLI)
- **THEN** the check SHALL fail
- **AND** remediation SHALL name invoking the candidate engine at the FRG-bound SHA

#### Scenario: Matching candidate identity passes

- **WHEN** the ship-end CLI identity matches the candidate SHA being released
- **AND** the playbook digest matches candidate `tugboat.sh` or the composer is the repo script from `REPO_DIR`
- **THEN** the check SHALL pass

#### Scenario: Unused ship-end tools skip

- **WHEN** doctor runs on a host with no installed Tugboat, no installed playbook, and no in-engine ship-end in progress
- **THEN** the identity check SHALL skip
- **AND** doctor SHALL NOT fail solely because the host does not ship
