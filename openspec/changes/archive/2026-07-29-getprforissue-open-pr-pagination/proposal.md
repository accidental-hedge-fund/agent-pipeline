## Why

`getPrForIssue` still lists open PRs with a hard `gh pr list -L 100` cap, then runs dual-strategy resolution on that truncated set. Historical any-state resolution was fixed after #511 to stop silently dropping PRs past a 100-item window; the **open** path was not upgraded. On busy repos, the issue’s open PR can fall outside the first 100 open PRs → `null` → wrong status, duplicate PR create, or broken review handoff.

## What Changes

- Open-issue PR resolution SHALL enumerate open candidates completely (or use an issue-scoped equivalent that cannot silently truncate the repo-wide open list). No fixed `-L 100` hard cap that drops valid open PRs.
- Preserve existing dual-strategy resolution (branch prefix `pipeline/<N>-*` for same-repo PRs, then `closingIssuesReferences` in the target repo). No body/title text matching. No per-PR `gh pr view` fan-out for resolution.
- Add an injectable list / API runner seam on the open path (mirroring `getPrForIssueAnyState`) so unit tests can prove multi-page / beyond-first-window resolution without real network.
- Regression coverage for “matching open PR only appears after the first page / outside a 100-item window.”
- Regenerate `plugin/` when `core/` changes; `npm run ci` green.

## Capabilities

### New Capabilities

- _(none)_ — completeness hardening of existing open PR resolution.

### Modified Capabilities

- `pr-resolution`: Open-candidate enumeration for `getPrForIssue` MUST NOT silently truncate (paginate, issue-scoped GraphQL equivalent, or head `pipeline/<N>-*` query path that still feeds complete dual-strategy resolution). Existing match strategies and “no body-text / no per-PR view fan-out” invariants remain.

## Impact

- **Code:** `core/scripts/gh.ts` — `getPrForIssue` open-list fetch (and any small helper shared with complete list enumeration); optional deps/`GhApiRunner`-style injection for tests. Pure `resolvePrForIssue` / `parsePrList` stay authoritative for match rules unless the design chooses an issue-scoped path that reuses the same semantics.
- **Tests:** `core/test/gh-parsers.test.ts` (or adjacent) — multi-page / beyond-100 open resolution regression via injected list deps, same class as #511 any-state timeline tests.
- **Callers:** All stages that call `getPrForIssue` (status, planning, review, pre-merge, deploy-ready, shipcheck, eval, visual, etc.) inherit completeness; no per-stage logic change expected.
- **Out of scope:** Fork spoof rule changes; `getPrForBranch` hard cap (unless it shares the same list helper and a one-line completeness fix is free); historical any-state path (already fixed); auto-merge.
- **Mirror / CI:** After `core/` edits, `node scripts/build.mjs` and include regenerated `plugin/`; `npm run ci` must pass.

## Acceptance criteria

Observable, falsifiable outcomes that make #623 done:

- [ ] `getPrForIssue` no longer depends on a single `gh pr list ... -L 100` (or equivalent fixed first-page-only) open scan that can omit a valid open PR for the issue.
- [ ] When the only matching open PR would appear outside the first page / first 100 open PRs of a repo-wide list, `getPrForIssue` still returns that PR’s number (branch-prefix or closing-references match).
- [ ] Dual-strategy rules are unchanged: same-repo `pipeline/<N>-*` wins; else target-repo `closingIssuesReferences`; body/title mention alone still does not match; fork branch-prefix spoof still excluded.
- [ ] Unit tests inject list/API deps (no real network) and cover at least the “PR only on a later page / beyond a 100-item window” case; tests fail if the open path stops after one capped page.
- [ ] `npm run ci` is green; if `core/` changed, `plugin/` is regenerated in the same change set.
