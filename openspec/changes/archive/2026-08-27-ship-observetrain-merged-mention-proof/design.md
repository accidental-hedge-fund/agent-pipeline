## Context

See `proposal.md` for motivation. Production `observeTrain` already requires each planned issue's PR to be `MERGED` with merge OID ancestor of the candidate head. It fails before that proof: any-state lookup (`getPrForIssueAnyState` → `pickPrFromTimelinePage`) returns null unless the timeline has a `ConnectedEvent` or a `CrossReferencedEvent` with `willCloseTarget: true`.

Pipeline squash titles are `… (#N)`, not `Fixes #N` / `Closes #N`. GitHub records `CrossReferencedEvent` with `willCloseTarget: false`. Live v1.39.14:

| Issue | Merged PR | Timeline |
|---|---|---|
| #1258 | #1262 `f71c4251` | CrossReferencedEvent, willCloseTarget=false |
| #1259 | #1263 `28e04331` | same |
| #1252 | #1267 `c75522cd` | same |

`convergeTrain` already skips `runTrain` when observation succeeds. The coordinator mole is not a second skip; the lookup is wrong.

`pr-resolution` forbids title/body search on the **open** path (`getPrForIssue`). That law stays. This change extends **any-state** lookup only.

### Engine-dogfood bar (#1269)

1. **Class vs site.** Class: any-state issue→PR resolution used for integration proof ignores GitHub non-closing `CrossReferencedEvent` records from pipeline squash titles `… (#N)`. Site: v1.39.14 `observeTrain` after `train --merge`. The resume STOP `ready-to-deploy but has no linked open PR` is the same class hitting train merge-wave.
2. **Shared law.** Change the shared any-state picker / `getPrForIssueAnyState` (consumed by `observeTrain` and train merge-wave). Do not add a ship-only second lookup.
3. **Next identical fault.** A later ship whose train squash-merges `… (#N)` titles (no `Fixes #N`, no Development sidebar) observes complete train evidence and continues FRG/release without a new mole.

## Goals / Non-Goals

**Goals:**

- Shared any-state match accepts ConnectedEvent, closing `willCloseTarget`, `pipeline/<N>-*` head, and title parenthetical `(#N)` for same-repo PRs.
- `observeTrain` returns complete evidence when those PRs are merged and contained; `convergeTrain` does not call `runTrain`.
- Train merge-wave classifies the same items already-integrated.
- Keep fork exclusion and mere-mention exclusion.

**Non-Goals:**

- Open-path `getPrForIssue` title search (conflicts with living `pr-resolution`).
- Requiring `Fixes #N` in pipeline commit titles.
- Hand-running FRG/release around a null observe.
- Unknown keys / profile-filled harnesses (#1264).
- Changing FRG, release, tag, or promote mutation once train evidence exists.
- Repo-wide `gh pr list --state all` (rejected in #511).
- `auto_merge` config or merge inside advance/loop.

## Decisions

### 1. Class fix in the shared any-state picker, not a ship-local fallback

**Choice:** Extend `pickPrFromTimelinePage` (and the GraphQL PR fragment) so `getPrForIssueAnyState` returns the pipeline PR. Pass issue number N so the picker can match `pipeline/<N>-*` and `(#N)`. `observeTrain` and train merge-wave keep their existing merged + ancestor checks.

**Why:** Both failure messages in the incident (`external integration proof is incomplete` and `ready-to-deploy but has no linked open PR`) are null lookup, then fail-closed. A ship-only fallback would leave train resume broken.

**Alternatives considered:**

- Ship-only second lookup in `observeTrain` → rejected: class-over-site; resume still STOPs in `runTrain`.
- Accept every `willCloseTarget: false` CrossReferencedEvent → rejected: #511 mere-mention false positives; keep the existing test for non-pipeline mentions.
- Require operators to use `Fixes #N` in squash titles → rejected: issue decision; merges on main are sufficient proof.
- Repo-wide `gh pr list --state all` for merged pipeline heads → rejected: #511 window/truncation; stay on the issue timeline.

### 2. Identities: branch prefix and parenthetical `(#N)`, not body text

**Choice:** Match (a) head starts with `pipeline/<N>-` (already on the GraphQL fragment as `headRefName`) and/or (b) PR title contains the parenthetical `(#N)`. Do not scan PR bodies. Do not match bare `#N`.

**Why:** v1.39.14 PRs are pipeline heads whose squash titles mention `(#N)`. Title parenthetical covers a same-repo PR that is not on the pipeline branch prefix. Body search is the false-positive class `pr-resolution` already forbids.

**Alternatives considered:**

- Title-only, no branch prefix → weaker; pipeline head is the strong identity and is already fetched.
- Branch-prefix only → misses a same-repo merged PR that used `(#N)` without `pipeline/<N>-*`. Issue lists both.

### 3. ObserveTrain stays merged + ancestor; no open PR required

**Choice:** After lookup succeeds, keep the current `observeTrain` loop: state `MERGED`, merge OID present, OID ancestor of candidate, finite `mergedAt`. Do not add an open-PR requirement. Do not treat closed-unmerged as integrated.

**Why:** Lookup is the bug. Containment is already the integration proof. `convergeTrain` already returns observed evidence without `runTrain`.

**Testing seam:** Export or deps-inject the any-state picker (already exported) and drive `observeTrain` through injectable gh/git deps so the three-issue fixture does not use real network. If production `observeTrain` stays closed inside `realShipCoordinatorDeps`, extract a small injected helper for the per-issue merged+ancestor proof. Coordinator `next_action` is already `frg_pack` when `progress.train` is set.

### 4. Open-path resolution unchanged

**Choice:** `getPrForIssue` stays branch-prefix + `closingIssuesReferences`. No title search on open PRs.

**Why:** Living `pr-resolution` forbids it. Open pipeline PRs already match `pipeline/<N>-*`. The incident is post-merge any-state.

## Risks / Trade-offs

- **[Risk] Title `(#N)` matches an unrelated same-repo PR.** → Mitigation: parenthetical form only, not bare `#N`; `observeTrain` / train still require MERGED + ancestor; newest-first scan; unit-test a non-pipeline mention that stays null.
- **[Risk] Changing the picker signature (issue number) breaks existing tests.** → Mitigation: keep newest-first ConnectedEvent / `willCloseTarget: true` cases; extend the mere-mention test so a non-pipeline `willCloseTarget: false` node still returns null.
- **[Risk] GraphQL fragment omits `title`.** → Mitigation: add `title` on the PullRequest selections used by any-state timeline query; tests assert the query includes it when the title identity is required.
- **[Risk] Loop reconcile inherits broader matches.** → Mitigation: intended. Reconcile should observe those merged pipeline PRs as merged, not `external-absent`.

## Migration Plan

- Ship on v1.39.14 so the stuck milestone can finish through FRG → release → tag → promote.
- Rollback: revert the lookup change; ships with `(#N)` squash titles fail observe again.
- No data migration. No grant file. No operator `Fixes #N` rewrite.

## Open Questions

None. Identities, class-over-site, and "merges on main are sufficient proof" are settled by the v1.39.14 incident (2026-08-27).
