## ADDED Requirements

### Requirement: Every harness adapter SHALL declare a delivery-channel `maxPromptBytes` capability

Every registered local-CLI harness adapter SHALL declare a `maxPromptBytes` value on its
`AdapterCapabilities` surface describing the maximum UTF-8 byte length of prompt payload its
declared prompt-delivery channel can accept. The value SHALL be exactly one of:

- a finite positive integer byte limit,
- unlimited (no practical single-payload ceiling on the prompt channel itself), or
- unknown (the adapter cannot honestly claim a bound).

`maxPromptBytes` SHALL be a generic delivery-channel capability for every adapter — built-in,
extension, and custom-reviewer compatibility — and SHALL NOT be modeled as a Pi- or OpenCode-only
exception. The public extension declaration’s prompt size/limit policy (`declaration.prompt`) SHALL
remain coherent with this capability: the shared declaration builder and conformance kit SHALL keep
a single source of truth so the coarse size-limit policy and `maxPromptBytes` cannot disagree.

Because the engine strips types rather than checking them, the shared runtime conformance kit SHALL
fail any registered adapter that omits `maxPromptBytes` or that declares an incoherent channel and
limit pair (for example, positional/`argv` delivery paired with unlimited, or stdin/file delivery
paired with any finite `maxPromptBytes` — stdin/file channels SHALL declare unlimited regardless
of magnitude).

#### Scenario: Conformance requires maxPromptBytes on every registered adapter

- **WHEN** the shared conformance kit evaluates the adapter registry
- **THEN** every registered adapter SHALL expose a `maxPromptBytes` capability that is finite,
  unlimited, or unknown
- **AND** an adapter missing the field SHALL fail the kit with a failure that names
  `maxPromptBytes` (or the equivalent declaration path)

#### Scenario: Argv delivery requires a finite limit

- **WHEN** an adapter declares prompt delivery via a positional/`argv` channel
- **THEN** its `maxPromptBytes` SHALL be a finite positive integer at most the harness
  spawnable argv ceiling (`MAX_ARGV_PROMPT_BYTES`, consistent with the OS per-argument
  limit used by the harness oversize guard)
- **AND** its declaration prompt size/limit policy SHALL not claim unlimited for that channel
- **AND** a finite `maxPromptBytes` greater than that ceiling SHALL fail shared coherence
  validation (conformance / doctor) so mid-gap prompts cannot bypass typed preflight

#### Scenario: Stdin or file delivery declares unlimited

- **WHEN** an adapter declares prompt delivery via standard input or a prompt file the CLI reads
- **THEN** its `maxPromptBytes` SHALL be unlimited
- **AND** its declaration prompt size/limit policy SHALL be coherent with unlimited

#### Scenario: Conformance rejects finite maxPromptBytes on stdin or file

- **WHEN** an adapter declares `stdin` or `file` prompt delivery and a finite `maxPromptBytes`
  (including a value greater than the harness spawnable argv ceiling)
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL identify that stdin/file channels must declare unlimited

#### Scenario: Built-in adapters declare expected limits

- **WHEN** the built-in `claude`, `codex`, `grok`, `pi`, and `opencode` adapters are inspected
- **THEN** `claude`, `codex`, and `grok` SHALL declare unlimited `maxPromptBytes` consistent with
  their stdin or file channels
- **AND** `pi` and `opencode` SHALL declare finite `maxPromptBytes` consistent with argv delivery
  and the harness `MAX_ARG_STRLEN` policy

---

### Requirement: Stage dispatch SHALL refuse a materialized prompt that exceeds the assigned adapter’s finite `maxPromptBytes` before spawn

Before spawning a local-CLI harness for a model-invoking stage, the pipeline SHALL measure the
UTF-8 byte length of the **fully materialized** prompt (after template substitution and assembly)
and compare it to the assigned adapter’s `maxPromptBytes`.

When the adapter declares a **finite** limit and the measured size exceeds that limit under the
single documented comparison rule shared with the harness constants, the pipeline SHALL refuse the
invocation **before** any child process is spawned. The refusal SHALL be a typed capability failure
distinguishable from missing-CLI, unauthenticated, unsupported model/effort, and bare spawn errors.
The failure message SHALL name the adapter, the declared limit, the measured byte size, and a
concrete remedy (for example: assign a stdin- or file-capable adapter; enable stdin prompt delivery
for a custom reviewer CLI; do not retry the same argv-bound assignment).

When the adapter declares **unlimited**, this size check SHALL NOT refuse the invocation for prompt
length alone. When the adapter declares **unknown**, stage dispatch SHALL fail closed before spawn
with remediation to declare a finite limit or unlimited — unknown SHALL NOT be treated as unlimited.

The existing pre-spawn oversize-argv guard on individual argument elements (`MAX_ARG_STRLEN`) SHALL
remain as a residual safety net and SHALL NOT be removed by this requirement.

#### Scenario: Oversize finite-limit prompt is refused before spawn

- **WHEN** a stage assigns an adapter with finite `maxPromptBytes` N
- **AND** the fully materialized prompt’s UTF-8 length is greater than N under the documented
  comparison rule
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed capability refusal naming the adapter, N, the measured size,
  and a remedy

#### Scenario: Under-limit finite prompt is not refused by this check

- **WHEN** a stage assigns an adapter with finite `maxPromptBytes` N
- **AND** the fully materialized prompt’s UTF-8 length is at or under N under the documented
  comparison rule
- **THEN** this size check SHALL NOT refuse the invocation solely for prompt length

#### Scenario: Unlimited adapter is not size-refused

- **WHEN** a stage assigns an adapter that declares unlimited `maxPromptBytes`
- **AND** the fully materialized prompt exceeds 131,072 UTF-8 bytes
- **THEN** this size check SHALL NOT refuse the invocation solely for prompt length
- **AND** the prompt SHALL still be delivered on the adapter’s declared non-argv channel

#### Scenario: Unknown limit fails closed

- **WHEN** a stage assigns an adapter that declares unknown `maxPromptBytes`
- **THEN** stage dispatch SHALL refuse before spawn
- **AND** the refusal SHALL tell the operator to declare a finite limit or unlimited

#### Scenario: Refusal is not a bare spawn error

- **WHEN** a finite-limit oversize refusal is produced
- **THEN** the failure SHALL be distinguishable from a missing CLI or transient spawn failure
- **AND** the message SHALL state that retrying the same invocation cannot succeed without changing
  adapter or delivery channel

---

### Requirement: Pi and OpenCode adapters SHALL record a re-verified upstream prompt-delivery finding

The `pi` and `opencode` adapter modules SHALL each carry a header comment that records a
re-verification of that CLI’s documented headless interface for a message-replacing standard-input
or prompt-file channel. The comment SHALL state whether such a channel exists. The adapters SHALL
NOT invent a channel the CLI does not document. When no message-replacing channel is documented,
the adapters SHALL keep argv delivery and a finite `maxPromptBytes` consistent with
`MAX_ARG_STRLEN`.

#### Scenario: Header comment documents the upstream finding

- **WHEN** the `pi` and `opencode` adapter source headers are read
- **THEN** each SHALL state the re-verified presence or absence of a stdin or prompt-file channel
  that replaces the message positional
- **AND** neither adapter SHALL claim a non-argv channel without that documented interface
