## MODIFIED Requirements

### Requirement: Complete + enabled SHALL invoke the existing release prepare path

The merge-queue SHALL, when release-when-complete is enabled and the queue is complete, invoke the same release prepare implementation used by `pipeline release` (the shared `runRelease` library or equivalent single-sourced prepare path). The invocation SHALL supply the operator-provided version argument and SHALL run non-interactively. Live mode SHALL produce a release pull request for separate finalization under the release path's existing gates. When release-when-complete is enabled without a version argument, the command SHALL exit non-zero with a usage error before any release mutation.

#### Scenario: Live complete drive prepares a release PR

- **WHEN** release-when-complete is enabled with `--release-version minor`, the queue is complete, and the command is not in dry-run
- **THEN** the command SHALL call the shared release prepare path with that version and non-interactive options
- **AND** an open release pull request SHALL exist on success, subject to the release path's gates

#### Scenario: Missing version is a usage error

- **WHEN** the operator enables release-when-complete without a release version
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** it SHALL NOT invoke release prepare mutations

### Requirement: Release-when-complete SHALL NOT tag, publish, or merge the release

The release-when-complete path SHALL NOT create or push a git tag, create or publish a GitHub Release, publish to npm, or merge the release pull request. A separate direct operator action or a disabled scoped factory finalizer with a valid exact operator grant MAY merge that release pull request. Tag and publish remain the existing post-merge release workflows.

#### Scenario: Successful prepare stops at open PR

- **WHEN** release prepare succeeds through release-when-complete
- **THEN** a release pull request SHALL exist for separate finalization
- **AND** this path SHALL create or push no tag
- **AND** this path SHALL publish no npm package
- **AND** this path SHALL NOT merge the release pull request
