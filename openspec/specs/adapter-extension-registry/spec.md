# adapter-extension-registry Specification

## Purpose
TBD - created by archiving change harness-adapter-extension-registry. Update Purpose after archive.
## Requirements
### Requirement: The pipeline SHALL expose a public adapter extension contract and runtime registry

The pipeline SHALL provide a documented public extension contract for local-CLI harness adapters
and a runtime registry that is the sole authoritative set of adapter IDs for local-CLI selection,
validation, doctor checks, discovery surfaces that list adapters, help text that enumerates
adapters, eval local-CLI treatment selection, and adapter-enumerating tests. The contract SHALL be
the same surface used by built-in adapters and by third-party extension adapters. Registration of
a new adapter ID SHALL NOT require editing core adapter implementation modules or recompiling a
closed name union into the engine.

Because the engine strips TypeScript types rather than checking them, the contract SHALL be backed
by a shared runtime conformance kit that asserts every registered adapter implements every required
member and declaration field.

#### Scenario: Runtime registry is the enumeration source

- **WHEN** config validation, doctor, discovery, help, evals, or adapter-enumerating tests need the
  set of known local-CLI adapter IDs
- **THEN** they SHALL obtain that set from the runtime registry API
- **AND** they SHALL NOT rely on a hardcoded closed list of built-in adapter names as the
  completeness criterion for "all adapters"

#### Scenario: Extension registration does not require core source edits

- **WHEN** an operator registers a synthetic third-party adapter package through the documented
  extension path
- **THEN** the adapter ID SHALL appear in the runtime registry
- **AND** no file under the engine's built-in adapter implementation set SHALL need to be modified
  for that registration to succeed

#### Scenario: Conformance kit rejects an incomplete adapter

- **WHEN** the shared conformance kit evaluates an adapter missing a required contract member or
  declaration field
- **THEN** the kit SHALL fail
- **AND** the failure SHALL name the missing member or field

---

### Requirement: Adapters SHALL register through a documented declarative manifest or package hook

The pipeline SHALL document and implement at least one supported end-user registration path:

1. a declarative manifest (or package metadata field) that names stable adapter IDs and module
   entry points, and/or
2. a programmatic package hook that registers an adapter implementation with the runtime registry.

Both paths SHALL load only packages or entry points the operator has explicitly configured or that
ship as built-ins. Registration SHALL be idempotent for the same adapter ID and same
implementation identity, and SHALL fail closed when the same adapter ID is claimed by distinct
implementations.

#### Scenario: Declarative or package-hook registration succeeds

- **WHEN** a correctly formed extension package is registered through the documented manifest or
  package hook
- **THEN** `resolveAdapter` for that ID SHALL return the registered implementation
- **AND** `registeredAdapterNames` SHALL include that ID

#### Scenario: Adapter ID collision fails closed

- **WHEN** two distinct adapter implementations attempt to register under the same adapter ID
- **THEN** registration SHALL fail with an error naming the conflicting ID
- **AND** the registry SHALL retain a single deterministic winner only if the implementations are
  identical in identity; otherwise neither silent overwrite nor dual registration SHALL occur

#### Scenario: Unconfigured packages are not auto-loaded

- **WHEN** an unrelated package exists on the host but is not listed in the operator's configured
  extension registration surface and is not a built-in
- **THEN** the pipeline SHALL NOT load or register that package as an adapter by default

---

### Requirement: The public contract SHALL declare the full extension surface for every adapter

Every adapter registered through the public contract SHALL declare, in a machine-checkable form:

- executable resolution (how the CLI binary is located)
- prompt delivery channel and size/limit policy
- model discovery and validation policy (including refusal when unsupported)
- effort discovery and validation policy (including refusal when unsupported)
- sandbox / tool / permission policy
- cwd / worktree behavior
- output envelope normalization expectations
- telemetry parsing behavior
- authentication probe behavior
- version probe behavior
- runtime smoke hook (a cheap readiness probe distinct from full stage invocation)
- role capabilities (which of implementer and/or reviewer the adapter may serve)

The shared conformance kit SHALL verify these declarations are present and that behavior matches
the declarations for supported and unsupported settings.

#### Scenario: Declared unsupported capability is refused

- **WHEN** a stage requests a model, effort, sandbox mode, or role the adapter declares unsupported
- **THEN** preflight or config resolution SHALL refuse with a distinguishable unsupported-setting
  (or role) failure
- **AND** the invocation SHALL NOT proceed with the unsupported setting silently dropped

#### Scenario: Supported settings produce the declared invocation treatment

- **WHEN** the conformance kit constructs an invocation for a supported model/effort/sandbox/cwd
  combination
- **THEN** the resulting command treatment SHALL match the adapter's declared invocation rules for
  that combination

#### Scenario: Telemetry parse never throws

- **WHEN** `parseTelemetry` is called with empty, partial, or malformed captured output
- **THEN** it SHALL return null fields rather than throwing
- **AND** it SHALL NOT invent a resolved model or cost when the CLI did not report one

#### Scenario: Runtime smoke hook is distinct from stage invocation

