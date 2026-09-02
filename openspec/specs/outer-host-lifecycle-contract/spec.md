# outer-host-lifecycle-contract Specification

## Purpose
TBD - created by archiving change outer-host-lifecycle-contract. Update Purpose after archive.

## Requirements

### Requirement: The pipeline SHALL expose a versioned outer-host lifecycle manifest independent of stage treatment identity

The pipeline SHALL provide a versioned outer-host lifecycle manifest schema and runtime
representation that declares outer-host identity and lifecycle capabilities. The manifest SHALL
be independent of stage adapter ID, provider/auth class, model, effort, and implementer/reviewer
role assignment. Outer-host identity fields SHALL NOT be rewritten to equal stage adapter
identity, and stage treatment fields SHALL NOT be required to equal the outer-host id.

#### Scenario: Manifest does not collapse into adapter identity

- **WHEN** an outer host with id `session-host-a` launches a run whose implementer adapter is
  `my-ext` and reviewer adapter is `codex`
- **THEN** run evidence and the outer-host registry SHALL record outer-host id `session-host-a`
  as distinct from adapter ids `my-ext` and `codex`
- **AND** the outer-host manifest SHALL NOT require adapter, provider, model, or effort fields
  as lifecycle identity

#### Scenario: Manifest carries a version

- **WHEN** a host registers a valid outer-host manifest
- **THEN** the manifest SHALL include an explicit version field (manifest or schema version)
- **AND** consumers SHALL be able to reject or ignore an unsupported version with a
  machine-readable diagnostic rather than silently mis-parse

---

### Requirement: The outer-host manifest SHALL declare the full lifecycle capability surface

Each registered outer-host manifest SHALL declare the following capability areas, each with an
explicit support level and, when not fully supported, an explicit unsupported/fallback behavior:

1. install / invocation profile (install mode, base-path resolution, managed artifacts)
2. skill or command surface (how operators invoke the pipeline on that host)
3. early run handoff observation
4. event follow
5. reattach after lost or cancelled follow
6. wait/cancel classification and recovery obligations
7. material-progress notification mapping
8. terminal cleanup (stop monitors/follows)
9. terminal summary

The portable baseline for observation SHALL remain machine-readable stdout and/or the run-store
`events.jsonl` stream. Hosts that lack rich notify tools SHALL still declare a fallback that
preserves correctness of supervision via that baseline.

#### Scenario: Complete declaration is accepted

- **WHEN** a host manifest declares every required capability area with either full support plus
  how-to data or unsupported plus fallback
- **THEN** registration and the conformance kit SHALL accept the manifest

#### Scenario: Missing capability area is rejected

- **WHEN** a host manifest omits a required capability area or omits fallback text for an
  unsupported capability
- **THEN** registration or the conformance kit SHALL fail
- **AND** the failure SHALL name the missing area or field

#### Scenario: Portable baseline is always available as fallback

- **WHEN** a host declares material-progress notify as unsupported or limited
- **THEN** its fallback SHALL name stdout and/or `events.jsonl` follow (or equivalent portable
  observation) rather than requiring a host-specific tool for correctness

---

### Requirement: The pipeline SHALL expose a runtime outer-host registry as the sole enumeration source

The pipeline SHALL provide a runtime outer-host registry that is the sole authoritative set of
outer-host ids for install host selection, discovery host enumeration that claims completeness
over installable hosts, help text that enumerates outer hosts, conformance kit iteration, and
tests that assert "all outer hosts." Built-in hosts and third-party hosts SHALL register through
the same public registration surface. Registration of a new outer-host id SHALL NOT require
editing a closed host-name table inside core outer-host implementation modules as the supported
extension path.

#### Scenario: Registry is the enumeration source

- **WHEN** install validation, discovery, help, conformance, or host-enumerating tests need the
  set of known outer-host ids
- **THEN** they SHALL obtain that set from the runtime registry API (or a test double of it)
- **AND** they SHALL NOT rely on a hardcoded closed list of built-in host names as the
  completeness criterion for "all outer hosts"

