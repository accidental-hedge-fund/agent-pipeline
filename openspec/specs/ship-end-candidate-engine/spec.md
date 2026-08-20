# ship-end-candidate-engine Specification

## Purpose
Defines the shared ship-end class law: after train-complete, Factory Reliability Gate (FRG) pack, release prepare, release finish, and tag SHALL execute the candidate engine bound to the SHA being released, not the previous production pin, and a doctor or unit check SHALL fail when the invoked CLI or playbook identity does not match that candidate.

## Requirements

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

### Requirement: Installed ship playbook SHALL be a thin launcher to repo Tugboat

The documented installed `pipeline-ship-playbook` path SHALL be a thin launcher that execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`. A thin-launcher body SHALL contain only an optional first-physical-line shebang, later comment lines, blank lines, and exactly one executable statement: `exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"`. The optional shebang, when present, SHALL be the first physical line and SHALL be one of `#!/usr/bin/env bash`, `#!/bin/bash`, or `#!/usr/bin/bash`, with no interpreter arguments. A first-line shebang that uses `env -S`, `bash -c`, or any other interpreter or argument list SHALL classify the body as noncompliant, not as a thin launcher. A later `#` line is a comment and SHALL NOT count as a shebang. Any other shell statement — including a production-pin `"$PIPELINE" release` or other ship-end verb before or after that exec — SHALL classify the body as noncompliant, not as a thin launcher. It SHALL NOT retain a second ship-end compose implementation. Marker-only presence SHALL NOT count as parity.

When the ship execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh` directly and does not invoke a divergent installed playbook, that posture SHALL pass the playbook check. A selected installed playbook that is not that launcher SHALL fail. An installed playbook body that is neither the thin launcher nor a recognized stale compose SHALL be classified as noncompliant, not unused. Unused SHALL mean absence of the playbook or an explicit non-selection from observed composer invocation state (for example Tugboat is the selected composer). Co-installation of Tugboat SHALL NOT count as that non-selection.

#### Scenario: Stale installed playbook fails when used for ship-end

- **WHEN** `~/.local/bin/pipeline-ship-playbook` exists
- **AND** its body is not a thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh`
- **AND** the ship uses that installed playbook for FRG pack, release, finish, or tag
- **THEN** the ship-end identity check SHALL fail
- **AND** remediation SHALL name refresh from candidate `examples/supervisor/shell/pipeline-ship-playbook.sh` or exec of `$REPO_DIR/examples/supervisor/shell/tugboat.sh`

#### Scenario: Repo script from REPO_DIR is an accepted composer

- **WHEN** the ship execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh` as the composer
- **AND** it does not invoke a divergent `~/.local/bin/pipeline-ship-playbook` for ship-end
- **THEN** the playbook check SHALL accept that posture
- **AND** ship-end CLI identity SHALL still be the candidate engine source SHA

#### Scenario: Thin launcher playbook passes

- **WHEN** the installed playbook execs `$REPO_DIR/examples/supervisor/shell/tugboat.sh`
- **AND** that resolved `tugboat.sh` matches the candidate SHA tree
- **THEN** the playbook check SHALL pass
- **AND** ship-end CLI identity SHALL still be the candidate engine source SHA

#### Scenario: Unrecognized selected installed playbook fails

- **WHEN** `~/.local/bin/pipeline-ship-playbook` exists
- **AND** its body is not the thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh`
- **AND** its body is not a known historical stale compose
- **AND** that installed playbook is selected for ship-end
- **THEN** the ship-end identity check SHALL fail
- **AND** the body SHALL NOT be classified as unused

#### Scenario: Co-installed Tugboat does not mark a stale playbook unused

