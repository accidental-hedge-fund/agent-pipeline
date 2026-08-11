## Context

See `proposal.md` for motivation. Today `stages/release.ts` already soft-fetches a matching milestone (`fetchMilestoneForVersion`) for theme/plan-row **scaffold** only. Plan integrity gates still key off ROADMAP:

- Pre-validate requires ROADMAP anchors including `release-plan-row` / `release-plan-none-row` / `shipped-section` (ensure can insert a plan row, but other anchors still abort).
- Live path aborts when `countPerIssueRows` finds planned ROADMAP rows for the version but zero stampable matches against shipped closing-issues (v1.35.0 failure mode).

GitHub milestones are already written by `pipeline roadmap --apply` (`roadmap-release-model`). Release must consume that store as plan authority.

## Goals / Non-Goals

**Goals:**

- Single plan authority for `pipeline release`: matching GitHub milestone membership.
- Remove ROADMAP plan-table / stamp-mismatch as hard release blockers.
- Keep ROADMAP as optional derived documentation when anchors exist.
- Surface milestone presence and open-issue counts on prepare preview (dry-run).
- Preserve SemVer bump policy as an explicit operator/version argument (not invented from milestones).

**Non-Goals:**

- Deleting `ROADMAP.md` or rewriting intake/sweep to stop writing it.
- Full auto-regenerate of ROADMAP from milestones in this change.
- Changing `roadmap --apply` reconciliation, FRG, open-soak, CI gate, or release-finish.
- Expanding dry-run into live PR creation or write paths.

## Decisions

### D1 — Planned issues = milestone membership

**Choice:** For resolved version `X.Y.Z`, planned issue numbers are the non-PR issues assigned to the matching GitHub milestone (open + closed), using the existing title match rules (`vX.Y.Z` / bare version token). That set is the only plan authority for theme/issues columns, PR body "planned" context, and integrity checks that previously used ROADMAP per-issue plan rows.

**Alternatives:** Keep dual authority with ROADMAP preferred (status quo, drifts). Union ROADMAP ∪ milestone (still drifts, ambiguous).

### D2 — Theme order: CLI → milestone → placeholder

**Choice:** `--theme` wins; else documented extraction from milestone title (strip version prefix); else existing placeholder. **Do not** require or prefer the ROADMAP plan-row Theme cell for success.

**Alternatives:** Prefer ROADMAP theme when present (keeps file authority). Milestone description field first (less stable than title convention).

### D3 — Missing milestone: fail closed on live prepare

**Choice:** Under the SemVer release path (`pipeline release` already refuses `continuous`), live prepare **aborts non-zero** when no matching milestone exists for the resolved version, with remediation naming create-milestone / `pipeline roadmap --apply`. Dry-run **does not abort** solely for absence: it prints `milestone: absent` (and open count `n/a`) and continues the local diff preview.

**Rationale:** If milestones are SSoT, shipping without one reintroduces an unowned plan. Hotfix versions still get a milestone via roadmap apply or a one-line GitHub create.

**Alternatives:** Empty plan + warn and proceed (softer, reopens unowned plan). Treat absence as "plan = shipped closing issues only" (conflates plan with outcome).

### D4 — Stale ROADMAP never blocks plan integrity

**Choice:** Remove or demote these hard gates:

1. Abort when `release-plan-row` / `release-plan-none-row` / `shipped-section` anchors are missing after ensure (plan-related anchors only — keep real structural needs if still required for optional doc writes, but missing anchors must not fail the release when doc mutation is skipped).
2. Abort when `planned > 0 && stampable === 0` against ROADMAP per-issue rows.

Optional ROADMAP mutations (compact plan-row ship-mark, per-issue stamps, intro chain if still present) become **best-effort**: apply when anchors exist; skip with a warning when they do not. Release PR + version bump + CI + FRG remain the success path.

**Alternatives:** Keep stamp abort but key "planned" off milestone membership instead of ROADMAP (still useful as consistency check, but different failure mode — open follow-up if wanted). Force regenerate ROADMAP before ship (larger scope).

### D5 — Dry-run may perform read-only milestone fetch

**Choice:** Narrow exception to the historical "dry-run calls no GitHub API" rule: dry-run **MAY** call a read-only milestone + issue-count lookup for the resolved version to print:

- milestone present / absent / fetch_failed
- open issue count (and total non-PR count when cheap)

Still forbids file writes, commits, PRs, and any mutating GitHub calls. If fetch fails (offline), print `milestone: unavailable` and continue local diffs (do not invent membership).

**Alternatives:** Add a separate `pipeline release <ver> --status` flag (more surface area). Keep dry-run offline-only and only surface milestone on live (fails the issue's dry-run visibility ask).

### D6 — ROADMAP provenance text

**Choice:** Correct the ROADMAP header (and release/help docs that restate it) so it no longer claims "forward-looking source of truth" for release plan membership. State that **GitHub milestones** own planned membership; ROADMAP is human-readable / derived documentation. Do not implement a full regenerate pipeline in this change.

**Alternatives:** Leave header stale (docs lie). Delete file (out of scope).

### D7 — Test seams

**Choice:** Extend existing `ReleaseDeps` / `fetchMilestoneForVersion` (and any count helper) so unit tests inject milestone fixtures without network. Bite-proof: a regression test that constructs the v1.35.0 shape (ROADMAP planned ≠ shipped closing issues; milestone matches shipped) and asserts prepare does **not** throw the stamp-abort error.

## Risks / Trade-offs

- **[Risk] Live releases without a milestone now fail** → Mitigation: clear error + dry-run preview; document in help; operators already use roadmap milestones through v1.53+.
- **[Risk] Best-effort ROADMAP leaves docs drift after ship** → Mitigation: provenance note + optional follow-up regenerate issue; release no longer blocked by drift.
- **[Risk] Dry-run network dependency surprises offline CI** → Mitigation: fetch soft-fails to `unavailable`; local diffs still print; no abort solely on fetch failure in dry-run.
- **[Risk] Intake/sweep still write ROADMAP as if authoritative** → Mitigation: out of scope; note for follow-up; release path stops reading it as plan authority first (highest-pain site).

## Migration Plan

1. Land OpenSpec change; implement behind normal PR review.
2. Operators: ensure target version has a GitHub milestone before live `pipeline release` (roadmap apply or manual).
3. After first green ship: update any supervisor scripts that parsed ROADMAP plan rows as plan authority to use milestones / `gh api`.
4. Rollback: revert the release.ts gate/theme changes; ROADMAP header can remain accurate even if code rolls back.

## Open Questions

_(none that block specs — absent-milestone fail-closed and dry-run read-only fetch are decided above.)_
