## Why

`pipeline release` still treats `ROADMAP.md` release-plan rows and per-issue plan stamps as blocking authorities, while `pipeline roadmap --apply` already writes GitHub Milestones as the real release plan. Those two stores drift: v1.35.0 planned `[#901, #765]` in ROADMAP while the milestone shipped `[#910, #978, #980, #983]`, and release aborted with "none could be stamped." A file that claims to be the "forward-looking source of truth" cannot keep vetoing a valid milestone ship.

## What Changes

- **Milestone is the release-plan source of truth:** `pipeline release` derives the target version's planned issues from the matching GitHub milestone (already soft-fetched in `release.ts`), not from ROADMAP plan-table rows or per-issue `→ Release` stamps as the authority for "what was planned."
- **Theme resolution drops ROADMAP plan-row dependency:** theme order becomes CLI `--theme` → matching milestone title/description → documented placeholder. ROADMAP plan-row theme is no longer required for a successful prepare.
- **ROADMAP anchors become non-blocking for release plan integrity:** missing or stale `release-plan-row`, `release-plan-none-row`, and `shipped-section` (and the "planned rows but none stampable" gate that encodes plan/reality mismatch against ROADMAP) SHALL NOT abort a release whose milestone membership and shipped-PR discovery are otherwise consistent. Optional ROADMAP writes remain best-effort / derived documentation when anchors exist.
- **ROADMAP provenance corrected:** if `ROADMAP.md` is retained, its header and operator-facing docs MUST stop calling it the release-plan source of truth; it is derived/human-readable documentation. Full auto-regenerate of ROADMAP is out of scope for this change unless already covered by existing tooling.
- **Status / dry-run visibility:** dry-run (and any release status/report path used for prepare preview) surfaces whether a milestone exists for the resolved version and how many open (and, when available, total) issues it has.
- **Regression coverage** for: milestone present with matching shipped issues; milestone absent; milestone vs ROADMAP drift (v1.35.0 class); stale ROADMAP not blocking; dry-run milestone summary.
- **Docs / mirror:** CLI/help/generated docs and `plugin/` stay in sync after implementation.

**BREAKING (operator-facing):** a release that previously aborted solely because ROADMAP plan rows disagreed with shipped PRs will now proceed when the GitHub milestone is the plan source (or when no blocking milestone integrity failure exists). Operators who relied on ROADMAP as a hard gate must use milestones (or explicit manual edits) instead.

## Acceptance Criteria

- [ ] Live `pipeline release <version>` (or its shared prepare entry) loads planned issue numbers for that version from the matching GitHub milestone membership, not from parsing ROADMAP release-plan table rows as the plan authority.
- [ ] Theme for the release PR title / scaffold uses `--theme` when set; otherwise the matching milestone title (or documented extraction); otherwise a documented placeholder — without requiring a ROADMAP plan-row theme cell.
- [ ] A stale or missing ROADMAP `release-plan-row` / `release-plan-none-row` / `shipped-section` does **not** cause a non-zero abort when milestone-based plan resolution and shipped-PR discovery succeed.
- [ ] The v1.35.0-class failure mode does **not** block: shipped PRs close milestone issues while ROADMAP still lists different planned issue numbers (or planned rows that cannot be stamped) — release prepare continues (optional ROADMAP stamp remains best-effort / advisory).
- [ ] When no matching milestone exists for the resolved version, dry-run/status reports that absence explicitly; live behavior is documented and deterministic (fail closed with remediation naming `pipeline roadmap --apply` / create milestone, or proceed with empty plan set + warnings — pick one in design and implement consistently).
- [ ] Dry-run (or release prepare preview) prints milestone present/absent and open-issue count for the resolved version without writing release-managed files.
- [ ] Unit tests cover: milestone present + matching shipped issues; milestone absent; milestone/ROADMAP drift (stale ROADMAP does not block); at least one test fails against pre-change abort-on-ROADMAP-stamp behavior (bite proof).
- [ ] ROADMAP header / release help / generated CLI docs no longer claim ROADMAP is the release-plan source of truth; they state GitHub milestones are authoritative for planned membership.
- [ ] After implementation: `node scripts/build.mjs` (when hosts/core docs change require it), `plugin/` mirror current, and `npm run ci` passes.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `release-sub-command`: Milestone-sourced plan membership; theme fallback order without ROADMAP plan-row authority; demote blocking ROADMAP plan anchors and the planned-vs-stampable abort; dry-run/status milestone summary; tests and docs contract.
- `generated-changelog`: Clarify that `ROADMAP.md` is derived/human-readable forward planning documentation, not the authoritative release-plan store (milestones are).

## Impact

- **Code:** `core/scripts/stages/release.ts` (plan resolution, pre-validate anchors, stamp gates, dry-run reporting, theme resolution); possibly CLI help in `pipeline.ts` / `command-docs.ts`; ROADMAP header text if edited as docs contract during release or as a one-time provenance fix in-repo.
- **Tests:** `core/test/release.test.ts` (and any dry-run/status fixtures).
- **Docs:** release usage, host SKILL if it documents ROADMAP as plan authority, generated CLI/config docs when the generator is present; `plugin/` mirror via `build.mjs` when core/hosts change.
- **Specs:** living `release-sub-command` and a small provenance tweak in `generated-changelog`.
- **Out of scope:** deleting `ROADMAP.md`; changing SemVer bump policy via milestones; changing `pipeline roadmap` write-back; auto-merge / tag / publish authority; full ROADMAP auto-regenerate pipeline (demote authority first; optional regenerate later).
