## 1. Types

- [ ] 1.1 Add a `ReviewFindingRecord` interface to `core/scripts/types.ts`: `key` plus the full `ReviewFinding` field set (`severity`, `title`, `body`, `file?`, `line_start?`, `line_end?`, `confidence`, `recommendation`, `category?`, `blocking?`).
- [ ] 1.2 Extend `ReviewRecord` in `core/scripts/types.ts` with optional `findings: ReviewFindingRecord[]`, `harness: string`, `model: string`, and `selfReview: boolean` (additive — keep `round`, `sha`, `verdict`, `findingCounts`).
- [ ] 1.3 Extend `ReviewVerdictEvent` in `core/scripts/run-store.ts` with `findings: ReviewFindingRecord[]`, `reviewer_harness: string`, `reviewer_model: string`, and `self_review: boolean`.

## 2. Build the finding records in the review stage

- [ ] 2.1 In `core/scripts/stages/review.ts`, map `verdict.findings` to `ReviewFindingRecord[]`, computing each `key` via `findingKey(f)` from `review-policy.ts` (do not reimplement identity).
- [ ] 2.2 Resolve the reviewer identity for the round: `harness` = the effective `reviewer` (post #39-fallback reassignment), `model` = `cfg.models.review` (the value passed to the harness), `selfReview` = the existing self-review flag.
- [ ] 2.3 Pass `findings`, `harness`, `model`, `selfReview` into the `recordReview(...)` call.
- [ ] 2.4 Add `findings`, `reviewer_harness`, `reviewer_model`, `self_review` to the `review_verdict` `appendEvent(...)` payload.
- [ ] 2.5 Confirm both writes stay inside the existing best-effort (`.catch`) / non-fatal paths and remain gated on `opts.stateDir` / `opts.runDir`.

## 3. Redaction

- [ ] 3.1 Verify finding `title`/`body`/`recommendation` flow through the existing write-time injection denylist + field-level secret redaction (`sanitizeDeep` / `redactSecrets`) on both the `events.jsonl` and `summary.json` write paths; add field-level screening if any new field bypasses it.

## 4. Tests (co-located in `core/test/`)

- [ ] 4.1 Record shape: a review round with findings persists one `ReviewFindingRecord` per finding with all required fields; optional fields present only when the finding carries them.
- [ ] 4.2 Key correlation: each persisted `key` equals `findingKey(finding)`; a finding and its `OverrideRecord` share a `key`; the same finding across two rounds shares a `key`.
- [ ] 4.3 Resolution derivation: over a two-round fixture, a `key` blocking in round 1 and absent in round 2 derives **resolved**; a `key` still present derives **still-open** — with no network/git/subprocess. Prove the test bites.
- [ ] 4.4 Reviewer identity: the persisted round records the effective reviewer harness, model, and `selfReview`; the #39 same-harness fallback records the implementing harness and `selfReview: true`.
- [ ] 4.5 Redaction: a finding whose `body` contains an injection-denylist span persists `[REDACTED-INJECTION]`; a finding field with a secret assignment persists `[REDACTED]`; the record is still written.
- [ ] 4.6 Non-fatal: an injected write failure on the enriched record does not abort/block the review stage (a warning is logged).
- [ ] 4.7 Zero findings: a verdict with no findings persists `findings: []` and still records verdict + counts.
- [ ] 4.8 `schema_version` (and `schemaVersion`) remain `1` with the new fields present.
- [ ] 4.9 `--json-events`: the enriched `review_verdict` line on stdout equals the `events.jsonl` line.

## 5. Mirror & gate

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 5.2 Run `npm run ci` from repo root; all checks green.
- [ ] 5.3 Run `openspec validate review-finding-records --strict` and fix any structural errors.
