# production-treatment-preflight Specification

## Purpose
TBD - created by archiving change harness-preflight-exact-resolved-treatment. Update Purpose after archive.
## Requirements
### Requirement: Every production local-CLI harness invocation SHALL preflight the exact resolved treatment before model work

The pipeline SHALL run a production preflight-on-invoke gate before every production local-CLI
harness model invocation. The gate SHALL receive the **exact resolved** treatment for that call:

- adapter identity (registry name or compatibility adapter for an unregistered custom CLI),
- role (`implementer` or `reviewer`, or the role the stage is executing as),
- requested model (when the stage resolved one),
- requested effort / reasoning-effort (when the stage resolved one),
- resolved sandbox / tool / permission policy the invocation will apply,
- fully materialized prompt size against the adapter’s declared `maxPromptBytes` (#779),
- executable readiness for the adapter’s declared command.

The gate SHALL complete before any child process spawn that delivers the stage prompt to the
harness CLI and before stage mutations that depend on a successful harness turn for that call.
Built-in adapters, externally registered adapters, and compatibility adapters SHALL use the **same**
preflight-on-invoke path. The pipeline SHALL NOT skip the gate when optional doctor run-start
preflight was not enabled.

#### Scenario: Implementer call preflights exact resolved request

- **WHEN** a production implementer-role harness invocation is about to run with a resolved model,
  effort, and sandbox/tool policy
- **THEN** preflight SHALL be invoked with that adapter, the implementer role, and those exact
  resolved settings
- **AND** the harness CLI SHALL NOT be spawned until preflight succeeds

#### Scenario: Reviewer call preflights exact resolved request

- **WHEN** a production reviewer-role harness invocation is about to run with a resolved model,
  effort, and sandbox/tool policy
- **THEN** preflight SHALL be invoked with that adapter, the reviewer role, and those exact
  resolved settings
- **AND** the harness CLI SHALL NOT be spawned until preflight succeeds

#### Scenario: Extension adapter uses the same path

- **WHEN** a production invocation is assigned an externally registered adapter
- **THEN** preflight SHALL run on that adapter through the same production preflight-on-invoke
  surface as built-ins
- **AND** the pipeline SHALL NOT use a separate unguarded spawn path for that adapter

#### Scenario: Doctor opt-in does not substitute for the gate

- **WHEN** `doctor.runOnStart` is false or absent and no `--doctor` flag was passed
- **AND** a production harness invocation is about to run
- **THEN** the production preflight-on-invoke gate SHALL still run for that invocation

---

### Requirement: Production preflight SHALL refuse unsupported, unavailable, unauthenticated, and incompatible capabilities before mutation

When production preflight detects any of the following, it SHALL fail closed **before** spawn:

1. missing executable / CLI not resolvable for the adapter’s declared command,
2. unauthenticated CLI (when the adapter’s documented auth probe reports unauthenticated),
3. headless / non-interactive mode unavailable (when applicable to the adapter),
4. unsupported model, effort, sandbox/tool policy, or role relative to the adapter’s declarations,
5. materialized prompt exceeding a finite `maxPromptBytes`, or unknown limit fail-closed (#779),
6. other adapter-declared incompatible capability for the exact resolved request.

Each refusal SHALL be distinguishable by failure class (or equivalent structured flag) and SHALL
include operator-actionable remediation text naming the adapter and the offending setting or
readiness gap. The pipeline SHALL NOT fall back to a different harness, SHALL NOT substitute an
ambient core-owned model default, and SHALL NOT silently drop an unsupported setting and proceed.

Failures SHALL project into the pipeline’s #760-compatible typed reason / human-intervention
classification surface (not free-form prose alone).

#### Scenario: Unsupported model blocks before spawn

- **WHEN** the exact resolved treatment requests a model the adapter does not support
- **THEN** production preflight SHALL fail with an unsupported-setting (or equivalent) class
- **AND** the harness CLI SHALL NOT be spawned
- **AND** the failure SHALL name the adapter and the requested model with remediation

#### Scenario: Unsupported effort blocks before spawn

- **WHEN** the exact resolved treatment requests an effort the adapter does not support
- **THEN** production preflight SHALL fail before spawn
- **AND** the failure SHALL name the requested effort

#### Scenario: Unsupported sandbox or tool policy blocks before spawn

- **WHEN** the exact resolved treatment requests a sandbox or tool policy the adapter cannot honor
- **THEN** production preflight SHALL fail before spawn
- **AND** the invocation SHALL NOT proceed with widened or silently omitted permissions

#### Scenario: Missing executable blocks before spawn

- **WHEN** the adapter’s declared CLI command cannot be resolved to a runnable executable
- **THEN** production preflight SHALL fail with a missing-CLI (or equivalent) class
- **AND** the harness CLI SHALL NOT be spawned

#### Scenario: Oversize or unknown prompt limit blocks before spawn

- **WHEN** the fully materialized prompt exceeds the adapter’s finite `maxPromptBytes`, or the
  adapter declares unknown limit
- **THEN** production preflight SHALL refuse before spawn under the #779 comparison rules
- **AND** the refusal SHALL be a typed capability failure, not a bare mid-stage spawn error

#### Scenario: No silent harness or model fallback

- **WHEN** production preflight fails for the assigned adapter and treatment
- **THEN** the pipeline SHALL NOT reassign the stage to another harness
- **AND** SHALL NOT invent a core-owned ambient model id to make the call succeed

#### Scenario: Typed remediation classification is present

- **WHEN** a production preflight failure is recorded into blocker or intervention evidence
- **THEN** the evidence SHALL carry a #760-compatible typed reason or intervention kind
- **AND** SHALL include remediation text an operator can act on

---

### Requirement: Production preflight SHALL resolve an absolute executable and share the version probe with treatment fingerprinting

When the adapter declares PATH-based executable resolution, production preflight SHALL attempt to
resolve the command to an absolute filesystem path using the production process’s harness-discovery
environment. When resolution succeeds, the absolute path SHALL be available to treatment
fingerprint / diagnostics consumers. When resolution fails, preflight SHALL fail closed for
missing executable rather than spawning on a hope that PATH will improve later.

Production preflight SHALL consume the once-per-run (per CLI identity) binary/version probe helper
shared with production treatment fingerprinting (#778). The pipeline SHALL NOT implement a second
independent always-on per-call version exec solely for preflight. Version **drift** relative to
verified-against identity remains fail-soft per the fingerprint capability (warn without blocking
solely for drift). Missing CLI or failed readiness remains blocking.

#### Scenario: Absolute path recorded when resolvable

- **WHEN** production preflight resolves a PATH command to an absolute executable successfully
- **THEN** that absolute path SHALL be available to the treatment fingerprint or probe record for
  the invocation
- **AND** subsequent version probe consumption for that CLI identity SHALL use the shared cache

#### Scenario: Unresolvable command fails closed

- **WHEN** the declared command cannot be resolved to a runnable absolute or PATH executable
- **THEN** production preflight SHALL fail before spawn
- **AND** SHALL NOT proceed with an unresolved command name alone when resolution is required for
  readiness

#### Scenario: One version probe path

- **WHEN** production preflight and production fingerprint accounting both need the CLI version for
  the same run and CLI identity
- **THEN** they SHALL consume the same cached probe helper result
- **AND** they SHALL NOT each always spawn an independent version process

---

### Requirement: Registered-adapter preflight and spawn failures SHALL have bounded diagnostic quality

The pipeline SHALL surface a bounded diagnostic when an externally registered or compatibility
adapter fails production preflight or fails spawn after a successful preflight: structured failure
class (or harness result flags), a non-secret human-readable message naming adapter and cause, and
remediation. The diagnostic quality SHALL be comparable to failures on built-in adapters and custom
executor preflight paths — not an untyped throw or empty error as the sole operator surface.
Credential material SHALL never appear in the diagnostic.

#### Scenario: Extension preflight failure is classifiable

- **WHEN** a synthetic registered adapter’s production preflight fails for missing CLI or
  unsupported setting
- **THEN** the failure SHALL expose a distinguishable class and remediation message
- **AND** SHALL NOT leak credentials

#### Scenario: Diagnostic parity with built-in path

- **WHEN** the same class of failure occurs on a built-in adapter and on a registered adapter
- **THEN** both paths SHALL produce operator-visible diagnostics of the same bounded quality class
  (structured class + remediation, not empty)

