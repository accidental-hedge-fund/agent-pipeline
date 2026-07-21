## ADDED Requirements

### Requirement: Prompt delivery SHALL NOT place the prompt in an argv element that can exceed the operating system's per-argument limit

The pipeline SHALL deliver a stage prompt to a harness CLI through a channel that imposes no
practical size limit — the CLI's standard input, or a file the CLI itself reads. For any prompt of
any size, no single argument in the argument list the pipeline executes SHALL exceed
`MAX_ARG_STRLEN` (131,072 bytes on Linux) when measured as UTF-8 bytes.

This requirement SHALL apply to every prompt-bearing invocation the pipeline constructs, including
reviewer invocations in prompt-harness mode, plan-review, implementation and fix rounds, and
evaluation-mode stage invocations.

#### Scenario: A prompt larger than the per-argument limit is delivered intact

- **WHEN** a stage invokes a harness with a prompt whose UTF-8 length exceeds 131,072 bytes
- **THEN** the prompt SHALL be delivered to the CLI in full and unmodified
- **AND** no argument in the executed argument list SHALL exceed 131,072 bytes
- **AND** the invocation SHALL NOT fail with a spawn error caused by argument size

#### Scenario: A large reviewer prompt produces a verdict instead of a spawn failure

- **WHEN** a review round assembles a prompt of roughly 168,000 characters from a large diff,
  digest, and conventions
- **THEN** the reviewer CLI SHALL receive that prompt and run the review
- **AND** its structured verdict SHALL be parsed from stdout exactly as it is for a small prompt

#### Scenario: Small-prompt behavior is unchanged

- **WHEN** a stage invokes a harness with a prompt below the per-argument limit
- **THEN** the executed command, its flags, its working directory, its telemetry mode, and the
  parsing of its stdout SHALL be identical to the pre-change behavior for that harness and options
- **AND** the only difference SHALL be the channel carrying the prompt

---

### Requirement: Each harness adapter SHALL declare its prompt-delivery channel from that CLI's own documented interface

The harness-adapter contract SHALL carry an explicit prompt-delivery channel — the CLI's standard
input, a prompt file the CLI reads, or a positional argument — and the adapter SHALL be the sole
owner of that decision. The invocation call site SHALL NOT branch on harness name to decide how the
prompt is delivered.

Each adapter's declared channel SHALL be derived from that CLI's own documented headless interface
and recorded in the change's design record; it SHALL NOT be invented. An adapter whose CLI documents
neither a standard-input nor a file channel SHALL declare the positional channel explicitly rather
than being assumed to support another one.

#### Scenario: An adapter delivers the prompt on its declared channel

- **WHEN** an adapter that declares the standard-input channel builds an invocation
- **THEN** the prompt SHALL be supplied as the child process's standard input payload
- **AND** the prompt SHALL NOT appear in the argument list

#### Scenario: A file-channel adapter references a prompt file the CLI reads

- **WHEN** an adapter that declares the file channel builds an invocation
- **THEN** the argument list SHALL reference a pipeline-created prompt file under the managed
  worktree root using that CLI's documented prompt-file option
- **AND** the prompt file SHALL contain the prompt verbatim
- **AND** the pipeline SHALL remove exactly that file after the invocation completes

#### Scenario: Standard input is opened only when a payload exists

- **WHEN** an invocation carries no standard-input prompt payload
- **THEN** the child process SHALL be spawned with its standard input configured exactly as before
  this change
- **AND** no data SHALL be written to the child's standard input

#### Scenario: The declared channel is pinned by a regression test

- **WHEN** the golden-argv regression test runs for every built-in adapter
- **THEN** it SHALL assert both the argument list and the declared prompt-delivery channel for each
  adapter and each option variant
- **AND** a change to either SHALL fail the test

---

### Requirement: An oversize prompt on a positional-delivery target SHALL be refused with a named, actionable failure instead of being spawned

The pipeline SHALL NOT attempt a spawn when the only available prompt-delivery channel for a target
is a positional argument and the prompt exceeds the per-argument limit. It SHALL instead fail with a
specific, named failure that states the per-argument limit, the measured prompt size, and the
remedy, and that is distinguishable from a transient or environmental spawn failure such as a
missing CLI.

#### Scenario: An oversize positional prompt is not spawned

- **WHEN** a positional-delivery target is invoked with a prompt whose UTF-8 length exceeds the
  per-argument limit
- **THEN** no child process SHALL be spawned
- **AND** the result SHALL name the per-argument limit and report the measured prompt byte size
- **AND** the result SHALL identify the prompt-delivery remedy

#### Scenario: The oversize failure is not mistaken for a transient error

- **WHEN** an invocation fails because the prompt exceeds the per-argument limit
- **THEN** the recorded failure SHALL be distinguishable from a spawn failure caused by a missing or
  unauthenticated CLI
- **AND** the failure SHALL be presented as a condition that retrying the same invocation cannot
  resolve

## MODIFIED Requirements

### Requirement: Claude and Codex invocations SHALL be preserved byte-for-byte behind their adapters

Moving the built-in `claude` and `codex` harnesses behind adapters SHALL NOT change the command or
arguments the pipeline executes for any existing configuration, including the machine-readable
telemetry mode and its opt-out, the sandboxed permission mode, the lean single-shot mode, and the
external-sandbox bypass mode. The sole permitted difference SHALL be the removal of the prompt from
the argument list where the adapter declares a standard-input or file prompt-delivery channel,
together with any argument that CLI documents for selecting that channel. A golden-argv regression
test SHALL pin these argv shapes and each adapter's declared prompt-delivery channel.

#### Scenario: Default claude and codex argv are unchanged apart from prompt delivery

- **WHEN** the invocation for `claude` and for `codex` is constructed with default options
- **THEN** the resulting command and argument list SHALL be identical to the pre-adapter argv for
  each harness except that the prompt positional is replaced by that CLI's documented
  standard-input selection
- **AND** the prompt SHALL be delivered as the standard-input payload

#### Scenario: Option variants are unchanged

- **WHEN** the invocation is constructed with the sandboxed permission mode, with the lean
  single-shot mode, with the telemetry opt-out set, and with the external-sandbox bypass set
- **THEN** each resulting argument list SHALL be identical to the pre-adapter argv for that variant
  apart from prompt delivery
- **AND** in the lean variant the tool-disabling option SHALL NOT consume any following argument
