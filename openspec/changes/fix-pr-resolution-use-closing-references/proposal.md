## Why

`getPrForIssue` falls back to scanning PR body text for any mention of the issue number (`#42`, `Fixes #42`, etc.), which matches PRs that merely reference the issue — not ones that close it. This causes `--status` (and potentially planning/review/pre-merge/deploy-ready stages) to resolve the wrong PR when an unrelated PR happens to mention the issue number in its body.

## What Changes

- Replace the loose body/text fallback in `getPrForIssue` with a `closingIssuesReferences` lookup: for each candidate PR returned by `gh pr list`, fetch its `closingIssuesReferences` (via `gh pr view --json closingIssuesReferences`) and match only if the issue number appears there.
- Remove the broad `#N` and keyword-prefixed text-search fallback entirely.
- Keep the branch-prefix match (`pipeline/<N>-*`) as the fast first check — it is already correct.
- Return `null` when neither the branch prefix nor closing references match, rather than returning a false positive.
- The fix covers all 5 call sites that share this function: `--status` display (pipeline.ts), planning, review, pre-merge, and deploy-ready stages.

## Capabilities

### New Capabilities

- `pr-resolution`: Authoritative issue→PR resolution: branch-prefix first, closing references second, null otherwise. No body-text matching.

### Modified Capabilities

<!-- No existing spec-level capabilities change requirements — this is a new correctness capability. -->

## Impact

- `core/scripts/gh.ts` — `getPrForIssue` function (the only change site)
- All 5 callers inherit the fix automatically: `core/scripts/pipeline.ts` (status), `core/scripts/stages/planning.ts` (×2), `core/scripts/stages/review.ts`, `core/scripts/stages/pre_merge.ts`, `core/scripts/stages/deploy_ready.ts`
- Adds one extra `gh pr view` API call per candidate PR in the fallback path (bounded by the 100-PR list cap; fast-path branch match avoids this for most pipeline PRs)
- No schema or config changes required
