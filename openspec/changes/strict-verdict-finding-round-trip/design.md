## Context

Two verdict parsers live in `core/scripts/stages/review-parsing.ts`:

| | `parseStructuredVerdict` | `parseStrictVerdict` |
|---|---|---|
| used by | local harness path, pre-merge delta | delegated `stage_executors` results (`review-routing.ts`) |
| findings | `data.findings as ReviewFinding[]` — blind cast, zero validation | `validateStrictFinding` per finding — hand-written field-by-field reconstruction |
| on violation | tolerant: prose/text fallback, partial defaulting | `null` → run blocked as a contract violation |

The strict parser's hand-written reconstruction is the bug surface: it enumerates
`severity/title/body/file/line_start/line_end/confidence/recommendation/category/
spec_divergence_direction/blocking` and stops. `prior_round_acknowledgment` (#389)
and `rejected_alternatives` (#483) were added to `ReviewFinding`,
`REVIEW_VERDICT_SCHEMA_BLOCK`, and `FINDING_FIELD_GUARD` but never to the
reconstruction — so on the delegated path they are dropped between a
correctly-emitting reviewer and the guards that consume them.

`validateStrictFinding` declares `ReviewFinding | null` as its return type, which
should make the omission a type error. It does not, for two reasons: the returned
object literal is a *subset* of an interface whose missing members are all optional,
and the repo runs Node's `--experimental-strip-types` with **no `tsc` step**, so
nothing type-checks at CI at all. This is the documented "back type-only invariants
with a runtime test" case from CLAUDE.md.

## Goals / Non-Goals

**Goals**
- The delegated path preserves every declared `ReviewFinding` field.
- The two parsers agree, structurally, on what a finding's fields are.
- The agreement is enforced by a runtime test driven by the existing
  `REVIEW_SCHEMA_FIELDS.finding` manifest, so future fields are covered for free.

**Non-Goals**
- Making `parseStructuredVerdict` strict. It is the tolerant local/legacy surface;
  hard-failing there would resurrect the `needs-attention/0` blocked-run class
  (#45/#50/#52/#54) that the tolerant path exists to prevent.
- Touching the settled-finding / reinstatement guard logic, review policy partition
  order, or the prompt schema text.

## Decisions

### D1. Separate *projection* from *validation*, and share only the projection

Introduce a single field-projection step — the one place that says "these are the
fields a `ReviewFinding` carries" — and let each parser layer its own policy on top:

- `parseStrictVerdict` → type-validate every declared field (required fields must be
  present and correctly typed; optional fields, when present, must be correctly
  typed), then project. A violation still returns `null` for the whole verdict.
- `parseStructuredVerdict` → project only, no rejection. A finding missing
  `confidence`/`recommendation` still flows through exactly as today.

*Alternative rejected:* have `parseStructuredVerdict` call `validateStrictFinding`
directly and drop findings that fail. That unifies the code but changes tolerant-path
behavior — a reviewer emitting a finding without `confidence` would go from "finding
routes to a fix round" to "finding silently disappears", which is a strictly worse
failure than the one being fixed. Rejected under rigor-over-latency: this change must
not remove review coverage anywhere.

*Alternative rejected:* keep two independent reconstructions and just add the two
missing fields to the strict one. That fixes today's instance but leaves the class
intact — the next `ReviewFinding` field repeats the bug. The issue explicitly asks for
one shared runtime finding schema.

### D2. The drift guard is manifest-driven, at finding granularity

The #56 guard iterates `REVIEW_SCHEMA_FIELDS.verdict`. Add a sibling that iterates
`REVIEW_SCHEMA_FIELDS.finding`, builds a sample finding populating every declared
field with a type-appropriate sentinel, runs it through **both** parsers, and asserts
each field survives with its sentinel value. Because the manifest is derived from
`FINDING_FIELD_GUARD` (which is `Record<keyof ReviewFinding, true>`), a new field on
the interface must be added to the guard to keep the editor honest, and the moment it
lands in the manifest the drift test starts exercising it. That closes the loop the
type system cannot close at runtime.

Sentinel typing must follow the field's declared type, not a blanket string: `severity`
must be one of the four accepted values, `confidence` a number in `[0,1]`,
`line_start`/`line_end` numbers, `blocking` a boolean, `spec_divergence_direction` one
of its two literals, `rejected_alternatives` a string array — otherwise the strict
validator rejects the sample and the guard passes vacuously. Deriving the sentinel from
the schema block's value hint (quoted → string, bare → number, `true | false` → boolean)
keeps it mechanical; an explicit per-field sample map is acceptable if simpler, provided
an unmapped new field makes the test fail loudly rather than be skipped.

### D3. Fail closed on malformed cross-round fields

`prior_round_acknowledgment` must be a string; `rejected_alternatives` must be an array
of strings. On the strict path a wrong type rejects the finding (and therefore the whole
verdict → run blocked with the executor named), matching how `isValidBlockingFindings`
already treats a malformed `rejectedAlternatives` on the artifact side, and matching the
strict parser's existing treatment of every other optional field. A guard that is fed a
coerced or half-trusted acknowledgment is worse than one that refuses to run.

### D4. Projection drops undeclared fields — accepted

Routing findings through a projection means an extra key an executor invents is not
carried into `ReviewFinding`. Today's blind cast would carry it. Nothing in the engine
reads an undeclared finding field (finding keys, severity policy, artifact encoding, and
both cross-round guards all read declared fields), and dropping unknown keys is the
correct reading of a single-sourced schema contract. Noted here so the behavior change is
deliberate rather than incidental.

## Risks

- **Vacuous drift guard.** If the sample finding is malformed, `parseStrictVerdict`
  returns `null` and a naive assertion could pass on an empty findings array. The test
  must assert the verdict parsed AND exactly one finding came back, before asserting
  fields — and must be shown to fail against the pre-fix parser (bite proof).
- **Tolerant-path regression.** Existing `parseStructuredVerdict` tests (prose fallback,
  partial findings, Codex prose review) are the guardrail; they must pass unmodified.