- **WHEN** doctor or preflight invokes the adapter's runtime smoke hook
- **THEN** the hook SHALL perform only the adapter's declared cheap readiness checks
- **AND** it SHALL NOT run a full stage prompt or consume a full implementer/reviewer turn

---

### Requirement: Any registered adapter SHALL be assignable to implementer or reviewer when capabilities allow

Role assignment SHALL be driven by repository/profile configuration and the adapter's declared
role capabilities. A registered adapter that declares the implementer role SHALL be a valid
`harnesses.implementer` (and implementer-side stage assignment) value. A registered adapter that
declares the reviewer role SHALL be a valid `harnesses.reviewer` / `review_harness` /
reviewer-side assignment value. An adapter that declares both roles SHALL be assignable to either.
An adapter that does not declare a requested role SHALL be rejected at configuration resolution or
preflight with a message naming the adapter ID, the requested role, and the missing capability.

#### Scenario: Extension adapter as implementer and reviewer

- **WHEN** a synthetic third-party adapter is registered declaring both implementer and reviewer
  roles
- **AND** configuration assigns that adapter ID as implementer for one resolution and as reviewer
  for another
- **THEN** both resolutions SHALL succeed without modifying core source
- **AND** invocation SHALL dispatch through that adapter for both roles

#### Scenario: Missing role capability is rejected

- **WHEN** configuration assigns an adapter as implementer but the adapter declares only the
  reviewer role
- **THEN** configuration resolution or preflight SHALL fail
- **AND** the error SHALL name the adapter ID and the implementer role

#### Scenario: Role is not inferred from adapter marketing name

- **WHEN** an adapter ID does not resemble a built-in name
- **THEN** role eligibility SHALL still be determined solely from declared role capabilities
- **AND** the pipeline SHALL NOT grant or deny roles by string pattern on the adapter ID

---

### Requirement: Host, adapter, provider, model, and effort identities SHALL remain independent

The pipeline SHALL treat outer-host identity (the host/profile that launched the pipeline), stage
adapter ID, provider/auth class, role, requested/resolved model, and requested/resolved effort as
independent identity dimensions. Stage accounting and treatment records SHALL continue to carry
adapter and provider as separate fields. The outer host SHALL NOT be rewritten to equal the stage
adapter ID. The pipeline SHALL NOT maintain a vendor-global catalog of every model. When an
adapter or CLI does not report provider or resolved model metadata, the recorded value SHALL be
`unknown` or null — never a silently invented default.

#### Scenario: Host identity is not collapsed into adapter identity

- **WHEN** a stage runs under outer host `claude` with stage adapter `my-ext`
- **THEN** evidence/treatment fields SHALL record adapter `my-ext`
- **AND** outer-host identity SHALL remain distinguishable from that adapter ID

#### Scenario: Unknown provider stays unknown

- **WHEN** an extension adapter's probe cannot determine provider/auth class
- **THEN** the recorded provider/auth class SHALL be `unknown` (or equivalent explicit unknown)
- **AND** the pipeline SHALL NOT infer provider solely from the model alias string

#### Scenario: No silent default model for extension adapters

- **WHEN** an extension adapter is invoked with no configured model and the adapter does not
  declare a required default model resolution
- **THEN** the pipeline SHALL NOT invent a vendor model id for that adapter
- **AND** any defaulting SHALL be limited to the adapter's own declared behavior or the CLI's own
  configured default without core substituting a global catalog entry

---

### Requirement: The shared conformance kit SHALL cover invocation, refusal, normalization, telemetry, and failure classification

The pipeline SHALL provide a shared conformance kit used in CI for built-in adapters and usable
for extension fixtures. For each adapter under test the kit SHALL verify:

1. declared capabilities and required declaration fields
2. exact invocation treatment for supported settings (table-driven where golden argv applies)
3. unsupported-capability refusal without silent drop
4. output normalization into the pipeline's harness result / envelope shape
5. telemetry coverage consistent with the declared telemetry capability
6. distinguishable failure classification for missing CLI, unauthenticated, headless-unavailable,
   and unsupported-setting outcomes (as applicable to the adapter)

#### Scenario: Built-in adapters pass the kit without behavior regression

- **WHEN** the conformance kit runs against each built-in adapter
- **THEN** every built-in SHALL pass
- **AND** established golden invocation shapes for built-ins SHALL remain satisfied

#### Scenario: Synthetic extension fixture exercises the kit

- **WHEN** the synthetic third-party adapter fixture is registered and run through the kit
- **THEN** the kit SHALL pass for that fixture when the fixture is complete
- **AND** deliberate incompleteness in the fixture SHALL fail the kit

#### Scenario: Failure classes remain distinguishable

- **WHEN** the kit simulates missing-CLI, unauthenticated, and unsupported-setting conditions for
  an adapter that declares those probes
- **THEN** each condition SHALL map to a distinct failure class
- **AND** the classes SHALL match the public adapter preflight failure vocabulary

---

### Requirement: Custom-reviewer CLI configurations SHALL migrate onto the extension contract compatibly

