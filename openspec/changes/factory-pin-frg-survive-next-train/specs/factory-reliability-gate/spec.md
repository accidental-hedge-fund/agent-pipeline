## ADDED Requirements

### Requirement: FRG runtime files SHALL NOT dirty the factory control checkout

`.agent-pipeline/frg/` (including `<X.Y.Z>/latest.json` and the rest of that tree) SHALL
be treated as an engine-written runtime artifact on the factory control checkout. A pack
or promote write of `latest.json` SHALL NOT fail the next train's `worktree-clean` check.
The FRG runbook SHALL NOT require that directory to stay unignored on the protected
checkout. Host-only `skip-worktree` SHALL NOT be the product fix.

Local `latest.json` SHALL remain the ship-host lookup for `pipeline release` and
`pipeline engine-promote` on the host that just packed. Release-eligible evidence SHALL
remain attachable to the release pull request (comment, body section, `git add -f` of
that version's evidence, or an equivalent artifact) so auto-tag can still require a
release-eligible pass for the version. That attachment SHALL NOT require leaving
`.agent-pipeline/frg/` unignored on the factory control checkout.

#### Scenario: Pack write does not fail the next train worktree-clean

- **WHEN** Tugboat or `pipeline factory-release prepare` writes
  `.agent-pipeline/frg/1.39.3/latest.json` on the factory control checkout
- **AND** that file is not committed
- **THEN** the next `pipeline train` / `pipeline doctor` `worktree-clean` check SHALL
  pass
- **AND** SHALL NOT fail solely because `latest.json` exists as an untracked file

#### Scenario: Runbook no longer requires unignored FRG on the protected checkout

- **WHEN** an operator reads the FRG runbook evidence-path section after this change
- **THEN** it SHALL state that `.agent-pipeline/frg/` is gitignored on the factory
  control checkout
- **AND** SHALL NOT require operators to commit leftover `latest.json` onto the
  protected checkout to keep the next train clean

#### Scenario: Auto-tag evidence remains attachable

- **WHEN** a release PR for version `1.39.3` is prepared after an FRG pack
- **THEN** release-eligible evidence for `1.39.3` SHALL still be attachable so
  auto-tag can require a pass
- **AND** that attachment MAY force-add that version's `latest.json` onto the release
  branch
- **AND** SHALL NOT require the factory control checkout to keep `.agent-pipeline/frg/`
  unignored
