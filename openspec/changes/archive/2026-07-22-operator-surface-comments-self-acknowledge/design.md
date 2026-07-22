# Design — operator-surface comments are self-acknowledging (#484)

## Context

`findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`) decides, for every
comment after the plan anchor, whether it is unacknowledged human input. Its two escape
hatches are (1) trusted-actor *verified* pipeline output, or a trusted-actor pipeline body
carrying no `NEGATION_PATTERNS` language; (2) being at or before an acknowledgement anchor
(`## Pipeline: Scope override`, or a trusted-actor plain human ack).

`## Pipeline: Unblocked` and `## Pipeline: Finding override` satisfy neither: they are
`verify: "exempt"` in `PIPELINE_COMMENT_KINDS`, and their bodies embed operator-written
free text that naturally contains "don't"/"instead"/"revert".

## Decision 1 — attest operator-surface comments (bind the operator text into the hash)

`unblocked`, `finding-override`, and `scope-override` become `verify: "pipeline-attest"`.
The `bodyHash` covers the full rendered body including the verbatim operator text.

The registry's current objection is that attesting *"would immunize genuine embedded human
objection language from the `NEGATION_PATTERNS` scan — the exact forgery/bypass hole #390
and #471 close."* That objection does not hold for these three kinds, for two reasons:

1. **Provenance.** The #390 hole was a *third party's* (or a trusted actor's *incidental*)
   objection wearing pipeline clothing. Here the embedded text is the trusted operator's
   direct answer, supplied through the pipeline's own CLI, whose entire purpose is
   "resume this run". Gating on it inverts the operator's stated intent.
2. **No new trust.** Attestation is tamper-evidence, not identity (existing spec). Exclusion
   still requires trusted authorship; a forged operator-surface comment from a third party
   gates exactly as before, and appended text breaks the hash.

`pre-planning-context` stays `exempt` — the distinction is authorship of the embedded text:
it wraps *third-party* comment excerpts the pipeline scraped, so attesting it really would
immunize other people's objections. Operator-surface bodies wrap text the trusted operator
typed at the CLI. This is the line the change draws, and it is the line the spec states.

### Rejected alternative — fence the operator text and scan only inside the fence

Render the operator text inside an `<operator-answer>` fence and keep applying
`NEGATION_PATTERNS` to it. Rejected: it preserves exactly the bug — an answer of
"don't retry the API call, batch it instead" is a *legitimate, expected* unblock answer, and
would still block the resume it was written to enable. The negation scan is a proxy for
"someone objected without being heard"; an operator invoking `pipeline unblock` has been
heard by construction.

## Decision 2 — anchor, not just self-exclusion

A verified, trusted-actor operator-surface comment advances the acknowledgement anchor
rather than merely excluding itself.

- Self-exclusion alone would leave any earlier unacknowledged comment still gating, so the
  operator would *still* hand-post a scope override — the reported symptom survives.
- Anchoring matches how `## Pipeline: Scope override` and the #390 plain-ack already behave:
  the operator, having spoken after those comments, is taken to have dismissed them.
- The gate's purpose is preserved positionally: anything posted *after* the operator-surface
  comment (the third-party case in the issue's acceptance criteria) is still counted.

Implementation note: `## Pipeline: Scope override`'s hard-coded heading match in the anchor
loop is subsumed by the new rule and should be replaced by it, not stacked beside it —
otherwise an unverified forged scope-override heading from a trusted-but-tampered body keeps
its current free pass. Trust membership (`trustedComments`) remains required, so the
fail-closed behaviour when `getGhActor()` returns `null` (nothing trusted, gate fires) is
unchanged; the operator's existing plain-ack escape still works in that degraded case.

## Decision 3 — identify operator-surface kinds from the registry, not by heading literal

The gate should ask the registry ("is this an operator-surface kind?") via the attestation
payload's `kind`, not re-match heading strings. The attestation already carries `kind`, and
`PIPELINE_COMMENT_KINDS` is already the single-sourced, drift-guarded enumeration. This
keeps a future fourth operator surface from silently missing the rule — adding it to the
registry with the operator-surface marker is the whole wiring.

## Deferred

The operator's unblock answer is still not injected into the resumed stage's prompt.
Pre-change it was not either — the gate blocked instead of forwarding it — so this change
does not regress delivery, and forwarding it touches the context-snapshot and fix-prompt
surfaces well outside #484's scope. Track separately.

## Risks

- **Widened immunity for the trusted actor.** A trusted actor could deliberately route a
  genuine objection through `pipeline unblock` to bypass the negation scan. Accepted: that
  actor can already clear the gate with a plain ack or a scope override, so no new authority
  is granted — only fewer keystrokes for the intended path.
- **Registry semantics drift.** Marking a kind operator-surface grants anchoring power, so
  the marker must not be applied to engine-authored status comments. The drift-guard test is
  extended to assert the operator-surface set is exactly the three CLI-driven kinds.
