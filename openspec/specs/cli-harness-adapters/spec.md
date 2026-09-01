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
external-sandbox bypass mode — **except** for the intentional Codex managed-sandbox flag migration
from the deprecated `--full-auto` alias to the non-deprecated `--sandbox workspace-write` pair
(issue #613). The sole other permitted difference SHALL be the removal of the prompt from the
argument list where the adapter declares a standard-input or file prompt-delivery channel, together
with any argument that CLI documents for selecting that channel. A golden-argv regression test
SHALL pin these argv shapes and each adapter's declared prompt-delivery channel.

For the Codex managed-sandbox shape (no external-bypass selection), the adapter SHALL emit
`--sandbox` and `workspace-write` as consecutive arguments after `exec` and SHALL NOT emit
`--full-auto`. The adapter SHALL NOT emit post-`exec` approval-policy arguments
(`-a`, `--ask-for-approval`, or equivalent): on the verified Codex CLI, those tokens are rejected
after `exec`, and the headless never-ask policy is the `codex exec` path default. The effective
sandbox and headless approval behavior SHALL remain equivalent to the former `--full-auto` path on
`codex exec` (session-equivalent `approval: never` and `sandbox: workspace-write` as verified for
the recorded CLI version in this change's design). The external-sandbox bypass argument remains
`--dangerously-bypass-approvals-and-sandbox` and SHALL be mutually exclusive with the managed
sandbox sequence (`--sandbox` + `workspace-write`) and with any approval-policy arguments.

Invocation shaping SHALL additionally accept an explicit caller-supplied external-sandbox mode. When
a caller supplies one, that value alone SHALL select the external-sandbox bypass or the harness's
managed sandbox for that invocation; the ambient external-sandbox environment variable SHALL be
consulted only when the caller supplies no value, preserving today's behavior for every existing
call site. Supplying a mode SHALL change no argument other than the sandbox-selecting argument
sequence (managed: `--sandbox` + `workspace-write`; bypass: the single external-bypass flag).

#### Scenario: Default claude argv is unchanged apart from prompt delivery

- **WHEN** the invocation for `claude` is constructed with default options
- **THEN** the resulting command and argument list SHALL be identical to the established
  post-adapter claude argv except that the prompt positional is replaced by that CLI's documented
  standard-input selection
- **AND** the prompt SHALL be delivered as the standard-input payload

#### Scenario: Default codex managed-sandbox argv uses non-deprecated sandbox flags

- **WHEN** the invocation for `codex` is constructed with default options and no external-bypass
  selection
- **THEN** the argument list SHALL include consecutive `--sandbox` and `workspace-write`
- **AND** the argument list SHALL NOT include `--full-auto`
- **AND** the argument list SHALL NOT include `-a` or `--ask-for-approval`
- **AND** the prompt SHALL be delivered as the standard-input payload with the trailing `-`
  sentinel

#### Scenario: Option variants preserve non-sandbox argv

- **WHEN** the invocation is constructed with the sandboxed permission mode, with the lean
  single-shot mode, with the telemetry opt-out set, and with the external-sandbox bypass set
- **THEN** each resulting argument list SHALL match the established shape for that variant
  apart from prompt delivery and the #613 managed-sandbox flag migration on codex
- **AND** in the lean variant the tool-disabling option SHALL NOT consume any following argument
- **AND** the external-sandbox bypass variant SHALL carry `--dangerously-bypass-approvals-and-sandbox`
  and SHALL NOT carry `--full-auto`, `--sandbox` with `workspace-write`, `-a`, or
  `--ask-for-approval`

#### Scenario: An explicitly supplied sandbox mode selects the invocation shape

- **WHEN** a caller constructs a `codex` invocation supplying the external-sandbox mode explicitly
- **THEN** the argument list SHALL carry the external-sandbox bypass argument
- **AND** every other argument SHALL be identical to the managed-sandbox shape after removing the
  managed sandbox-selecting sequence (`--sandbox`, `workspace-write`) from the managed side and the
  bypass flag from the bypass side
- **AND** neither side SHALL carry `--full-auto` or post-`exec` approval-policy arguments

#### Scenario: An explicitly supplied mode overrides the ambient environment variable

- **WHEN** the ambient external-sandbox environment variable is set and a caller supplies the
  managed-sandbox mode explicitly
- **THEN** the resulting argument list SHALL be the managed-sandbox shape (`--sandbox` +
  `workspace-write`, not the bypass flag, not `--full-auto`, not `-a` / `--ask-for-approval`)

#### Scenario: Callers supplying no mode keep the ambient-environment behavior

- **WHEN** an invocation is constructed with no caller-supplied sandbox mode
- **THEN** the external-sandbox bypass SHALL be selected exactly when the ambient environment
  variable requests it
- **AND** otherwise the managed-sandbox shape SHALL use `--sandbox` + `workspace-write` and SHALL
  NOT use `--full-auto` or post-`exec` approval-policy arguments

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

Durable operator documentation SHALL describe, for each built-in adapter, the
operator-run login step required before use and an example configuration that
assigns the adapter to a model-invoking stage. The documentation SHALL state
that similarly named effort levels are not comparable across harnesses. A
generated short host one-pager MAY point to that documentation; it SHALL NOT be
required to carry the five-adapter setup and configuration tutorial.

#### Scenario: Documentation covers all five adapters

- **WHEN** the adapter setup documentation is read
- **THEN** it SHALL give a setup step and an example per-stage assignment for
  `claude`, `codex`, `grok`, `pi`, and `opencode`
- **AND** it SHALL state that effort levels are not comparable across harnesses

#### Scenario: Generated one-pager links instead of duplicating setup

- **WHEN** an operator reads a generated host one-pager
- **THEN** it MAY link to the durable adapter documentation
- **AND** it SHALL NOT be required to repeat login commands or per-stage YAML for
  all built-in adapters

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

### Requirement: Adapters SHALL expose a golden stage-output fixture hook without provider-branched validation

The local-CLI harness adapter layer SHALL support registration or discovery of golden response
shape fixtures for stage-output contracts so built-in and extension adapters can contribute
regression cases. Named Claude, Grok, and Codex shapes SHALL be fixtures only: production
validation SHALL NOT branch on adapter or provider name when accepting or rejecting product
output. Extension adapters SHALL be able to add fixtures for registered contract ids through
the documented hook or discovery path without forking the central stage-output validator.

Fixture registration shape SHALL remain alignable with the adapter capability / declaration
layer used for extension adapters so capability negotiation work (#738 / #783) can reference
the same adapter identity without inventing a second adapter namespace.

#### Scenario: Built-in adapters contribute golden fixtures as data

- **WHEN** golden stage-output fixtures for built-in adapters are loaded in tests
- **THEN** each fixture SHALL be associated with a registered contract id and expected
  validate outcome
- **AND** evaluation SHALL call the central contract validate function

#### Scenario: Extension adapter fixture uses the same validator

- **WHEN** an extension adapter registers a golden fixture for a registered contract id
- **THEN** the fixture SHALL be validated by the same central validate function as built-in
  fixtures
- **AND** production validation code SHALL NOT gain a branch on that extension adapter's name

#### Scenario: Provider name is absent from validation acceptance

- **WHEN** unit tests scan the stage-output validation path used after adapter normalization
- **THEN** acceptance of product shape SHALL NOT depend on reading the active harness name
- **AND** a regression test SHALL fail if such a dependency is introduced

### Requirement: Built-in adapters SHALL register through the same public extension contract as third-party adapters

The built-in local-CLI adapters (`claude`, `codex`, `grok`, `opencode`, `pi`) SHALL be registered
into the runtime registry through the public extension registration API (or equivalent public
registration path), not through a private side channel that bypasses the public contract. Their
invocation construction, preflight, telemetry parsing, and treatment description SHALL continue to
satisfy the existing `HarnessAdapter` behavioral requirements, including golden-argv regression
coverage for established claude and codex shapes. Adding a built-in SHALL not reintroduce a closed
compile-time name union as the production source of truth for "which adapters exist."

#### Scenario: Built-ins appear in the runtime registry via public registration

- **WHEN** the engine finishes built-in registration at boot
- **THEN** `claude`, `codex`, `grok`, `opencode`, and `pi` SHALL each resolve from the runtime
  registry
- **AND** each SHALL implement the public extension contract members required of every registered
  adapter

#### Scenario: Built-in invocation shapes do not intentionally regress

- **WHEN** golden-argv (or equivalent) regression tests run for built-in adapters after migration
  onto the public registration path
- **THEN** established invocation shapes for those adapters SHALL remain satisfied
- **AND** any intentional shape change SHALL be out of scope for this extension-registry change

#### Scenario: Production paths do not hardcode the built-in name set as completeness

- **WHEN** config error messages, doctor enumeration, discovery, help, or evals list available
  local-CLI adapters
- **THEN** the list SHALL come from the runtime registry
- **AND** a newly registered extension adapter SHALL appear without editing a hardcoded built-in
  name array in those consumers

---

### Requirement: Adapter identity namespace SHALL stay shared with extension golden-fixture and treatment surfaces

The adapter ID space used by the runtime registry SHALL be the same identity namespace referenced by
stage-output golden-fixture registration and by treatment/accounting adapter fields. Extension
adapters SHALL NOT require a second adapter namespace for fixtures or evidence. Production
validation of stage product output SHALL continue to avoid branching on adapter or provider name.

#### Scenario: Extension adapter ID is consistent across registry and fixtures

- **WHEN** an extension adapter registers under ID `ext-demo` and contributes a golden stage-output
  fixture
- **THEN** the fixture's adapter identity field SHALL use `ext-demo`
- **AND** treatment records for invocations of that adapter SHALL use the same ID

#### Scenario: Product-output validation remains adapter-name agnostic

- **WHEN** the central stage-output validator accepts or rejects product shape after adapter
  envelope normalization
- **THEN** acceptance SHALL NOT depend on reading the active adapter name as a provider branch

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

### Requirement: Machine-readable telemetry mode SHALL be fixture-verified before an adapter declares it

An adapter SHALL declare `telemetry: "jsonl"` (or the contract-equivalent machine-readable mode)
only when its machine-readable output schema has been verified against **recorded fixtures**
checked into the repository. Flag existence in CLI help alone SHALL NOT justify declaring
machine-readable telemetry.

When telemetry is declared machine-readable, the adapter SHALL:

1. enable only the verified output-mode flags in `buildInvocation` (subject to any existing
   telemetry kill-switch),
2. implement `parseTelemetry` such that fixture inputs recover assistant text for stdout consumers
   and recover only those cost, usage, `resolvedModel`, and `throttled` fields actually present in
   the fixtures,
3. never throw from `parseTelemetry` on truncated, empty, or unparseable input (degrade to nulls).

When verification is incomplete or the CLI has no documented machine-readable mode, the adapter
SHALL keep `telemetry: "none"`, keep plain/text invocation flags, and return empty/null telemetry
fields — leaving accounting at unknown — rather than guessing envelope keys.

Built-in adapters that already declare machine-readable telemetry (`claude`, `codex`) SHALL remain
subject to the same fixture-or-equivalent regression coverage for any schema they claim.

#### Scenario: Unverified adapter remains telemetry none

- **WHEN** a built-in adapter's machine-readable mode has not been verified against recorded
  fixtures
- **THEN** that adapter SHALL declare `telemetry: "none"`
- **AND** `parseTelemetry` SHALL NOT invent cost, resolved model, or throttle values

#### Scenario: Fixture-verified adapter may declare jsonl

- **WHEN** recorded fixtures for an adapter's machine-readable envelope exist and unit tests prove
  `parseTelemetry` recovers assistant text and the claimed field classes from those fixtures
- **THEN** that adapter MAY declare machine-readable telemetry and enable the verified output-mode
  flags
- **AND** fields absent from the fixtures SHALL remain null/unknown in the parser result

#### Scenario: Unparseable capture degrades without throwing

- **WHEN** `parseTelemetry` is invoked with empty, truncated, or non-matching capture text on any
  registered adapter
- **THEN** it SHALL return a result object with nulls for unrecovered fields
- **AND** it SHALL NOT throw

#### Scenario: Extension adapters follow the same verification rule

- **WHEN** an externally registered adapter declares machine-readable telemetry
- **THEN** the shared conformance kit or fixture registration path SHALL require the same
  non-throwing parse and no-invented-resolved-model guarantees as built-ins
- **AND** production code SHALL NOT branch on vendor name to accept the declaration

### Requirement: Adapter probe cliVersion SHALL be threaded from the shared run probe

When constructing treatment identity via `describeTreatment`, the harness invocation path SHALL
supply `AdapterProbe.cliVersion` from the once-per-run (or once per CLI identity) cached version
probe result for that adapter's CLI, not a hard-coded null when a successful probe result exists
for the run.

`describeTreatment` SHALL continue to accept null `cliVersion` when the probe is unavailable.
Adapters SHALL copy `probe.cliVersion` into `HarnessTreatment.cliVersion` rather than inventing a
version string.

#### Scenario: Probe result reaches treatment identity

- **WHEN** invoke constructs treatment identity and a cached version probe for the adapter CLI is
  present
- **THEN** the `AdapterProbe` passed to `describeTreatment` SHALL carry that `cliVersion`
- **AND** the resulting `HarnessTreatment.cliVersion` SHALL equal the probe value

#### Scenario: Absent probe keeps null cliVersion

- **WHEN** invoke constructs treatment identity and no version probe result is available
- **THEN** `AdapterProbe.cliVersion` SHALL be null
- **AND** `HarnessTreatment.cliVersion` SHALL be null

### Requirement: Built-in adapters SHALL record a verified-against CLI identity for drift comparison

Each built-in adapter that freezes argv or telemetry schema against a specific CLI version SHALL
record that verified-against identity in structured form readable by tests and by the production
version-drift warning path (in addition to any human header comment). The identity SHALL name the
CLI and the version (and optional build id) used for verification.

#### Scenario: Verified-against identity is machine-readable

- **WHEN** the built-in adapter metadata is loaded in tests
- **THEN** each built-in that claims argv or telemetry verification SHALL expose a non-empty
  verified-against version identity
- **AND** a regression test SHALL fail if the structured identity is missing for an adapter that
  enables machine-readable telemetry

### Requirement: Telemetry recovery SHALL not echo requested settings as resolved

`parseTelemetry` and treatment construction SHALL set `resolvedModel` and `resolvedEffort` only
from CLI-reported signals (telemetry envelope or documented probe). They SHALL NOT copy
`requestedModel` or `requestedEffort` into the resolved fields to fill gaps. `throttled` and
`fallback` SHALL remain null when unreported.

#### Scenario: Plain or empty telemetry leaves resolved model null

- **WHEN** an adapter with `telemetry: "none"` or an empty capture runs `parseTelemetry` and
  treatment description with a non-null requested model
- **THEN** `resolvedModel` SHALL be null
- **AND** `throttled` SHALL be null

### Requirement: Production harness invoke SHALL dispatch the exact resolved AdapterRequest through adapter preflight before buildInvocation or spawn

The production local-CLI harness invocation entry point SHALL, for every registered or
compatibility adapter, call that adapter’s `preflight` with the exact resolved model, effort, and
sandbox/tool policy that the subsequent `buildInvocation` will apply (together with role
eligibility for the stage’s role). Preflight SHALL use the pipeline’s injectable execution seam so
tests can prove the request without real subprocesses.

When preflight returns a failure, `invoke` SHALL return a failed harness result (or equivalent
structured failure) **without** calling `buildInvocation` for a model-consuming spawn and **without**
falling back to another adapter. When preflight succeeds, invocation construction and spawn MAY
proceed under existing capped-execution rules.

This requirement is additive to doctor and evals preflight call sites: production invoke SHALL not
rely on those sites having already run.

#### Scenario: Successful preflight proceeds to invocation construction

- **WHEN** production invoke is called with a resolved model and effort the adapter supports
- **AND** preflight returns ok
- **THEN** the pipeline MAY call `buildInvocation` and spawn under existing rules
- **AND** the preflight request SHALL have included that model and effort

#### Scenario: Failed preflight skips buildInvocation spawn path

- **WHEN** production invoke is called and adapter preflight returns not-ok for unsupported setting
  or missing CLI
- **THEN** the pipeline SHALL NOT spawn the harness CLI for that call
- **AND** SHALL NOT substitute a different adapter

#### Scenario: Injected-deps test observes exact resolved request

- **WHEN** a unit test injects a fake preflight and invokes production invoke for implementer and
  reviewer roles with distinct model/effort/sandbox values
- **THEN** the fake SHALL receive those exact values for each role
- **AND** no real subprocess SHALL be required to prove the contract

---

### Requirement: Adapter preflight and production invoke SHALL never silently drop unsupported settings

Production preflight SHALL refuse with an unsupported-setting (or role) failure when a stage or
caller requests a model, effort, sandbox mode, tool policy, or role that the adapter’s capabilities
or declaration mark unsupported. `buildInvocation` SHALL NOT be used as the sole enforcement point
by omitting flags while reporting success.

#### Scenario: Unsupported setting is refused rather than omitted

- **WHEN** production invoke is requested with sandbox or effort the adapter declares unsupported
- **THEN** preflight SHALL fail
- **AND** the resulting failure SHALL identify the unsupported setting
- **AND** a successful spawn with that setting silently omitted SHALL NOT occur

### Requirement: Streaming telemetry tail capture SHALL preserve complete product assistant text for freeform consumers

When a harness adapter enables machine-readable streaming output and uses tail-bounded capture of the raw envelope (so a terminal cost/usage record remains recoverable under large streams), the pipeline SHALL still expose **complete reconstructed plain assistant product text** to freeform and markdown stage consumers.

Product text SHALL be accumulated from the same assistant deltas the adapter’s forward transform prints for human observation (or an equivalent reconstruction that does not depend solely on a tail-truncated raw JSONL buffer). Tail truncation of the raw telemetry envelope MUST NOT cause `HarnessResult.stdout` (or the field freeform contracts read) to omit leading product content that was successfully streamed and forwarded.

Telemetry fields (`costUsd`, `usage`, `resolvedModel`, `throttled`) MAY continue to be parsed from a tail-capped or dual-buffered raw capture. Accounting recovery under large streams SHALL remain available when the terminal envelope line is present in the retained raw capture.

If product plain text itself exceeds an implemented bound, the pipeline SHALL fail visibly or preserve a head-biased product buffer that retains leading sections; it SHALL NOT silently tail-truncate product text used by freeform contracts in a way that drops a leading machine-checkable section while keeping only the plan tail.

#### Scenario: Leading product text survives when raw JSONL exceeds the capture cap

- **WHEN** a streaming-json adapter with production tail capture emits a large stream whose raw envelope length exceeds the raw capture cap
- **AND** the plain assistant product text begins with content that appears only in the first portion of the stream
- **THEN** the product text exposed as harness stdout for freeform consumers SHALL still include that leading content
- **AND** the pipeline SHALL NOT report that leading content as absent solely because the raw envelope buffer was tail-truncated

#### Scenario: Terminal cost envelope remains recoverable under large streams

- **WHEN** the same large streaming-json run ends with a complete terminal cost/usage envelope record
- **AND** that record is retained under the adapter’s telemetry capture strategy
- **THEN** `parseTelemetry` SHALL still recover cost and usage fields from that terminal record
- **AND** freeform product text completeness SHALL NOT require abandoning cost recovery

#### Scenario: Grok production settings are covered by regression

- **WHEN** unit or integration tests exercise Grok production capture settings (`--output-format streaming-json`, `captureMode: "tail"`, production raw `MAX_OUTPUT`, Grok forward transform and `parseGrokTelemetry` as used by `invoke`)
- **AND** a synthetic stream places a valid plan-revision acknowledgement only in the first ~20% of the stream with a large trailing plan body
- **THEN** the reconstructed product stdout SHALL contain that acknowledgement for contract validation
- **AND** the regression SHALL fail against the pre-fix tail-only product reconstruction behavior

#### Scenario: Truly missing product text is not invented

- **WHEN** the adapter streams no acknowledgement section in any forwarded product delta
- **THEN** reconstructed product text SHALL NOT fabricate a `## Feedback Incorporated` section
- **AND** freeform contract validation SHALL see the true absence

### Requirement: Every harness adapter SHALL declare background_job_lifecycle support or non-support

Every registered local-CLI harness adapter SHALL declare a versioned `background_job_lifecycle`
capability as either supported or unsupported. The declaration SHALL be part of the adapter's
capability and extension-declaration surface. Because the engine strips types rather than
checking them, the shared runtime conformance kit SHALL fail any registered adapter that omits
the declaration. A supported declaration SHALL name schema version
`pipeline/background-job-lifecycle@1` (or a later documented version) and MAY include a join
grace no larger than the pipeline-owned maximum. An unsupported declaration SHALL be explicit
boolean non-support, not an omitted field.

#### Scenario: Conformance requires an explicit declaration on every registered adapter

- **WHEN** the shared conformance kit evaluates the adapter registry
- **THEN** every registered adapter SHALL expose `background_job_lifecycle` as supported or
  unsupported
- **AND** an adapter missing the field SHALL fail the kit with a failure that names
  `background_job_lifecycle`

#### Scenario: Built-in adapters declare support or non-support explicitly

- **WHEN** the built-in `claude`, `codex`, `grok`, `pi`, and `opencode` adapters are inspected
- **THEN** each SHALL declare `background_job_lifecycle` supported or unsupported
- **AND** none SHALL omit the field
- **AND** an adapter whose raw protocol cannot prove lifecycle state SHALL declare unsupported

#### Scenario: Supported declarations cannot exceed the pipeline join maximum

- **WHEN** an adapter declares `background_job_lifecycle` supported with a join grace larger than
  the pipeline-owned versioned maximum
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL name the incoherent join grace

### Requirement: Mutating implementation work SHALL refuse adapters that lack background_job_lifecycle

The pipeline SHALL refuse a local-CLI harness for product-mutating implementation work (implement, fix-round, test-fix, eval-fix, visual-fix) when the assigned adapter omits `background_job_lifecycle` or supplies a malformed required lifecycle declaration. The pipeline SHALL spawn that harness when the adapter declares `background_job_lifecycle.supported` as false. Explicit non-support SHALL mean the adapter cannot prove join. The lifecycle supervisor SHALL stay disabled for that invocation. The pipeline SHALL NOT invent lifecycle events for an unsupported adapter. Outer stage timeout and existing salvage SHALL still apply. When the adapter declares the capability supported under a coherent schema, the pipeline SHALL keep the join-grace watchdog. An omitted-field or malformed-declaration refusal SHALL be a typed `capability-refusal` distinguishable from missing-CLI, unauthenticated, unsupported model or effort, prompt-size refusal, signal termination, timeout, malformed harness output, and bare spawn errors. The refusal result SHALL carry `preflight_failed`, a structured `preflight_class`, `preflight_reason_code: capability-refusal`, intervention kind `auth-tooling-preflight-failure`, and a bounded actionable message. Planning and review invocations SHALL NOT require this capability and SHALL NOT be refused solely because the adapter declares `background_job_lifecycle` unsupported.

#### Scenario: Unsupported implementer is spawned without lifecycle supervision

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter that declares `background_job_lifecycle` unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the lifecycle supervisor SHALL stay disabled
- **AND** the pipeline SHALL NOT invent lifecycle events
- **AND** the pipeline SHALL spawn the harness CLI

#### Scenario: Omitted lifecycle declaration is refused before spawn

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter that omits `background_job_lifecycle`
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed `capability-refusal` naming the adapter and the missing capability
- **AND** the message SHALL state that retrying the same invocation cannot succeed without changing the adapter or the declaration
- **AND** the result SHALL set `preflight_failed` with `preflight_reason_code: capability-refusal` and intervention kind `auth-tooling-preflight-failure`

#### Scenario: Malformed required lifecycle declaration is refused before spawn

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter whose `background_job_lifecycle` object is malformed (supported is not boolean, or supported is true without a coherent schema)
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed `capability-refusal`
- **AND** the result SHALL set `preflight_failed` with `preflight_reason_code: capability-refusal`
- **AND** the bounded message SHALL name the adapter and the malformed field

#### Scenario: Planning and review still run on an unsupported adapter

- **WHEN** a planning or review stage assigns an adapter that declares `background_job_lifecycle` unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the stage SHALL proceed through the existing preflight path for that adapter

#### Scenario: Supported implementer is not refused by this check

- **WHEN** implementing assigns an adapter that declares `background_job_lifecycle` supported under a coherent schema and join grace
- **THEN** this capability check SHALL NOT refuse the invocation solely for that declaration

### Requirement: Provider authentication SHALL be a typed harness signal

Adapters and the shared invoke path SHALL surface provider authentication as a typed signal. Production preflight that reports unauthenticated SHALL set `preflight_reason_code` to `environment-auth`. After spawn, the harness result SHALL prefer a structured provider status object when the CLI emits one. A compatibility fallback MAY match only exact allowlisted codes (including `refresh_token_invalidated` as a JSON `error.code` or equivalent closed field, and a structured HTTP 401 on that status object). The path SHALL NOT classify arbitrary stderr or transcript prose as unauthenticated. Missing structured status without an allowlisted marker SHALL NOT be invented as authenticated or as environment-auth.

#### Scenario: Unauthenticated preflight is typed environment-auth

- **WHEN** production preflight refuses spawn because the adapter reports `unauthenticated`
- **THEN** the harness result SHALL set `preflight_reason_code` to `environment-auth`
- **AND** SHALL NOT require matching free-form stderr text as the primary signal

#### Scenario: Structured provider status after spawn is preferred

- **WHEN** a spawned CLI emits a structured provider status whose closed field reports an invalidated or unauthenticated session
- **THEN** the harness result SHALL carry that structured status for classification
- **AND** classification consumers SHALL prefer that status over leftover log prose

#### Scenario: Allowlisted compatibility marker is exact

- **WHEN** CLI output contains a JSON object whose closed `error.code` (or equivalent) equals `refresh_token_invalidated`
- **THEN** that marker SHALL be accepted as a compatibility auth signal
- **AND** an English sentence such as `please log in` without an allowlisted closed field SHALL NOT be accepted as that signal

#### Scenario: Served-model telemetry stays unchanged

- **WHEN** a Codex (or other) adapter has no recorded current CLI fixture that proves a served-model field
- **THEN** `resolved_model` SHALL remain absent or null
- **AND** this requirement SHALL NOT invent a served-model parse

### Requirement: Mutating stages SHALL preserve typed production-preflight refusal on the stage outcome

The pipeline SHALL preserve a typed production-preflight refusal through the stage outcome of every mutating implementer stage (`implement`, `fix-1` / `fix-round`, `test-fix`, `eval-fix`, `visual-fix`). The outcome SHALL retain `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and the bounded actionable message. The pipeline SHALL NOT flatten that refusal to a bare `exit -1` reason. The pipeline SHALL NOT invent a harness session, SHALL NOT call `buildInvocation` for a model-consuming spawn, and SHALL NOT switch adapters. The same treatment SHALL NOT be retried as a crash. Existing crash and timeout retry behavior SHALL remain bounded and unchanged.

#### Scenario: Implement stage keeps typed fields instead of exit -1

- **WHEN** implementing receives a harness result with `preflight_failed: true` and `preflight_reason_code: capability-refusal`
- **THEN** the blocked stage outcome SHALL keep that reason code and intervention kind
- **AND** SHALL NOT classify the failure as `workflow-engine-defect` from `exit -1`
- **AND** SHALL record one stage-treatment invocation and zero harness sessions

#### Scenario: Eval-fix, visual-fix, and test-fix keep typed fields

- **WHEN** eval-fix, visual-fix, or test-fix receives a harness result with `preflight_failed: true`
- **THEN** the stage block reason SHALL include the typed preflight diagnostic
- **AND** SHALL NOT be only `exit -1`
- **AND** the stage SHALL NOT start another harness invocation for that same treatment
- **AND** the stage outcome or stage diagnostic SHALL retain `preflight_failed`, `preflight_class`, `preflight_reason_code`, and intervention kind

#### Scenario: Typed refusal stays distinct from other harness failures

- **WHEN** a mutating stage receives a typed production-preflight refusal
- **THEN** classification SHALL remain distinct from spawn error, signal termination, timeout, malformed harness output, and environment-auth
- **AND** SHALL NOT set those other flags as the primary class
