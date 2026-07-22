# Design — delta review resolution context

## Context

`enforceReviewShaGate` (core/scripts/stages/pre_merge.ts) already builds a `PriorRoundDigest` from
the durable comment thread and passes it to `runDeltaReview`, and `buildDeltaReviewPrompt` renders
it via `priorRoundsDigestSection`. `settledFindings(digest)` already classifies entries with
`resolution` of `resolved-by-fix` or `overridden` as settled, and `partitionFindings` already
demotes an *unacknowledged reversal* of a settled finding.

What is missing is verification capability, not memory: the reviewer is shown only the delta diff,
so a claim of the form "the prior finding is still unfixed — this delta doesn't touch it" is
unfalsifiable from the prompt. The #451 evidence is exactly that shape: three settled findings
re-asserted with narrow-delta rationale and head code that contradicts them.

## Decisions

### D1 — Reuse the digest as the source of truth; add no new durable artifact

The resolved-finding verification context is a *rendering* of `settledFindings(priorRoundsDigest)`,
which is already derived from durable PR evidence and already trust-gated on the authenticated
actor. No new comment marker, no run-local state.

**Rationale:** #389 established that cross-round memory must survive a crashed run, a fresh clone,
and a host switch. Introducing a parallel source would give two things that can disagree.
**Alternative rejected:** recomputing resolution status by re-reading fix commits — needs git
history the reviewer path does not have and duplicates the digest's trust model.

### D2 — HEAD file state comes from the delta reviewer's worktree at the reviewed head

Surfaces are `<file>|<category>` (`surfaceKey`). The file component of each settled surface is
resolved against `deltaWorktreePath` — the same directory the delta diff is computed from (#371) —
so the content the reviewer is shown is exactly the state its verdict will be recorded against.
Reads go through an injectable seam (`readHeadFiles`) so unit tests do no filesystem I/O, matching
`ShaGateDeps`.

**Rationale:** `cfg.repo_dir` is not fetched mid-run and can lag the branch head; the worktree
authored the commit.
**Alternative rejected:** `gh api` blob fetches — an extra network dependency for content already
on disk, and it can race the head.

### D3 — Bounded, disclosed truncation; deterministic ordering

Files are emitted in ascending path order, deduplicated across surfaces, with a per-file cap and a
total cap; anything trimmed is marked `(truncated)` in-band. A missing or unreadable file is
rendered as an explicit `(file not present at HEAD)` note rather than silently omitted — a deleted
file is itself evidence about resolution.

**Rationale:** the delta prompt already truncates the diff at 50KB; unbounded file injection would
blow the reviewer context and change the diff's effective budget. Determinism keeps the prompt
drift-guardable by a test and keeps `verdict-diff-hash` reasoning stable.

### D4 — Evidence rule extends the existing demotion path, it does not add a new one

A delta finding whose `surfaceKey` matches a settled finding's surface and which cites no HEAD-state
evidence is routed through the same advisory partition the #389 reversal machinery uses, with a
distinct reason so the comment and the run event can name it. The reviewer contract stays "cite the
current file state"; the *absence* of that citation is what demotes, so a genuine regression found
by reading HEAD still blocks.

**Rationale:** two competing demotion mechanisms on the same surface would make dispositions
ambiguous and double-report in the comment.
**Alternative rejected:** hard-suppressing any finding on a settled surface — that would mask real
regressions in exactly the files most likely to have been churned by fixes.

### D5 — Absent when there is no settled history

No settled findings (first delta round, or the fail-closed `actor: null` digest) ⇒ no section, no
file reads, prompt byte-identical to today. This keeps the non-OpenSpec and first-delta paths
untouched and gives the drift guard a clean negative case.

## Risks

- **Prompt budget.** Mitigated by D3's caps; the caps are constants next to the existing 50KB diff
  cap so the total is reviewable in one place.
- **Reviewer gaming the evidence rule** by pasting a token file reference. Accepted: the rule
  raises the floor from "assume persistence" to "look at the file"; the severity/confidence policy
  and the delta-round ceiling (#483) remain the backstops.
- **Surface drift.** A settled finding whose file was renamed by the delta will render as not
  present at HEAD; that is correct — it tells the reviewer to verify rather than assume.
