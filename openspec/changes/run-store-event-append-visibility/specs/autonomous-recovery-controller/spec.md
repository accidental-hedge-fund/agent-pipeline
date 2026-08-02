## ADDED Requirements

### Requirement: Missing control-critical event evidence SHALL fail safe and remain operator-visible

The autonomous recovery controller (or an equivalent recovery consumer) SHALL fail safe when it
cannot retrieve a required control-critical record — including blocker diagnostics / `blocker_set`
evidence, recovery claim or result records, or loop/run terminal state — because the run event
stream is missing, truncated, or marked elevated by write-health. It SHALL treat the persistence or
retrieval failure as an engine-owned control-plane defect path (typed `workflow-engine-defect` or
the existing unknown/malformed diagnostic failure path), SHALL surface the exact persistence failure
through operator-visible write-health / status / summary signals, and SHALL NOT invent an unrelated
recovery class, SHALL NOT create a human hold solely from missing evidence, SHALL NOT treat absence
as "blocker cleared" or "recovered," and SHALL NOT reconstruct authority or disposition from labels
or free-form prose. Existing fail-closed behavior for unknown diagnostics SHALL be preserved.

#### Scenario: Write-health elevated control-critical loss does not invent a human hold

- **WHEN** recovery needs a control-critical blocker or recovery claim record
- **AND** write-health for the run indicates control-critical append failure or the record is
  absent after a recorded stream failure
- **THEN** the controller SHALL NOT create a human hold solely from that missing evidence
- **AND** SHALL NOT project an unrelated blocker class from labels or prose
- **AND** the persistence failure SHALL remain visible via write-health or status/summary

#### Scenario: Missing recovery result does not mark recovered

- **WHEN** a recovery attempt was started but its result record cannot be retrieved because of
  event-stream write failure or truncation
- **THEN** the controller SHALL NOT record `recovered` solely from the missing result
- **AND** SHALL reconcile via the existing fail-safe / restart reconciliation path without
  inventing success

#### Scenario: Partial write after restart does not reclassify as a different class

- **WHEN** a process restarts and only partial `events.jsonl` lines plus elevated write-health are
  available for a blocked item
- **THEN** the controller SHALL fail closed or retain the prior durable ledger authority for
  classification
- **AND** SHALL NOT silently reclassify the item into an unrelated recovery class based on the
  incomplete event stream alone
