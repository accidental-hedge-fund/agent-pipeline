## ADDED Requirements

### Requirement: Factory doctor SHALL accept a shared-path production-quality pin after promote

On this factory control repository, after a non-skip promote of version `X.Y.Z` that
wrote a production-quality pin (`frg_run_id` does not start with `no-frg-`;
`frg_evidence_path` is non-null) to the shared factory pin path
(`AGENT_PIPELINE_PRODUCTION_PIN` or the default factory pin file), `pipeline doctor`
check `install:engine-track` SHALL pass under pinned-track intent when the install
matches that pin under existing track-coherence rules and the factory control checkout
is clean of unignored dirt.

The check SHALL load the shared / exported pin path. It SHALL NOT fail solely because a
promote worktree still holds a different pin file, or because committed `origin/main`
still names `no-frg-*` when that file is not the exported factory pin.

Version `X.Y.Z+1` train SHALL be allowed to start without a manual copy of the pin.

#### Scenario: Doctor accepts frg pin for N after promote

- **WHEN** a non-skip promote of `1.39.3` has written `frg_run_id` `frg-abc` to the
  exported factory pin
- **AND** `pipeline doctor` runs on the factory control checkout with that same pin
  path
- **AND** the install matches `1.39.3` under existing track-coherence rules
- **AND** the checkout has no unignored dirt
- **THEN** `install:engine-track` SHALL have status `"pass"`
- **AND** SHALL NOT require a human to copy the pin from a worktree

#### Scenario: Worktree pin is not the doctor authority when export is set

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` points at the factory pin with
  `frg_run_id` `frg-abc` for `1.39.3`
- **AND** a worktree `repoDir` still has `frg_run_id` `no-frg-1.39.1`
- **AND** `pipeline doctor` runs under pinned-track intent on the factory control
  checkout
- **THEN** `install:engine-track` SHALL evaluate the exported factory pin
- **AND** SHALL NOT fail solely because the worktree pin is `no-frg-*`
