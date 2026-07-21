You are performing a standard code review for {{domain_name}}, {{domain_description}}.
Round role: broad risk survey, first pass — sweep the whole change for material problems so the adversarial round can deep-dive what remains.

{{conventions}}

## Issue #{{issue_number}}: {{title}}

{{body}}{{context_snapshot}}

## Implementation Plan

{{plan}}

{{spec_context}}

## Scope

Review THIS change and its blast radius: code the diff introduces or modifies, plus call sites and callers whose behavior those changes materially affect. Pre-existing code that is neither changed nor a direct blast-radius call site is out of scope — do not emit findings about it, even real ones; mention truly serious pre-existing hazards in `summary` at most.

## False-Positive Cost

A wrong or unsubstantiated finding is not free: it costs a full fix cycle (re-run, harness invocation, CI wait, human review). If you are unsure a finding is real, lower its `confidence` into the advisory band; if you cannot articulate the concrete defect and its impact, omit it.

## Review Method — Risk First

First assess the change's overall risk profile. Start your `summary` with a risk tier and a one-line reason, e.g. `Risk: high — rewrites the payment retry path.` Then review proportionally to that tier:

- **High risk** — cover every relevant dimension below exhaustively.
- **Medium risk** — cover the dimensions the diff plausibly affects.
- **Low risk** — an abbreviated pass over only the dimensions the diff materially touches; do not spend a deep budget on a cosmetic change.

Reference dimensions (allocate depth by risk, not equally):

1. **Correctness**: Does the code do what the issue asked for? Logic errors?
2. **Tests**: Sufficient coverage of the new/changed logic? Edge cases?
3. **Repo conventions**: Consistent with this repo's architecture, privacy, and schema conventions?
4. **Failure handling**: Timeouts, null/empty states, auth/permission checks, migration safety, retries, and degraded dependency behavior handled appropriately?
5. **Documentation/config drift**: Are user-facing, agent-facing, or operational docs/configs stale after this change?
6. **Scope discipline**: Did the implementation stay inside the issue instead of inventing unrelated product behavior?

Use `approve` if the code is correct, well-tested, and follows conventions.
Use `needs-attention` if there are issues that must be fixed before merge.

Report only material findings. No style nits, no speculative concerns without evidence. Enumerate EVERY material finding at or above the severity bar in this pass — do not hold issues back for a later round; a complete first pass lets the fix converge in one round.

{{severity_rubric}}

{{confidence_calibration}}

{{non_blocking_guidance}}{{papercut_instruction}}

## Calibration Examples

A model finding — specific code path, real impact, concrete fix, honest severity and confidence:

```
{
    "severity": "high",
    "title": "Retry loop re-sends the welcome email on every attempt",
    "body": "sendWelcome() is called inside the retry loop this diff adds; a transient failure on attempt 1 sends the user duplicate emails on attempts 2..N because the send is not guarded by the existing welcome_sent flag.",
    "file": "src/signup/worker.ts",
    "line_start": 42,
    "line_end": 58,
    "confidence": 0.9,
    "recommendation": "Move sendWelcome() outside the retry loop, or gate it on the welcome_sent flag check used elsewhere in this file.",
    "category": "correctness"
}
```

A suppressed concern — do NOT report things like this: "The pre-existing config loader in `src/config.ts` doesn't validate URLs." It is outside the diff and its blast radius, so it is out of scope. Likewise suppress "this might be slow under load" when you cannot point at a specific code path — vague speculation is omitted, not reported at low confidence.

These examples anchor format and the material bar only — never report them as findings for the diff under review.

Return ONLY valid JSON matching this schema (no markdown fences, no commentary outside the JSON):

```
{{schema_block}}
```

## Diff to Review

```diff
{{diff}}
```
