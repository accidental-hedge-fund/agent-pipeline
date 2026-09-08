## ADDED Requirements

### Requirement: Child diagnostics SHALL survive independent forge observation failure

Dispatch SHALL observe and classify a completed nested child's structured terminal evidence independently from the subsequent forge refresh. When the child supplies a valid precise diagnostic and the forge refresh fails or is unobservable, Pipeline SHALL retain the child diagnostic as the operation blocker and SHALL record the forge observation failure as independent uncertainty. The later failure SHALL NOT overwrite the child diagnostic with a generic dispatch diagnostic, prove any gate successful, or manufacture a Tester binding.

When a persisted blocked record contains only a coarse transport diagnostic, RecoverySupervisor MAY refine it from the terminal events of the recorded linked advance. Such refinement SHALL be bound to the blocked item's recorded advance run identity and to that run's canonical run-store event location. Events from an arbitrary path, another run, a malformed stream, or a mismatched item SHALL NOT confer diagnostic authority. Refinement SHALL preserve the existing Recovery Episode and attempt history; it SHALL NOT edit historical events or mint a replacement episode solely to adopt the more precise observation.

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

#### Scenario: Untrusted or mismatched events fail closed

- **WHEN** a candidate event stream is missing, malformed, outside the canonical run-store location, names a different run or item, or lacks a valid terminal diagnostic
- **THEN** RecoverySupervisor SHALL NOT use it to replace persisted diagnostic authority
- **AND** SHALL NOT infer successful observation, Tester binding, or a new recovery episode