#### Scenario: Extension registration does not require core host-table edits

- **WHEN** an operator registers a synthetic third-party outer-host package or fixture through
  the documented extension path
- **THEN** the host id SHALL appear in the runtime registry
- **AND** no built-in host implementation module SHALL need to be modified for that registration
  to succeed

#### Scenario: Host id collision fails closed

- **WHEN** two distinct outer-host manifests attempt to register under the same host id
- **THEN** registration SHALL fail with an error naming the conflicting id
- **AND** silent overwrite of a distinct implementation SHALL NOT occur

---

### Requirement: Shared orchestration SHALL consume declared capabilities and never branch on host names

Shared advance and loop orchestration SHALL resolve the active outer host's declared capabilities
and select lifecycle steps from those declarations. Shared orchestration includes shared skill
contract text, shared orchestration helpers, and core modules that select lifecycle steps for the
supervising host. Shared orchestration SHALL NOT dispatch lifecycle behavior by comparing the
outer-host id to a fixed set of built-in name strings (for example `if (host === "claude")` style
branches) as the extension model.

Host-local implementation details of a declared capability (for example a specific notify tool
name) MAY appear in the host's own overlay or in the capability's declared mapping, but MUST NOT
be re-encoded as host-name switches in shared orchestration.

#### Scenario: Lifecycle steps follow capability declarations

- **WHEN** shared advance orchestration runs under an outer host that declares event follow and
  reattach as supported
- **THEN** the shared orchestration contract SHALL require follow-until-terminal and reattach
  after cancelled wait using the host's declared how-to
- **AND** those requirements SHALL be selected from capability support, not from the host id
  string matching a built-in name

#### Scenario: Unsupported capability uses documented fallback

- **WHEN** shared orchestration needs material-progress notify and the active host declares that
  capability unsupported with a stdout/`events.jsonl` fallback
- **THEN** orchestration SHALL use the declared fallback
- **AND** SHALL NOT require a Claude-only notify tool for that host

#### Scenario: Shared code has no host-name lifecycle switch as extension path

- **WHEN** a new outer-host id is registered with complete lifecycle declarations
- **THEN** shared orchestration SHALL be able to supervise that host's declared lifecycle without
  adding a new host-name branch in shared orchestration modules

---

### Requirement: Every capability SHALL define explicit unsupported and fallback behavior

For each required capability area, the contract SHALL define what "supported" means and what
consumers MUST do when the capability is unsupported. Unsupported SHALL never mean "silently
skip supervision." Cancelled or lost wait before terminal SHALL never be classified as a terminal
pipeline outcome solely because a host-rich wait tool failed.

#### Scenario: Cancelled wait is not terminal

- **WHEN** a host's event follow or wait is cancelled, interrupted, or times out before
  `run_complete` / sentinel completion
- **THEN** the outer-host contract SHALL classify that event as non-terminal
- **AND** SHALL require reattach or portable CLI re-follow per the host's reattach/wait_cancel
  declarations (or the portable baseline fallback)

#### Scenario: Unsupported early handoff falls back to status discovery

- **WHEN** a host declares early run handoff unsupported
- **THEN** its fallback SHALL name a portable discovery path (for example `pipeline status` /
  run-store inspection) sufficient to obtain `run_id` and events path for follow
- **AND** shared orchestration SHALL NOT treat missing host-native handoff parsing as permission
  to skip supervision

---

### Requirement: A shared outer-host conformance kit SHALL gate complete host declarations

The pipeline SHALL provide a shared conformance kit that evaluates every registered outer host
(built-in and extension). The kit SHALL assert: required declaration fields are present; each
capability has support-or-fallback completeness; install profile data names managed artifacts and
user-owned exclusions when install is supported; identity fields remain independent of stage
adapter identity; and incomplete fixtures fail with named missing members.

#### Scenario: Built-in hosts pass the kit

