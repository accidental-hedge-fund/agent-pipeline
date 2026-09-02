## ADDED Requirements

### Requirement: Host artifacts SHALL contain only launch, follow, reattach, answer, cancel, and notification behavior

Outer-host SKILLs, example supervisor packs, and host overlays SHALL instruct the session host to launch the pipeline CLI, follow events, reattach through the Liveness Provider or portable follow, answer typed requests through CLI, cancel only through authenticated cancel surfaces, and notify material progress. Those artifacts SHALL NOT classify faults, choose recovery recipes, retry supervised operations, merge, release, deploy, or create a second ledger. Builtin registered hosts (`claude`, `codex`, `grok`, `opencode`, `omp`) and direct CLI SHALL enter identical supervisor semantics for those six behaviors.

#### Scenario: Generated SKILL has no recovery recipe

- **WHEN** a generated host SKILL or example supervisor pack is inspected
- **THEN** it SHALL contain launch, follow, reattach, answer, cancel, and notification behavior
- **AND** it SHALL NOT instruct the host to classify a dead worker, retry a supervised verb, or merge from follow

#### Scenario: Builtin hosts and direct CLI share supervisor semantics

- **WHEN** Claude, Codex, Grok, OpenCode, OMP, and direct CLI launch or restore the same durable run
- **THEN** each SHALL hand off, follow, reattach, answer, cancel, and notify through the same CLI semantics
- **AND** prompt-text differences SHALL NOT change the typed lifecycle outcome

---

### Requirement: Host liveness parity SHALL compare typed lifecycle outcomes

Host-conformance tests for worker death and restore SHALL reuse the existing outer-host conformance kit. Pass criteria SHALL be typed lifecycle outcomes (verified success, Cooling, external-condition wait, typed request, cancellation). Prompt-text equality SHALL NOT be the pass criterion. Unsupported host capability SHALL be a typed Capability Request or a checked `not_applicable` capability reason. It SHALL NOT become a False-human projection or an ownerless terminal.

#### Scenario: Dead-worker restore yields the same class as direct CLI

- **WHEN** a host-conformance fixture kills the worker of a non-terminal run and restores through the Liveness Provider
- **THEN** the typed outcome SHALL match direct CLI for that fixture
- **AND** prompt-text equality SHALL NOT be the pass criterion

#### Scenario: Unsupported restore capability is a typed condition

- **WHEN** a host cannot launch restore or follow
- **THEN** that cell SHALL be a typed Capability Request or checked `not_applicable` capability reason
- **AND** doctor SHALL NOT report that absence as human authority

---

### Requirement: Hermes and OpenClaw SHALL remain example-supervisor fixtures for liveness

Hermes and OpenClaw SHALL remain example external supervisors under `examples/supervisor/`. They SHALL be subject to liveness conformance fixtures. They SHALL NOT be silently promoted to shipped builtin hosts, install targets, or control planes. Existing #971 wrapper request/receipt/follow artifacts SHALL remain an earlier, non-authoritative baseline. Supported adapters SHALL reattach through the Liveness Provider rather than becoming retry controllers.

#### Scenario: Example packs are not builtin hosts

- **WHEN** the outer-host registry and generated host membership are enumerated
- **THEN** Hermes and OpenClaw SHALL NOT appear as builtin install hosts
- **AND** they SHALL still have conformance fixtures for launch, follow, reattach, answer, cancel, and notify

#### Scenario: #971 wrappers do not own retry

- **WHEN** a #971 request/receipt/follow wrapper observes a dead worker
- **THEN** it SHALL invoke the shared liveness restore or portable follow
- **AND** it SHALL NOT retry the supervised operation or classify recovery
