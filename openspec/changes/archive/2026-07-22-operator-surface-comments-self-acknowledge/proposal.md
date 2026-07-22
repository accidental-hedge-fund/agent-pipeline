# Operator-surface comments are self-acknowledging (#484)

## Why

The unacknowledged-human-input gate counts the pipeline's own `## Pipeline: Unblocked`
comment as unacknowledged human input — a #390/#471-class recurrence on a comment
surface those changes missed.

Observed on PraxisIQ/fuseiq-core#95 (2026-07-21, v1.16.0), run `95/2026-07-21T15:43:07Z`:
the operator ran `pipeline unblock 95 "<answer>"`, which posts the answer as a
`## Pipeline: Unblocked` comment and clears `pipeline:blocked`. On relaunch, the resumed
fix-2 stage immediately blocked with *"1 unacknowledged human comment(s) after the latest
plan — re-plan or post a scope override to proceed"*. The unacknowledged comment **was the
unblock answer itself**. The operator then had to hand-post a `## Pipeline: Scope override`
comment and clear the label manually — for every unblock that resumes into a fix stage.

Root cause, in `findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`):
a comment classified `pipeline` self-excludes only when it is authored by a trusted actor
**and** (is verified pipeline output **or** carries no `NEGATION_PATTERNS` language).
`## Pipeline: Unblocked` is deliberately `verify: "exempt"` in `PIPELINE_COMMENT_KINDS`
(`core/scripts/gh.ts`), so it is never verified; and it embeds the operator's verbatim
answer, which routinely contains "don't", "instead", "revert" — ordinary words for an
answer that redirects the work. So it fails both arms and gates.

The same hole exists on `pipeline override`'s `## Pipeline: Finding override` comment
(built by `overrideComment` in `core/scripts/review-policy.ts`, posted by `runOverride`):
it is unattested and its `### Reason` prose is operator-written, so an override reason
containing "instead" gates the run it was invoked to unblock. `## Pipeline: Scope override`
escapes only by accident — its literal heading is hard-coded as an acknowledgement anchor.

Two of the registry's `exempt` justifications are also factually wrong: `finding-override`
and `scope-override` are documented as *"posted by the human operator directly … not
constructed/posted anywhere in `core/scripts/`"*, but both bodies are constructed by
`overrideComment` / `scopedOverrideComment` and posted by `runOverride`.

## What Changes

Introduce the notion of an **operator-surface comment**: a body the *engine* renders in
direct response to an operator CLI invocation, wrapping operator-supplied free text
(`pipeline unblock`, `pipeline override`). Three kinds qualify: `unblocked`,
`finding-override`, `scope-override`.

- These kinds move from `verify: "exempt"` to `verify: "pipeline-attest"` — the whole
  rendered body, operator text included, is bound by the attestation `bodyHash`, so any
  later edit or append fails verification exactly as for every other attested kind.
- The gate treats a **verified, trusted-actor** operator-surface comment as an
  acknowledgement anchor: it is not counted itself, and comments at or before it are
  dismissed — the same treatment `## Pipeline: Scope override` gets today, now earned
  structurally rather than by heading literal.
- Forge resistance is unchanged: an operator-surface heading from a non-trusted author, or
  one whose body fails verification (text appended, body edited), is still counted as
  unacknowledged human input.
- Fix the two incorrect `exempt` reasons; `pre-planning-context` stays exempt (it wraps
  *third-party* human excerpts, not operator-authored text — see `design.md`).

## Acceptance Criteria

- [ ] `pipeline unblock <N> "<answer>"` on an item whose next stage is a fix round resumes
      and runs that fix round with no manual scope-override comment and no manual label
      edit, even when the answer text contains change-request wording ("don't", "instead").
- [ ] `findUnacknowledgedComments` returns zero for a comment list whose only post-plan
      comment is a trusted-actor `## Pipeline: Unblocked` comment carrying an answer with
      `NEGATION_PATTERNS` wording.
- [ ] The same holds for `## Pipeline: Finding override` and `## Pipeline: Scope override`
      comments whose operator-written `### Reason` contains change-request wording.
- [ ] A genuine third-party human comment posted *after* the unblock/override comment and
      before the resume is still counted, and the stage still blocks with the
      `## Pipeline: New human input detected` warning.
- [ ] An operator-surface heading posted by an author who is neither the pipeline actor nor
      a `cfg.trusted_override_actors` entry is still counted (forgery gates).
- [ ] An operator-surface body with human text appended after the attestation marker fails
      verification and is still counted.
- [ ] `PIPELINE_COMMENT_KINDS` lists `unblocked`, `finding-override`, and `scope-override`
      as `pipeline-attest`; the existing registry drift guards pass with no allowlist
      additions; no `exempt` entry claims a body is un-constructed when `core/scripts/`
      constructs it.
- [ ] `npm run ci` is green from the repo root, including the regenerated `plugin/` mirror.

## Impact

- Affected specs: `issue-context-snapshot`
- Affected code: `core/scripts/gh.ts` (registry), `core/scripts/pipeline.ts`
  (`runUnblock` body), `core/scripts/review-policy.ts` (`overrideComment`,
  `scopedOverrideComment`), `core/scripts/issue-context-snapshot.ts`
  (`findUnacknowledgedComments`), plus tests and the generated `plugin/` mirror.
- No config keys added; no change to what an ordinary human comment does.

## Out of Scope

- The gate's treatment of ordinary human comments (working as designed).
- Delivering the unblock answer's *content* into the resumed stage's prompt. It is not
  delivered today either (the gate blocked instead of forwarding), so this change does not
  regress it; see `design.md` "Deferred" for the follow-up.