Unregistered harness names used as custom reviewer CLIs SHALL continue to resolve without requiring
the operator to publish a package (the `#40` escape hatch, including `review_harness` string and
object forms). The engine SHALL materialize a compatibility adapter for such a command through the
public extension contract, using configured prompt-delivery defaults and thin capability
declarations appropriate to an unconstrained CLI. That compatibility path SHALL NOT remain a
permanent raw-spawn branch that bypasses preflight, treatment identity, and failure classification.

#### Scenario: Existing review_harness string keeps working

- **WHEN** `.github/pipeline.yml` sets `review_harness: my-reviewer` and no package registers
  `my-reviewer`
- **THEN** reviewer resolution SHALL still target the `my-reviewer` command
- **AND** invocation SHALL go through the compatibility adapter built on the extension contract

#### Scenario: Compatibility adapter participates in doctor and treatment identity

- **WHEN** a custom reviewer is resolved via the compatibility path
- **THEN** doctor/preflight SHALL be able to report missing-CLI for that command
- **AND** treatment identity SHALL record the adapter ID and mark the compatibility origin
  distinctly enough that operators can tell it from a full package adapter

#### Scenario: Full package registration replaces compatibility for the same ID

- **WHEN** a package later registers adapter ID `my-reviewer` with full declarations
- **THEN** resolution of `my-reviewer` SHALL use the package implementation
- **AND** the thin compatibility adapter SHALL NOT silently override the registered package

### Requirement: Extension adapters SHALL declare `maxPromptBytes` coherent with prompt delivery

Every registered extension adapter SHALL declare a `maxPromptBytes` delivery-channel limit (finite
positive integer, unlimited, or unknown) that is coherent with its declared prompt-delivery channel
and with the declaration’s prompt size/limit policy. Built-in, third-party package, and
custom-reviewer compatibility adapters all use this same generic field — not a vendor-specific
exception. The public contract vocabulary SHALL treat `maxPromptBytes` as that shared capability.

The shared conformance kit SHALL reject an extension adapter that:

- omits `maxPromptBytes`,
- declares prompt delivery and size/limit policy that disagree with `maxPromptBytes`,
- claims unlimited on a positional/`argv` channel or any finite `maxPromptBytes` on a
  stdin/file channel (stdin/file SHALL declare unlimited, regardless of magnitude), or
- claims a finite `maxPromptBytes` on a positional/`argv` channel greater than the harness
  spawnable argv ceiling (`MAX_ARGV_PROMPT_BYTES` / `MAX_ARG_STRLEN`-aware bound used by the
  residual oversize-argv guard).

Machine-readable manifests and package-hook registrations SHALL be able to express the same three
limit classes so extension authors do not need a second, conflicting size field.

#### Scenario: Conformance rejects an extension missing maxPromptBytes

- **WHEN** the shared conformance kit evaluates a registered extension adapter that omits
  `maxPromptBytes`
- **THEN** the kit SHALL fail
- **AND** the failure SHALL name the missing field

#### Scenario: Conformance rejects channel and limit disagreement

- **WHEN** an extension adapter declares `argv` prompt delivery and unlimited `maxPromptBytes`
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL identify the incoherent pair

#### Scenario: Conformance rejects argv limit above the spawnable ceiling

- **WHEN** an extension adapter declares `argv` prompt delivery and a finite `maxPromptBytes`
  greater than the harness spawnable argv ceiling
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL identify the unspawnable limit

#### Scenario: Conformance rejects finite maxPromptBytes on stdin or file delivery

- **WHEN** an extension adapter declares `stdin` or `file` prompt delivery and a finite
  `maxPromptBytes` (including a value greater than the harness spawnable argv ceiling)
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL identify that stdin/file channels must declare unlimited

#### Scenario: Compatibility custom-reviewer path declares a limit

- **WHEN** the custom-reviewer compatibility adapter is registered with default argv prompt delivery
- **THEN** it SHALL declare a finite `maxPromptBytes` consistent with the OS per-argument limit
- **AND** when configured for stdin prompt delivery it SHALL declare unlimited `maxPromptBytes`
  coherent with that channel

### Requirement: Outer-host lifecycle evidence SHALL not collapse host identity into stage adapter identity

When outer-host lifecycle supervision records identity in run evidence, the pipeline SHALL keep
outer-host identity independent of stage adapter identity as already required by the adapter
extension registry identity-separation rules. Outer-host lifecycle registration and evidence
SHALL NOT require stage adapter registration for the same id, and stage adapter registration
SHALL NOT imply outer-host lifecycle capabilities.

#### Scenario: Host lifecycle and adapter extension remain separate registries

- **WHEN** a stage adapter id `my-ext` is registered without a matching outer-host id
- **THEN** the outer-host registry SHALL NOT invent an outer host named `my-ext`
- **AND** outer-host lifecycle capabilities SHALL NOT be inferred from that adapter's model or
  role declarations

#### Scenario: Evidence fields stay distinct under extension adapters

- **WHEN** a run uses outer host `claude` with implementer adapter `my-ext`
- **THEN** evidence SHALL record outer-host identity separately from implementer treatment
  identity `my-ext`
- **AND** neither field SHALL be rewritten to equal the other

