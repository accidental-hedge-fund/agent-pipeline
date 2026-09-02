## MODIFIED Requirements

### Requirement: recover-parked CLI SHALL reflow a park with one supervised pass per fingerprint

The pipeline SHALL expose a `recover-parked` command that accepts an issue (or linked PR→issue) number. The command SHALL be a RecoverySupervisor compatibility entrypoint. It SHALL claim or resume the Recovery Episode of the owning Logical Operation. It SHALL NOT keep an independent controller budget or an independent terminal outcome. When invoked for an item that is parked with `pipeline:blocked` and/or `pipeline:needs-human` (or equivalent residual park after review/fix/pre-merge residual block at the current head), the command SHALL:

1. Run deterministic engine recover first (see deterministic-first requirement).
2. If the park remains, load residual blocking findings against the **live PR HEAD**.
3. Classify each residual key as override-eligible or non-overridable under the structured-record rules.
4. For override-eligible keys only, record audited dispositions through the existing `pipeline override` / governed override path.
5. Optionally run at most one implementer fix round for remaining still-valid non-overridable defects (fix ≠ override).
6. When the residual blocking set is empty after those steps, re-enter `pipeline single` (or equivalent same-issue advance continuation) without restarting the item from backlog.
7. When non-overridable residuals remain at the (possibly new) HEAD, project the park and surface a human notify path. RecoverySupervisor SHALL retain ownership. The command SHALL NOT declare an ownerless terminal.

The fingerprint "one pass" SHALL be a RecoverySupervisor strategy-cursor position for that Recovery Episode. Exhausting that treatment SHALL advance the cursor rather than end lifecycle ownership. The command SHALL NOT merge, SHALL NOT invent a second state machine, and SHALL NOT drop `blocked`/`needs-human` without an audited disposition or a successful deterministic clear.

#### Scenario: Stale or below-high park reflows via override and re-enters single

- **WHEN** a parked item's residual blocking keys at live HEAD are all override-eligible (stale/DNR and/or below-high)
- **AND** the Recovery Episode strategy cursor has not already spent that supervisor-pass treatment
- **THEN** `recover-parked` SHALL record an audited override for each eligible key with a key-bound evidence reason
- **AND** SHALL re-enter same-issue advance (`pipeline single` or equivalent)
- **AND** SHALL NOT restart the item from backlog selection

#### Scenario: Still-valid HIGH or CRITICAL remains parked

- **WHEN** residual findings at live HEAD include still-valid HIGH or CRITICAL keys
- **THEN** `recover-parked` SHALL NOT record an override disposition for those keys
- **AND** the item SHALL remain projected as parked (`blocked` and/or `needs-human` as applicable)
- **AND** a human notify / punch-list path SHALL remain available
- **AND** RecoverySupervisor SHALL retain ownership of the Logical Operation

#### Scenario: Unparked item is a no-op fail-closed

- **WHEN** the target issue is not in a residual park state eligible for supervisor reflow
- **THEN** `recover-parked` SHALL exit without applying overrides
- **AND** SHALL NOT mutate labels solely to force a reflow

#### Scenario: Independent fingerprint terminal is forbidden

- **WHEN** the strategy cursor has already spent the recover-parked pass treatment
- **AND** residual blocking keys remain
- **THEN** `recover-parked` SHALL emit an observation
- **AND** SHALL NOT end RecoverySupervisor ownership solely because the command-local pass is spent
