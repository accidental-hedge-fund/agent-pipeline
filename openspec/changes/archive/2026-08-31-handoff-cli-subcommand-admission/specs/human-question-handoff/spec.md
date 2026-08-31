## ADDED Requirements

### Requirement: The shared CLI positional gate SHALL admit documented `handoff` sub-verb grammar

The shared extra-positionals gate SHALL match the documented `pipeline handoff` grammar so that argv reaches the existing `handoff` dispatch block. The gate SHALL admit `handoff list` with the verb only. The gate SHALL admit `handoff show`, `handoff answer`, `handoff reject`, and `handoff supersede` with the verb plus exactly one handoff ID. Flags such as `--issue` and `--json` SHALL remain options and SHALL NOT count as positional tokens. The operator interface SHALL be the `pipeline handoff <verb>` CLI. Direct module invocation SHALL NOT be an accepted operator path. This requirement SHALL NOT change per-verb required flags, registry allowlists, authentication, idempotency, issue locking, Decisions materialization, or audit behavior. Authenticated handlers SHALL still enforce authentication.

#### Scenario: `handoff list` reaches the list handler

- **WHEN** an operator runs `pipeline handoff list --issue N --json`
- **THEN** the shared extra-positionals gate SHALL NOT reject the `list` verb as an unexpected argument
- **AND** argv SHALL reach the existing list handler

#### Scenario: `handoff show` reaches the read-only handler

- **WHEN** an operator runs `pipeline handoff show <handoff-id> --issue N --json`
- **THEN** the shared extra-positionals gate SHALL NOT reject the `show` verb or the handoff ID as unexpected arguments
- **AND** argv SHALL reach the existing read-only show handler

#### Scenario: Mutating verbs reach authenticated handlers

- **WHEN** an operator runs `pipeline handoff answer <handoff-id> …`, `pipeline handoff reject <handoff-id> …`, or `pipeline handoff supersede <handoff-id> …` with exactly one handoff ID and the existing required flags
- **THEN** the shared extra-positionals gate SHALL NOT reject the verb or the handoff ID as unexpected arguments
- **AND** argv SHALL reach the matching existing authenticated handler
- **AND** that handler SHALL still enforce authentication

#### Scenario: Flags are not positional tokens

- **WHEN** the real argument parser receives `pipeline handoff list --issue N --json`
- **THEN** `--issue` and `--json` SHALL be options
- **AND** the remaining positionals SHALL be `handoff` and `list` only

#### Scenario: CLI-parser regression covers every documented verb

- **WHEN** CLI-level regression tests run each documented handoff verb (`list`, `show`, `answer`, `reject`, `supersede`) through the real argument parser
- **THEN** those tests SHALL fail if the positional gate still rejects the verb
- **AND** handler-only unit tests SHALL NOT be treated as sufficient coverage for this admission gate

#### Scenario: Materialization stays on existing seams

- **WHEN** tests prove that an operator can answer a Decisions authority handoff through the CLI
- **THEN** verification SHALL use the CLI parser plus existing handler and materialization seams with injected I/O
- **AND** verification SHALL NOT require a live GitHub mutation in CI
- **AND** landing this change SHALL NOT itself attest a live Decisions node

#### Scenario: Handler mutation semantics stay unchanged

- **WHEN** admitted `handoff answer`, `handoff reject`, or `handoff supersede` argv reaches its existing handler
- **THEN** that handler SHALL keep current mutation, idempotency, and audit semantics
- **AND** a successful answer SHALL NOT advance the issue as a side effect
- **AND** advance SHALL still stop at `pipeline:ready-to-deploy`
- **AND** merge SHALL remain a separate operator-authorized verb

---

### Requirement: Invalid `handoff` argv SHALL fail with exit 2 before a read or a mutation

The shared extra-positionals gate plus the verb-aware extra-token check SHALL reject invalid `handoff` argv with exit code 2, matching current CLI validation. A missing verb, an unknown verb, or extra positional tokens SHALL fail before dispatch to a handler. Invalid `list` or `show` argv SHALL fail before a read. Invalid `answer`, `reject`, or `supersede` argv SHALL fail before mutation. Extra positional tokens, a missing required ID, a missing verb, and an unknown verb SHALL never reach `answer`, `reject`, or `supersede`. The gate SHALL only admit argv. This requirement SHALL NOT weaken handler authentication.

#### Scenario: Extra tokens after `list` fail before a read

- **WHEN** an operator runs `pipeline handoff list` with an extra positional token
- **THEN** the CLI SHALL exit 2
- **AND** the list handler SHALL NOT run

#### Scenario: ID-taking verbs require exactly one handoff ID

- **WHEN** `show`, `answer`, `reject`, or `supersede` is invoked with no handoff ID
- **THEN** the CLI SHALL exit 2
- **AND** no read SHALL run for `show`
- **AND** no mutation SHALL run for `answer`, `reject`, or `supersede`

#### Scenario: Extra tokens after an ID-taking verb fail before a read or a mutation

- **WHEN** `show`, `answer`, `reject`, or `supersede` is invoked with a handoff ID plus an extra positional token
- **THEN** the CLI SHALL exit 2
- **AND** `show` SHALL NOT read
- **AND** `answer`, `reject`, and `supersede` SHALL NOT mutate

#### Scenario: Missing or unknown verb fails before a handler

- **WHEN** an operator runs `pipeline handoff` with no verb, or with a verb that is not `list`, `show`, `answer`, `reject`, or `supersede`
- **THEN** the CLI SHALL exit 2
- **AND** no list, show, answer, reject, or supersede handler SHALL run