- **WHEN** the conformance kit runs against all built-in registered outer hosts in CI
- **THEN** each built-in host SHALL pass
- **AND** failures SHALL name the host id and missing or invalid field

#### Scenario: Incomplete synthetic host fails the kit

- **WHEN** the kit evaluates a synthetic host missing a required capability area or fallback
- **THEN** the kit SHALL fail
- **AND** the failure SHALL name the missing area or field

#### Scenario: Complete synthetic third-party host passes without core edits

- **WHEN** a complete synthetic third-party outer-host fixture is registered through the
  documented extension path
- **THEN** the kit SHALL pass for that host
- **AND** registration SHALL NOT require modifying built-in host implementation modules

---

### Requirement: Cross-host lifecycle regression fixtures SHALL express closed host lifecycle behaviors

The pipeline SHALL provide host-agnostic regression fixtures (conformance kit scenarios and/or
unit tests over capability-driven orchestration) that express the closed lifecycle behaviors from
#699/#725/#731/#742 and the post-#787 default host lifecycle without encoding them as provider
tables or host-name tables. Fixtures SHALL cover at least:

1. early/durable run handoff observation
2. event follow until terminal
3. reattach / re-arm after cancelled wait before terminal
4. cancellation handling that does not treat cancel as terminal success
5. material progress observation via declared notify or portable baseline
6. terminal exit detection
7. monitor / follow cleanup on terminal
8. final summary emission

#### Scenario: Reattach-after-cancel fixture is host-agnostic

- **WHEN** the reattach-after-cancelled-wait fixture runs
- **THEN** it SHALL drive behavior from reattach/wait_cancel capability declarations
- **AND** SHALL NOT hardcode only `claude` or `codex` as the sole hosts that must reattach

#### Scenario: Handoff-follow-summary fixture covers the long-running path

- **WHEN** the long-running lifecycle fixture runs for a host that declares handoff, follow,
  cleanup, and terminal summary support (or portable fallbacks)
- **THEN** it SHALL prove the ordered path handoff → progress observation → terminal exit →
  cleanup → final summary under the contract
- **AND** a cancelled mid-follow step SHALL re-enter follow before summary when reattach is
  required

---

### Requirement: Run evidence SHALL record outer-host identity separately from treatment identity

When a run is supervised or launched under a known outer host, run evidence SHALL record the
outer-host id as its own field (or equivalent structured location) separate from implementer
adapter treatment identity and reviewer adapter treatment identity. The pipeline SHALL NOT infer
outer-host id solely from model name, provider, or stage adapter id. When the outer host is
unknown, the field SHALL be omitted or set to an explicit unknown sentinel rather than invented
from the implementer adapter.

#### Scenario: Evidence keeps host and adapter distinct

- **WHEN** a run starts under outer host `opencode` with implementer adapter `claude` and
  reviewer adapter `codex`
- **THEN** run evidence SHALL record outer-host identity `opencode` separately from implementer
  `claude` and reviewer `codex`

#### Scenario: Unknown host is not invented from adapter

- **WHEN** stage adapters are known but outer-host identity cannot be determined
- **THEN** the outer-host evidence field SHALL be omitted or `unknown`
- **AND** SHALL NOT be silently set equal to the implementer adapter id

---

### Requirement: Host installation update uninstall and discovery SHALL use manifest install data and preserve user-owned content

Install, update, uninstall, and discovery surfaces that claim to manage outer hosts SHALL use
each host's declared install/invocation profile from the outer-host registry/manifest for:
base-path resolution inputs, install mode, managed artifact paths, and post-install operator
hints. Uninstall and update SHALL remove or replace only managed pipeline artifacts declared by
the host's install profile and SHALL preserve user-owned content outside those managed paths.

#### Scenario: Install uses manifest-managed paths

- **WHEN** `install --host <id>` runs for a registered host with install supported
- **THEN** the installer SHALL place managed skill/command artifacts according to that host's
  install profile
- **AND** SHALL NOT require a new core host-name branch solely to know the skill destination for
  a registry-registered host that already declares those paths

