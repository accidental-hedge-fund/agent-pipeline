## Why

Today an operator's corrective touches on a run — an accepted `--override`, an `unblock`
answer, a successful auto-recovery, a rejected finding, a durably-landed fix-round repair —
are scattered across separate event shapes (`human_intervention`, `blocker_cleared`,
`review_verdict`, override records, fix-retry events). The system can *see* that a human or
the pipeline touched the run, but it cannot answer the learning-loop question that milestone
v1.25.0 depends on: **what expert correction changed this run, and is that correction
reusable?** There is no single, stable, machine-readable contract that names the accepted
correction, ties it to its originating evidence, keys it for deterministic recurrence
matching, and records whether it could become a reusable control.

This change adds that evidence layer — a first-class, append-only `correction_event` ledger.
It records only *observable* accepted corrections. It does **not** infer private reasoning,
implement any control, cluster or score corrections, or grant any new merge/deploy/override
authority. It is the foundation the correction compiler and effectiveness metrics build on.

## What Changes

- Add a new `correction_event` record type to the run's append-only event stream, emitted
  through the existing `appendEvent` chokepoint (`run-store.ts`) so it inherits
  `--json-events` streaming, byte-identical event-sink delivery, and `summary.json`
  accumulation — the delivery guarantees `emitHumanIntervention` currently bypasses.
- Define the bounded contract: stable `correction_id` (replay/dedup key), deterministic
  `correction_key` (recurrence key), `schema_version`, `at`, `issue`/`repo`, `run_id`,
  `stage`, `reviewed_sha`/`head_sha` when applicable, a closed `source_kind`
  (`override`, `rejection`, `retry`, `repair`, `unblock`, `manual`), a closed `failure_class`
  (with an `other` escape hatch), `actor_kind` (`human` | `pipeline`), an `evidence_ref`
  lineage pointer, the observable `correction` disposition text, `reusable`
  (`yes` | `no` | `unknown`), and an optional bounded `proposed_control`.
- Emit exactly one `correction_event` from each Pipeline-owned corrective surface —
  override, unblock, retry/recovery, rejection, repair — **only after** the action is durably
  accepted; failed or no-op commands emit none, and a bare blocker / finding / retry *attempt*
  is never emitted as a correction (the event represents an accepted action, not a detection).
- Add a narrow, read-mostly `pipeline correction record` CLI sub-command that records an
  external/manual correction against an *existing* run with explicit required fields. It
  cannot advance, unblock, override, merge, deploy, or mutate code — enforced by its
  command-registry entry (`mutatesGitHub: false`, not wired to any of those handlers) and by
  the fact that its only side effect is appending one sanitized `correction_event`.
- Derive `correction_key` deterministically from bounded fields only
  (`source_kind` + `failure_class` + `stage`) — never from raw free text, issue number, PR
  number, SHA, or a model-generated paraphrase — so recurrence matching is stable.
- Screen the free-text `correction` and `evidence_ref` fields through the existing write-time
  injection denylist + secret redaction before serialization; all fields are additive so
  `schema_version` stays `1`.

## Capabilities

### New Capabilities

- `correction-event-ledger`: The `correction_event` contract — its field set, the bounded
  `source_kind` / `failure_class` / `actor_kind` / `reusable` / `proposed_control` enums, the
  deterministic `correction_key` derivation and stable `correction_id`, the evidence-lineage
  and reviewed/head-SHA staleness fields, the emit-only-on-durable-acceptance discipline (and
  the disposition-not-detection rule), replay/idempotency by `correction_id`, and the
  visible-failure handling of malformed/older records in reports.
- `correction-record-command`: The narrow `pipeline correction record` CLI — its explicit
  required fields, its record-against-an-existing-run behavior, and its hard authority
  boundary (no advance/unblock/override/merge/deploy/code-mutation).

### Modified Capabilities

- `events-jsonl-streaming`: Add `correction_event` as a recognized additive event type on the
  append-only stream (base fields + the contract), streamed under `--json-events` like every
  other event; readers must preserve it and stage-timeline filters must exclude it.
- `configurable-event-sink`: Add `correction_event` to the enumerated set of `appendEvent`
  producers delivered to a configured sink byte-identically to the local `events.jsonl` line.
- `command-registry`: Add a `correction` command entry so dispatch routing and allowlist-based
  flag validation cover it, with metadata declaring it non-mutating (`mutatesGitHub: false`).

## Impact

