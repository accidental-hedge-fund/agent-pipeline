## Context

`#432` (`stage-eval-runner`) runs each eval cell in an isolated worktree and appends one compact
`CellRecord` to `runs.jsonl` / `failures.jsonl`, carrying identity keys, a `result_class`, and stage
summaries. `#433` (`eval-graders` + `eval-comparative-reporting`) adds a separate, additive grading
pass that reads those records and writes `grades.jsonl` plus optional judge and disagreement records
and a deterministic `summary.json`. Both layers are deliberately compact indexes: they say *what
happened* and *how good it was*, but not *what the treatment actually did* or *what the verifier
actually looked at*.

That gap is the diagnosis gap. When a cell scores surprisingly, the maintainer must inspect the
concrete execution — and, symmetrically, the concrete verifier run — to tell an agent defect
(reward-hacking, fake completion, irrelevant evidence, tool misuse) from a task/environment/grader/
judge defect. This change persists that evidence as bounded, sanitized, immutable, content-addressed
per-cell artifacts referenced by descriptor from the existing streams.

## Goals / Non-Goals

Goals:
- Diagnosability: from any cell record, resolve to exactly what the treatment did and, separately,
  what each verifier consulted.
- Compact streams: `runs.jsonl` / `grades.jsonl` stay small; heavy detail lives in referenced files.
- Safety: no secret, no injection payload, and no verifier-only material ever lands in a persisted
  treatment artifact or on a treatment-visible path.
- Additivity and determinism: artifacts are immutable and content-addressed; resume and re-run never
  rewrite them; truncation is deterministic.

Non-Goals:
- Storing raw provider chain-of-thought (never requested, never required).
- A tracing backend or UI.
- Letting any trajectory or judge content move a deterministic grade.
- Capturing production runs beyond what the run store already supports.

## Decisions

### 1. Artifacts are content-addressed files referenced by descriptor; streams stay compact

Each artifact is written as a standalone file under the experiment output directory, addressed by a
hash of its sanitized bytes. The referencing record (`runs.jsonl`, `grades.jsonl`, judge,
disagreement) carries only an `ArtifactDescriptor` `{ path, content_hash, schema_version, byte_count,
truncation_status }`.

Rationale: this preserves the append-only, resume-safe contract of the runner and grader streams —
a line is written once and never rewritten — while keeping large trajectories out of the streams
(one of the issue's explicit out-of-scope items). Content addressing makes resume idempotent for
free: re-collecting identical content lands on the same address and rewrites nothing; a *differing*
body at the same address is a real anomaly and is surfaced rather than silently overwritten.

Rejected: embedding trajectories inline in `runs.jsonl`. It bloats the index, defeats streaming
parse, and would make an already-written line's meaning depend on trajectory size.

### 2. Treatment and verifier evidence are separate, independently addressable artifacts

A cell yields (a) one treatment trajectory artifact and (b) one verifier evidence artifact per
verifier (each deterministic grader, and the optional judge). They are distinct files with distinct
descriptors.

Rationale: the source insight is that refining an eval means inspecting *both* the agent and the
verifier trajectory — and specifically that a disagreement needs both sides visible without
conflation. Separate artifacts also let verifier-only material (hidden checks, ground truth) live in
the verifier artifact where it belongs, while the treatment artifact is provably free of it. If the
two were one artifact, either the treatment side would leak ground truth or the verifier side would
be censored of its own inputs.

### 3. Capability-aware, best-effort collection; `unavailable` ≠ empty

Harnesses differ: an API endpoint treatment may expose structured tool-call events while a CLI
harness emits only text. Each trajectory records per-channel availability. A channel the harness does
not expose is marked `unavailable` with a reason.

Rationale: silently writing an empty tool-events list for a CLI harness would later read as "the
agent made no tool calls" — a false negative that corrupts exactly the diagnosis this feature exists
to support. Distinguishing *unavailable* from *empty* is the difference between honest and misleading
evidence. Collection is best-effort: it never changes a cell's `result_class`, because a telemetry
failure is not a treatment outcome (consistent with the runner's `result_class` discipline).

### 4. Sanitize, then bound, then hash — in that order

The pipeline for each artifact is: apply field-level value-redaction + write-time injection denylist
(reusing the `run-artifact-conventions` helpers) → apply deterministic head/tail bounding against
configurable byte/event ceilings, recording dropped counts and `truncation_status` → hash the
resulting bytes to derive the content address and descriptor.

Rationale: redaction must run before serialization/hashing so a secret can never be persisted, even
transiently, and so the content address is computed over the *safe* bytes. Bounding before hashing
makes the truncated artifact the addressed object, so re-collection of the same over-ceiling input is
byte-identical and resolves to the same address. Head/tail retention keeps the most diagnostic parts
(opening actions and final outcome/error) while dropping the bulky middle, and recording the dropped
counts keeps truncation visible rather than a silent lie of completeness.

### 5. Hidden-material containment reuses the fixture-contract exclusion boundary

Verifier-only material is already excluded from what the treatment sees (hidden checks are kept out
of treatment inputs by the fixture contract). This change extends the same boundary to *capture*: the
treatment trajectory collector only reads treatment-visible channels, so it structurally cannot
capture material the treatment never saw. Verifier artifacts are the only place ground truth appears.

### 6. Reporting linking is opt-in and non-mutating

Comparative reporting stays byte-identical by default. An opt-in flag adds artifact references for
flagged cells (outliers, disagreements, false positives/negatives, failed cells) as additive fields;
it changes no aggregate, interval, or grouping, and repeated summarization stays byte-identical.

Rationale: the summary's determinism and stability are load-bearing (`eval-comparative-reporting`),
so linking must be purely additive and gated. Flagging is derived deterministically from grades/
judge records already in hand, so no new computation influences the numbers.

## Risks / Trade-offs

- **Storage growth**: per-cell artifacts add bytes. Mitigated by ceilings, head/tail truncation, and
  content addressing (identical replicate content de-duplicates to one file).
- **Capture fidelity varies by harness**: some channels will often be `unavailable`. This is
  disclosed, not hidden — an honest partial trajectory beats a fabricated complete one.
- **Redaction over-redaction**: aggressive denylist matches could scrub legitimate trajectory text.
  Accepted: the existing run-artifact denylist is the single source of truth; this change does not
  loosen it for eval artifacts.

## Migration / Compatibility

All new artifacts and descriptor fields are additive and optional; absence is valid (a cell without
a trajectory simply has no descriptor). Per `run-artifact-conventions`, adding optional fields does
not bump consuming record `schema_version`s. Existing experiment directories remain readable; the
grading and reporting passes stay additive and never rewrite runner output.
