## MODIFIED Requirements

### Requirement: Merge-queue dry-run SHALL be the default and SHALL perform zero mutations
The merge-queue command SHALL default to dry-run mode. In dry-run mode the
handler SHALL inspect GitHub state and print a plan only. It SHALL NOT invoke
`gh pr merge`, push, force-push, delete a branch, add/remove labels, close
issues, create comments, run surgical/mechanical repair side effects, or
otherwise mutate repository or issue state. An explicit `--dry-run` flag SHALL
be accepted as affirming the default. Apply/drive mode MAY perform merges only
when the operator passes an explicit apply/confirm flag; optional repair MAY
run only when repair is explicitly enabled and the invocation is not dry-run.
The command SHALL NOT introduce an `auto_merge` config key.

#### Scenario: Default invocation is dry-run with no merges
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2"`
- **THEN** the handler SHALL run in dry-run mode
- **AND** SHALL NOT call any merge primitive or mutating GitHub write

#### Scenario: Explicit --dry-run is accepted
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2" --dry-run`
- **THEN** the handler SHALL produce the same class of plan output as the default
- **AND** SHALL NOT mutate GitHub state

#### Scenario: Dry-run ignores repair intent for side effects
- **WHEN** the user runs dry-run with a repair opt-in flag present
- **THEN** the command SHALL NOT open worktrees for repair, invoke an implementer,
  push repair commits, or merge any PR

#### Scenario: Dry-run is idempotent
- **WHEN** the user runs the same dry-run invocation twice against unchanged
  GitHub state
- **THEN** both runs SHALL report the same ordered merge-candidate set and the
  same skip set (same issue/PR identities and order)
- **AND** neither run SHALL mutate GitHub state

---

## ADDED Requirements

### Requirement: Merge-queue apply mode SHALL surface typed holds and optional repair without auto_merge

When apply/drive is enabled, the merge-queue command SHALL process candidates
through the existing merge surface and MAY record typed holds
(`merge-conflict`, `checks-failed`) per `merge-queue-repair-hold`. An optional
repair opt-in (CLI flag and/or config defaulting to false) SHALL be rejected or
ignored for side effects unless apply mode is active. The command registry
allowlist MAY include apply and repair-related flags; unsupported flags still
fail closed. No `auto_merge` config key SHALL enable drive or repair.

#### Scenario: Apply without repair records holds on conflict

- **WHEN** the operator runs apply/drive without repair enabled and a candidate
  is conflicting
- **THEN** the command SHALL record a `merge-conflict` hold with remediation
- **AND** SHALL NOT force-merge that PR

#### Scenario: Repair flag does not grant auto_merge

- **WHEN** repository configuration and CLI flags for merge-queue are inspected
- **THEN** no `auto_merge` key SHALL enable autonomous merging
- **AND** repair opt-in SHALL only authorize surgical/mechanical remediation of
  held items under the repair-hold capability, not unattended merge of red/dirty PRs

#### Scenario: Advance loop still does not invoke merge-queue

- **WHEN** the advance loop dispatches any stage
- **THEN** no call to merge-queue plan, drive, hold, or repair handlers occurs
