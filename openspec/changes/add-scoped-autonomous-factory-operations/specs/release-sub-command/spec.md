## MODIFIED Requirements

### Requirement: Release prepare SHALL remain invocable as a shared library for programmatic callers

The release prepare implementation used by `pipeline release` SHALL remain available as a shared in-process entry point (the existing `runRelease` function or an equivalent single-sourced API) so other explicit-authority CLI surfaces can invoke the same prepare path without reimplementing version bump, mirror regeneration, CI gate, ROADMAP scaffold, or pull-request creation. Programmatic callers SHALL be able to pass dry-run and non-interactive (`noEdit`) options equivalent to the CLI flags. A live non-interactive call SHALL still stop at an open release pull request. This requirement does not add tag, publish, or merge authority to the prepare path.

#### Scenario: Programmatic dry-run prepare performs no mutations

- **WHEN** a programmatic caller invokes the shared release prepare entry with dry-run enabled
- **THEN** the prepare path SHALL NOT write release-managed files
- **AND** it SHALL NOT open a release pull request
- **AND** it SHALL NOT create or push a tag

#### Scenario: Programmatic non-interactive prepare skips the editor

- **WHEN** an explicit-authority caller invokes the shared release prepare entry with non-interactive options
- **THEN** the prepare path SHALL NOT wait on `$EDITOR`
- **AND** on success it SHALL open a release pull request for separate operator or scoped-factory finalization

### Requirement: The release prepare path SHALL NOT gain tag, publish, or merge authority via merge-queue callers

The release prepare path SHALL remain prepare-only when invoked from merge-queue release-when-complete, a scoped factory, or any other programmatic caller. It SHALL NOT create or push git tags, publish npm packages, create GitHub Releases, or merge the release pull request. A separate direct operator action or a disabled factory finalizer with a valid exact operator grant MAY merge the prepared release pull request. Existing post-merge tag and publish workflows remain the only automated tag and publish path.

#### Scenario: Merge-queue-triggered prepare does not merge or tag

- **WHEN** release prepare is invoked because merge-queue release-when-complete passes its completeness gates
- **THEN** the prepare path SHALL stop at an open release pull request or dry-run report
- **AND** it SHALL NOT merge that pull request
- **AND** it SHALL NOT create or push a version tag as part of that invocation

#### Scenario: Scoped factory preparation remains separate from finalization

- **WHEN** a scoped factory invokes the prepare path under a valid grant
- **THEN** the prepare function SHALL return after it creates or reconciles the open release pull request
- **AND** a separate finalizer SHALL revalidate the grant, exact release head, FRG evidence, checks, and merge state before any merge

### Requirement: The candidate-native factory handoff SHALL use one stable prepare interface

Issue #908 SHALL add the candidate-native interface in v1.34.0 after #890 and #891. The exact non-interactive command SHALL be `pipeline factory-release prepare --request <absolute-request.json> --json`. The stable #898 wrapper SHALL invoke this command from the clean exact integrated candidate, because the currently installed engine can be one release behind the candidate that provides the command. The unchanged request SHALL be versioned, secret-free, and bound to the verified installed production pin, freshly observed base, exact integrated candidate, active release grant, and stable action identity.

The command SHALL implement an idempotent two-call protocol. The first call SHALL create or reconcile fresh unsigned FRG artifacts without an FRG credential or credential path in its environment, inherited file descriptors, candidate-action cgroup credential mount, request, or result. When those artifacts are ready, it SHALL return JSON with `status: "awaiting_frg_attestation"`, their closed identities and digests, and the stable restart checkpoint. It SHALL NOT accept or return a pass claim, open the release pull request, or receive the signing credential through this interface.

The wrapper SHALL submit those artifacts to the fixed trusted attestor defined by the Factory Reliability Gate contract. After the wrapper stores the verified production-owned attestation, it SHALL invoke the same command with the unchanged request. The second call SHALL verify the bound attestation, invoke the existing prepare-only release implementation, and return `status: "complete"` with the exact FRG run, release pull request, release head, base commit, and restart checkpoint. Repeated calls before or after attestation SHALL return the same proved state without creating a second pack, attestation, branch, or pull request.

The command SHALL grant no attestation, release-PR merge, publication, pin, install, or rollback authority. The v1.33.0 bootstrap MAY use its documented hybrid path, but no later release MAY fall back to that path.

#### Scenario: Stable wrapper calls a one-release-newer candidate

- **WHEN** the verified installed production engine is v1.33.0 and fresh `main` contains the v1.34.0 candidate implementation of #908
- **THEN** the unchanged #898 wrapper SHALL invoke `pipeline factory-release prepare --request <absolute-request.json> --json` from that exact candidate before and after trusted attestation as needed
- **AND** it SHALL NOT require a manual wrapper or config replacement

#### Scenario: First call waits for trusted attestation

- **WHEN** the unchanged request has produced complete unsigned FRG artifacts but no verified production-owned attestation exists
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"` with only the bound unsigned artifact identities, digests, and restart checkpoint
- **AND** it SHALL NOT create the release pull request

#### Scenario: Second call returns the complete release pull request

- **WHEN** the trusted attestor has stored a valid attestation for the unchanged request and exact unsigned artifacts
- **THEN** the next call SHALL prepare or reconcile one release pull request and return `status: "complete"` with its exact identity and head
- **AND** a repeat call SHALL return the same proved result without another mutation

#### Scenario: Candidate prepare does not acquire signing or finalization authority

- **WHEN** the candidate-native prepare command returns a successful JSON result
- **THEN** the factory SHALL have passed no FRG signing credential or credential path through the candidate environment, inherited file descriptors, candidate-action cgroup credential mount, request, or result
- **AND** the trusted attestor SHALL have imported or executed no candidate code
- **AND** a separate granted wrapper action SHALL still be required for merge, publication verification, pin promotion, install, or rollback
