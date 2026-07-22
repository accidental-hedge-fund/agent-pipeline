## Context

The fix stage's no-commit path (`core/scripts/stages/fix.ts`, `advanceFix`) currently resolves in
one of three ways after `headBefore === headAfter` and salvage finds nothing:

1. `decideExternalCommitAdvance` (#349) — a human already pushed the requested fix → rebase and
   run the normal gates.
2. `decideDoesNotReproduceAdvance` (#391) — every invoked blocking finding carries a valid
   `pipeline-does-not-reproduce` declaration → advance to the round's next stage.
3. Otherwise → `setBlocked(..., "no-commits")`, which
   `blockerKindToInterventionKind` maps to `"test-build-failure"`.

Case 3 is the sink for a fourth, real outcome: the fix agent correctly determined that the
finding cannot be resolved by code at all — it needs a product decision, an authority the agent
does not have, or an external capability that does not exist. Today that lands in (3) and is
mis-recorded as a test/build failure.

## Goals / Non-Goals

Goals:
- One bounded, machine-readable declaration for "this needs a human decision".
- Route it to the existing human-decision surface with durable, readable evidence.
- Keep every existing path byte-identical when the declaration is absent or invalid.

Non-Goals:
- Advancing the item, clearing a finding, or recording any disposition on the agent's word.
- A new stage, label, or `HumanInterventionKind` member.
- Any change to the #391 or #349 decision functions.

## Decisions

### 1. Declaration grammar mirrors `pipeline-does-not-reproduce`

    <!-- pipeline-needs-human-decision: <category> <override-key> <finding-fingerprint> <reviewed-sha> | <one-line decision request> -->

- **Why**: the #391 sentinel already solved fixed-field parsing with a free-text tail: an
  anchored full-line regex with a ` | ` delimiter so arbitrary punctuation in the tail cannot
  break the fixed fields. Reusing the shape means one grammar for the fix harness to learn and
  one parser idiom to review.
- `<category>` ∈ `product-decision` | `authority` | `external-dependency`, matched by literal
  alternation in the regex — an unknown category simply fails to parse, so the round fails closed
  rather than silently accepting an invented category.
- `<finding-fingerprint>` is required for the same reason as in #391: the coarse 8-hex
  `override-key` can be minted for several distinct findings in one review, and only the verbatim
  `<!-- finding-fingerprint: ... -->` value identifies which finding is meant. A declaration
  whose `(key, fingerprint)` matches no rendered finding is dropped.
- `<reviewed-sha>` must equal the current worktree `HEAD` — the tree the harness actually saw.
  This is the same staleness guard #391 uses; it prevents a declaration copied from an older
  round (or from another issue) being honoured against a tree that has since moved.

### 2. Precedence: human-decision is evaluated before the #391 advance

On the no-commit path, order is: `decideExternalCommitAdvance` → **human-decision** →
does-not-reproduce → `no-commits` block.

- **Why**: the two outcomes are not symmetric. Does-not-reproduce advances; human-decision parks.
  If a round declares finding A non-reproducing and finding B needs a product decision, advancing
  would carry an unresolved blocker forward. Evaluating human-decision first makes "any valid
  human-decision declaration ⇒ park" an invariant that cannot be defeated by declaration
  ordering or by partial coverage.
- Consequence: the #391 advance can only be reached when **zero** human-decision declarations are
  accepted. The existing #391 code path and its decision function are untouched.

### 3. New `BlockerKind`, no new `HumanInterventionKind`

`"human-decision-required"` is added to `BLOCKER_KINDS` (+ a `BLOCKER_RECIPES` entry, which
`blocked-recipes.test.ts` enforces) and mapped in `blockerKindToInterventionKind` to the existing
`"product-judgment-required"`.

- **Why a new BlockerKind**: the blocker kind is what the run artifact and the "How to unblock"
  recipe key off. Reusing `"needs-human"` would produce a review-ceiling-shaped recipe ("fix the
  findings above or `--override`") that is wrong here — the resolution is a human *decision*
  recorded via `--unblock`, possibly followed by re-scoping the issue.
- **Why no new intervention kind**: `human-intervention-taxonomy` already defines
  `"product-judgment-required"` — "a stage defers to a human for a product decision" — which is
  exactly this. Adding a member would be gratuitous surface with a forward-compatibility cost.

### 4. Park, do not disposition

The park posts a `## Pipeline: Human decision required` comment per accepted declaration, via a
new `humanDecisionComment(...)` in `review-policy.ts` wrapped in the same
`attestPipelineComment` envelope as the other pipeline-authored comments.

- **It is not an override.** It uses its own heading and sentinel
  (`<!-- pipeline-human-decision: ... -->`), and — unlike
  `extractNonReproducingDispositions` — **nothing reads it back to suppress a finding**. It is
  evidence for the human and for the audit trail, full stop. This is the hard boundary the issue
  demands: a harness must never self-certify a review finding.
- The blocking findings stay blocking. A later `--override` by a trusted author is the only thing
  that can disposition them, exactly as today.

### 5. Fail-closed everywhere

Absent, malformed, unknown-category, stale-SHA, unmatched-identity, or empty-request declarations
are ignored — they are simply not accepted, and the round falls through to the unchanged
`no-commits` block. There is no partial-credit path and no "best effort" parse.

## Risks / Trade-offs

- **Risk: the harness reaches for the human-decision outcome to avoid hard work.** Mitigated by
  (a) the outcome being strictly *worse* for the agent than fixing — it parks the item and
  resolves nothing; (b) the closed category set; (c) the required per-finding decision request
  being posted verbatim under the agent's name in a durable comment, so a weak invocation is
  visible to the operator immediately.
- **Trade-off: one more branch on the no-commit path.** Accepted; the alternative (overloading
  the #391 declaration with a "kind" field) would blur an advance outcome and a park outcome into
  one grammar, which is precisely the conflation this issue exists to fix.

## Open Questions

- None blocking. Whether a parked human decision should also emit a dedicated `events.jsonl`
  event beyond the existing `blocker_set` + `human_intervention` pair is deferred: the existing
  pair already carries the category-bearing reason text.
