## Context

Two independent surfaces have to agree for a review-mode eval cell to produce a
meaningful grade:

| | production review | eval `mode: "review"` (today) |
|---|---|---|
| prompt | `review_standard.md` / `review_adversarial.md` with `{{schema_block}}` ← `REVIEW_VERDICT_SCHEMA_BLOCK` | `STAGE_INSTRUCTIONS.review` one-liner + task input + stage artifact JSON |
| output contract | JSON verdict, explicitly demanded | none stated |
| parse | `parseStructuredVerdict` (fenced/inline extraction, prose fallback) or `parseStrictVerdict` | `JSON.parse(stdout)` on the whole stdout, `findings` array only |
| on failure | prose fallback / blocked contract violation, both visible | `undefined` → silently zero findings |

The eval side re-implements both halves and drifts from both. The fix is not to write
a better eval-local contract; it is to stop having one.

`stage-adapters.ts` deliberately does not call production stage entry points (they
assume live PR/issue/worktree state — see `stage-eval-runner`'s design). That
constraint applies to *stage execution*, not to *shared constants and pure parsers*:
`REVIEW_VERDICT_SCHEMA_BLOCK` and `review-parsing.ts` are both pure and stateless, so
importing them introduces no live-state dependency.

## Goals / Non-Goals

**Goals**
- An eval reviewer is asked for the same output shape production asks for, from the
  same constant.
- A verdict a production reviewer would have parsed is a verdict the eval parses.
- "Reviewer found nothing" and "reviewer never answered in the contract" are
  distinguishable on the cell record.

**Non-Goals**
- Changing what a good review *is* — no schema, policy, or grader-math changes.
- Making the eval runner enter production stage code paths.
- Fixing `plan-review`'s (separate) output contract.

## Decisions

### D1. Contract text comes from `REVIEW_VERDICT_SCHEMA_BLOCK`, appended only for `review`

`materializeStagePrompt` gains a per-stage contract suffix, populated for `review`
only, built from the imported constant. The four existing prompt parts are untouched
and the other five stages get no suffix, so their materialized text is byte-identical
to today (asserted by test).

*Alternative rejected:* load `review_standard.md` and substitute placeholders. That
template carries prior-round digests, PR/issue context, and policy language that a
frozen fixture cannot supply; a half-populated production template would either leave
unsubstituted `{{…}}` tokens in the prompt or fabricate context that biases the
measurement. The verdict *contract* is the only part of the production prompt the
eval needs, and it is already single-sourced as a constant.

*Alternative rejected:* give every stage a contract suffix now. The issue's acceptance
criteria require non-review prompts to be unchanged, and `plan-review`'s contract is a
different schema — bundling it would broaden scope with no fixture to validate it.

### D2. Parse with the production parsers, in strict-then-tolerant order

`parseReviewFindings` becomes:

1. `parseStrictVerdict(stdout)` — non-null means the treatment satisfied the full
   contract. Record provenance `strict`; use its findings.
2. Otherwise `parseStructuredVerdict(stdout)` — recovers a fenced/inline verdict whose
   findings are partial (e.g. a missing `confidence`). If it yields a verdict that was
   actually parsed from JSON, record provenance `tolerant` and use its findings.
3. Otherwise record provenance `unparseable`, leave `detail.findings` absent.

Strict-first gives the honest signal (did the treatment honor the contract?) without
throwing away a recoverable verdict, which matters because `gradeReview` only needs
`file`/`line_start`/`line_end`/`severity` — a finding missing `recommendation` is still
a real, gradeable detection, and discarding it would understate recall.

The prose/text fallback inside `parseStructuredVerdict` must NOT be treated as a
verdict here: it returns `findings: []` for arbitrary text, which is precisely the
"silently zero findings" outcome this change exists to eliminate. Step 2 therefore
only accepts a result that came from parsed JSON (the fallback is identifiable by its
`_raw` field / empty findings with no JSON candidate); everything else is
`unparseable`.

*Alternative rejected:* strict only. One malformed optional field in one finding would
zero out a cell in which the reviewer found every defect — a worse measurement error
than the one being fixed.

*Alternative rejected:* tolerant only. Then every cell "parses", provenance carries no
information, and a prose-answering harness is indistinguishable from a compliant one
that found nothing.

### D3. Provenance is an additive `detail` key, not a new result class

An unparseable review is a real treatment outcome — the treatment was asked correctly
and answered wrongly. It stays `result_class: "completed"` with
`detail.review_verdict_parse: "unparseable"`. Reclassifying it as `infra_error` would
hide genuine harness non-compliance, which is exactly the signal harness-pair selection
needs. The results contract is append-only (`stage-eval-runner`), so an added `detail`
key is compatible with previously recorded experiments.

### D4. Both execution paths get the same treatment

`runCell` captures review findings in two places: the API/model-endpoint path
(`cell.treatment.executor`) and the local-CLI stage loop. Both call the same
`parseReviewFindings`, so both inherit the fix and both record provenance for a
`review`-stage cell. The API path's existing call for a `plan-review` cell is left as
is — without the review contract in its prompt, its output remains unparseable exactly
as today (no behavior change, no new findings attributed to it).

## Risks

- **Prompt-length / attention shift.** Appending the schema block lengthens the review
  prompt. This is the same block production reviewers already receive, so it is
  bounded and representative; a fixture-level A/B is not warranted.
- **Provenance mis-classification.** If step 2 accidentally accepts the text fallback,
  every cell reports `tolerant` and the diagnostic value is lost. Covered by an explicit
  test: prose stdout → `unparseable`, and `detail.findings` absent.
- **Cross-experiment comparability.** Grades recorded before this change are not
  comparable to grades after it (the earlier ones measure a prompt defect, not a
  reviewer). Out of scope to re-run; worth stating in the change's impact when results
  are next compared.
