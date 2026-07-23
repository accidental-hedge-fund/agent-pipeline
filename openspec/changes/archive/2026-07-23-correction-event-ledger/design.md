## Context

Issue #499 asks for a first-class, append-only `correction_event` contract for *observable*
operator corrections and recovered failures, so recurring expert intervention can later be
compiled into reusable controls (milestone v1.25.0) instead of being rediscovered. The
evidence already exists transiently across the engine but under separate, un-joinable shapes:

- `human_intervention` (`intervention.ts`) fires at **exit/block/override points** — "a human
  is needed here" — not at the accepted-disposition point.
- `blocker_cleared`, override records, `review_verdict` findings, and `fix_harness_retry`
  each capture one facet, none of them keyed for recurrence or tagged with reusability.

None of these answers "what accepted correction changed the run, and is it reusable?" This
change adds the one contract that does, purely as an evidence layer.

## Decision 1 — a distinct event type, not an extension of `human_intervention`

`human_intervention` and `correction_event` are complementary, not redundant, and must stay
separate:

- `human_intervention` marks the **exit point** ("review non-converged; a human is needed").
- `correction_event` marks the **accepted disposition** ("the operator overrode finding
  `a1b2c3d4`; that correction is reusable as a `deterministic-gate`").

The issue is explicit that "a blocker, review finding, or retry attempt by itself is not
mislabeled as an expert correction; the event represents an accepted action/disposition." A
single override therefore legitimately produces *both*: a `human_intervention`
(`kind: "human-risk-override"`, at the exit) and — once the override is durably applied — a
`correction_event` (`source_kind: "override"`). Folding them together would either mislabel
detections as corrections or lose the exit-point taxonomy. So `correction_event` is a new type
in the `RunEvent` union with its own contract.

## Decision 2 — route through `appendEvent`, not the intervention direct-write path

`emitHumanIntervention` writes to `events.jsonl` **directly**, bypassing `appendEvent`, so it
does *not* get event-sink delivery or `summaryEvents` accumulation (`finalizeRun` re-reads the
file to recover intervention events). Acceptance criterion "reaches the configured event sink
byte-identically to the local append-only event record" is a hard requirement here, so
`emitCorrectionEvent` MUST go through `appendEvent` in `run-store.ts` — the single chokepoint
that already provides:

- byte-identical `eventSink` delivery of the exact serialized line (`event-sink.ts`),
- `--json-events` stdout streaming of the same line,
- `summaryEvents` accumulation so the event survives into `summary.json` even in exclusive
  sink mode.

This makes the sink guarantee fall out of the existing contract rather than being
re-implemented. `configurable-event-sink` is modified only to add `correction_event` to its
enumerated producer list.

## Decision 3 — the contract shape

```
{
  schema_version: 1,
  type: "correction_event",
  at:              <ISO 8601 UTC>,
  correction_id:   <string>,   // stable per-instance; the replay/dedup key
  correction_key:  <string>,   // deterministic per-class recurrence key (bounded fields only)
  source_kind:     "override" | "rejection" | "retry" | "repair" | "unblock" | "manual",
  failure_class:   <CorrectionFailureClass>,   // closed enum + "other" escape hatch
  actor_kind:      "human" | "pipeline",
  issue:           <integer>,
  repo:            <string "owner/name">,
  run_id:          <string>,
  stage:           <stage name string | null>,
  reviewed_sha:    <string | null>,   // SHA the corrected evidence was reviewed against
  head_sha:        <string | null>,   // current head SHA when the correction was recorded
  evidence_ref:    { kind: "finding" | "blocker" | "event" | "comment" | "artifact",
                     id: <string> },   // lineage to the originating evidence
  correction:      <string>,          // observable disposition applied (screened, bounded)
  reusable:        "yes" | "no" | "unknown",
  proposed_control?: "instruction" | "skill-rubric" | "eval" | "deterministic-gate" | "human-judgment"
}
```

`correction_id` and `correction_key` are deliberately distinct (Decision 4). `correction` is
the *observable* disposition — what was done, never inferred rationale or chain-of-thought
(out of scope). It is capped (like `outputExcerpt`, 500 chars) and screened. `evidence_ref.id`
carries the originating handle: a `findingKey` (8 hex) for a finding, a blocker kind/message
for a blocker, an event/comment id, or an artifact path.

## Decision 4 — `correction_id` vs `correction_key`

These answer different questions and are derived differently:

- **`correction_key`** identifies the *class* for recurrence matching. It is a pure
  deterministic hash of **bounded fields only**: `sha1(source_kind ␟ failure_class ␟ stage)`
  truncated to 8 hex. It deliberately excludes free text, issue number, PR number, SHA, and
  any model paraphrase, per the issue. Two overrides of a `review-finding` class in the
  `review` stage collide on `correction_key` → the compiler sees recurrence. A drift-guard
  test asserts that changing issue/PR/SHA/`correction` text does not move the key.
- **`correction_id`** identifies *this specific correction instance* and is the replay/dedup
  key. It must be unique per instance yet **reproducible on replay** (so a crash-and-re-emit
  collapses to one). It is derived deterministically from instance-identifying inputs:
  `sha1(run_id ␟ source_kind ␟ evidence_ref.kind ␟ evidence_ref.id ␟ reviewed_sha)` truncated
  to 16 hex. Downstream consumers dedup by `correction_id`; the record content (excluding the
  append-time `at`) is identical across replays, so idempotency holds.

Both reuse the `sha1(...).slice(...)` idiom already established by `findingKey` /
`findingPayloadFingerprint` in `review-policy.ts` — no new hashing convention is introduced.

## Decision 5 — the `failure_class` enum

A closed union with an `other` escape hatch, mirroring the `HumanInterventionKind` /
`"unknown"` forward-compat pattern:

- `review-finding` — a review finding was dispositioned (override/rejection/repair).
- `blocker` — a set blocker was answered/cleared (unblock).
- `harness-crash` — a harness crash or instability was recovered (retry).
- `test-build-failure` — the test/build gate failure was repaired.
- `eval-shipcheck-failure` — an eval or ship-check gate failure was repaired.
- `merge-conflict` — a pre-merge conflict or branch drift was repaired.
- `spec-defect` — a plan/spec defect was corrected.
- `env-tooling` — an environment / tooling / auth issue was corrected.
- `other` — escape hatch; consumers treat any unrecognized value as `other` for aggregation
  but preserve the raw string. Adding a member does not bump `schema_version`; removing or
  renaming one is breaking and requires a bump.

`source_kind` (how the correction was applied) and `failure_class` (what was wrong) are
orthogonal and both recorded — e.g. `source_kind: "override"` + `failure_class: "review-finding"`,
or `source_kind: "retry"` + `failure_class: "harness-crash"`.

## Decision 6 — actor kind maps to the surface

`actor_kind` is derived, not inferred: operator-driven surfaces (`override`, `unblock`,
`rejection`, `manual`) are `"human"`; autonomous-recovery surfaces (`retry`, `repair`) are
`"pipeline"`. This directly realizes the issue's "operator interventions **and** recovered
failures" framing without leaking any human identity — no username, no email, just the kind.

## Decision 7 — emit only on durable acceptance; the disposition-not-detection rule

Each Pipeline-owned surface emits **after** the action is durably accepted, at the point the
run actually changed:

| surface   | durable-acceptance trigger                                              | actor    |
|-----------|-------------------------------------------------------------------------|----------|
| override  | the override is applied to the finding and recorded                      | human    |
| unblock   | the answer is posted **and** the blocked label is cleared                | human    |
| rejection | the finding is dispositioned as invalid/not-a-defect                     | human    |
| retry     | an auto-recovery attempt durably succeeds                                | pipeline |
| repair    | a fix commit lands **and** the targeted blocker/finding clears on recheck| pipeline |

A failed or no-op command (override key that matches nothing, unblock that fails to clear the
label, a retry/fix attempt that does not resolve its target) emits **nothing**. A bare
`blocker_set`, a raw review finding, or a retry *attempt* is a detection, not a correction, and
never emits. Tests assert both the positive (one event on success) and negative (zero on
failure/no-op/detection) branches for each surface.

## Decision 8 — the `pipeline correction record` CLI and its authority boundary

A new `correction` command keyword with a required `record` action records an external/manual
correction against an existing run:

- **Required, explicit fields** (no inference): `--source-kind`, `--failure-class`, `--stage`,
  the run reference (`--issue` + `--run-id`, or resolved to the latest run for the issue),
  `--evidence-ref`, `--correction`, `--reusable`; optional `--proposed-control`. A missing
  required field → exit non-zero, append nothing. `actor_kind` is forced to `"human"`.
- **Hard authority boundary**: its `command-registry` entry declares `mutatesGitHub: false`,
  `needsGhAuth: false`, and dispatches to a handler whose only side effect is one
  `emitCorrectionEvent` (which appends via `appendEvent` + optional sink). It is not wired to
  the advance, unblock, override, merge, or deploy handlers, and the allowlist-based flag
  validation rejects any flag it does not declare. So it cannot advance, unblock, override,
  merge, deploy, or mutate code — enforced structurally, not just by convention.

The command locates the run's directory host-locally (like every other run-artifact reader);
recording a manual correction is done on the host that holds the run, consistent with the
`cross-host-concurrency-scope` disposition (this is host-local evidence, not a shared
irreversible artifact).

## Decision 9 — redaction, non-fatal, schema_version, and visible-failure reports

- **Redaction**: `correction` and `evidence_ref.id` are operator/model-authored free text, so
  they flow through the existing `sanitize(redactSecrets(...))` field-level path **before**
  serialization (an injection span → `[REDACTED-INJECTION]`, a secret → `[REDACTED]`), the same
  path every artifact record uses. The bounded enum fields need no screening.
- **Non-fatal**: the append stays inside `appendEvent`'s best-effort try/catch — a write or
  sink failure logs a warning and never aborts, blocks, or changes a stage outcome. No label,
  blocking, or routing decision reads the ledger.
- **schema_version**: every field is additive/optional-or-bounded, so `schema_version` stays
  `1`; older runs with no `correction_event` read normally (absent → treated as `0`).
- **Visible failure of malformed/old records**: a report/consumer that reads
  `correction_event`s validates `schema_version` and the required bounded fields; a malformed
  or unknown-`schema_version` record is surfaced as a visible error line in the report (not
  silently dropped) but does not crash the reader or the run — satisfying "malformed or older
  records fail visibly in reports without breaking the run."

## Risks / trade-offs

- **Double-recording an override** (both `human_intervention` and `correction_event`): accepted
  and intended — they are different lenses (exit-point vs. accepted-disposition) and are joined
  downstream by `evidence_ref` / finding key. Decision 1 documents why folding them is wrong.
- **Event-line growth**: `correction` text enlarges some lines. Bounded by the 500-char cap and
  screened; the raw disposition is what the compiler needs.
- **`correction_key` collisions across genuinely different corrections** that share
  `source_kind`+`failure_class`+`stage`: intended — that *is* the recurrence signal. Instance
  distinctness lives in `correction_id`, not `correction_key`.

## Out of scope (restated from the issue)

Clustering, issue creation, control implementation, effectiveness scoring; mining
chain-of-thought or inferring a human's rationale; any new merge/deploy/publish/override
authority. This change is the evidence layer only.