- **WHEN** `~/.local/bin/pipeline-ship-playbook` exists
- **AND** its body is not a thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh`
- **AND** Tugboat is also installed
- **AND** there is no observed composer invocation that selects Tugboat instead of that playbook
- **THEN** the ship-end identity check SHALL fail
- **AND** the playbook SHALL NOT be classified as unused

#### Scenario: Embedded Tugboat exec does not certify a stale playbook

- **WHEN** an installed playbook body contains `"$PIPELINE" release 1.39.5`
- **AND** the same body later contains `exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"`
- **THEN** the body SHALL be classified as noncompliant
- **AND** it SHALL NOT be classified as a thin launcher

#### Scenario: Executable shebang preamble does not certify a thin launcher

- **WHEN** an installed playbook body's first physical line is `#!/usr/bin/env -S bash -c '"$PIPELINE" release 1.39.5; exec bash "$0"'`
- **AND** the same body later contains `exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"`
- **THEN** the body SHALL be classified as noncompliant
- **AND** it SHALL NOT be classified as a thin launcher

### Requirement: Doctor or unit check SHALL fail on ship-end identity mismatch

A unit test or `pipeline doctor` check SHALL fail when ship-end tools are used for release, FRG pack, or tag and either of the following is true:

1. The invoked ship-end CLI source SHA (`commit_sha` from `pipeline --version --json` or `git rev-parse HEAD` at the engine root) does not equal the FRG-bound candidate SHA. Package `--version` equality alone SHALL NOT pass.
2. The selected installed playbook is not a thin launcher to `$REPO_DIR/examples/supervisor/shell/tugboat.sh` and the composer is not execing that repo script.

Absence of those tools (hosts that do not run thin ship or in-engine ship-end) SHALL skip the check. Doctor SHALL skip only when no installed Tugboat, no installed playbook, and no in-engine ship-end is in use. A stale installed playbook SHALL fail only when it is selected. Selection SHALL come from observed composer invocation state, not from co-installation of Tugboat. When doctor has no such observation, an installed playbook SHALL be treated as selected. The check SHALL be hermetic in unit tests (injected version strings, digests, and SHA). It SHALL NOT start a live ship, network call, or subprocess release.

#### Scenario: Production-pin CLI used for release fails the check

- **WHEN** the check evaluates a ship-end invocation whose CLI source SHA is the `1.39.4` pin
- **AND** the candidate SHA being released is `C` at package version `1.39.5`
- **THEN** the check SHALL fail
- **AND** remediation SHALL name invoking the candidate engine at the FRG-bound SHA

#### Scenario: Matching version with mismatched SHA fails

- **WHEN** the invoked CLI `--version` equals the candidate package version
- **AND** the invoked CLI `commit_sha` does not equal the FRG-bound candidate SHA
- **THEN** the check SHALL fail

#### Scenario: Matching candidate identity passes

- **WHEN** the ship-end CLI `commit_sha` equals the candidate SHA being released
- **AND** the playbook is a thin launcher or the composer is the repo script from `REPO_DIR`
- **THEN** the check SHALL pass

#### Scenario: Unused ship-end tools skip

- **WHEN** doctor runs on a host with no installed Tugboat, no installed playbook, and no in-engine ship-end in progress
- **THEN** the identity check SHALL skip
- **AND** doctor SHALL NOT fail solely because the host does not ship

### Requirement: Tugboat skipping candidate ensure-tag SHALL fail the ship-end identity class

A ship-end composer that can merge a release pull request SHALL invoke candidate `release ensure-tag` (or in-process `ensureAnnotatedReleaseTag`) after that merge. "Tugboat SHALL NOT invoke `git tag`" SHALL NOT be treated as permission to skip `release ensure-tag`. A doctor or unit check SHALL fail when Tugboat's post-finish path still goes to `wait-release` without that CLI verb while ship-end tools are in use.

#### Scenario: Tugboat post-finish path without ensure-tag fails the check

- **WHEN** an automated ship-end check inspects Tugboat
- **AND** the post-`release finish` path has no candidate `release ensure-tag`
- **THEN** the check SHALL fail
- **AND** remediation SHALL name candidate `pipeline release ensure-tag <X.Y.Z> <mergeCommitOid>`
