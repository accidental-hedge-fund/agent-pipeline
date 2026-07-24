# cli-harness-adapters Specification

## Purpose
TBD - created by archiving change cli-harness-adapters. Update Purpose after archive.
## Requirements
### Requirement: A typed local-CLI harness adapter contract SHALL own every harness-specific invocation detail

The pipeline SHALL define a single typed adapter contract that is the only place a local CLI
harness's specifics live. Each adapter SHALL provide: a stable adapter name, a declared
capability set, a capability preflight, construction of a headless invocation (working directory,
prompt delivery, model, effort, permission/sandbox mode), telemetry/result extraction, and a
treatment-identity description. The harness invocation entry point SHALL dispatch through a
registry of adapters rather than branching on harness names, and SHALL return the pipeline's
existing normalized harness result unchanged for every adapter.

Because the engine strips types rather than checking them, the contract SHALL be backed by a
runtime conformance test asserting that every registered adapter implements every contract member.

#### Scenario: Every registered adapter satisfies the contract at runtime

- **WHEN** the conformance test iterates the adapter registry
- **THEN** every registered adapter SHALL expose a name, a declared capability set, and callable
  invocation-construction, preflight, telemetry-extraction, and treatment-description members

#### Scenario: Invocation dispatches through the registry

- **WHEN** the harness invocation entry point is called with a registered adapter name
- **THEN** the command and arguments SHALL be produced by that adapter's invocation construction
- **AND** the returned value SHALL be the pipeline's existing normalized harness result shape

#### Scenario: Declared capabilities describe the adapter

- **WHEN** an adapter's declared capability set is read
- **THEN** it SHALL state whether that CLI supports model selection, a reasoning-effort control,
  a restricted-permission mode, how its working directory is set, and whether it offers
  machine-readable per-call output

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

### Requirement: The pipeline SHALL provide Grok Build, Pi, and OpenCode adapters that run headlessly in the stage worktree

The adapter registry SHALL include adapters named `grok`, `pi`, and `opencode` in addition to
`claude` and `codex`. Each SHALL construct a single-turn, headless, non-interactive invocation
whose working directory is the stage worktree, SHALL rely solely on the credentials established by
that CLI's own already-completed login flow, and SHALL NOT require or trigger any interactive
prompt, terminal UI, or login flow at invocation time.

Each adapter's concrete arguments SHALL be derived from that CLI's own documented headless
interface, recorded in the change's design record, and SHALL NOT be invented. Where a CLI offers no
control for a requested capability, the adapter SHALL declare that capability unsupported rather
than silently omitting the request.

#### Scenario: A new adapter runs a stage in the worktree without interaction

- **WHEN** a model-invoking stage is assigned to the `grok`, `pi`, or `opencode` adapter and that
  CLI's documented login has already completed
- **THEN** the invocation SHALL execute headlessly with the stage worktree as its working directory
- **AND** it SHALL complete without presenting an interactive prompt or terminal UI

#### Scenario: An unsupported capability is declared, not dropped

- **WHEN** a reasoning effort is requested for an adapter whose CLI offers no reasoning-effort
  control
- **THEN** that adapter SHALL declare the effort capability unsupported
- **AND** preflight SHALL report the requested effort as unsupported rather than the invocation
  silently proceeding without it

### Requirement: Adapter preflight SHALL distinguish missing, unauthenticated, headless-incapable, and unsupported-setting states before the stage runs

Each adapter SHALL provide a preflight that reports, as separately identifiable outcomes: the CLI
is not present on `PATH`; the CLI is present but not authenticated; the CLI's headless
non-interactive mode is unavailable; and the requested model or effort is unsupported by that
adapter. Preflight SHALL run before the stage's model invocation begins. A preflight failure SHALL
block the item with an error naming both the stage and the adapter, and the pipeline SHALL NOT fall
back to a different harness, because a silent substitution would change the treatment being
measured. Preflight SHALL execute through the pipeline's injected execution seam so it is testable
without real subprocess or network calls.

#### Scenario: Missing CLI is reported before the stage starts

- **WHEN** a stage is assigned an adapter whose CLI is not present on `PATH`
- **THEN** preflight SHALL fail with a message naming the stage and the adapter and identifying the
  CLI as missing
- **AND** the stage's model invocation SHALL NOT be attempted

#### Scenario: Unauthenticated CLI is distinguished from a missing CLI