- `core/scripts/run-store.ts` — new `CorrectionEvent` interface added to the `RunEvent` union;
  a `finalizeRun` filter branch so `correction_event` survives into `summary.json` under
  exclusive sink mode; a `deriveCorrectionKey` / `deriveCorrectionId` helper (bounded-field
  hashing, reusing the `sha1(...).slice(...)` pattern from `review-policy.ts`).
- `core/scripts/correction.ts` (new) — the emitter helper `emitCorrectionEvent(runDir, payload,
  deps)` that builds, sanitizes, and appends the event via `appendEvent`; the bounded enums.
- `core/scripts/stages/*.ts`, `pipeline-run.ts`, `review-routing.ts`, `auto_recover`/fix path —
  one emit call at each durable-acceptance point (override applied, unblock posted + label
  cleared, recovery succeeded, finding rejected, repair commit landed + gate cleared).
- `core/scripts/command-registry.ts` + `pipeline.ts` — register + dispatch `correction record`.
- `core/scripts/types.ts` — the contract types; `evidence_ref` shape.
- `core/test/` — tests per source kind, failed/no-op no-emit, redaction, deterministic key,
  stale-SHA lineage, sink byte-identity, and replay/idempotency.
- `plugin/` mirror regenerated. No state-machine edge, review verdict schema, or blocking /
  routing decision reads the ledger — it is a write-only evidence supplement.

## Acceptance Criteria

Observable, falsifiable outcomes that make #499 done:

- [ ] A durably-accepted Pipeline-owned **override** appends exactly one `correction_event`
      with `source_kind: "override"`, `actor_kind: "human"`, and an `evidence_ref` pointing at
      the overridden finding's `key`; a failed or no-op override command appends none.
- [ ] A successful **unblock** (answer posted **and** blocked label cleared) appends one
      `correction_event` with `source_kind: "unblock"`, `actor_kind: "human"`; an unblock that
      fails to clear the label appends none.
- [ ] A successful **retry/recovery** appends one `correction_event` with `source_kind:
      "retry"`, `actor_kind: "pipeline"`, emitted only after recovery durably succeeds — a bare
      retry attempt that does not recover appends none.
- [ ] A **rejection** disposition (a finding accepted as invalid) appends one `correction_event`
      with `source_kind: "rejection"`; a **repair** whose fix commit lands and whose targeted
      blocker/finding is cleared on re-check appends one with `source_kind: "repair"`,
      `actor_kind: "pipeline"` — a fix *attempt* that does not resolve its target appends none.
- [ ] `pipeline correction record` appends exactly one `correction_event` with `actor_kind:
      "human"` against an existing run when all required fields are supplied; it exits non-zero
      and appends nothing when a required field is missing or the run cannot be located; and it
      never advances, unblocks, overrides, merges, deploys, or writes any code/GitHub state.
- [ ] `correction_key` is a pure deterministic function of `source_kind` + `failure_class` +
      `stage`: a unit test proves two corrections with those three fields equal share a
      `correction_key`, and that changing the issue number, PR number, SHA, or free-text
      `correction` does **not** change the key.
- [ ] Every `correction_event` carries `evidence_ref` (originating finding key / blocker /
      event / comment / artifact) and, when applicable, `reviewed_sha` and `head_sha`, so a
      consumer can distinguish a stale correction (reviewed_sha ≠ current head) from a current
      one with no GitHub access.
- [ ] A bare `blocker_set`, a review finding, or a retry attempt does **not** produce a
      `correction_event`; the ledger only records accepted actions/dispositions (a test asserts
      no event is emitted at those detection points).
- [ ] With an active event sink, the `correction_event` line delivered to the sink is
      byte-identical to the line written to the local `events.jsonl`, already screened by the
      injection denylist and secret redaction; `schema_version` remains `1`.
- [ ] Duplicate delivery/replay of the same `correction_id` is idempotent for downstream
      consumers: the emitter produces a stable `correction_id` for the same correction, and a
      test confirms a consumer deduping by `correction_id` collapses replays to one.
- [ ] Existing run artifacts remain readable — an older run with no `correction_event` reads
      normally — and a malformed or unknown-`schema_version` `correction_event` is surfaced as
      a visible error in a report/consumer without aborting the run or the reader.
- [ ] `correction` / `evidence_ref` free text is screened before serialization: a `correction`
      containing an injection span persists `[REDACTED-INJECTION]`; one containing a secret
      assignment persists `[REDACTED]`; the record is still written.
- [ ] Tests cover each source kind, failed/no-op actions, redaction, deterministic-key
      generation, stale-SHA lineage, sink byte-identity, and replay/idempotency; `npm run ci`
      is green and the `plugin/` mirror is regenerated and committed.
