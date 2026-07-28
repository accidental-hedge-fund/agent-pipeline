## Why

Delegated review under `stage_executors` parses the executor's output with
`parseStrictVerdict` (`core/scripts/stages/review-parsing.ts`). Its per-finding
validator, `validateStrictFinding`, reconstructs each `ReviewFinding` field by
hand — and that hand-written reconstruction omits the two cross-round fields:

- `prior_round_acknowledgment` (#389) — the settled-finding reversal guard reads it
  in `partitionFindings`; absent/blank on a settled surface means the finding is
  demoted to advisory with reason `reversal-unacknowledged`.
- `rejected_alternatives` (#483) — the alternative-reinstatement guard reads it, and
  it rides the durable `blockingFindings` artifact into the prior-round digest.

A reviewer that correctly emits both fields (they are in
`REVIEW_VERDICT_SCHEMA_BLOCK`, so the prompt asks for them) has them silently
dropped on the delegated path. The guards then see `undefined`:

- a legitimately-acknowledged re-raise is **falsely demoted** to advisory
  (`reversal-unacknowledged`), losing a real blocking finding; and
- a later round's recommendation can no longer be checked against what an earlier,
  now-settled round required removed — so reinstatement detection **silently
  degrades** on every delegated round, and the digest entry written from that
  round carries no `rejectedAlternatives`.

The local harness path (`parseStructuredVerdict`) keeps the fields only by
accident: it blind-casts `data.findings as ReviewFinding[]` with no per-field
reconstruction. So the two parsers disagree about the finding contract, and the
declared `ReviewFinding` return type of `validateStrictFinding` is a lie that
`--experimental-strip-types` never type-checks — CI is green today.

The existing parser drift guard (#56, `review.test.ts`) only iterates
`REVIEW_SCHEMA_FIELDS.verdict` — the *top-level* fields. Nothing iterates
`REVIEW_SCHEMA_FIELDS.finding`, which is exactly why adding
`prior_round_acknowledgment`/`rejected_alternatives` to the schema and types did
not fail any test when the strict parser was not updated.

## What Changes

- `validateStrictFinding` reconstructs **every** field named in
  `REVIEW_SCHEMA_FIELDS.finding`, including `prior_round_acknowledgment` and
  `rejected_alternatives`, and type-validates both (string; string array of
  strings) — rejecting the whole finding when either is present with a wrong type,
  matching the existing fail-closed style of the validator.
- One runtime finding contract is shared by both parsers: `parseStructuredVerdict`
  routes its findings through the same validator instead of blind-casting, so the
  two paths cannot diverge again. Findings that fail validation on the structured
  path keep that path's tolerant behavior (it is the local-harness/legacy surface
  and must not start hard-failing); only the strict path treats a violation as a
  contract failure that blocks the run.
- A **finding-level** parser drift guard, driven by `REVIEW_SCHEMA_FIELDS.finding`,
  asserts both parsers round-trip every declared finding field. Adding a field to
  `ReviewFinding`/the schema block without teaching the parsers about it now fails
  a test instead of silently losing data at runtime.
- Regression test: a delegated-executor verdict fixture carrying
  `prior_round_acknowledgment` and `rejected_alternatives` → the parsed
  `ReviewFinding` retains both, with exercised end-to-end effect on the
  settled-finding guard (an acknowledged re-raise is NOT demoted to
  `reversal-unacknowledged`).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `verdict-schema-single-source`: extend the single-source guarantee from the
  prompt↔types axis to the **parser** axis at finding granularity — strict verdict
  parsing SHALL round-trip every declared `ReviewFinding` field, both parsers SHALL
  share one runtime finding contract, and the drift guard SHALL cover finding-level
  fields.

## Impact

- `core/scripts/stages/review-parsing.ts` — `validateStrictFinding` field
  reconstruction + type checks; `parseStructuredVerdict` finding path.
- `core/test/review.test.ts` (and/or `gh-parsers.test.ts`) — finding-level drift
  guard + cross-round round-trip regression tests.
- `plugin/` — regenerated mirror.
- No changes to review policy partition order, severity/confidence thresholds,
  labels, config schema, or the prompt text/schema block itself.

## Out of Scope

- Changing review policy partition order or the settled-finding/reinstatement guard
  semantics themselves — this change only stops feeding them `undefined`.
- OS-level eval isolation (#618).
- The evals review-mode structured verdict contract (#606) — same dual-parser class,
  tracked separately.

## Acceptance Criteria

- [x] `parseStrictVerdict`, given a verdict whose finding carries
      `prior_round_acknowledgment: "<text>"`, returns a finding with that exact
      string value (not `undefined`).
- [x] `parseStrictVerdict`, given a verdict whose finding carries
      `rejected_alternatives: ["alt-a", "alt-b"]`, returns a finding with that exact
      array (not `undefined`).
- [x] For every field name in `REVIEW_SCHEMA_FIELDS.finding`, a test asserts the
      field survives `parseStrictVerdict` when present in the input — the assertion is
      driven by the manifest, so a newly-added finding field is automatically covered.
- [x] The same manifest-driven assertion also covers `parseStructuredVerdict`, so the
      two parsers cannot diverge on which finding fields they carry.
- [x] A finding with `prior_round_acknowledgment` of a non-string type, or
      `rejected_alternatives` that is not an array of strings, is rejected by
      `parseStrictVerdict` (returns `null` for the whole verdict), consistent with the
      validator's existing fail-closed handling of malformed optional fields.
- [x] A verdict that omits both fields entirely still parses successfully on both
      paths, with both fields absent — no behavior change for reviewers that do not
      emit them.
- [x] With a delegated (`executor_name`-bearing) review result whose finding
      re-raises a settled surface **with** a non-empty `prior_round_acknowledgment`,
      the finding is NOT demoted with reason `reversal-unacknowledged` — proving the
      round-trip reaches the guard, not just the parser.
- [x] Each new test is proven to bite: it fails against the pre-fix
      `validateStrictFinding` and passes after.
- [x] `npm run ci` passes from the repo root, including `build.mjs --check` with the
      regenerated `plugin/` mirror committed alongside `core/`.
