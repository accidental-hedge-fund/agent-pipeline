## ADDED Requirements

### Requirement: Ship status SHALL project RecoverySupervisor lifecycle without becoming a second controller

`pipeline ship` SHALL compose existing train, FRG, release, tag, publication, promotion, deployment, and rollback capabilities as RecoverySupervisor-owned operations. Ship status SHALL project phase, candidate lineage, next action, and current typed request. It SHALL NOT choose recovery recipes, declare terminal mechanical failure, or become a second lifecycle owner.

#### Scenario: Status remains observational

- **WHEN** an adapter polls `pipeline ship status --milestone <title> --json`
- **THEN** the response SHALL describe the projected RecoverySupervisor state for that shipment
- **AND** the request SHALL perform no train, merge, release, promotion, deployment, or rollback mutation

#### Scenario: Coordinator does not become a recoverer

- **WHEN** a post-ready phase reports a mechanical fault
- **THEN** ship SHALL hand the observation to RecoverySupervisor
- **AND** it SHALL NOT implement a ship-local retry taxonomy or STOP policy

---

### Requirement: A failed ship phase SHALL remain owned instead of becoming a thrown terminal

When a post-ready ship phase fails, times out, or is interrupted, `pipeline ship` SHALL persist owned lifecycle (active, Cooling, or external-condition wait) and SHALL return that status. It SHALL NOT persist `last_error` and rethrow as an ownerless terminal. Same-argv retry SHALL resume the same shipment. Genuine typed requests MAY project `human_authority` without ending ownership of the Logical Operation.

#### Scenario: Mechanical failure does not rethrow as ownerless terminal

- **WHEN** release prepare, finish, tag, publication, promotion, or deployment returns a mechanical fault
- **THEN** ship SHALL persist the phase as Cooling or wait
- **AND** the command SHALL NOT leave an ownerless thrown failure as the product outcome
- **AND** a later same-argv invoke SHALL resume that phase after reconciliation

#### Scenario: Pending release checks remain resumable

- **WHEN** release-PR checks are pending and the session poll cap expires
- **THEN** ship SHALL preserve `next_action` for finish
- **AND** it SHALL NOT persist terminal ship failure

---

### Requirement: Ship SHALL NOT infer human_authority from error-message regex

`pipeline ship` SHALL NOT set `human_authority` by matching `last_error` or exception text against `needs-human`, `missing-authority`, `human.authority`, or `specification-decision`. The human-authority flag SHALL be a projection of a current typed Authority Request or a canonical diagnostic whose disposition is `human_authority`.

#### Scenario: Error text does not set the human-authority bit

- **WHEN** a ship phase fails with message `needs-human: missing-authority for milestone release` and no typed Authority Request is current
- **THEN** persisted ship status SHALL NOT set `human_authority` true from that regex
- **AND** hosts SHALL be allowed to re-invoke the same ship argv for mechanical recovery

#### Scenario: Canonical human-authority diagnostic still projects the bit

- **WHEN** RecoverySupervisor holds a current `human_authority` diagnostic or Authority Request
- **THEN** ship status MAY set `human_authority` true
- **AND** hosts SHALL stop and report that state

---

### Requirement: Ship SHALL interpret roadmap.release_model for applicable phases

`pipeline ship` SHALL read the resolved `config.roadmap.release_model` as the single shipment-intent policy. Under `continuous`, ship SHALL complete after exact-candidate integration is proven and SHALL NOT run SemVer-only release, tag, publication, promotion, or deployment phases. Under `semver` or an absent key, ship SHALL keep the existing SemVer phase order after train merge. Ship SHALL NOT add a `ship.model` config key.

#### Scenario: Continuous ship skips SemVer-only phases

- **WHEN** `roadmap.release_model` is `continuous`
- **AND** train merge has proven the frozen candidates are contained in the configured base
- **THEN** `pipeline ship` SHALL record complete
- **AND** it SHALL NOT invoke `pipeline release`, `release finish`, tag, GitHub Release wait, `engine-promote`, or rollback

#### Scenario: SemVer ship still runs post-train phases

- **WHEN** `roadmap.release_model` is `semver` or the key is absent
- **AND** an operator runs `pipeline ship --milestone v1.39.3`
- **THEN** the coordinator SHALL still compose FRG, release, finish, publication, and engine-promote after train merge
