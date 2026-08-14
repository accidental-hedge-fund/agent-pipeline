## Purpose

Defines the shared host-side ship status notifier (`ship-notify`) so optional Buzz posts are retried on transient send failures, audited on success and failure, and never silently appear delivered when the relay rejects them — while remaining best-effort for ship and train composers.

## ADDED Requirements

### Requirement: Ship-notify SHALL capture send exit status and reason instead of masking them

When the shared ship-notify helper is configured to post (messenger binary, channel, and credentials present; `SHIP_NOTIFY` not disabled) and it invokes the messenger send command, it SHALL capture the send command’s exit status and a non-empty reason derived from stderr or a status summary when the send fails. The helper SHALL NOT discard all send failures solely via an unconditional success path that leaves no durable failure record. Successful and finally-failed send outcomes SHALL be written to an audit artifact under the notify state directory (`PIPELINE_SUPERVISOR_STATE` notify root, or the helper’s documented default state root).

#### Scenario: Failed send records an audit line with reason

- **WHEN** a configured ship-notify send exhausts its retry budget with non-zero exit status on every attempt
- **THEN** the helper SHALL append an audit record under the notify state directory that includes a timestamp and a failure reason (or truncated stderr summary)
- **AND** the helper SHALL NOT treat the outcome as a silent success with no durable failure artifact

#### Scenario: Successful send records success audit without a final-failure marker

- **WHEN** a configured ship-notify send succeeds on any attempt within the retry budget
- **THEN** the helper SHALL record a successful delivery audit entry under the notify state directory
- **AND** it SHALL NOT leave a supervisor-visible final-failure marker for that successful attempt

### Requirement: Ship-notify SHALL retry transient messenger failures with bounded backoff

When a configured send fails with a non-zero exit status, the shared ship-notify helper SHALL retry the send up to a bounded maximum number of attempts (default at least three total attempts including the first). Between attempts the helper SHALL wait according to a documented backoff schedule (default increasing delays suitable for short gateway blips, e.g. on the order of seconds to tens of seconds). The helper SHALL stop retrying immediately after the first successful send. Operators and tests SHALL be able to shorten or zero the sleep via environment configuration so automated checks do not wait the full production backoff.

#### Scenario: Transient failures then success yield one successful post

- **WHEN** the messenger send fails on the first two attempts and succeeds on the third within the default attempt budget
- **THEN** the helper SHALL invoke the send command three times
- **AND** it SHALL record a successful delivery audit entry
- **AND** it SHALL NOT record a final-failure marker for that notification

#### Scenario: Exhausted retries still exit zero

- **WHEN** every send attempt within the retry budget fails
- **THEN** the helper SHALL stop after the budgeted attempts
- **AND** the process SHALL exit with status 0 (best-effort notify)
- **AND** a supervisor-visible failure marker SHALL exist under the notify state directory

### Requirement: Ship-notify final failure SHALL leave a supervisor-visible marker

When a configured send fails after all retries, the helper SHALL write a durable marker file under the notify state directory that an operator or outer supervisor can discover without reading process memory. The marker SHALL include enough of the intended message content (or its key) and the failure reason to identify what was not delivered. The helper SHALL NOT require a second messenger product or a new pipeline stage to create this marker.

#### Scenario: Marker is present after total send failure

- **WHEN** a configured send fails all attempts
- **THEN** a file under the notify state directory SHALL identify the failed notification and reason
- **AND** the helper process SHALL still exit 0

#### Scenario: No-op configuration does not invent failure markers

- **WHEN** `SHIP_NOTIFY` is `0`, or the messenger binary/channel/credentials are not configured
- **THEN** the helper SHALL exit 0 without posting
- **AND** it SHALL NOT create a final-failure marker solely because the messenger is unconfigured

### Requirement: Ship-notify SHALL preserve dedupe and force semantics without masking errors

When a dedupe key is supplied without `--force`, the helper SHALL continue to suppress a second send of the same content for that key within the configured TTL using the existing on-disk dedupe file format under the notify state directory. When `--force` is supplied with a key, the helper SHALL bypass TTL dedupe for that invocation. In both paths, when a send is actually attempted and fails after retries, the helper SHALL still write audit and final-failure artifacts and SHALL NOT mask the failure. Empty message content SHALL exit 0 without posting.

#### Scenario: TTL dedupe suppresses duplicate within window

- **WHEN** the helper is invoked twice with the same key and same content within the dedupe TTL without `--force`
- **AND** the first invocation already recorded the dedupe entry
- **THEN** the second invocation SHALL exit 0 without performing an additional messenger send

#### Scenario: Force bypasses dedupe and still surfaces send failure

- **WHEN** the helper is invoked with `--force` and a configured messenger that fails all send attempts
- **THEN** the helper SHALL attempt the send (not skip solely due to TTL)
- **AND** it SHALL write failure audit and supervisor-visible marker artifacts
- **AND** it SHALL exit 0

#### Scenario: Empty message is a no-op

- **WHEN** the helper is invoked with an empty message
- **THEN** it SHALL exit 0
- **AND** it SHALL NOT invoke the messenger send command

### Requirement: Ship-notify delivery failure SHALL NOT block ship or train progression

Callers of the shared ship-notify helper (including Tugboat, the chain ship playbook, and stage-watch) rely on best-effort delivery. A messenger send failure after retries SHALL leave the helper exit status 0 so that notify failure alone does not fail a ship phase or train solely due to channel delivery. Stage progression and composer phase status remain governed by their own gates, not by proof of Buzz delivery.

#### Scenario: Exhausted notify failure does not fail the helper process

- **WHEN** a configured send fails every attempt in the retry budget
- **THEN** `ship-notify` SHALL exit 0
- **AND** durable audit and failure marker artifacts SHALL still be present for operators

### Requirement: Ship-notify delivery observability SHALL be regression-tested

Automated tests covered by `npm run ci` SHALL exercise the shared helper with a fake messenger binary (no real network). The suite SHALL include at least: (1) fail-then-succeed within budget → one successful outcome and success audit; (2) fail-all → failure audit, supervisor-visible marker, exit 0. The suite SHALL fail if the helper again discards all send failures without durable audit/marker artifacts while claiming success only by exit code.

#### Scenario: Transient-success fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that fails twice then succeeds
- **THEN** the tests SHALL observe a successful audit outcome and the expected send attempt count
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Permanent-failure fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that always fails
- **THEN** the tests SHALL observe exit 0, a failure audit line, and a supervisor-visible marker
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Silent-mask regression fails the suite

- **WHEN** the helper implementation returns exit 0 after a total send failure without writing a failure audit or marker
- **THEN** the automated regression tests SHALL fail
