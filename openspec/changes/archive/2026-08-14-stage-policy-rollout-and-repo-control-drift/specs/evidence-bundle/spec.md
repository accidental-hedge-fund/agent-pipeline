## ADDED Requirements

### Requirement: Finalized evidence SHALL record staged policy effective state and policy hash

When staged policies are in scope for a run, `summary.json` (and the legacy `evidence.json` mirror written at finalization) SHALL include a machine-readable section listing each in-scope policy with at least `policy_id`, effective lifecycle `state`, and `policy_hash`. Absent staged-policy configuration SHALL omit the section or emit an empty list without inventing policies.

#### Scenario: Enforcing policy appears in finalized evidence

- **WHEN** `finalizeRun` completes for a run with an in-scope policy in state `enforcing`
- **THEN** the finalized evidence SHALL contain that policy’s `policy_id`, `state`, and `policy_hash`

#### Scenario: No staged policies configured

- **WHEN** a run finalizes with no staged-policy configuration
- **THEN** the evidence SHALL NOT invent policy entries
- **AND** finalization SHALL still succeed

---

### Requirement: Finalized evidence SHALL record repository-control drift results

When repository-control desired state is configured and a compare runs during the run (or is attached from the read-only check path into run evidence), `summary.json` / legacy `evidence.json` SHALL include structured drift results with closed `outcome` values (`in_sync` | `drifted` | `unknown` | `unsupported` | `unavailable`), field-level differences when drifted, freshness metadata, repository identity, policy identity when bound, live snapshot reference or digest, timestamp, and evidence-subject identity when a candidate run context exists.

#### Scenario: Drifted compare recorded at finalize

- **WHEN** a run performs repository-control compare with outcome `drifted`
- **AND** `finalizeRun` is called
- **THEN** finalized evidence SHALL include a drift result with `outcome: "drifted"` and non-empty field-level differences

#### Scenario: Unavailable live read recorded distinctly

- **WHEN** live read fails due to permissions during the run
- **THEN** finalized evidence SHALL record `outcome: "unavailable"`
- **AND** SHALL NOT record that control as `in_sync`
