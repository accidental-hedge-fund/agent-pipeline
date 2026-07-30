## ADDED Requirements

### Requirement: README install pins SHALL not recommend obsolete release tags

README install pins SHALL not recommend obsolete release tags. Install examples
that pin a GitHub ref (`#vX.Y.Z` or `git checkout vX.Y.Z`) SHALL either use a
release tag that matches the repository’s current package version major.minor.patch
at the time of the change, or describe pinning without embedding a historically
obsolete version number. The README SHALL NOT present `v1.2.1` (or any other
abandoned line) as the recommended or worked-example pin when the package version
is on a later major/minor line.

#### Scenario: Recommended install does not cite a stale pin

- **WHEN** a reader follows the highlighted recommended install command(s)
- **THEN** the command(s) SHALL NOT pin `#v1.2.1` or another obsolete tag as if
  it were current
- **AND** any pin shown SHALL either match the current package release tag or
  use unversioned / “pick a released tag from GitHub Releases” wording

#### Scenario: Specific-version section avoids ancient hardcoded examples

- **WHEN** the README documents installing a specific version
- **THEN** worked examples SHALL NOT use `v1.2.1` as the only illustrated pin
  when the package is past the 1.2 line
- **AND** the section SHALL remain accurate for how `npx github:…#<tag>` works

### Requirement: README SHALL describe durable loop without requiring external goal-loop

README SHALL describe durable multi-item loop without requiring external
goal-loop. Text about `pipeline:loop` / durable multi-item runs and about the
doctor check `loop:contract-coherence` SHALL match in-repo loop reality: durable
loop does not require an externally installed goal-loop skill. The README SHALL
NOT state that goal-loop must be installed for `/pipeline:loop` or
`$pipeline:loop` to work. Where `loop:contract-coherence` is documented, absence
of goal-loop SHALL be described as non-failing (skip/warn/optional), not as a
hard doctor failure or install blocker.

#### Scenario: Loop section does not require goal-loop

- **WHEN** a reader reads the durable multi-item / `pipeline:loop` section
- **THEN** the section SHALL NOT require installing goal-loop as a prerequisite
  for loop
- **AND** it SHALL be consistent with the in-repo durable loop supervisor

#### Scenario: Doctor table matches optional goal-loop semantics

- **WHEN** the README documents the `loop:contract-coherence` doctor check
- **THEN** it SHALL NOT claim the check fails solely because goal-loop is absent
- **AND** it SHALL NOT claim `pipeline:loop` itself requires that check to pass
  via an external goal-loop install