#### Scenario: Uninstall preserves user-owned files

- **WHEN** uninstall runs for a host whose commands directory contains both managed pipeline
  command files and unrelated user command files
- **THEN** managed pipeline artifacts SHALL be removed per the install profile
- **AND** unrelated user-owned files SHALL remain

#### Scenario: Discovery enumerates registry hosts

- **WHEN** discovery reports installable outer hosts in a completeness-oriented listing
- **THEN** it SHALL include hosts present in the outer-host registry (including a registered
  synthetic host in tests)
- **AND** SHALL NOT treat a hardcoded built-in-only name list as the sole completeness source

### Requirement: Builtin outer-host set SHALL include omp independent of adapter pi

The runtime outer-host registry SHALL include builtin host id `omp` after this change ships. Outer-host identity `omp` SHALL remain independent of stage adapter id `pi`. Shared orchestration SHALL consume `omp` from its manifest capability declarations and SHALL NOT dispatch OMP lifecycle by comparing adapter id `pi`.

#### Scenario: Conformance kit accepts builtin omp

- **WHEN** the shared outer-host conformance kit runs against builtin registered hosts
- **THEN** host id `omp` SHALL be present
- **AND** the `omp` manifest SHALL pass the kit
- **AND** the kit SHALL NOT require adapter id `pi` to equal `omp`

#### Scenario: Evidence records omp not pi as the outer host

- **WHEN** a run starts under outer host `omp` with implementer adapter `claude` and reviewer adapter `codex`
- **THEN** run evidence SHALL record outer-host identity `omp`
- **AND** SHALL NOT record outer-host identity `pi` solely because a Pi adapter exists

### Requirement: OMP initial lifecycle SHALL be stdout_only with portable follow

The `omp` outer-host manifest SHALL declare `material_progress_notify` with mapping surface `stdout_only`. Early run handoff, event follow, reattach, wait/cancel, terminal cleanup, and terminal summary SHALL name the portable baseline (launcher stdout and/or run-store `events.jsonl` via `pipeline logs --events --follow`, including detach) as support or fallback. The initial OMP host SHALL NOT require an OMP-native notify tool for supervision correctness.

#### Scenario: OMP notify surface is stdout_only

- **WHEN** the `omp` outer-host manifest is loaded
- **THEN** `material_progress_notify.mapping.surface` SHALL be `stdout_only`
- **AND** the fallback or how-to SHALL name stdout and/or `events.jsonl` follow

#### Scenario: Durable follow remains the portable pipeline path

- **WHEN** shared orchestration supervises a durable run launched from OMP
- **THEN** it SHALL use pipeline detach, run-store, and event-follow commands as the durable follow path
- **AND** SHALL NOT treat missing OMP-native notify as permission to skip supervision

### Requirement: The fault-recovery matrix host dimension SHALL reuse the outer-host conformance kit

The universal fault-recovery matrix host dimension SHALL evaluate builtin registered outer hosts and direct CLI through the existing outer-host conformance kit. Host rows SHALL compare typed lifecycle outcomes (verified success, Cooling, external-condition wait, typed request, cancellation). They SHALL NOT compare prompt text alone. Hermes and OpenClaw SHALL remain example-supervisor fixtures. Unsupported host capability SHALL be a typed Capability Request. This capability SHALL NOT add a second host table or a host-specific recovery recipe.

#### Scenario: Builtin hosts are scored by typed outcomes

- **WHEN** the matrix host layer runs against builtin registered outer hosts
- **THEN** each host SHALL be evaluated by the existing conformance kit
- **AND** a mechanical fixture SHALL yield the same unique-operation terminal class as direct CLI
- **AND** prompt-text equality SHALL NOT be the pass criterion

#### Scenario: Unsupported host capability is a typed request

- **WHEN** a host cannot launch a required supervised verb
- **THEN** that cell SHALL be a typed Capability Request or a checked `not_applicable` capability reason
- **AND** SHALL NOT become a False-human projection or ownerless terminal
