## ADDED Requirements

### Requirement: Each executed cell SHALL be able to emit an immutable, bounded treatment trajectory artifact

The eval runner SHALL be able to emit, for each executed cell, one immutable treatment trajectory
artifact that captures the treatment's execution: bounded per-stage messages and output, tool calls
and their results when the harness exposes them, actions taken, errors, timing, and references to
any artifacts the treatment produced. The artifact SHALL be written under the experiment output
directory, SHALL carry a `schema_version`, and once written SHALL NOT be modified, rewritten,
truncated, or deleted by a later cell or a resumed run. Artifact collection SHALL NOT gate or fail
the cell: a collection failure SHALL be recorded and the cell's `result_class` SHALL be unaffected.

#### Scenario: A completed cell emits a treatment trajectory artifact

- **WHEN** a cell executes and produces a treatment outcome
- **THEN** a treatment trajectory artifact MAY be written under the experiment output directory
- **AND** it SHALL contain the cell's bounded stage messages/output, tool events when exposed,
  actions, errors, timing, and references to artifacts the treatment produced
- **AND** it SHALL carry a `schema_version`

#### Scenario: A treatment trajectory artifact is immutable once written

- **WHEN** an experiment is resumed or re-run over a directory that already contains a treatment
  trajectory artifact for a cell
- **THEN** the existing artifact's bytes SHALL be unchanged

#### Scenario: Artifact collection never fails the cell

- **WHEN** collecting or writing a treatment trajectory artifact raises an error
- **THEN** the error SHALL be recorded
- **AND** the cell's `result_class` SHALL be the same as it would be without collection

---

### Requirement: Deterministic graders and the optional model judge SHALL emit separate verifier evidence artifacts

Each deterministic grader and the optional model judge SHALL be able to emit its own verifier
evidence artifact for a cell, carrying the inputs it consumed, the checks or evidence it consulted,
the grader or judge identity and version, intermediate structured decisions when available, and the
final result. A verifier evidence artifact SHALL be independently addressable from the cell's
treatment trajectory artifact and from other verifiers' artifacts, so that inspecting one side of a
disagreement never resolves to another side's content. A verifier evidence artifact SHALL carry a
`schema_version` and SHALL be immutable once written.

#### Scenario: A deterministic grader emits a verifier evidence artifact

- **WHEN** a deterministic grader grades a cell
- **THEN** it MAY write a verifier evidence artifact carrying its inputs, the checks/evidence
  consulted, its grader identity and version, intermediate structured decisions when available, and
  its final result

#### Scenario: A model judge emits its own verifier evidence artifact

- **WHEN** the optional model judge scores a cell
- **THEN** its verifier evidence artifact SHALL be a separate artifact from any deterministic
  grader's artifact and from the treatment trajectory artifact

#### Scenario: Both sides of a disagreement are independently addressable

- **WHEN** a cell has both a treatment trajectory artifact and a verifier evidence artifact
- **THEN** each SHALL be resolvable by its own reference
- **AND** neither reference SHALL resolve to the other's content

---

### Requirement: Result, grade, judge, and disagreement records SHALL reference artifacts by descriptor rather than embedding them

Referencing records SHALL point to their treatment and verifier artifacts by an artifact descriptor
rather than embedding the trajectory content: this applies to `runs.jsonl` cell records,
`grades.jsonl` grade records, judge records, and disagreement records. Each descriptor SHALL carry a repo-relative `path`, a
`content_hash` over the artifact's bytes, a `schema_version`, a `byte_count`, and a
`truncation_status`. The `content_hash` SHALL verify against the referenced file's bytes. The
referencing records SHALL remain compact append-only lines and SHALL NOT embed the full trajectory.

#### Scenario: A cell record references its treatment artifact by descriptor

- **WHEN** a `runs.jsonl` cell record has a treatment trajectory artifact
- **THEN** the record SHALL carry a descriptor with `path`, `content_hash`, `schema_version`,
  `byte_count`, and `truncation_status`
- **AND** the record SHALL NOT embed the trajectory content inline

#### Scenario: Grade, judge, and disagreement records reference verifier artifacts by descriptor

- **WHEN** a `grades.jsonl` record, a judge record, or a disagreement record has a verifier evidence
  artifact
