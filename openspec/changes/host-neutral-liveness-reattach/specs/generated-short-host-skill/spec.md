## ADDED Requirements

### Requirement: Generated host SKILLs SHALL own only launch, follow, reattach, answer, cancel, and notification behavior

Each generated host SKILL SHALL tell the session host to exec `pipeline <verb>` to launch, follow events with `pipeline logs` / `pipeline loop logs`, reattach through the shared liveness restore or portable follow, answer typed requests through CLI (`pipeline unblock` or the documented answer surface), cancel only through authenticated cancel surfaces, and notify from the active outer-host manifest row. Generated SKILLs SHALL NOT encode recovery recipes, fault classification, retry controllers, merge-from-follow, or a second ledger. Compact policy that names operator-authorized merge and ship surfaces SHALL remain launch documentation only. The follower SHALL still never invoke a merge-capable command.

#### Scenario: SKILL reattach points at shared restore

- **WHEN** a reader opens a generated host SKILL
- **THEN** interrupted follow and dead-worker restore SHALL be described as non-terminal
- **AND** the SKILL SHALL name the shared liveness restore or portable follow CLI
- **AND** it SHALL NOT tell the host to retry `pipeline single` or classify a recipe

#### Scenario: Recovery and retry language is absent from host-owned behavior

- **WHEN** the four generated SKILL bodies are inspected for host-owned behavior
- **THEN** they SHALL NOT instruct the host to classify faults, park as needs-human, or merge because follow stopped
- **AND** they SHALL still list operator-authorized merge and ship as explicit launch surfaces outside follow

---

### Requirement: Host-skill generation SHALL keep OMP argv-only and SHALL NOT promote example supervisors

The generator SHALL continue to emit exactly the `SKILL_HOST_IDS` targets and SHALL NOT write `hosts/omp/SKILL.md`. OMP SHALL remain an installer host that launches the CLI without a SKILL overlay. Hermes and OpenClaw example packs SHALL NOT be added to `SKILL_HOST_IDS`. Direct CLI SHALL remain in supervisor-semantic parity without a generated SKILL.

#### Scenario: OMP still has no generated SKILL

- **WHEN** the generator runs
- **THEN** it SHALL NOT write `hosts/omp/SKILL.md`
- **AND** OMP SHALL still launch the same liveness restore and follow CLI

#### Scenario: Hermes and OpenClaw stay out of generated membership

- **WHEN** `SKILL_HOST_IDS` is enumerated
- **THEN** it SHALL NOT contain Hermes or OpenClaw
- **AND** example packs under `examples/supervisor/` SHALL remain example fixtures
