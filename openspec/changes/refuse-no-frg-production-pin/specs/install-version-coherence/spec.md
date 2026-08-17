## ADDED Requirements

### Requirement: Factory doctor install:engine-track SHALL fail closed on a no-frg production pin

On this factory control repository, `pipeline doctor` check `install:engine-track` SHALL fail
when pinned-track intent applies and the live production pin is not production-quality: its
`frg_run_id` starts with `no-frg-`, or `frg_evidence_path` is null or empty. The check SHALL
fail even when the installed/running version matches the pin version and tag-install
provenance is otherwise coherent. Detail and remediation SHALL name the `no-frg-*` / null
evidence defect and SHALL instruct a non-skip promote from a real FRG pass (or an explicit
`--skip-frg` only when the operator intends a non-production-quality pin).

The check SHALL NOT fail solely for this marker when two-track factory policy is inactive
(ordinary non-factory product host). Under explicit candidate soak intent, the check SHALL
still report the marker in detail and SHALL NOT fail solely because the pin is `no-frg-*`.

This rule is fail-closed because default promote already requires FRG after the Tugboat
FRG ship path (#1039). A warn-only result is not sufficient on the factory pinned track.

#### Scenario: Factory pinned doctor fails a no-frg pin

- **WHEN** `pipeline doctor` runs on this factory repo under pinned-track intent
- **AND** the live production pin has `frg_run_id` `no-frg-1.37.0` or `frg_evidence_path` null
- **THEN** `install:engine-track` SHALL have status `"fail"`
- **AND** the detail SHALL name the `no-frg-*` or null-evidence defect
- **AND** the remediation SHALL instruct promote from a real FRG pass

#### Scenario: Matching install does not hide a no-frg pin

- **WHEN** pinned-track intent applies on this factory repo
- **AND** the installed/running version matches the pin version
- **AND** the pin `frg_run_id` starts with `no-frg-`
- **THEN** `install:engine-track` SHALL still have status `"fail"`
- **AND** SHALL NOT pass solely because version and tag-install provenance match

#### Scenario: Non-factory doctor does not fail solely for no-frg

- **WHEN** `pipeline doctor` runs on a non-factory product repository host
- **AND** two-track factory policy is inactive
- **AND** a readable pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker

#### Scenario: Candidate soak reports the marker without failing for it

- **WHEN** `pipeline doctor` runs with explicit candidate soak intent
- **AND** the live pin has `frg_run_id` `no-frg-1.37.0`
- **THEN** the check SHALL report the `no-frg-*` marker in detail
- **AND** SHALL NOT fail solely because the pin is `no-frg-*`

#### Scenario: Production-quality pin still passes when install matches

- **WHEN** `pipeline doctor` runs on this factory repo under pinned-track intent
- **AND** the live pin has a real FRG `frg_run_id` and a non-null `frg_evidence_path`
- **AND** the install matches the pin under existing track-coherence rules
- **THEN** `install:engine-track` SHALL have status `"pass"`