- **THEN** the record SHALL carry a verifier-artifact descriptor with `path`, `content_hash`,
  `schema_version`, `byte_count`, and `truncation_status`

#### Scenario: A descriptor hash verifies against the artifact bytes

- **WHEN** a descriptor's `content_hash` is recomputed over the referenced artifact file's bytes
- **THEN** it SHALL equal the descriptor's recorded `content_hash`

---

### Requirement: Trajectory collection SHALL be best-effort and capability-aware

Trajectory collection SHALL adapt to what each harness exposes. A telemetry channel the treatment
does not expose — for example structured tool-call events from a CLI harness that only emits text —
SHALL be recorded as explicitly `unavailable` with a reason. An unavailable channel SHALL NOT be
represented as an empty but successful channel. Both CLI harness treatments and API endpoint
treatments SHALL be supported, each recording the channels it can and cannot provide.

#### Scenario: Unavailable tool telemetry is marked unavailable, not empty-successful

- **WHEN** a treatment's harness does not expose structured tool-call events
- **THEN** the tool-events channel of its trajectory artifact SHALL be marked `unavailable` with a
  reason
- **AND** it SHALL NOT be recorded as an empty list of successfully-captured tool events

#### Scenario: CLI and API treatments both produce trajectory artifacts

- **WHEN** a cell runs under a CLI harness treatment, and another cell runs under an API endpoint
  treatment
- **THEN** each SHALL produce a treatment trajectory artifact recording the channels it can provide
  and marking as `unavailable` the channels it cannot

---

### Requirement: Every artifact SHALL be secret-redacted and injection-sanitized before persistence

Before a treatment or verifier artifact is written, the engine SHALL apply the same value-redaction
and write-time injection denylist used for run-dir artifacts to the artifact's captured text.
Secret env assignments and API keys SHALL be replaced with the redaction placeholder, and
injection-pattern spans SHALL be replaced with the injection placeholder, before the bytes are
persisted. A raw secret value SHALL NOT appear in a persisted artifact, and the redaction SHALL be
applied to string fields before serialization so that JSON escaping cannot let a secret survive.

#### Scenario: A secret in captured trajectory text is redacted before write

- **WHEN** captured trajectory text contains a secret env assignment such as
  `OPENAI_API_KEY="<value>"`
- **THEN** the persisted artifact SHALL contain the redaction placeholder in place of the value
- **AND** the raw secret value SHALL NOT appear in the persisted artifact

#### Scenario: An injection role-marker in captured trajectory text is sanitized

- **WHEN** captured trajectory text contains an injection-pattern span such as "ignore previous
  instructions"
- **THEN** the matching span SHALL be replaced with the injection placeholder in the persisted
  artifact
- **AND** the artifact SHALL still be written, not dropped

---

### Requirement: Artifacts SHALL be bounded by configurable ceilings using deterministic head/tail retention

Treatment and verifier artifacts SHALL respect configurable byte and event ceilings. When captured
content exceeds a ceiling, the engine SHALL retain a deterministic head and tail of the content and
drop the middle, SHALL record exactly what was dropped as a dropped-event count and dropped-byte
count, and SHALL set the artifact's and descriptor's `truncation_status` to indicate truncation
occurred. Truncation SHALL be deterministic: bounding the same input twice SHALL produce
byte-identical output. Raw chain-of-thought SHALL neither be requested from nor required of a
harness; structured messages, tool events, outputs, evidence, and verdict data SHALL be sufficient
for a complete artifact.

#### Scenario: Over-ceiling content is head/tail truncated with drop accounting

- **WHEN** a captured artifact's content exceeds the configured byte or event ceiling
- **THEN** the artifact SHALL retain a deterministic head and tail and drop the middle
- **AND** it SHALL record the dropped event count and dropped byte count
- **AND** its `truncation_status` SHALL indicate truncation occurred

#### Scenario: Truncation is deterministic

- **WHEN** the same over-ceiling input is bounded twice with the same ceilings
- **THEN** the two persisted artifacts SHALL be byte-identical

#### Scenario: A within-ceiling artifact is untruncated

