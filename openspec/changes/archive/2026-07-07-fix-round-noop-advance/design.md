# Design — fix-round-noop-advance

## Context

Two independent no-op paths converge on the same dead-end in `advanceFix`
(`core/scripts/stages/fix.ts`): the harness makes no commit, `trySalvageUncommittedWork`
finds nothing, `decideExternalCommitAdvance` fails closed, and the round blocks with
`blockerKind: "no-commits"`. The two paths need different handling:

- **Overrides** are known *before* the harness runs → pre-filter the fix scope at
  entry, and skip the harness entirely when nothing remains.
- **Non-reproduction** can only be determined *by running* the harness (it has to
  inspect the code at the reviewed SHA) → classify the no-commit outcome *after*
  the harness returns.

## Decision 1 — Override consultation is a fix-entry pre-filter, reusing the review-time identity

The fix stage already derives its scope from the triggering review comment via
`extractBlockingReviewFindings`, which subtracts advisory findings using the review
comment's frozen `pipeline-blocking-keys` marker. That marker is a snapshot from
*review* time and does not reflect overrides recorded afterward (the exact gap that
`override-auto-resume` exposes).

At fix entry we additionally subtract the **live** overrides:

1. `buildTrustedOverrideComments(detail.comments, fixActor, cfg.trusted_override_actors)`
   — the fix stage already builds this for the acknowledgement gate; reuse it.
2. `extractOverrides` (key → disposition) and `extractScopedOverrides` (scope list)
   over the trusted comments.
3. Match each triggering-review blocking finding by `findingKey` (key overrides) and
   by `matchFindingScope` (scope overrides) — the same identity functions
   `partitionFindings` uses (`review-severity-policy` / `stable-finding-identity`),
   never a re-implementation.

Effective blocking set = triggering blocking findings − overridden. If empty →
advance without invoking the harness. If partial → the harness is invoked with only
the remaining findings rendered into the prompt (surgical-fix discipline is
preserved — the harness is never told to fix a dispositioned finding).

**Why reuse `findingKey`/scope rather than the frozen marker:** the frozen marker
cannot capture a disposition made after the comment was posted. `stable-finding-identity`
guarantees the key is stable across rewordings, so a review re-emitting the same
finding still matches its recorded override.

**Resolves open question 2 (mixed set):** the harness runs scoped to only the
actionable subset; overridden findings are excluded from the prompt entirely rather
than passed as "context." This matches the existing `filterToBlockingFindings`
behavior for advisory findings and the surgical-fix discipline.

## Decision 2 — "Does not reproduce" is a controlled harness declaration, validated by the stage

`HarnessResult.stdout` already captures the harness output (capped at 100 KB). The
fix prompt gains a sanctioned outcome: when the harness makes no change because an
assigned blocking finding does not reproduce at the reviewed SHA, it emits one
controlled machine-readable declaration **per finding**, carrying:

- the finding's stable key (as displayed in the fix prompt via `override-key: <8hex>`),
- the reviewed SHA it assessed against, and
- a one-line justification (why the finding is a non-issue / tooling artifact).

On the no-commit path, before the `no-commits` block, the fix stage:

1. Parses the harness output for these declarations (a controlled sentinel shape,
   analogous to `pipeline-override`; the exact bytes live in `fix.md` and are
   drift-guarded in `prompt-loader.test.ts`).
2. Validates each declaration: its key MUST belong to the **invoked** blocking set,
   and its reviewed SHA MUST equal the current worktree `HEAD` (the tree the harness
   actually saw). Declarations that fail validation are ignored (fail closed).
3. Advances only when **every** invoked blocking finding is covered by a valid
   declaration. Any finding left neither committed nor validly declared falls
   through to the existing `no-commits` block.

**Why parse harness output rather than require a commit:** a non-reproducing finding
by definition needs no code change; forcing a no-op commit would be dishonest and
would trip the surgical-fix / commit-message gates. Trusting the harness's own word
is bounded by Decision 3 and Decision 4.

## Decision 3 — Auto-record the disposition, but SHA-anchored (resolves open question 1)

The original proposal text ("recommend override") is ambiguous between auto-record
and confirm-then-record. We auto-record — otherwise the dead-end persists and the
operator is back to manual surgery, defeating the issue — **but** the recorded
disposition is deliberately weaker than an operator `--override`:

- It is a **distinct** audited sentinel (a non-reproducing disposition, not a
  `pipeline-override`), authored by the pipeline actor so it round-trips through the
  trusted-comment filter, carrying the finding key **and the reviewed SHA**.
- It is **SHA-anchored**: consulted on a later fix/review entry only when the
  reviewed SHA still matches. A key `--override` is unconditional and human-authored;
  a non-reproducing disposition is a falsifiable, machine-authored claim scoped to
  one exact tree. Any new commit (SHA change) drops the disposition and the finding
  is re-evaluated from scratch.

This satisfies "recorded and consulted on subsequent runs so the same dead-end does
not recur at the same SHA" while refusing to let the implementer permanently wave
off a reviewer finding.

## Decision 4 — The advance target is always a review stage, so the claim is re-checked

Round 1 advances to `review-2` (a fresh adversarial review) and round 2 advances to
`pre-merge`, whose #16 SHA gate re-reviews the pushed head. So a does-not-reproduce
self-assessment is **never the final word** — the implementer asserting a reviewer
finding is a non-issue is independently re-examined downstream. This is what keeps
the change rigor-preserving (golden rule 3): it removes a spurious dead-end, not a
review.

## Interaction with `fix-external-commit-advance`

That capability already governs the no-commit decision point: advance when HEAD is
past the reviewed SHA (a human pushed the fix), else block. This change adds two
carve-outs *before* the fail-closed block — an empty effective blocking set, and a
valid does-not-reproduce declaration set — so its "block when HEAD equals reviewed
SHA" requirement is modified to yield to those cases. The external-commit advance
path (HEAD moved past the reviewed SHA) is unchanged.

## Testability

Both decisions run over data the fix stage already holds (`detail.comments`, the
worktree `HEAD`, and `result.stdout`) and are exercised through the existing
`AdvanceFixDeps` seams — no real network, git, or subprocess. Regression tests
cover: all-overridden skip-advance, partial scope, all-non-reproducing advance,
partial no-op still blocks (fail closed), invalid declaration ignored, and
SHA-anchored disposition consultation across a re-entry. Each test bites against the
pre-change fix stage.
