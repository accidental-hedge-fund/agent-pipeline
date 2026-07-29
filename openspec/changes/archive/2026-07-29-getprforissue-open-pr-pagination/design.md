## Context

`getPrForIssue` is the shared open-issue→PR resolver used by status, planning, review, pre-merge, deploy-ready, and other stages. Match rules live in pure `resolvePrForIssue` (branch prefix, then closing refs). The **fetch** that feeds it is still:

```text
gh pr list --json number,headRefName,isCrossRepository,closingIssuesReferences \
  --state open -L 100 -R <repo>
```

That is the same truncation class #511 fixed on the historical path: a repo-wide bounded list can omit the PR that belongs to the issue. `getPrForIssueAnyState` already resolves via the issue timeline (GraphQL, paginated backward) with an injectable `GhApiRunner` and regression tests in `gh-parsers.test.ts`. The open path was left on `-L 100`.

Living `pr-resolution` requires dual-strategy resolution from a candidate set that carries branch, fork flag, and closing refs in one list-shaped fetch — no body text, no per-PR `gh pr view` fan-out. Completeness of that candidate set was never spelled as a requirement; this change closes that gap for **open** resolution.

## Goals / Non-Goals

**Goals:**

- Open resolution never returns `null` solely because the matching open PR was past a hard first-page / first-100 cap.
- Keep dual-strategy semantics and pure `resolvePrForIssue` as the match authority where possible.
- Injectable I/O for unit tests (no real `gh`/network).
- Regression test that would have caught #623.

**Non-Goals:**

- Changing fork spoof rules or closing-ref case-insensitive repo matching (optional: if touching `parsePrList`, missing `isCrossRepository` may stay “unknown as non-fork” / `false` as today — do not broaden fork acceptance).
- Reworking `getPrForIssueAnyState` (already complete).
- Fixing every other `-L 100` call site in the repo (e.g. `getPrForBranch`) unless a shared complete-open-list helper makes that free and clearly correct.
- Auto-merge, GraphQL field inventing without verifying shapes, or new config keys.

## Decisions

### Decision 1: Prefer complete open-candidate enumeration + existing `resolvePrForIssue`

**Preferred approach:** Fetch **all** open PR candidates (or enough pages to exhaust open PRs) in list shape `{ number, headRefName, isCrossRepository, closingIssuesReferences }`, parse with `parsePrList`, resolve with `resolvePrForIssue`.

Ways to enumerate completely (implementation picks one after verifying real `gh` behavior):

1. **Paginated REST** — e.g. `gh api repos/{owner}/{repo}/pulls?state=open&per_page=100 --paginate --slurp` (same pagination class as `getOpenIssues` / improve list), mapping fields so `parsePrList` still works; or
2. **CLI multi-page** — if `gh pr list` can be driven with page/limit loops via an injected runner; or
3. **Issue-scoped GraphQL / search** — only if it still supplies branch + fork + closing refs for dual strategy without body-text matching.

Rationale: Dual strategy stays byte-compatible; pure resolvers stay the single source of match truth; tests inject multi-page list results.

**Rejected as sole strategy:** Raising `-L` to a larger constant (still a silent cap). **Rejected as sole strategy:** Timeline-only reuse of `getPrForIssueAnyState` without an open filter **and** without branch-prefix coverage — timeline does not encode “head starts with `pipeline/<N>-`” unless a connected/closing event exists; pure branch-prefix open PRs would regress.

### Decision 2: Injectable runner on the open path

Add a `GhApiRunner` (or narrow `listOpenPrs` dep) parameter to `getPrForIssue`, defaulting to production `ghRun`, mirroring `getPrForIssueAnyState`. Production callers stay zero-arg; tests pass multi-page fixtures.

If the design uses a dedicated `listOpenPrCandidates(cfg, run)` helper, export it for tests only as needed; keep public `getPrForIssue` signature backward-compatible for call sites (`cfg, issueNumber` required; optional third arg for run).

### Decision 3: Safety bound, not a silent product cap

Pagination may include a high safety max pages (like any-state’s 40×50 timeline bound) so a runaway API cannot loop forever. That bound MUST be far above realistic open-PR counts for supported repos **or** the implementation MUST fail visibly when the bound is hit without exhausting pages — never return `null` as if no PR exists after truncating mid-list.

### Decision 4: Field shapes verified, not guessed

Before coding REST/GraphQL field maps, confirm real output for closing refs and `isCrossRepository` (golden rule #5). Prefer reusing existing `parsePrList` / `normalizeClosingRefs` shapes. Do not invent `nameWithOwner` if gh still emits nested `repository.owner.login` + `name`.

### Decision 5: Optional head-prefix short path

An optional optimization — query open PRs by head `pipeline/<N>-*` / search first — MAY reduce work on huge repos **if** incomplete prefix search cannot miss a closing-references-only match. If the short path misses, fall through to complete enumeration. Spec outcomes care about correctness; the short path is optional.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| More API volume on repos with many open PRs | Page until match found then stop early if implementation can resolve mid-stream **without** missing a better branch-prefix match that appears later; document order. Prefer early-exit only when resolution strategy order is preserved (branch prefix scan needs full set OR a dedicated head query first). Safest: complete list then resolve; optimize later if measured. |
| REST pulls field shape differs from `gh pr list --json` | Map explicitly; unit-test parser with fixture matching verified shapes. |
| Early-exit after first match breaks “branch prefix over later closing ref” | Keep strategy order: either full list + existing two-pass `resolvePrForIssue`, or guaranteed branch-prefix query first. |
| Shared helper accidentally changes `getPrForBranch` | Only touch `getPrForBranch` if completeness is intentional and tested; otherwise leave it. |
| Timeline-only shortcut regresses branch-prefix-only PRs | Do not ship timeline-only without proving branch-prefix coverage. |

## Migration Plan

- Behavioral fix only; no config, labels, or schema migration.
- Deploy by merging the usual pipeline PR; all callers pick up the new fetch immediately.
- Rollback: revert the `gh.ts` + test + plugin mirror commits.

## Open Questions

- Exact complete-list transport (`gh pr list` paging vs `gh api .../pulls --paginate` vs GraphQL) — resolve during implementation by verifying field shapes and pagination flags; design requires completeness, not a specific CLI flag.
- Whether early-exit mid-pagination is safe under dual-pass resolution — default to full open enumeration unless a head-prefix-first path is proven complete for strategy 1.
