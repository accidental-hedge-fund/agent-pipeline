# engine-class-live-sibling Specification

## Purpose
After first recovered engine-class scratch or workflow-engine defect on a live train item, file at most one milestone-scoped ready sibling so the durable engine fix lands in the current ship without patching the victim PR.

## Requirements

### Requirement: First recovered engine-class fingerprint SHALL file at most one live milestone sibling

When the pipeline successfully recovers (or classifies and clears via engine-scratch recover) a **first-occurrence** engine-class fingerprint — limited to `workflow-engine-defect` / engine-scratch class evidence recovered under the engine-scratch path (for example `unlink_engine_scratch` after #1020 classification) — it SHALL file **at most one** sibling GitHub issue keyed by that `evidence_key` (or equivalent stable evidence identity). Filing SHALL be invoked only from that successful recover path. Product-class review findings, design/credential holds, dirty product porcelain (`core/`, dirty product `openspec/`, or other non-scratch product paths), and `human-decision-required` SHALL NEVER trigger a live sibling and SHALL NOT assign a milestone for those non-triggers. Filing SHALL reuse the existing cross-host-safe auto-file pattern: pre-create GitHub-state dedup and rate-cap, plus post-create reconciliation. Rate-cap membership SHALL be scoped to this capability’s provenance marker and SHALL NOT consume papercut, correction, or durable-run-blocker auto-file budgets. A second identical `evidence_key` inside the configured window SHALL NOT create a duplicate open sibling; post-create reconciliation SHALL close rate-cap or title/key duplicates down to the lowest-numbered open survivors when applicable. The recovered (victim) item SHALL continue toward `pipeline:ready-to-deploy` without absorbing engine-source patches into its PR as part of this filing path. Sibling filing failure or skip SHALL NOT reverse a successful recover, re-apply a mechanical `pipeline:blocked` solely because filing failed, or STOP train solely because a sibling was filed or skipped.

#### Scenario: #1013-class recover files one sibling and continues the victim

- **WHEN** an item is recovered from engine-scratch / workflow-engine-defect evidence with a fresh first-occurrence `evidence_key`
- **AND** a train or ship run is driving a current milestone
- **THEN** the engine SHALL create exactly one sibling issue for that key
- **AND** the recovered item SHALL continue toward ready-to-deploy
- **AND** the victim PR SHALL NOT receive engine-source patches solely from this sibling path
- **AND** train SHALL NOT STOP solely because recover cleared a mechanical block or because the sibling was filed

#### Scenario: Duplicate evidence_key does not refile

- **WHEN** the same `evidence_key` is observed again inside the auto-file window after a sibling was already filed
- **THEN** no second open sibling SHALL be created for that key
- **AND** post-create reconciliation SHALL close rate-cap or title/key duplicates down to the lowest-numbered open survivors when applicable

#### Scenario: Human-decision and product dirt do not file a live sibling

- **WHEN** the diagnostic is `human-decision-required` or the dirt is product (`core/`, dirty product `openspec/`, or other non-scratch product paths)
- **THEN** the engine SHALL NOT file a live milestone sibling
- **AND** SHALL NOT assign a milestone for that non-trigger

#### Scenario: Sibling filing failure does not reverse recover

- **WHEN** engine-class recover succeeds and the subsequent sibling create or list call fails
- **THEN** the recover outcome SHALL remain successful
- **AND** the engine SHALL NOT re-apply `pipeline:blocked` solely because sibling filing failed

---

### Requirement: Live engine-class siblings SHALL be ready-labeled, milestone-scoped, and dependency-linked

A live engine-class sibling created under this capability SHALL carry labels `bug`, `pipeline:engine-class` (or the stable engine-class marker), and `pipeline:ready`. It SHALL NOT carry `pipeline:backlog` and SHALL NOT be filed as a papercut cluster issue. When the filing path has a current train milestone in scope (the milestone `pipeline train --milestone` / ship playbook is driving, preferably from first-class train/loop run context), the sibling SHALL be assigned that milestone. When no train milestone is in scope, the engine SHALL file without a milestone and SHALL NOT invent a milestone title or pick an unrelated open milestone (including advisory improve-milestone prose). The sibling body SHALL declare a machine-usable `Depends on: #<recovered-item>` edge so train orders the sibling after the recovered item. This capability is a narrow exception to the #538 backlog-only auto-file policy and SHALL NOT reverse that policy for papercuts, corrections, or durable-run-blockers. The filing path SHALL NOT auto-merge any PR and SHALL NOT invoke review overrides.

#### Scenario: Sibling labels and Depends on

- **WHEN** a live engine-class sibling is created for recovered item N under train milestone M
- **THEN** the sibling SHALL carry `bug`, `pipeline:engine-class`, and `pipeline:ready`
- **AND** SHALL NOT carry `pipeline:backlog`
- **AND** SHALL be assigned milestone M
- **AND** its body SHALL declare `Depends on: #N` (or the equivalent machine-usable dependency form)

#### Scenario: No train milestone fails closed on assignment

- **WHEN** engine-class recover would file a sibling but no current train milestone is in scope
- **THEN** the engine MAY still create the sibling without a milestone
- **AND** SHALL NOT invent a milestone title or pick an unrelated open milestone

#### Scenario: Papercut auto-file policy remains backlog-only

- **WHEN** a recurring papercut cluster is auto-filed under the existing papercut path
- **THEN** that issue SHALL still follow papercut-auto-file rules (`pipeline:backlog`, no stage advance labels)
- **AND** this live-sibling capability SHALL NOT reclassify that papercut path as `pipeline:ready`

#### Scenario: Live sibling path never merges or overrides

- **WHEN** a live engine-class sibling is filed or skipped after recover
- **THEN** the engine SHALL NOT merge any PR as part of this filing path
- **AND** SHALL NOT apply a review override solely to land the sibling or the recovered item
