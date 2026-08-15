## ADDED Requirements

### Requirement: Hard waits SHALL be admitted only for open prerequisites on the current work-list selector

Work-list population SHALL apply a deterministic **hard-wait admission** step after raw
declared prerequisites are unioned from authoritative sources, and before `depends_on` /
`external_depends_on` partition and contract compilation. A candidate prerequisite id for a
depender SHALL be admitted as a hard wait only when **both** are true:

1. The target issue is a member of the **current work-list / train selector snapshot** (the
   same set of issue ids that the run is compiling — milestone membership, explicit
   work-list, label/roadmap-slice resolution, or equivalent selector), and
2. The target issue is observed **open** (not closed-as-completed, not closed-as-not-planned,
   not merged-closed) at admission time through the injectable discovery / observation seam.

An admitted hard wait SHALL flow into the existing in-snapshot / external partition rules
exactly as today's raw declared edge does when the target is in-snapshot and open. A
non-admitted candidate SHALL **not** appear on the compiled item's `depends_on` or
`external_depends_on` gates. Population SHALL NOT invent ordering from LLM inference, list
position, or shared-file heuristics. Unit tests SHALL inject fakes for selector membership
and open/closed observation and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Open on-selector Depends on remains a hard wait

- **WHEN** work-list snapshot contains issues `647` and `599`
- **AND** issue `647` declares `Depends on: #599` (or equivalent phrase form)
- **AND** issue `599` is observed open
- **THEN** the compiled contract item for `647` SHALL include `599` in in-snapshot
  `depends_on`

#### Scenario: Open off-selector Depends on is not a hard wait

- **WHEN** work-list snapshot contains issue `838` but not issue `822`
- **AND** issue `838` declares `Depends on: #822` or a bare `#822` under `## Dependencies`
- **AND** issue `822` is observed open
- **THEN** the compiled contract item for `838` SHALL NOT include `822` on `depends_on` or
  `external_depends_on`
- **AND** an `ignored_dep` record for depender `838` and target `822` SHALL be produced with
  reason indicating the target is not on the selector

#### Scenario: Closed or merged on- or off-selector declaration is not a hard wait

- **WHEN** issue `A` declares a dependency on `#B` via an authoritative lexical source
- **AND** issue `B` is observed closed (completed or not-planned) or satisfied via a merged
  linked PR under the observation seam used for admission
- **THEN** the compiled contract item for `A` SHALL NOT gate on `B` as a hard wait
- **AND** an `ignored_dep` record SHALL name `B` and a closed/merged-class reason
- **AND** `A` SHALL remain eligible for scheduling subject to other gates

#### Scenario: Soft Related-only reference never becomes a hard wait

- **WHEN** issue `A` mentions `#B` only under a soft Related / see-also section with no
  dependency phrase
- **AND** lexical observation uses the shared grammar
- **THEN** `B` SHALL NOT appear in `A`'s raw declared set
- **AND** no hard wait on `B` SHALL be compiled for `A`

### Requirement: Non-admitted declarations SHALL be logged as ignored_dep with a stable reason

When hard-wait admission drops a candidate prerequisite, population SHALL emit a structured
`ignored_dep` observation (event field, discovery result field, or equivalent durable run
telemetry) that includes at least: depender issue id, ignored target id, and a stable
machine-readable reason code. Reason codes SHALL distinguish at least:

- `not_on_selector` — target not in the current work-list / train snapshot
- `closed` — target observed closed (completed or not-planned class as applicable)
- `not_open` — target not open for any other observed reason used by admission

Admission MUST NOT require rewriting the issue body. Operators MAY leave stale
`## Dependencies` prose in place; the engine ignores non-admitted targets without a
mid-ship body edit.

#### Scenario: Off-selector ignore is auditable

- **WHEN** issue `839` declares `#822` under `## Dependencies` and `822` is not on the
  train selector
- **THEN** compilation SHALL produce an `ignored_dep` for `839`→`822` with reason
  `not_on_selector` (or an equivalent documented alias)
- **AND** the run SHALL NOT stop solely because that reference existed in the body

#### Scenario: Body rewrite is not required

- **WHEN** a non-admitted soft or stale dependency reference remains in the issue body
- **THEN** hard-wait admission SHALL still ignore it for scheduling
- **AND** the engine SHALL NOT require an operator or Hermes body edit to clear the gate
