## ADDED Requirements

### Requirement: Train SHALL invoke recover-parked once per park fingerprint before terminal human STOP

When `pipeline train` (including ship/Tugboat composition that invokes train) observes an item at `pipeline:needs-human` or leftover `pipeline:blocked` **after** existing deterministic enter-path resume has been attempted for the current advance, the train SHALL invoke the engine `recover-parked` command (or the same pure entrypoint the CLI uses) **at most once** for that item's current park fingerprint before treating the park as a terminal per-item hold or whole-train STOP for lack of schedulable work. Train SHALL NOT implement a second finding classifier, SHALL NOT call `pipeline override` directly for this reflow, SHALL NOT drop `blocked`/`needs-human` without the recover-parked path, and SHALL NOT call `repair_pipeline_item` as a train-local senior recoverer. If the item remains parked after the single recover-parked attempt (or if the fingerprint already spent its supervisor pass), train SHALL apply today's hold/STOP + notify behavior and MAY continue proven-independent schedulable peers under existing independence rules.

#### Scenario: First park invokes recover-parked once then holds if still parked

- **WHEN** a train item reaches `pipeline:needs-human` (or residual leftover `blocked` after deterministic resume) with a fingerprint that has not spent a supervisor pass
- **THEN** train SHALL invoke `recover-parked` once for that item
- **AND** if the item is still parked afterward, train SHALL hold that item and notify with the park reason
- **AND** train SHALL NOT invent an override disposition outside recover-parked

#### Scenario: Spent fingerprint does not re-invoke senior recover

- **WHEN** the item's park fingerprint has already spent its supervisor recover-parked pass
- **AND** the item is still or again parked with the same fingerprint
- **THEN** train SHALL NOT spend another recover-parked senior pass for that fingerprint
- **AND** SHALL STOP/hold with human notify under existing park rules

#### Scenario: Successful reflow continues same-issue advance without backlog restart

- **WHEN** recover-parked clears or re-enters advance for the parked issue
- **THEN** train/loop SHALL continue that same issue toward ready-to-deploy on the current work list
- **AND** SHALL NOT remove and re-select the issue from backlog solely because recover-parked ran

#### Scenario: Train still does not merge from recover-parked

- **WHEN** train invokes recover-parked during a non-merge or merge train
- **THEN** recover-parked SHALL NOT grant merge authority
- **AND** train merge behavior SHALL remain governed only by existing `--merge` / merge-wave rules
