## Context

Runs already emit stage lifecycle events, `stage_accounting` (duration, cost_source actual|estimated|unknown), review verdicts, fix rounds, and `correction_event` records into `events.jsonl`. Planning produces artifacts that may declare assumptions, open questions, and risk-related context; pre-code attestation already uses closed risk-class vocabularies. Production outcomes (#576) live in a host-local `.agent-pipeline/outcomes/` store with attribution to runs, commits, PRs, issues, and components.

What is missing is a **first-class, versioned join** of: (1) which planning depth and risk class a run used, (2) how long each delivery phase took (elapsed vs known active effort), (3) which assumptions remained unresolved into later phases, and (4) how much **material** correction effort followed — linked to #576 outcomes without inventing causation.

See proposal.md for motivation and acceptance criteria.

## Goals / Non-Goals

**Goals:**

- Versioned additive telemetry that survives schema evolution and reader unknown-field tolerance.
- Explicit phase boundaries with timestamps; elapsed vs active-effort distinction.
- Stable assumption lineage across stages.
- Operational material-rework definition with testable positive/negative cases.
- Join keys compatible with run store and #576 attribution.
- Reporting that never presents unavailable effort as zero cost or zero duration without labeling.
- Privacy-safe host-local default consistent with fleet-data-governance principles.

**Non-Goals:**

- Auto-selecting or changing planning depth based on metrics.
- Productivity scores, expected-pain scores, or causal impact claims.
- Replacing `stage_accounting` or #576 outcome records (compose with them).
- New fleet collector or third-party shipping requirement for v1.
- Changing review rigor, merge authority, or advance→R2D stop behavior.

## Decisions

### D1 — Additive event types + optional per-run summary snapshot

**Decision:** Emit planning-leverage observations primarily as **additive `events.jsonl` event types** through the existing `appendEvent` path (same denylist/redaction and sink delivery as other events). Optionally materialize a **per-run summary snapshot** (`planning_leverage.json` or a `summary.json` section) at phase close / run complete for cheap scoreboard scans.

Event types (names fixed in specs):

| type | role |
| --- | --- |
| `planning_leverage_phase` | Phase boundary open/close with timestamps and depth/risk context |
| `assumption_lineage` | Create/update of an assumption or open question |
| `material_rework` | Material rework classification for a fix round or correction span |
| `planning_leverage_snapshot` | Optional rolled-up observed + derived metrics at a checkpoint |

Base event fields remain `schema_version: 1`, `type`, `at` (additive types do not bump the stream schema version, matching `correction_event` / `stage_accounting` practice). Nested payload fields carry their own `record_schema_version` integer starting at `1` for the planning-leverage family.

**Rationale:** Matches existing observability pattern; late readers can reconstruct from the event stream; summary is convenience not sole source of truth.

**Alternatives:** Only host-local side store like outcomes — rejected for v1 primary path (phases happen during the run; events already stream). Only summary mutation — rejected (loses timeline and mid-run carry-forward).

### D2 — Phase model is a closed enum of delivery phases

**Decision:** `phase` is exactly one of:

| phase | Meaning |
| --- | --- |
| `alignment` | Alignment / specification before or during formal planning |
| `planning` | Planning / OpenSpec / plan-review / plan-revision work |
| `implementation` | Implementing stage work producing the candidate |
| `review` | Code/review layer (including re-review) |
| `correction` | Fix rounds and material correction after review findings |

A phase event carries `boundary` (`start` | `end`), `started_at` / `ended_at` when known, `elapsed_ms` when both ends known, and optional `active_effort` (see D3). Multiple non-overlapping or nested intervals for the same phase across a run are allowed (e.g. review → correction → review); each interval has its own `phase_instance_id`.

**Rationale:** Matches issue phase list; closed enum enables aggregation.

### D3 — Elapsed vs active effort vs cost, with explicit unknown

**Decision:**

1. **Elapsed:** derived only from explicit timestamps (`ended_at - started_at` → `elapsed_ms`). If either timestamp is missing, `elapsed_ms` is null and `elapsed_availability` is `unavailable`.
2. **Active effort:** optional object `{ value_ms, source, availability }` where `source` is `harness_accounted` | `operator_reported` | `derived` | `unknown`, and `availability` is `observed` | `inferred` | `unavailable`. Missing active effort MUST use `availability: "unavailable"` and null value — **never** default to elapsed or zero.
3. **Cost:** reuse stage-accounting semantics when available (`cost_source` actual|estimated|unknown, `cost_usd` null when unknown). Planning-leverage records MAY reference or sum known stage_accounting rows by stage, but SHALL NOT invent USD when unknown.
4. **Derived metrics** (e.g. `correction_elapsed_over_planning_elapsed`) live only in snapshot/report objects under a `derived` namespace and each carries `inputs` + `availability`. Raw observations never overwrite derived fields.

**Rationale:** Issue requires documenting unknown correction effort and separating raw from derived.

### D4 — Planning depth and risk class are closed, selected-for-run fields

**Decision:**

- `planning_depth` is exactly one of: `minimal` | `standard` | `deep` | `unknown`.
  - Mapping from existing engine behavior is implementation detail, but emitters MUST record the depth that was **actually selected for the run** (config/policy/human choice), not a post-hoc judgment of plan quality.
  - When the engine cannot determine depth, use `unknown` rather than guessing `standard`.
- `risk_class` is a string from a closed built-in set reused from pre-code / design-gate risk classes where applicable, plus `unknown` and optional multi-value `risk_classes[]` when multiple apply. Prefer the same vocabulary already used for attestation triggers so joins are stable.

**Rationale:** Future progressive-planning policy needs the selected depth as an independent variable; inventing depth defeats the measurement purpose.

**Alternatives:** Free-text depth — rejected (metrics need closed set). Infer depth from plan file length — rejected as inferred-only; may later appear under `derived` with `availability: inferred`, never as the selected field.

### D5 — Assumption lineage with stable ids and resolution status

**Decision:** Each assumption or open question is a record with:

- `assumption_id` — stable string, unique within run (UUID or deterministic hash of first statement + ordinal)
- `kind` — `assumption` | `open_question`
- `statement` — bounded, redacted free text
- `introduced_phase` — phase enum when first recorded
- `status` — `open` | `resolved` | `invalidated` | `deferred` | `unknown`
- `status_updated_at` — ISO timestamp of last status change
- `resolution` — optional bounded redacted note + `resolved_in_phase`
- `evidence_refs` — optional bounded refs (finding keys, artifact paths, comment ids) without secrets

Updates append a new `assumption_lineage` event with the same `assumption_id` and new status; consumers take last-write-per-id for current state and retain full history from the stream.

**Rationale:** Issue requires identities and resolution status across planning → implementation → review.

### D6 — Material rework is operationally stricter than “any fix”

**Decision:** A correction span or fix round is **material rework** only when at least one of the following holds (closed criteria, OR):

1. **Scope expansion:** net new production paths/modules beyond the original plan/scope boundary (documented component or path-prefix growth), not formatting-only or test-only churn unless tests redefine product contract.
2. **Design/interface change:** public API, schema, wire format, or persisted data model change introduced in fix rounds after initial review of the candidate.
3. **Re-plan or re-open assumptions:** planning artifacts revised, or previously resolved assumptions reopened, in response to review/fix.
4. **Multi-round severity:** two or more fix rounds addressing blocking findings of severity at or above the active review `block_threshold`, or a single round classified by the engine as `architecture` / `correctness` material class when such classification is recorded.

Otherwise the work is **ordinary review edit** (`materiality: "ordinary"`). Classification fields:

- `materiality` — `material` | `ordinary` | `unknown`
- `material_criteria` — array of matched criterion codes (`scope_expansion`, `design_interface_change`, `replan_or_assumption_reopen`, `multi_round_blocking`) or empty when ordinary/unknown
- `fix_round` — integer or null
- `review_effort` — structured counts (findings_blocking, findings_advisory, re_review_count) with availability labels

Every review edit is **not** material by default; when evidence is insufficient, use `materiality: "unknown"`, not `material`.

**Rationale:** Issue explicitly forbids treating every review edit as equivalent material rework.

### D7 — Linkage reuses #576 attribution patterns

**Decision:** Planning-leverage records carry an `attribution` array (same target types as outcome-linkage: `run`, `commit`, `pr`, `issue`, `component`) with `method`, `authority` (`observed`|`inferred`), optional `confidence`. Additionally allow `target_type: "production_outcome"` with `target_id` = outcome_id when a join to #576 is known.

Emitters MUST set run attribution from the active run store identity as `authority: observed`. They MUST NOT invent production_outcome ids; joins to outcomes are typically report-time or late-binding.

**Rationale:** Clean join to #576 without coupling run finalization to delayed production signals.

### D8 — Privacy, retention, customer-hosted

**Decision:**

- Default: host-local under run directory / `.agent-pipeline/` (same trust boundary as runs and outcomes).
- Free text (assumption statements, resolution notes) passes injection denylist + secret redaction; no raw prompts, model transcripts, source dumps, or env secrets.
- Retention: follow run-store / configurable evidence retention; scoreboard windows honor the same window parameters as other sections; expired data excluded from default reports.
- Customer-hosted installs operate without a fleet collector; fleet export if later enabled reuses fleet envelope + governance (pseudonymous ids, no human identity).
- No personal human usernames/emails in telemetry (actor_kind only if needed, matching correction_event).

### D9 — Scoreboard section is additive and labeled

**Decision:** `pipeline scoreboard --json` gains a `planning_leverage` object:

- phase elapsed totals and counts by `planning_depth` / `risk_class`
- assumption open/resolved counts
- material vs ordinary rework counts and fix-round distributions
- partitions or labels for `observed` vs `derived` vs `unavailable` fields
- **no** `productivity_score`, `leverage_score`, or `expected_pain` field

Missing telemetry on older runs yields zeros + diagnostic `telemetry_absent`, not fabricated depths.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Wall-clock elapsed mistaken for active effort | Separate fields + availability enums; tests forbid defaulting active = elapsed |
| Over-labeling material rework | Closed criteria; default ordinary/unknown; negative test cases |
| Planning depth unknown for legacy configs | Explicit `unknown`; do not backfill `standard` |
| Event stream growth | Bounded free text; phase events only at boundaries; retention windows |
| Confusion with #576 follow_up_rework | Document: in-pipeline material rework vs post-delivery production rework; optional outcome join only |
| Dual summary vs events drift | Snapshot derived from events at checkpoint; tests compare reconstruction |

## Migration Plan

1. Land schema types + pure validators + unit tests (no emission behavior change).
2. Emit phase/assumption events from planning and stage boundaries behind existing run store paths.
3. Emit material_rework classification at fix-round completion.
4. Wire scoreboard section; document CLI/scoreboard fields.
5. Dogfood on agent-pipeline runs; confirm older runs report `telemetry_absent` without errors.
6. Rollback: stop emitting new types; older engines ignore unknown event types (existing reader tolerance); scoreboard section degrades to empty.

## Open Questions

- Exact on-disk name for optional per-run snapshot file vs embedding only in `summary.json` — choose at implement time without changing field semantics.
- Whether multi-value `risk_classes[]` needs a primary `risk_class` always present (default yes: primary + optional array).
- Mapping table from current config/plan-review effort knobs to `planning_depth` enum values — finalize against live config keys during implementation with tests locking the mapping.
