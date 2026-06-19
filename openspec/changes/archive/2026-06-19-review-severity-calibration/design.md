## Context

The review gate is `reviewMode: prompt-harness`: the reviewer CLI is invoked with a
JSON-returning prompt whose schema is single-sourced (`REVIEW_VERDICT_SCHEMA_BLOCK` →
`{{schema_block}}`) and severity rubric is single-sourced (`SEVERITY_RUBRIC` →
`{{severity_rubric}}`). `partitionFindings` (in `review-policy.ts`) then splits the verdict's
findings into `blocking` / `advisory` / `overridden` under the repo's `review_policy`
(`block_threshold`, `min_confidence`). Only `blocking` routes to a fix round.

The observed failure: 0 LOW findings across 23 rounds because LOW is advisory, so the reviewer
inflates hardening/nitpick findings to MEDIUM to make them "count," and they block. The schema
offers no way to record a finding as non-blocking, so even a reviewer who *wants* to note an
out-of-scope observation must pick a blocking severity.

## Goals / Non-Goals

- **Goal:** make LOW a real, populated tier via rubric calibration (prompt-only).
- **Goal:** add an explicit non-blocking emission path (schema field + policy treatment +
  reviewer guidance) so an honest observation does not force a fix round.
- **Non-Goal:** change blocking thresholds/defaults, engine-side severity auto-classification, or
  the round-1/round-2 prompt restructuring owned by `review-prompt-craft-gaps`.

## Decision 1 — `blocking?: boolean`, named by effect not by reason

The marker is named `blocking` (a `false` value records a non-blocking finding) rather than
`out_of_scope`. The issue lists three distinct *reasons* a reviewer might not want a finding to
block — out-of-scope, pre-existing, informational — but they share one *effect*: do not route to
a fix round. Naming the field by its singular effect avoids minting three parallel boolean flags
(`out_of_scope`, `pre_existing`, `informational`) that would all mean the same thing to the gate.
The reviewer records *which* reason applies in the finding `body`; the prompt guidance enumerates
the reasons.

- The field is **optional** (`blocking?: boolean`). Absent or `true` → classify normally under
  the severity/confidence policy (full backward compatibility: every existing verdict behaves
  exactly as before). `false` → advisory regardless of severity/confidence.
- Backward compatibility for the parser: `parseStructuredVerdict` already carries findings
  through as `data.findings as ReviewFinding[]`, so the optional field flows through untouched
  with no parser change. An older reviewer that never emits the field is unaffected.

## Decision 2 — policy treats `blocking === false` as advisory, before the severity test

In `partitionFindings`, a finding with `blocking === false` is moved into `advisory` ahead of the
severity/confidence classification, with a reason like `marked non-blocking by reviewer`. Two
consequences must hold:

1. It is advisory **even at `critical`/`high`** — the whole point. This is checked *after* scope
   and key overrides (those already produce `overridden`, which is also non-blocking, so order
   between them is immaterial) but *before* the severity/confidence test.
2. It must **not** be counted as a blocking candidate in the ambiguity-guard pre-pass
   (`blockingFingerprintsByKey`). That pre-pass counts distinct blocking-candidate payloads per
   key to decide whether a key override is ambiguous. A `blocking: false` finding is not a
   blocking candidate, so it must be excluded there too — otherwise a non-blocking finding could
   spuriously inflate a key's distinct-candidate count and wrongly withhold a legitimate override.

The existing all-advisory advance path (`review-severity-policy`: "All-advisory verdict advances
with an audit record") already itemizes advisory findings in the audit comment, so a non-blocking
finding is recorded there automatically once it lands in `advisory`.

## Decision 3 — rubric calibration is prompt-only, single-sourced

`SEVERITY_RUBRIC` is edited in place (it is already injected into both prompts via
`{{severity_rubric}}`, so both rounds stay in sync). The LOW bullet is expanded to name the
classes explicitly and an anti-inflation directive plus at least one concrete LOW example is
added. No code path reads the rubric text, so this is a pure prompt change; a test asserts the
rubric string contains the LOW classes and the anti-inflation directive so the calibration can't
silently regress.

The "when to mark non-blocking" guidance is a new single-sourced constant (mirroring
`CONFIDENCE_CALIBRATION_BLOCK`) injected into both prompts via a new placeholder, so the two
rounds cannot drift.

## Decision 4 — drift guard gains a third (boolean) type-token category

`verdict-schema-single-source`'s drift guard currently maps TS `number` → bare angle-bracket hint
and TS `string` → quoted hint (a two-category vocabulary). `blocking` is a TS `boolean`, which is
neither, so the vocabulary is extended to a third category: a TS `boolean` field maps to an
unquoted boolean-literal hint rendered as `true | false` in the schema block. The guard
recognizes this token form and asserts the boolean field carries it. Field-name parity (the
original guard) is unchanged: adding `blocking` to `ReviewFinding` without adding it to
`REVIEW_VERDICT_SCHEMA_BLOCK` (or vice versa) still fails the test.

Schema-block rendering inside the `findings[]` object:

```
"blocking": true | false,
```

The optionality ("omit unless this finding should not block") lives in the reviewer guidance
text, not the schema block, to keep the block's value hint a clean boolean token the drift guard
can categorize.

## Risks / Trade-offs

- **A reviewer could mark a real blocker non-blocking.** Accepted: the marker is the reviewer's
  honest self-disposition and is audited in the advance comment exactly like an advisory finding.
  The adversarial reviewer is still instructed to block real defects; the channel exists for
  observations, and giving it removes the *stronger* failure mode (severity inflation to force a
  block). This is the same trust posture the advisory band already has.
- **Rubric wording is a soft lever.** Prompt calibration can't be unit-proven to change model
  behavior; the regression test only pins the text. That is acceptable — it matches how
  `SEVERITY_RUBRIC` / `CONFIDENCE_CALIBRATION_BLOCK` are already validated.

## Migration

None. The field is additive and optional; absent it, every verdict classifies exactly as today.
No persisted sentinel or stored verdict shape changes.