- **WHEN** a stage is assigned an adapter whose CLI is installed but has not completed its login
- **THEN** preflight SHALL fail with an outcome identifying an unauthenticated CLI, distinct from
  the missing-CLI outcome

#### Scenario: Unsupported model or effort is reported

- **WHEN** a stage requests a model or effort value the assigned adapter does not support
- **THEN** preflight SHALL fail with an outcome identifying the unsupported setting and naming the
  requested value

#### Scenario: Preflight failure never falls back to another harness

- **WHEN** an adapter's preflight fails for an assigned stage
- **THEN** the item SHALL be blocked
- **AND** the stage SHALL NOT be executed on the profile default harness or any other adapter

### Requirement: Timeout or cancellation SHALL terminate an adapter's entire process tree

Every adapter invocation SHALL run through the pipeline's capped-execution path with process-group
termination and its existing hard secondary deadline. No adapter SHALL spawn its process detached
from that path. When the wall-clock cap fires or the run is cancelled, the harness CLI **and** any
processes it spawned SHALL be terminated, and the result SHALL be flagged as timed out.

#### Scenario: A spawned child of the harness CLI is also terminated

- **WHEN** an adapter's CLI spawns a long-lived child process and the invocation exceeds its
  wall-clock cap
- **THEN** both the CLI process and its child SHALL be terminated
- **AND** the returned result SHALL be flagged as timed out

#### Scenario: No adapter bypasses the capped-execution path

- **WHEN** the adapter registry is inspected
- **THEN** every adapter's invocation SHALL be executed through the capped-execution path with
  process-group termination enabled

### Requirement: Treatment identity SHALL distinguish harness adapter from provider and separate requested from resolved settings

Every adapter invocation SHALL produce a treatment identity carrying: the adapter name, the CLI
version, the provider/auth class when the CLI reports one, the requested model, the resolved model,
the requested effort, the resolved effort, and the resolved native argument names.

The adapter name and the provider SHALL be recorded as distinct values. An invocation through the
`pi` or `opencode` adapter that is served by a given provider SHALL be recorded with that adapter's
name and that provider — and SHALL NOT be recorded under another vendor's native-CLI adapter name.
When the CLI reports no reliable provider signal, the provider SHALL be recorded as unknown; it
SHALL NOT be inferred from the model name, because one model alias may be served by more than one
route.

Requested and resolved effort SHALL be recorded verbatim as two separate values. The pipeline SHALL
NOT define any cross-harness effort normalization, mapping, or equivalence, and SHALL NOT represent
similarly named effort levels from different harnesses as equal compute.

#### Scenario: A third-party harness on another vendor's model is not mislabeled

- **WHEN** a stage runs through the `opencode` or `pi` adapter configured against an Anthropic model
- **THEN** the treatment identity SHALL record the adapter as `opencode` or `pi` respectively and
  the provider as that provider
- **AND** it SHALL NOT record the adapter or harness as `claude`

#### Scenario: Unknown provider is recorded as unknown

- **WHEN** an adapter's CLI reports no provider or auth-route signal
- **THEN** the treatment identity SHALL record the provider as unknown
- **AND** it SHALL NOT derive a provider value from the requested model name

#### Scenario: Requested and resolved settings are both recorded

- **WHEN** a stage requests a model and an effort and the adapter resolves them to native values
- **THEN** the treatment identity SHALL carry the requested model, the resolved model, the
  requested effort, and the resolved effort as separate values
- **AND** SHALL carry the resolved native argument names used for that invocation

#### Scenario: No cross-harness effort equivalence is asserted

- **WHEN** two stages run at the same requested effort on two different adapters
- **THEN** each SHALL record its own requested and resolved effort verbatim
- **AND** no mapping, normalization, or statement of equal compute between the two SHALL be produced

### Requirement: Adapters SHALL rely on existing local CLI credentials and never persist them

An adapter SHALL depend only on the credentials that CLI already holds from its own login flow.
The pipeline SHALL NOT read, synthesize, forward, or store any credential value, token, or auth
file content, and SHALL NOT emit one in any run artifact, event, log line, or error message. Only
the coarse provider/auth class label SHALL ever appear in evidence.

#### Scenario: No credential material reaches evidence

- **WHEN** a stage runs through any adapter and its run artifacts, events, and error messages are
  inspected
- **THEN** no credential value, token, or auth file content SHALL appear in any of them
- **AND** at most a coarse provider/auth class label SHALL be present

