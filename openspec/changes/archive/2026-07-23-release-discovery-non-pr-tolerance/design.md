## Context

`discoverShippedPRs` (`core/scripts/stages/release.ts`) scans `git log <lastTag>..HEAD`
subjects and collects PR numbers from two shapes:

- `Merge pull request #N` — a standard GitHub merge commit (`MERGE_PR_RE`).
- a trailing `(#N)` — the last parenthetical on a squash-merge subject (`SQUASH_PR_RE`),
  since pipeline squash commits are `title (#issue) (#pr)`.

The problem: a **non-PR** commit can also end in `(#N)` where `#N` is an *issue*, not a
PR — e.g. a release-prep docs commit `docs: ... (#451)`. The squash regex captures it,
so `#451` enters the shipped set. Later, `collectShippedIssueNumbers` calls
`fetchPRClosingIssues(451)`, whose `gh pr view 451 --json closingIssuesReferences` exits
non-zero ("Could not resolve to a PullRequest"), which throws → `hadFailures = true` →
the release aborts.

## Goals / Non-Goals

- **Goal**: a mis-parsed non-PR `(#N)` no longer aborts the release; it is dropped with a
  warning and produces no Shipped row.
- **Goal**: preserve the safety net — a *genuine* API failure on a real PR still aborts,
  so an incomplete per-issue ROADMAP stamp is never silently written (#170 rigor).
- **Non-Goal**: syntactic-only filtering of subjects. A squash-PR subject and a non-PR
  docs subject can both end in `(#N)`; they are indistinguishable without asking GitHub
  whether `#N` is a PR. So a semantic check is required.
- **Non-Goal**: handling multi-issue suffixes like `(#433, #434)` — `SQUASH_PR_RE`
  already never matches them (the `)` does not immediately follow the digits), so they
  are correctly ignored today.

## Decision

Classify each candidate number by whether GitHub reports it as a pull request, and act
on three outcomes instead of two:

1. **Is a PR** → keep it (existing behavior: title enrichment + closing-issue lookup).
2. **Not a PR** (the "Could not resolve to a PullRequest" class) → **exclude** the number
   from the shipped set with a warning; no Shipped row, no closing-issue lookup, no
   abort. This is the false-positive parse of an issue suffix.
3. **Genuine failure** (network / auth / rate-limit — any non-zero that is *not* the
   not-a-PR class) → keep the existing abort path (`hadFailures`), because the number may
   be a real PR whose issues we could not read.

The not-a-PR classification is done at **discovery** time (in `discoverShippedPRs`), so an
excluded number never reaches `collectShippedIssueNumbers` and never appears as a bogus
`| PR #451 | … |` Shipped row. `Merge pull request #N` numbers bypass validation — a
merge commit is unambiguously a PR.

Detection uses the `gh` error surface, which is single-sourced through a `ReleaseDeps`
seam so it can be faked in unit tests (no real network/git). The "not a pull request"
signal is GitHub's stable GraphQL message ("Could not resolve to a PullRequest") /
REST 404 for the pulls endpoint; the classifier matches that class specifically and
treats everything else as a transient/genuine failure (fail-safe: an unrecognized error
falls through to the abort path, never to silent exclusion).

## Risks / Trade-offs

- **False exclusion of a real PR**: only if GitHub misreports a real PR as "not a
  PullRequest". Mitigated by matching the not-a-PR class narrowly and defaulting every
  other error to the abort path.
- **Extra API call**: discovery already fetches a title per candidate in live mode; the
  PR/non-PR classification can reuse that same `gh pr view` result rather than adding a
  round trip.

## Migration

None. Behavior change is confined to `pipeline release`; the dry-run path (`localOnly`)
makes no GitHub calls and is unchanged. No config keys added.