- **WHEN** captured content is within both ceilings
- **THEN** the artifact SHALL contain the full captured content
- **AND** its `truncation_status` SHALL indicate no truncation

#### Scenario: No chain-of-thought is required for a complete artifact

- **WHEN** a treatment exposes only structured messages, tool events, and outputs and no raw
  chain-of-thought
- **THEN** its treatment trajectory artifact SHALL still be considered complete

---

### Requirement: Verifier-only material SHALL NOT leak into treatment trajectories or the treatment-visible filesystem

Verifier-only material SHALL NOT appear in a treatment trajectory artifact and SHALL NOT reach the
treatment-visible filesystem during cell execution — this covers hidden checks, golden answers,
seeded-defect ground truth, and any other verifier-only material. Verifier-only material SHALL appear only in verifier evidence
artifacts. This SHALL hold even when the treatment trajectory captures stage output that references
check execution.

#### Scenario: Hidden material is absent from the treatment trajectory

- **WHEN** a cell is graded with hidden checks, seeded defects, and golden answers
- **THEN** none of the hidden check bodies, seeded-defect ground truth, or golden answers SHALL
  appear in the cell's treatment trajectory artifact

#### Scenario: Hidden material never reaches the treatment-visible filesystem

- **WHEN** a treatment executes in its isolated worktree
- **THEN** no verifier-only material SHALL be present on any treatment-visible filesystem path

#### Scenario: Verifier-only material appears only in verifier artifacts

- **WHEN** a verifier consults hidden checks or seeded-defect ground truth
- **THEN** that material MAY appear in the verifier's evidence artifact
- **AND** SHALL NOT appear in the treatment trajectory artifact

---

### Requirement: Artifacts SHALL be content-addressed and resume SHALL NOT rewrite an existing artifact

Trajectory artifacts SHALL be content-addressed by a hash of their bytes. A resumed run SHALL NOT
rewrite an existing trajectory artifact. A duplicate collection whose content matches an existing
content-addressed artifact SHALL resolve to that existing artifact. A duplicate collection whose
content differs from an artifact already stored at the same address SHALL be surfaced visibly rather
than silently overwriting the existing artifact. Artifact writes SHALL be non-fatal, consistent with
the run-artifact write convention.

#### Scenario: Resume does not rewrite an existing artifact

- **WHEN** an experiment is resumed and a cell's trajectory artifact already exists
- **THEN** the existing artifact SHALL NOT be rewritten
- **AND** no duplicate artifact with different bytes SHALL be created for the same content

#### Scenario: Duplicate identical content resolves to the existing artifact

- **WHEN** collection re-produces content identical to an already-stored content-addressed artifact
- **THEN** the reference SHALL resolve to the existing artifact
- **AND** no new artifact file SHALL be written

#### Scenario: A content collision is surfaced, not overwritten

- **WHEN** collection produces content that differs from an artifact already stored at the same
  content address
- **THEN** the conflict SHALL be surfaced
- **AND** the existing artifact SHALL NOT be overwritten

#### Scenario: An artifact write failure is non-fatal

- **WHEN** writing an artifact throws an I/O error
- **THEN** the engine SHALL record the failure and continue
- **AND** the failure SHALL NOT propagate to abort the experiment or grading pass

---

### Requirement: Trajectory artifact collection SHALL be exercised deterministically without live model calls

The trajectory-artifact behavior SHALL be exercised by checked-in synthetic fixtures and recorded
cell and grade records, covering CLI and API treatments, unavailable tool telemetry, judge
disagreement, hidden-material non-leakage, secret redaction, injection sanitization, deterministic
truncation, resume idempotency, and artifact hash verification. These tests SHALL make no live model
call, no network request, no real git operation, and no subprocess spawn.

#### Scenario: The suite runs offline

- **WHEN** the trajectory-artifact test suite runs in continuous integration
- **THEN** it SHALL exercise collection, sanitization, truncation, unavailability, hidden-material
  non-leakage, resume, and hash verification
- **AND** it SHALL make no live model call, network request, real git operation, or subprocess spawn

#### Scenario: Hash verification is tested

- **WHEN** a test recomputes a descriptor's `content_hash` over its referenced artifact's bytes
- **THEN** the recomputed hash SHALL equal the recorded `content_hash`