### Requirement: Harness resolution precedence SHALL be deterministic and preserve the custom reviewer-CLI escape hatch

For a model-invoking stage the pipeline SHALL resolve its harness in this order: an explicit
per-stage executor assignment; otherwise, for review stages, the configured reviewer-harness
override; otherwise the active profile's implementer or reviewer harness. When no executor
assignment and no reviewer-harness override are configured, harness resolution and the executed
argv SHALL be exactly as they were before adapters were introduced, with no new warning.

A harness name that is not a registered adapter SHALL continue to be invoked as a configured
reviewer CLI with the prompt as a single positional argument, and a CLI that cannot be spawned
SHALL still yield the existing named, actionable failure in the returned result rather than an
unknown-harness error.

#### Scenario: A stage assignment outranks the reviewer-harness override

- **WHEN** a review stage has both a per-stage executor assignment and a configured
  reviewer-harness override
- **THEN** the stage SHALL run through the assigned executor's adapter

#### Scenario: Absent configuration is unchanged

- **WHEN** the configuration contains no executor assignments and no reviewer-harness override
- **THEN** each stage SHALL resolve to the profile's harness and execute the same argv as before
  this change
- **AND** no new warning SHALL be emitted

#### Scenario: An unregistered name still takes the custom reviewer-CLI path

- **WHEN** a configured reviewer harness names a command that is not a registered adapter
- **THEN** it SHALL be spawned with the prompt as a single positional argument
- **AND** if it cannot be spawned, the result SHALL carry the existing named "not found or not
  executable" message and spawn-failure flag rather than an unknown-harness error

### Requirement: Adapter setup and per-stage assignment SHALL be documented for every built-in adapter

The host skill documentation SHALL describe, for each of the five built-in adapters, the
operator-run login step required before use and an example configuration assigning that adapter to
a model-invoking stage. The documentation SHALL state explicitly that similarly named effort levels
are not comparable across harnesses.

#### Scenario: Documentation covers all five adapters

- **WHEN** the host skill documentation is read
- **THEN** it SHALL give a setup step and an example per-stage assignment for `claude`, `codex`,
  `grok`, `pi`, and `opencode`
- **AND** it SHALL state that effort levels are not comparable across harnesses

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

### Requirement: The Pi adapter's missing-CLI install guidance SHALL name the maintained npm package

The Pi adapter's `missing-cli` preflight guidance SHALL direct users to install the
maintained npm package `@earendil-works/pi-coding-agent`, and SHALL NOT name the deprecated
package `@mariozechner/pi-coding-agent`. The deprecated package's own npm notice directs
users to the maintained package, so naming it in the pipeline's user-facing guidance would
install an unmaintained package. This constraint applies to every user-facing occurrence of
the package name in the executable adapter source (the `missing-cli` message and any
provenance comment), and SHALL hold identically in both the `core/` source and its
generated packaged-plugin mirror.

The change SHALL be backed by a regression assertion so the user-facing install guidance
cannot drift back to the deprecated package name. Because the binary name (`pi`) and the
preflight probe arguments are unchanged, this SHALL NOT alter the adapter's presence check,
argv, capabilities, or any preflight outcome other than the text of the install guidance.

#### Scenario: Missing Pi CLI guidance names the maintained package

- **WHEN** the Pi adapter's preflight reports that the `pi` CLI is not present on `PATH`
- **THEN** the returned guidance SHALL name `@earendil-works/pi-coding-agent` as the package
  to install
- **AND** the guidance SHALL NOT contain the deprecated package name
  `@mariozechner/pi-coding-agent`

#### Scenario: A regression assertion guards against drift to the deprecated name

- **WHEN** the adapter test suite runs
- **THEN** an assertion SHALL confirm the Pi adapter's missing-CLI guidance names
  `@earendil-works/pi-coding-agent`
- **AND** that assertion SHALL fail if the deprecated name `@mariozechner/pi-coding-agent`
  reappears in the user-facing install guidance

#### Scenario: Presence detection is unchanged by the guidance update

- **WHEN** the `pi` binary installed by `@earendil-works/pi-coding-agent` is present on
  `PATH`
- **THEN** the Pi adapter's presence check SHALL pass using the same probe arguments as
  before the guidance update
- **AND** the `missing-cli` outcome SHALL be returned only when the `pi` binary is absent

