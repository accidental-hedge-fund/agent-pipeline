## MODIFIED Requirements

### Requirement: The candidate-native factory handoff SHALL use one stable prepare interface

The engine SHALL expose the exact non-interactive command `pipeline factory-release prepare --request <absolute-request.json> --json` for durable FRG generation and prepare-only release handoff on every release after v1.33.0. Stable wrappers and ship adapters MAY invoke this command from the clean exact integrated candidate when the installed production engine is one release behind the candidate that provides the command. The request SHALL be versioned, secret-free, and bound to the verified installed production pin (when present), freshly observed base, exact integrated candidate, target release version, and stable action identity when supplied. The request SHALL NOT carry FRG credentials, executable paths, module names, network targets, or caller-authored pass claims.

The command SHALL implement an idempotent multi-tick protocol. A call for a post-1.33 request with no request-bound pack loop, or with a bound loop that is not terminal, SHALL start or resume that bound candidate pack loop, persist `loop_run_id`, and return JSON with `status: "in_progress"`, the bound `loop_run_id`, and a stable restart checkpoint. That call SHALL NOT invent `pass: true`, SHALL NOT return `status: "complete"`, and SHALL NOT open the release pull request. A repeat call with the **unchanged** request SHALL resume the same `loop_run_id` and SHALL NOT start a second unbound pack.

When the bound pack loop is terminal, the command SHALL score it with `pipeline factory-gate --for <target-version> --from-run <loop_run_id>` (or the in-process equivalent) and SHALL NOT pass `--observations`. Only after that score produces complete unsigned FRG artifacts, and no verified production-owned attestation exists, SHALL the command return JSON with `status: "awaiting_frg_attestation"`, closed unsigned artifact identities and digests, and a stable restart checkpoint. It SHALL NOT open the release pull request on that call.

After the wrapper stores a verified production-owned attestation for those exact artifacts, a later call with the **unchanged** request SHALL verify the bound attestation, invoke the existing prepare-only release implementation, and return `status: "complete"` with the exact FRG run identity, release pull request, release head, base commit, and restart checkpoint. Repeated calls at any proved checkpoint SHALL return the same proved state without creating a second pack, loop, attestation, branch, or pull request.

The command SHALL grant no attestation signing, release-PR merge, publication, pin, install, rollback, or Tugboat `--skip-frg` authority. The v1.33.0 hybrid path SHALL NOT be used as a fallback when this command is missing or fails for a later release.

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

- **WHEN** the process stops after pack creation, after loop dispatch, after attestation storage, or after release PR creation but before checkpoint advancement
- **THEN** a restart with the same request SHALL re-observe pack, loop, run, attestation, branch, PR, and head state
- **AND** it SHALL continue from the proved checkpoint without creating a duplicate pack, loop, branch, or release PR

#### Scenario: Missing or failed FRG blocks complete status

- **WHEN** required FRG evidence is missing, stale, failed, mismatched, skipped, or waived without policy support
- **THEN** the command SHALL NOT return `status: "complete"`
- **AND** it SHALL exit non-zero or return a failure status that names the version and defect class

#### Scenario: First call with no bound loop returns in-progress

- **WHEN** a post-1.33 prepare request has no request-bound pack loop
- **THEN** the command SHALL start a bound candidate pack loop and return `status: "in_progress"` with that `loop_run_id` and a restart checkpoint
- **AND** it SHALL NOT return `status: "complete"` or invent `pass: true`
- **AND** it SHALL NOT treat the missing pre-bound loop as `missing_generator`

#### Scenario: Re-invoke resumes the same loop_run_id

- **WHEN** a later call uses the unchanged request
- **AND** the pack instance already records bound `loop_run_id` `L`
- **THEN** the command SHALL resume `L` and return the same proved in-progress, awaiting, complete, or failed state
- **AND** it SHALL NOT start a second unbound pack

## ADDED Requirements

### Requirement: Factory-release prepare SHALL NOT merge, tag, promote, or skip FRG

`pipeline factory-release prepare` SHALL grant no merge, tag, publication, pin
promotion, install, rollback, or Tugboat `--skip-frg` authority on any
protocol tick. An in-progress or failed pack loop SHALL NOT flip those
controls.

#### Scenario: In-progress tick does not gain ship authority

- **WHEN** prepare returns `status: "in_progress"` after dispatching the bound
  pack loop
- **THEN** the command SHALL NOT merge, tag, publish, promote, install, or set
  `--skip-frg`
