## ADDED Requirements

### Requirement: Release prepare SHALL remain invocable as a shared library for programmatic callers

The release prepare implementation used by `pipeline release` SHALL remain
available as a shared in-process entry point (the existing `runRelease` function
or an equivalent single-sourced API) so other human-gated CLI surfaces — such as
merge-queue release-when-complete — can invoke the same prepare path without
reimplementing version bump, mirror regen, CI gate, ROADMAP scaffold, or PR
creation. Programmatic callers SHALL be able to pass dry-run and non-interactive
(`noEdit`) options equivalent to the CLI flags. This requirement does not add
tag, publish, or merge authority to the prepare path.

#### Scenario: Programmatic dry-run prepare performs no mutations

- **WHEN** a programmatic caller invokes the shared release prepare entry with
  dry-run enabled
- **THEN** the prepare path SHALL NOT write release-managed files
- **AND** SHALL NOT open a release PR
- **AND** SHALL NOT create or push a tag

#### Scenario: Programmatic non-interactive prepare skips the editor

- **WHEN** a programmatic caller invokes the shared release prepare entry with
  non-interactive options (`noEdit` or equivalent)
- **THEN** the prepare path SHALL NOT wait on `$EDITOR`
- **AND** on success SHALL still open a release PR for human review (live mode)

---

### Requirement: The release prepare path SHALL NOT gain tag, publish, or merge authority via merge-queue callers

The release prepare path SHALL remain prepare-only when invoked from merge-queue
release-when-complete or any other programmatic caller: it SHALL NOT create or
push git tags, SHALL NOT publish npm packages, SHALL NOT create GitHub Releases,
and SHALL NOT merge the release PR. Human merge of the release PR and existing
post-merge tag/publish workflows remain the sole path to ship.

#### Scenario: Merge-queue-triggered prepare does not merge or tag

- **WHEN** release prepare is invoked because merge-queue release-when-complete
  succeeded its completeness gates
- **THEN** the prepare path SHALL stop at an open release PR (or dry-run report)
- **AND** SHALL NOT merge that PR
- **AND** SHALL NOT create or push a version tag as part of that invocation
