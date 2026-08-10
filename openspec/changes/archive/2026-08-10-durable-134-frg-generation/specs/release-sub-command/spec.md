## MODIFIED Requirements

### Requirement: Ship coordination SHALL reuse the normal release prepare interface

The ship coordinator and the durable factory-release prepare path SHALL invoke the same shared release prepare entry used by `pipeline release` when opening or reconciling the release pull request. They SHALL NOT implement an alternate release builder, wrapper-local PR discovery protocol, or second release state machine that diverges from prepare-only release semantics. The durable command `pipeline factory-release prepare` MAY orchestrate FRG generation and the attestation checkpoint before it calls that shared entry. After all existing FRG and release gates pass, ship SHALL store the typed prepare result and pass that identity into release finalization.

#### Scenario: Ship prepare uses the shared implementation

- **WHEN** an authorized ship reaches release preparation for a version that has release-eligible FRG evidence
- **THEN** it SHALL call the shared `runRelease` implementation or its stable equivalent (directly or via `factory-release prepare` after attestation)
- **AND** the returned typed version, PR, base, and head SHALL become the finalization identity

#### Scenario: Factory-release is not a second release builder

- **WHEN** `pipeline factory-release prepare` opens or reconciles a release pull request
- **THEN** it SHALL do so only by invoking the shared `runRelease` prepare path
- **AND** it SHALL NOT merge, tag, publish, promote, or install as a side effect

#### Scenario: Ship prepare grants no finalization authority by itself

- **WHEN** release prepare returns its typed identity
- **THEN** it SHALL NOT merge, tag, publish, promote, or install as a side effect
- **AND** the ship coordinator SHALL revalidate its authorization and observed release identity before each later mutation

## ADDED Requirements

### Requirement: The candidate-native factory handoff SHALL use one stable prepare interface

The engine SHALL expose the exact non-interactive command `pipeline factory-release prepare --request <absolute-request.json> --json` for durable FRG generation and prepare-only release handoff on every release after v1.33.0. Stable wrappers and ship adapters MAY invoke this command from the clean exact integrated candidate when the installed production engine is one release behind the candidate that provides the command. The request SHALL be versioned, secret-free, and bound to the verified installed production pin (when present), freshly observed base, exact integrated candidate, target release version, and stable action identity when supplied. The request SHALL NOT carry FRG credentials, executable paths, module names, network targets, or caller-authored pass claims.

The command SHALL implement an idempotent two-call protocol. The first call SHALL create or reconcile fresh unsigned FRG artifacts without an FRG credential or credential path in its environment, inherited file descriptors, request, or result. When those artifacts are ready and no verified production-owned attestation exists, it SHALL return JSON with `status: "awaiting_frg_attestation"`, closed unsigned artifact identities and digests, and a stable restart checkpoint. It SHALL NOT open the release pull request on that call.

After the wrapper stores a verified production-owned attestation for those exact artifacts, a second call with the **unchanged** request SHALL verify the bound attestation, invoke the existing prepare-only release implementation, and return `status: "complete"` with the exact FRG run identity, release pull request, release head, base commit, and restart checkpoint. Repeated calls before or after attestation SHALL return the same proved state without creating a second pack, attestation, branch, or pull request.

The command SHALL grant no attestation signing, release-PR merge, publication, pin, install, or rollback authority. The v1.33.0 hybrid path SHALL NOT be used as a fallback when this command is missing or fails for a later release.

#### Scenario: First call waits for trusted attestation

- **WHEN** the unchanged request has produced complete unsigned FRG artifacts but no verified production-owned attestation exists
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"` with only the bound unsigned artifact identities, digests, and restart checkpoint
- **AND** it SHALL NOT create the release pull request

#### Scenario: Second call returns the complete release pull request

- **WHEN** the trusted attestor has stored a valid attestation for the unchanged request and exact unsigned artifacts
- **THEN** the next call SHALL prepare or reconcile one release pull request via shared `runRelease` and return `status: "complete"` with its exact identity and head
- **AND** a repeat call SHALL return the same proved result without another pack, branch, or pull request mutation

#### Scenario: Candidate prepare does not acquire signing or finalization authority

- **WHEN** the candidate-native prepare command returns a successful JSON result
- **THEN** the factory SHALL have passed no FRG signing credential or credential path through the candidate environment, inherited file descriptors, request, or result
- **AND** a separate granted or operator action SHALL still be required for merge, publication verification, pin promotion, install, or rollback

#### Scenario: Crash mid-protocol re-observes before mutate

- **WHEN** the process stops after pack creation, after attestation storage, or after release PR creation but before checkpoint advancement
- **THEN** a restart with the same request SHALL re-observe pack, run, attestation, branch, PR, and head state
- **AND** it SHALL continue from the proved checkpoint without creating a duplicate pack, branch, or release PR

#### Scenario: Missing or failed FRG blocks complete status

- **WHEN** required FRG evidence is missing, stale, failed, mismatched, skipped, or waived without policy support
- **THEN** the command SHALL NOT return `status: "complete"`
- **AND** it SHALL exit non-zero or return a failure status that names the version and defect class
