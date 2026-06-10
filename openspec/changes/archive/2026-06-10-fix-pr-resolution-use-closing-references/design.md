## Context

`getPrForIssue` in `core/scripts/gh.ts` is the single function that maps an issue number to its associated PR across all 5 pipeline stages. It currently uses two strategies:

1. **Branch-prefix match** (correct): checks if any open PR's head branch starts with `pipeline/<N>-`.
2. **Body/text fallback** (buggy): scans title+body for keywords like `Closes #N`, `Fixes #N`, `Resolves #N`, `Refs #N`, or bare `#N`. The bare `#N` pattern is far too broad — any PR mentioning the issue number matches, even unit-test fixtures.

The sibling function `getPrLinkedIssue` (PR→issue direction) already uses `gh pr view --json closingIssuesReferences` correctly. The inverse direction (issue→PR) should use the same API.

## Goals / Non-Goals

**Goals:**
- Make `getPrForIssue` authoritative: only return a PR that actually closes the issue (via closing references) or is on the pipeline branch for the issue.
- Eliminate false positives from body-text matching.
- Cover all 5 call sites without changing their signatures.

**Non-Goals:**
- Changing the PR→issue resolution path (`getPrLinkedIssue`) — it already works correctly.
- Handling closed PRs — the existing `--state open` filter is correct and unchanged.
- Handling draft PRs specially — no change to current behavior.

## Decisions

### Decision: Per-PR closing-reference lookup, not a list query

`gh pr list` does not support `closingIssuesReferences` as a JSON field (it is not available in the `list` subcommand). The only way to retrieve it is `gh pr view <N> --json closingIssuesReferences`.

**Options considered:**

A. Iterate `gh pr view` for each PR in the list — adds N extra API calls but is straightforward and bounded by the 100-PR list cap. The branch-prefix fast path eliminates this cost for any pipeline PR on the standard naming convention.

B. Use the GitHub GraphQL API directly — more powerful but introduces a new dependency (raw `gh api graphql`), is harder to mock in tests, and the `list` → `view` pattern already exists in the codebase (`getPrLinkedIssue` uses it).

**Choice: Option A.** Keeps the implementation pattern consistent with the existing `getPrLinkedIssue`. In practice, pipeline PRs match on branch prefix (zero extra calls); the closing-references path only activates for non-pipeline-branch PRs (rare).

### Decision: Remove all keyword/body-text matching

Keyword patterns like `Closes #N` could still produce false positives (any PR can include these phrases in its body when explaining context). The `closingIssuesReferences` API is authoritative at the GitHub layer — it reflects what GitHub actually considers a closing link. Replacing the heuristic entirely eliminates the class of bugs.

## Risks / Trade-offs

- **Extra API calls**: For repos with many open PRs and no pipeline-branch match, this adds up to 100 `gh pr view` calls. → Mitigation: branch-prefix check remains first; most pipeline issues will match there and skip the fallback entirely.
- **Rate limiting**: 100 extra calls is well within GitHub's REST API rate limit (5000/hr for authenticated users). → No mitigation needed for typical usage.
- **Closing references not set**: If a PR body uses `Closes #N` syntax but GitHub hasn't indexed the closing reference (e.g., draft PRs, cross-repo references), it won't be returned by `closingIssuesReferences`. → Acceptable: this is the correct authoritative signal; the branch-prefix check handles pipeline PRs.

## Migration Plan

- Single-function change in `core/scripts/gh.ts`; all callers are unaffected.
- Plugin mirror (`plugin/`) must be rebuilt after the change (existing convention via `build.mjs`).
- No config or schema changes; no data migration.
