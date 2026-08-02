## MODIFIED Requirements

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
`--sandbox` and `workspace-write` as consecutive arguments and SHALL NOT emit `--full-auto`. The
effective sandbox and headless approval behavior SHALL remain equivalent to the former
`--full-auto` path on `codex exec` (workspace-write sandbox with non-interactive never-ask
approval as provided by that CLI's exec path). The external-sandbox bypass argument remains
`--dangerously-bypass-approvals-and-sandbox`.

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
- **AND** the prompt SHALL be delivered as the standard-input payload with the trailing `-`
  sentinel

#### Scenario: Option variants preserve non-sandbox argv

- **WHEN** the invocation is constructed with the sandboxed permission mode, with the lean
  single-shot mode, with the telemetry opt-out set, and with the external-sandbox bypass set
- **THEN** each resulting argument list SHALL match the established shape for that variant
  apart from prompt delivery and the #613 managed-sandbox flag migration on codex
- **AND** in the lean variant the tool-disabling option SHALL NOT consume any following argument
- **AND** the external-sandbox bypass variant SHALL carry `--dangerously-bypass-approvals-and-sandbox`
  and SHALL NOT carry `--full-auto` or `--sandbox workspace-write`

#### Scenario: An explicitly supplied sandbox mode selects the invocation shape

- **WHEN** a caller constructs a `codex` invocation supplying the external-sandbox mode explicitly
- **THEN** the argument list SHALL carry the external-sandbox bypass argument
- **AND** every other argument SHALL be identical to the managed-sandbox shape after removing the
  managed sandbox-selecting sequence (`--sandbox`, `workspace-write`) from the managed side and the
  bypass flag from the bypass side

#### Scenario: An explicitly supplied mode overrides the ambient environment variable

- **WHEN** the ambient external-sandbox environment variable is set and a caller supplies the
  managed-sandbox mode explicitly
- **THEN** the resulting argument list SHALL be the managed-sandbox shape (`--sandbox` +
  `workspace-write`, not the bypass flag, not `--full-auto`)

#### Scenario: Callers supplying no mode keep the ambient-environment behavior

- **WHEN** an invocation is constructed with no caller-supplied sandbox mode
- **THEN** the external-sandbox bypass SHALL be selected exactly when the ambient environment
  variable requests it
- **AND** otherwise the managed-sandbox shape SHALL use `--sandbox` + `workspace-write` and SHALL
  NOT use `--full-auto`
