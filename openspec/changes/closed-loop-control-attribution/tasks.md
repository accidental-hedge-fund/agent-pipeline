## 1. control_attribution record contract

- [ ] 1.1 In `core/scripts/correction.ts`, add the `control_attribution` record type with bounded
      `control_type` (reuse `CORRECTION_PROPOSED_CONTROLS`) and `disposition`
      (`implemented` | `human-owned` | `rejected` | `superseded`) enums, plus `correction_key`,
      `issue`, `pr`, `effective_commit`, `effective_release`, `effective_at`, `supersedes`,
      `evidence_ref`, and `note`.
- [ ] 1.2 Add a pure `deriveAttributionId(...)` helper (stable hash of the identifying fields) so
      re-recording the same attribution is idempotent; add `validateControlAttribution(raw)`
      mirroring `validateCorrectionEvent` (schema_version + bounded fields, tolerant of unknown).
- [ ] 1.3 Add `emitControlAttribution(...)` that sanitizes `note`/`evidence_ref.id` through the
      existing injection denylist + secret redaction, appends one record to the durable
      append-only ledger `.agent-pipeline/control-attributions.jsonl`, and is non-fatal (caught,
      warned, never aborts). Set `effective_at` only for `implemented` (and superseding-implemented)
      dispositions.

## 2. Explicit audited write command

- [ ] 2.1 Add a `correction attribute` sub-command dispatch in `core/scripts/pipeline.ts` and a
      registry entry in `core/scripts/command-registry.ts` with `mutatesGitHub: false`,
      `needsGhAuth: false`, and the attribution flags (`correctionKey`, `controlType`,
      `disposition`, `issue`, `pr`, `effectiveCommit`, `effectiveRelease`, `supersedes`,
      `evidenceRef`, `note`).
- [ ] 2.2 Prove the authority boundary: the command is never wired to advance/unblock/override/
      merge/deploy, and no issue-close or PR-merge path writes an attribution.

## 3. Scoreboard recurrence aggregation

- [ ] 3.1 In `core/scripts/scoreboard.ts`, during the existing run scan, read `correction_event`
      records (deduped by `correction_id`) and compute total corrections, distinct classes
      (distinct `correction_key`), repeated-class count and rate, and corrections per
      ready-to-deploy item — all under the existing zero-denominator→`null` rule.
- [ ] 3.2 Read `.agent-pipeline/control-attributions.jsonl`, join attributions to classes by
      `correction_key`, and compute `time-to-control` per attributed class.
- [ ] 3.3 Evaluate post-control recurrence over eligible exposure (runs after `effective_at` that
      exercised the class's stage) and classify each attributed class `recurred`,
      `no_recurrence_observed`, or `insufficient_post_control_evidence` (zero eligible runs).
- [ ] 3.4 Resolve supersession chains (latest non-`rejected` implemented boundary), surface
      superseded/rolled-back controls, and keep all wording temporal (no causal claim).

## 4. Grouping, trends, and top-recurring output

- [ ] 4.1 Add the `--corrections-by <dimension>` flag (`repo`, `stage`, `harness`, `model`,
      `source_kind`, `failure_class`, `proposed_control`, `implemented_control`) validated exactly
      like `--by` (one dimension, rejected-before-read, additive keys).
- [ ] 4.2 Carry per-period recurrence totals inside the existing `--bucket` series; render a
      top-still-recurring-classes list with sanitized evidence pointers.
- [ ] 4.3 Emit the recurrence sections additively in human, `--json`, and `--html` output without
      changing existing keys or `schema_version` semantics.

## 5. Diagnostics, read-only, and tolerance

- [ ] 5.1 Surface malformed/partial/old-schema `correction_event` and `control_attribution`
      records, and attributions referencing an unknown `correction_key`, as window-level
      diagnostics with stable reason codes; never crash or silently skew.
- [ ] 5.2 Assert the scoreboard invokes no GitHub command and writes nothing under
      `.agent-pipeline/` (including the attribution ledger).

## 6. Regression fixtures and CI

- [ ] 6.1 Fixtures proving: falling recurrence after a `deterministic-gate`/`eval` control;
      continued recurrence after an `instruction` (documentation-only) control; zero-exposure →
      `insufficient_post_control_evidence`; duplicate `correction_id` delivery counted once; and
      control supersession/rollback re-measured from the new boundary.
- [ ] 6.2 Prove each test bites (fails without the change); run `npm run ci`, regenerate and commit
      the `plugin/` mirror.
