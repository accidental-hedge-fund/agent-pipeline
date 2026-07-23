## 1. Contract types and enums

- [x] 1.1 Add a `correction.ts` module under `core/scripts/` defining the closed
      `CorrectionSourceKind` (`override`, `rejection`, `retry`, `repair`, `unblock`, `manual`),
      `CorrectionFailureClass` (`review-finding`, `blocker`, `harness-crash`,
      `test-build-failure`, `eval-shipcheck-failure`, `merge-conflict`, `spec-defect`,
      `env-tooling`, `other`), `CorrectionActorKind` (`human`, `pipeline`), `CorrectionReusable`
      (`yes`, `no`, `unknown`), and `CorrectionProposedControl` (`instruction`, `skill-rubric`,
      `eval`, `deterministic-gate`, `human-judgment`) string unions, each as `as const` arrays.
- [x] 1.2 Add the `CorrectionEvent` interface (base `schema_version`/`type`/`at` + the full
      contract from the spec) and an `EvidenceRef` type (`{ kind, id }`) to `types.ts` /
      `run-store.ts`; add `CorrectionEvent` to the `RunEvent` union in `run-store.ts`.

## 2. Deterministic key + id derivation

- [x] 2.1 In `correction.ts`, add `deriveCorrectionKey({ source_kind, failure_class, stage })`
      = `sha1(source_kind ␟ failure_class ␟ stage).slice(0, 8)`, reading **only** those bounded
      fields (never issue/PR/SHA/free text). Single source; do not reimplement elsewhere.
- [x] 2.2 Add `deriveCorrectionId({ run_id, source_kind, evidence_ref, reviewed_sha })` =
      `sha1(run_id ␟ source_kind ␟ evidence_ref.kind ␟ evidence_ref.id ␟ reviewed_sha).slice(0, 16)`
      — stable per instance, reproducible on replay.
- [x] 2.3 Derive `actor_kind` from `source_kind` (`override`/`rejection`/`unblock`/`manual` →
      `human`; `retry`/`repair` → `pipeline`) in a single mapping helper.

## 3. Emitter routed through appendEvent

- [x] 3.1 Add `emitCorrectionEvent(runDir, payload, deps)` in `correction.ts` that builds the
      full record, caps `correction` (500 chars), screens `correction` and `evidence_ref.id`
      via `sanitize(redactSecrets(...))` before serialization, and appends through
      `appendEvent` (run-store) — NOT a direct `appendFile` — so it inherits `--json-events`,
      byte-identical sink delivery, and `summaryEvents` accumulation. Non-fatal (its own/inner
      try-catch consistent with `appendEvent`).
- [x] 3.2 Add a `finalizeRun` filter branch so `correction_event` records survive into
      `summary.json` under exclusive sink mode (mirror the `human_intervention`/`stage_accounting`
      branches, both the `summaryEvents` and the re-read paths).

## 4. Pipeline-owned emission points (only on durable acceptance)

- [x] 4.1 **override**: at the point an override is durably applied to a finding
      (override path / `review-routing.ts`), emit `source_kind: "override"`,
      `failure_class: "review-finding"`, `evidence_ref` = `{ kind: "finding", id: findingKey }`.
- [x] 4.2 **unblock**: after the answer is posted AND the blocked label is cleared, emit
      `source_kind: "unblock"`, `failure_class: "blocker"`; emit nothing if the clear fails.
- [x] 4.3 **retry/recovery**: after an auto-recovery durably succeeds (`auto_recover` path),
      emit `source_kind: "retry"`, `actor_kind: "pipeline"`; nothing on a failed attempt.
- [x] 4.4 **rejection**: when a finding is dispositioned invalid/not-a-defect, emit
      `source_kind: "rejection"`, `failure_class: "review-finding"`.
- [x] 4.5 **repair**: after a fix commit lands AND the targeted blocker/finding clears on
      re-check (fix path), emit `source_kind: "repair"`, `actor_kind: "pipeline"`; nothing on a
      fix attempt that does not resolve its target.
- [x] 4.6 Confirm no emission fires at a bare `blocker_set`, a raw enumerated finding, or a
      mere retry attempt (detection ≠ correction).

## 5. `pipeline correction record` CLI

- [x] 5.1 Register a `correction` entry in `COMMAND_REGISTRY` (`command-registry.ts`) with
      `mutatesGitHub: false`, `needsGhAuth: false`, `needsIssueNumber` per the run-reference
      design, and an `allowedFlags` set limited to the record action's flags; wire dispatch in
      `pipeline.ts` for the `record` action.
- [x] 5.2 Implement the `record` handler: require `--source-kind`, `--failure-class`, `--stage`,
      the run reference (`--issue` + `--run-id` or resolved latest run), `--evidence-ref`,
      `--correction`, `--reusable`; optional `--proposed-control`. Force `actor_kind: "human"`.
      Locate the run dir host-locally, call `emitCorrectionEvent`, exit 0 on success.
- [x] 5.3 On a missing required field or an unlocatable run, append nothing and exit non-zero
      with a clear error. Ensure the handler has no advance/unblock/override/merge/deploy path.

## 6. Report-side visible failure

- [x] 6.1 In the consumer/report that reads `correction_event` records, validate
      `schema_version` and required bounded fields; surface a malformed/unknown-version record
      as a visible error line without crashing the reader or aborting the run; a run with no
      correction events reads normally.

## 7. Tests (co-located in `core/test/`)

- [x] 7.1 Contract shape per source kind: override, unblock, retry, rejection, repair, and a
      manual CLI record each produce one well-formed `correction_event` with the correct
      `source_kind`/`actor_kind` and an `evidence_ref`.
- [x] 7.2 Failed/no-op: a no-match override, an unblock that fails to clear the label, and a
      retry/fix attempt that does not resolve emit **zero** events; a bare `blocker_set` /
      enumerated finding emits zero. Prove the test bites.
- [x] 7.3 Deterministic key: equal `source_kind`+`failure_class`+`stage` ⇒ equal
      `correction_key`, and changing issue/PR/SHA/`correction` text does not move the key;
      differing bounded fields ⇒ differing key.
- [x] 7.4 Stale-SHA lineage: a `correction_event` whose `reviewed_sha` ≠ current head is
      classifiable as stale from the run dir alone; equal ⇒ current. `evidence_ref.id` for a
      finding equals `findingKey`.
- [x] 7.5 Redaction: a `correction` with an injection span persists `[REDACTED-INJECTION]`; a
      `correction`/`evidence_ref.id` with a secret assignment persists `[REDACTED]`; record
      still written. Non-fatal: an injected append failure does not abort the surrounding stage.
- [x] 7.6 Sink byte-identity: with an active sink, the delivered `correction_event` line equals
      the local `events.jsonl` line; `schema_version` stays `1`; exclusive mode still lands the
      record in `summary.json`.
- [x] 7.7 Replay/idempotency: emitting the same correction twice yields the same
      `correction_id`; a consumer deduping by `correction_id` collapses to one.
- [x] 7.8 CLI authority boundary: `correction record` mutates no GitHub/code state; its registry
      entry declares `mutatesGitHub: false`; an undeclared flag is rejected with exit 2 before
      any append.
- [x] 7.9 Report visible-failure: a malformed/unknown-version `correction_event` is surfaced as
      a visible error without aborting the reader; a run with no correction events reads normally.

## 8. Mirror & gate

- [x] 8.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the
      same change.
- [x] 8.2 Run `npm run ci` from repo root; all checks green.
- [x] 8.3 Run `openspec validate correction-event-ledger --strict` and fix any structural errors.
