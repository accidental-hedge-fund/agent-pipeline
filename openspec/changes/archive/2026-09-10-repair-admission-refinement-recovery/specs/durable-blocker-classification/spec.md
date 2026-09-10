## ADDED Requirements

### Requirement: Child diagnostics SHALL survive independent forge observation failure

Dispatch SHALL observe and classify a completed nested child's structured terminal evidence independently from the subsequent forge refresh. When the child supplies a valid precise diagnostic and the forge refresh fails or is unobservable, Pipeline SHALL retain the child diagnostic as the operation blocker and SHALL record the forge observation failure as independent uncertainty. The later failure SHALL NOT overwrite the child diagnostic with a generic dispatch diagnostic, prove any gate successful, or manufacture a Tester binding.

When a persisted blocked record contains only a coarse transport diagnostic, RecoverySupervisor MAY refine it from the terminal events of the recorded linked advance. Such refinement SHALL be bound to the blocked item's recorded advance run identity and to the exact event path derived from Pipeline's configured persistent/common run-store root and that run identity. A suffix-shaped path under a foreign prefix or operator worktree SHALL NOT be canonical. Events from an arbitrary path, another run, a malformed stream, or a mismatched item or candidate SHALL NOT confer diagnostic authority.

Historical terminal evidence that omits `pr_head`, as in the captured #1558 record, MAY bind through matching recorded run/item identity and the current authoritative full head and candidate epoch. An explicit terminal-evidence head or candidate SHALL match the current authoritative binding. Refinement SHALL preserve the existing Recovery Episode and attempt history; it SHALL NOT edit historical events, mint a replacement episode solely to adopt the more precise observation, prove the Tester gate, or manufacture a Tester binding.

#### Scenario: Forge outage retains precise child blocker

- **WHEN** a nested child completes with a valid `tester_rebind_pr_head_unobservable` diagnostic
- **AND** the following forge issue or PR refresh throws or cannot be observed
- **THEN** dispatch SHALL return `tester_rebind_pr_head_unobservable` as the retained blocker diagnostic
- **AND** SHALL record the forge refresh as independent observation uncertainty
- **AND** SHALL NOT report the Tester gate passed or write a fabricated Tester subject

#### Scenario: Matching linked terminal events refine coarse persisted evidence

- **WHEN** a blocked item persists a coarse workflow-engine transport diagnostic and records linked advance run R
- **AND** the canonical event stream for R contains a valid terminal diagnostic for that same item and candidate
- **THEN** RecoverySupervisor SHALL use the more precise diagnostic for recipe applicability
- **AND** SHALL preserve the item's episode identity and all prior attempt records

#### Scenario: Missing historical head binds through current candidate observation

- **WHEN** the recorded linked advance terminal diagnostic omits historical `pr_head`
- **AND** its run and item identity match the blocked record
- **AND** the current authoritative full head and candidate epoch bind the same retained operation
- **THEN** RecoverySupervisor SHALL permit the precise diagnostic to control recipe applicability
- **AND** SHALL NOT treat that diagnostic as a Tester pass or synthesize a Tester subject

#### Scenario: Untrusted or mismatched events fail closed

- **WHEN** a candidate event stream is missing, malformed, non-terminal, outside the configured persistent/common run-store location, rooted under a foreign prefix or operator worktree, names a different run, item, head, or candidate, or lacks a valid terminal diagnostic
- **THEN** RecoverySupervisor SHALL NOT use it to replace persisted diagnostic authority
- **AND** SHALL NOT infer successful observation, Tester binding, or a new recovery episode
