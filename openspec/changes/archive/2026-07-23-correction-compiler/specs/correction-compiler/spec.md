## ADDED Requirements

### Requirement: The compiler SHALL cluster corrections deterministically from the bounded event contract

`pipeline improve` SHALL read `correction_event` records from run artifacts and cluster them into a
distinct `correction` category. Cluster identity SHALL be the event contract's deterministic
`correction_key` (derived by #499 from `source_kind` + `failure_class` + `stage` only). Raw-text
similarity or an LLM MAY enrich a proposal draft's prose but SHALL NOT determine cluster identity,
deduplication, or whether a cluster qualifies for issue creation. Two `correction_event` records with
the same `correction_key` SHALL cluster together; two with different `correction_key`s SHALL NOT.

#### Scenario: Same correction_key clusters together

- **WHEN** `correction_event` records across two runs share the same `correction_key`
- **THEN** the compiler SHALL group them into one `correction` cluster keyed on that `correction_key`

#### Scenario: Different correction_key does not merge

- **WHEN** two `correction_event` records carry different `correction_key`s but similar free-text
  `correction` prose
- **THEN** the compiler SHALL keep them as two distinct `correction` clusters

#### Scenario: LLM cannot change cluster membership or qualification

- **WHEN** the correction clusters are computed with the enrichment LLM stubbed out or absent
- **THEN** cluster membership, deduplication, and which clusters qualify for issue creation SHALL be
  identical to the result with the LLM present
- **AND** the LLM's only effect SHALL be optional draft prose in a proposal body

### Requirement: The compiler SHALL count occurrences by distinct correction instance

The compiler SHALL count a cluster's occurrences by distinct `correction_id`, so that repeated
delivery or replay of a single correction (which #499 guarantees shares a `correction_id`) counts as
one occurrence. Two distinct `correction_id`s within the same `correction_key` cluster SHALL count as
two occurrences.

#### Scenario: Duplicate delivery counts once

- **WHEN** the same `correction_id` is delivered or replayed more than once into a cluster
- **THEN** the cluster's occurrence count SHALL increase by exactly one for that `correction_id`

#### Scenario: Distinct instances count separately

- **WHEN** two different `correction_id`s share a `correction_key`
- **THEN** the cluster's occurrence count SHALL be two

### Requirement: Singletons SHALL be visible but SHALL NOT be filed by default

A `correction` cluster with a single distinct occurrence SHALL appear in the dry-run report and in
`--json` output, but SHALL NOT result in issue creation at the default threshold. Issue creation for
the `correction` category SHALL require two distinct correction occurrences by default (the
`--min-occurrences` default for this category SHALL be 2).

#### Scenario: Singleton is reported but not filed

- **WHEN** a `correction` cluster has exactly one distinct occurrence and `pipeline improve --apply`
  is run at the default threshold
- **THEN** the cluster SHALL appear in the printed report and in `--json` output
- **AND** no GitHub issue SHALL be created for it

#### Scenario: Two distinct occurrences qualify

- **WHEN** a `correction` cluster has two distinct correction occurrences and `pipeline improve
  --apply` is run at the default threshold
- **THEN** the cluster SHALL be eligible for issue creation

### Requirement: Each correction cluster SHALL report a bounded evidence bundle

Each reported `correction` cluster SHALL record: the occurrence count, the number of distinct runs,
the number of distinct items (issues/PRs), the first-seen and last-seen timestamps, the affected
stages, the affected harnesses/actors, severity/impact evidence when available in the source records,
and sanitized evidence links/excerpts. Every excerpt and link SHALL pass the engine's secret
redaction and injection screening before it appears in any report line, `--json` field, or issue
body.

#### Scenario: Cluster carries the full evidence bundle

- **WHEN** a `correction` cluster is reported
- **THEN** it SHALL include occurrence count, distinct run count, distinct item count, first/last
  seen, affected stages, affected harnesses/actors, and at least one sanitized evidence excerpt
- **AND** severity/impact evidence SHALL be included when present in the source records

#### Scenario: A secret in a correction never reaches a report line or issue body

- **WHEN** a source `correction_event`'s free text contains a value matching a recognized secret
  pattern
- **THEN** every report line, `--json` field, and issue body derived from that cluster SHALL contain
  the redacted form and SHALL NOT contain the raw secret

### Requirement: Every proposal SHALL name one next control level with acceptance criteria and rationale

Every proposed correction issue SHALL name exactly one next control level — one of `instruction`,
`skill-rubric`, `eval`, `deterministic-gate`, or `human-judgment` — or the explicit sentinel
`undetermined` when the evidence does not justify a level. The proposal SHALL include acceptance
criteria and a rationale explaining why that level fits the cluster's evidence. When the source
`correction_event` records carry a consistent `proposed_control`, it SHALL seed the named level
deterministically; a level suggested only by an enrichment LLM SHALL be rendered as a draft
suggestion that is not treated as human approval.

#### Scenario: Proposal names a control level

- **WHEN** a qualifying `correction` cluster is turned into a proposal
- **THEN** the issue body SHALL name exactly one of `instruction`, `skill-rubric`, `eval`,
  `deterministic-gate`, `human-judgment`, or `undetermined`
- **AND** it SHALL include acceptance criteria and a rationale tying the level to the evidence

#### Scenario: Consistent proposed_control seeds the level deterministically

- **WHEN** every `correction_event` in a cluster carries the same `proposed_control`
- **THEN** the proposed control level SHALL be that value, independent of any LLM

#### Scenario: Absent or mixed proposed_control yields undetermined

- **WHEN** a cluster's records carry no `proposed_control` or an inconsistent one and no level is
  otherwise justified
- **THEN** the proposal SHALL name `undetermined` rather than guessing a level

### Requirement: Proposals SHALL follow the graduation ladder and SHALL NOT harden judgment into a gate

The proposal SHALL follow the graduation ladder `documented rule -> skill/rubric -> eval ->
deterministic gate`, proposing the lowest rung the evidence supports. It SHALL NOT harden provisional
taste, strategy, product judgment, or an authority boundary into an executable `eval` or
`deterministic-gate`; such corrections SHALL be proposed as `human-judgment` (or `undetermined`).
Model-generated prose SHALL NOT be treated as evidence of human approval.

#### Scenario: Human-judgment correction is not hardened into a gate

- **WHEN** a `correction` cluster's evidence reflects provisional taste, strategy, product judgment,
  or an authority boundary
- **THEN** the proposal SHALL name `human-judgment` or `undetermined`
- **AND** it SHALL NOT propose an `eval` or `deterministic-gate` for that cluster

#### Scenario: Ladder proposes the lowest justified rung

- **WHEN** a cluster's evidence would be satisfied by a documented instruction
- **THEN** the proposal SHALL name `instruction` rather than escalating to a heavier control level

### Requirement: The compiler SHALL default to dry-run and SHALL only file pipeline:backlog issues

Dry-run SHALL remain the default for the `correction` category: with no write flag the compiler SHALL
create no issues and mutate no state. With `--apply`, the compiler SHALL reuse the existing open-issue
`[pipeline-improve]` deduplication and SHALL create only `pipeline:backlog` issues. It SHALL NOT
queue, advance, approve, or merge any issue, SHALL NOT auto-edit repository instructions, skills,
tests, or CI, and SHALL NOT apply any label that advances an issue past `pipeline:backlog`.

#### Scenario: Dry-run creates nothing

- **WHEN** `pipeline improve` is run without `--apply` over runs containing correction clusters
- **THEN** no GitHub issue SHALL be created and no pipeline state SHALL be mutated
- **AND** the correction clusters SHALL still be printed and available in `--json`

#### Scenario: Apply files only a backlog issue

- **WHEN** `pipeline improve --apply` files a qualifying `correction` cluster
- **THEN** the created issue SHALL carry only the `pipeline:backlog` label
- **AND** the compiler SHALL NOT queue it, start a run for it, or advance it past `pipeline:backlog`

#### Scenario: Apply reuses open-issue dedup

- **WHEN** a qualifying `correction` cluster's proposed `[pipeline-improve]` title already matches an
  open issue
- **THEN** no new issue SHALL be created for that cluster
- **AND** the cluster SHALL still be reported, annotated as already tracked
