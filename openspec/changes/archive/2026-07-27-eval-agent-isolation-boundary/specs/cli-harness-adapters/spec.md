## MODIFIED Requirements

### Requirement: Claude and Codex invocations SHALL be preserved byte-for-byte behind their adapters

Moving the built-in `claude` and `codex` harnesses behind adapters SHALL NOT change the command or
arguments the pipeline executes for any existing configuration, including the machine-readable
telemetry mode and its opt-out, the sandboxed permission mode, the lean single-shot mode, and the
external-sandbox bypass mode. The sole permitted difference SHALL be the removal of the prompt from
the argument list where the adapter declares a standard-input or file prompt-delivery channel,
together with any argument that CLI documents for selecting that channel. A golden-argv regression
test SHALL pin these argv shapes and each adapter's declared prompt-delivery channel.

Invocation shaping SHALL additionally accept an explicit caller-supplied external-sandbox mode. When
a caller supplies one, that value alone SHALL select the external-sandbox bypass or the harness's
managed sandbox for that invocation; the ambient external-sandbox environment variable SHALL be
consulted only when the caller supplies no value, preserving today's behavior for every existing
call site. Supplying a mode SHALL change no argument other than the sandbox-selecting one.

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

#### Scenario: An explicitly supplied sandbox mode selects the invocation shape

- **WHEN** a caller constructs a `codex` invocation supplying the external-sandbox mode explicitly
- **THEN** the argument list SHALL carry the external-sandbox bypass argument
- **AND** every other argument SHALL be identical to the managed-sandbox shape

#### Scenario: An explicitly supplied mode overrides the ambient environment variable

- **WHEN** the ambient external-sandbox environment variable is set and a caller supplies the
  managed-sandbox mode explicitly
- **THEN** the resulting argument list SHALL be the managed-sandbox shape

#### Scenario: Callers supplying no mode keep the ambient-environment behavior

- **WHEN** an invocation is constructed with no caller-supplied sandbox mode
- **THEN** the external-sandbox bypass SHALL be selected exactly when the ambient environment
  variable requests it, identical to pre-change behavior
