## ADDED Requirements

### Requirement: Release plan membership SHALL come from the matching GitHub milestone

For a resolved SemVer version `X.Y.Z`, `pipeline release` (and its shared prepare entry) SHALL treat the matching GitHub milestone as the sole authority for **planned** issue membership for that release. Planned issue numbers SHALL be the non-PR issues assigned to that milestone (open and closed). The command SHALL NOT use `ROADMAP.md` release-plan table rows or per-issue `→ Release` plan cells as the authority for which issues were planned for the version.

Milestone match rules SHALL remain version-aware (title contains `vX.Y.Z` or a bare `X.Y.Z` token bounded so it does not match a different patch/minor). The command SHALL NOT invent issue numbers that do not appear on the milestone or in shipped-PR discovery sources.

#### Scenario: Planned issues loaded from milestone membership

- **WHEN** a GitHub milestone matching version `1.35.0` exists and its non-PR issues are `#910`, `#978`, `#980`, and `#983`
- **AND** `ROADMAP.md` lists different planned issues for `v1.35.0` (for example `#901` and `#765`)
- **THEN** the release prepare path SHALL use `[#910, #978, #980, #983]` as the planned issue set
- **AND** SHALL NOT treat the ROADMAP list as plan authority

#### Scenario: Milestone issues do not invent numbers

- **WHEN** milestone membership and shipped-PR discovery yield no issue numbers
- **THEN** the prepare path SHALL NOT fabricate `#N` values for planned membership

---

### Requirement: Live release prepare SHALL fail closed when no matching milestone exists

When `pipeline release` runs a **live** prepare (not dry-run) under the SemVer release path and no GitHub milestone matching the resolved version exists, the command SHALL exit non-zero **before** opening a release pull request, with an error that names the resolved version and remediation (create the milestone and/or run `pipeline roadmap --apply`). It SHALL NOT treat a missing milestone as an empty silent plan.

#### Scenario: Missing milestone aborts live prepare

- **WHEN** the operator runs a live `pipeline release 1.36.0` (or an alias resolving to `1.36.0`)
- **AND** no matching GitHub milestone exists for `1.36.0`
- **THEN** the command SHALL exit non-zero naming version `1.36.0` and the missing milestone
- **AND** SHALL NOT open a release pull request as a successful completion

#### Scenario: Present milestone allows plan resolution to continue

- **WHEN** a matching milestone exists for the resolved version
- **THEN** plan membership resolution SHALL succeed from that milestone
- **AND** the missing-milestone refusal SHALL NOT apply

---

### Requirement: Live release prepare SHALL fail closed when multiple milestones match the version

When `pipeline release` runs a **live** prepare (not dry-run) under the SemVer release path and **more than one** GitHub milestone matches the resolved version by the version-aware title rules, the command SHALL exit non-zero **before** opening a release pull request. The error SHALL name the resolved version and identify the matching milestones (numbers and/or titles) with remediation to keep exactly one canonical match (rename or close extras). The command SHALL NOT silently select the first REST-list entry, and SHALL NOT invent plan membership from an arbitrary match.

GitHub permits duplicate milestone titles; list ordering is not a release-plan disambiguation contract.

#### Scenario: Duplicate matching milestones abort live prepare

- **WHEN** the operator runs a live `pipeline release 1.36.0`
- **AND** two or more GitHub milestones match version `1.36.0` (for example an accidental old `v1.36.0` and an intended one with different issue membership)
- **THEN** the command SHALL exit non-zero naming version `1.36.0` and the ambiguity
- **AND** SHALL NOT open a release pull request as a successful completion
- **AND** SHALL NOT treat either matching milestone as the sole plan authority without operator disambiguation

#### Scenario: Exactly one matching milestone is required for plan resolution

- **WHEN** exactly one GitHub milestone matches the resolved version
- **THEN** plan membership resolution SHALL use that milestone
- **AND** the ambiguous-milestone refusal SHALL NOT apply

---

### Requirement: Stale or missing ROADMAP plan anchors SHALL NOT block a milestone-backed release

When planned membership has been resolved from a matching GitHub milestone (or live prepare has already failed closed for a missing milestone), the release path SHALL NOT abort solely because:

- `ROADMAP.md` is missing a `release-plan-row` for the version,
- the `release-plan-none-row` insert sentinel is absent,
- a `shipped-section` anchor is absent, or
- ROADMAP per-issue rows are planned for the version but none are stampable from shipped closing-issue numbers (including the historical failure text of the form "found N shipped PR(s) and M ROADMAP row(s) planned … but none could be stamped").

Optional ROADMAP documentation mutations (for example compact plan-row ship-mark or per-issue stamps) SHALL be best-effort: applied when the needed anchors exist; skipped with an explicit warning when they do not. Success of release prepare SHALL not require those mutations.

#### Scenario: v1.35.0-class ROADMAP stamp mismatch does not abort

- **WHEN** shipped PRs resolve closing issues that match the milestone membership for the version
- **AND** `ROADMAP.md` still has per-issue rows planned for that version that do not match those shipped issues (stampable count is zero against ROADMAP)
- **THEN** the command SHALL NOT exit non-zero solely for that ROADMAP stamp mismatch
- **AND** release prepare MAY continue to version bump, CI, and release PR creation per other requirements

#### Scenario: Missing release-plan-row does not abort when milestone plan exists

- **WHEN** a matching milestone supplies planned membership for the resolved version
- **AND** `ROADMAP.md` has no `| **vX.Y.Z** |` release-plan row and cannot insert one
- **THEN** the command SHALL NOT abort solely with a `release-plan-row` / `release-plan-none-row` anchor error
- **AND** it MAY warn that ROADMAP documentation was not updated

#### Scenario: Missing shipped-section anchor does not abort when milestone plan exists

- **WHEN** a matching milestone supplies planned membership for the resolved version
- **AND** the ROADMAP `shipped-section` anchor is absent
- **THEN** the command SHALL NOT abort solely for that missing anchor
- **AND** it MAY skip the corresponding ROADMAP mutation with a warning

---

### Requirement: Dry-run SHALL surface milestone presence and open-issue count

Under `--dry-run`, after version resolution, the command SHALL report for the resolved version whether a matching GitHub milestone is present, absent, or unavailable (fetch failed), and when present SHALL report how many **open** non-PR issues that milestone has (total non-PR count MAY also be reported). This report SHALL be printed even when local ROADMAP diffs are also printed.

Dry-run MAY perform a **read-only** GitHub milestone lookup for that report. Dry-run SHALL still write no release-managed files, create no commit, and open no pull request. Dry-run SHALL NOT abort solely because the milestone is absent or the fetch failed; it SHALL label the status clearly and continue the local preview.

#### Scenario: Dry-run reports present milestone and open count

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** a matching milestone exists with 3 open non-PR issues
- **THEN** stdout SHALL indicate the milestone is present for `1.36.0`
- **AND** SHALL report open issue count `3`
- **AND** no release-managed file SHALL be modified

#### Scenario: Dry-run reports absent milestone without aborting

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** no matching milestone exists
- **THEN** stdout SHALL indicate the milestone is absent for `1.36.0`
- **AND** the command SHALL NOT exit non-zero solely for that absence
- **AND** no release-managed file SHALL be modified

#### Scenario: Dry-run reports unavailable milestone when fetch fails

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** the read-only milestone lookup fails (network, auth, or API error)
- **THEN** stdout SHALL indicate milestone status is unavailable (or equivalent)
- **AND** the command SHALL NOT invent planned membership
- **AND** local version/ROADMAP diff preview MAY still print

---

### Requirement: Release theme resolution SHALL prefer CLI then milestone without ROADMAP authority

When composing the release theme used for PR title and optional ROADMAP documentation columns, the command SHALL resolve theme in this order: (1) CLI `--theme` when provided and non-empty after trim; (2) documented extraction from the matching milestone title when a milestone is available; (3) a documented placeholder. The command SHALL NOT require a ROADMAP release-plan Theme cell for a successful prepare, and SHALL NOT treat that cell as higher priority than CLI or milestone sources.

#### Scenario: CLI theme wins over milestone

- **WHEN** the operator passes `--theme "Factory reliability"`
- **AND** a matching milestone title would yield a different theme string
- **THEN** the release theme SHALL be `Factory reliability`

#### Scenario: Milestone theme used when CLI theme is absent

- **WHEN** no `--theme` flag is provided
- **AND** a matching GitHub milestone is available
- **THEN** the release theme SHALL be derived from that milestone title by the documented extraction rule

#### Scenario: Placeholder when neither CLI nor milestone theme exists

- **WHEN** no `--theme` is provided
- **AND** no matching milestone is available on the path that still composes a theme (for example dry-run with absent milestone)
- **THEN** the theme SHALL be the documented placeholder rather than an empty silent string

## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL support `--dry-run`

Under `--dry-run`, the command SHALL resolve the version, compute the version-bump diff, compute any optional ROADMAP documentation scaffold diff when anchors allow, compose the PR body preview, and report milestone presence/open-issue status for the resolved version (read-only GitHub lookup permitted) — then print those artifacts to stdout and exit 0 without writing any file, creating any commit, or calling any **mutating** GitHub API. Dry-run SHALL NOT open a pull request.

#### Scenario: `--dry-run` prints without writing

- **WHEN** `pipeline release 1.6.0 --dry-run` is run
- **THEN** the resolved version, the file diffs (when applicable), the PR body preview, and the milestone status summary are printed to stdout
- **AND** no file on disk is modified
- **AND** no git commit is created
- **AND** no pull request is opened
- **AND** no mutating GitHub API is called

#### Scenario: `--dry-run` still validates the version argument

- **WHEN** `pipeline release foo --dry-run` is run
- **THEN** the command SHALL exit non-zero with a version-validation error, same as without `--dry-run`

#### Scenario: `--dry-run` may read milestone metadata

- **WHEN** `pipeline release 1.6.0 --dry-run` runs with network available
- **THEN** the command MAY perform a read-only milestone lookup for version `1.6.0`
- **AND** SHALL still perform no file writes and no PR creation

---

### Requirement: The `release` sub-command SHALL scaffold `ROADMAP.md` at four locations

After CI passes, the command SHALL **attempt** to patch `ROADMAP.md` in memory at documentation sites that still exist in the file, for human-readable derived docs only. ROADMAP is **not** the release-plan authority; planned membership comes from the GitHub milestone (see milestone plan-membership requirement).

When the relevant anchors are present, the command MAY:

1. **Intro paragraph** — append a new "shipped" clause for the version when that site is still maintained.
2. **Release-plan table row** — ensure/update a matching `| **vX.Y.Z** |` row's status toward shipped documentation when the table exists (inserting a scaffolded row when missing and insert is possible remains allowed as best-effort docs hygiene).
3. **Shipped section** — when a shipped-section structure is present and still maintained by the release path, update it from git history since the last tag; when the project uses `CHANGELOG.md` as the primary history surface, the release path SHALL NOT reintroduce unbounded Shipped prose solely to satisfy a missing anchor.
4. **Per-issue semver table** — best-effort stamp of `Planned ver` / shipped markers for issue numbers that appear in the **milestone plan set and/or shipped closing-issue set** when the table exists.

If a documentation anchor is missing, the command SHALL skip that site with a warning rather than aborting the release solely for that absence. The command SHALL NOT require ROADMAP plan rows to match shipped PRs as a condition of success.

#### Scenario: All four sites are patched atomically

- **WHEN** the scaffold succeeds and all four documentation site anchors are present
- **THEN** the ROADMAP on disk contains all four documentation changes in a single write (no intermediate partially-patched states)
- **AND** when one or more plan-related anchors are missing, the command SHALL skip those sites without writing a partially-patched ROADMAP that claims success for missing sites

#### Scenario: Missing release-plan row is ensured before ship mutations

- **WHEN** no `| **vX.Y.Z** |` row matching the resolved version exists in ROADMAP.md
- **AND** the release-plan insert sentinel is present
- **THEN** the command MAY insert a scaffolded unshipped plan row for that version before other optional ROADMAP documentation mutations
- **AND** SHALL NOT exit solely with a missing `release-plan-row` anchor error for that absence when milestone plan resolution succeeded
- **AND** SHALL NOT write a partially-patched ROADMAP if a later non-plan-row documentation site fails mid-write

#### Scenario: Shipped PRs that resolve no stampable rows abort

- **WHEN** shipped PRs exist and per-issue ROADMAP rows are planned for the resolved version, but none of those ROADMAP rows can be stamped because the shipped PRs resolve no matching closing issue numbers against those rows
- **THEN** the command SHALL NOT abort solely for that ROADMAP stamp mismatch when planned membership was resolved from the matching GitHub milestone
- **AND** the command MAY warn that ROADMAP per-issue documentation stamps were incomplete
- **AND** when no matching milestone exists, the live missing-milestone refusal applies instead of this ROADMAP stamp gate

#### Scenario: Scaffolded PR/issue rows are derived from `git log` since the last tag

- **WHEN** the command determines what shipped for PR body and optional ROADMAP docs
- **THEN** it SHALL run `git log <last-release-tag>..HEAD` and extract PR numbers from merge-commit messages (standard GitHub `Merge pull request #N` pattern) and from squash-merge commit messages (parenthetical `(#N)` pattern), then MAY scaffold one documentation table row per PR when a shipped-section structure is still maintained

#### Scenario: No merged PRs detected

- **WHEN** `git log` since the last tag yields no recognizable PR references
- **THEN** any scaffolded Shipped documentation subsection SHALL contain a placeholder row `| (no merged PRs detected — fill manually) |` or equivalent clear empty representation and the command SHALL print a warning
- **AND** the command SHALL NOT abort solely for an empty shipped set when other gates pass

---

### Requirement: Scaffolded release-plan rows SHALL use documented theme and issue sources without inventing issue numbers

When the release path inserts or updates a **documentation** release-plan row in ROADMAP (best-effort), it SHALL populate columns as follows:

- **Release:** `| **v{version}** |` (unshipped until ship-mark when that step runs).
- **Bump:** derived from the resolved version (`major` / `minor` / `patch`).
- **Theme:** from `--theme` when provided; otherwise from the matching GitHub milestone title when available; otherwise a documented placeholder such as `<theme>`. ROADMAP is not an input authority for theme.
- **Issues:** from **milestone membership** (primary) and/or issue numbers discovered from shipped PRs / `git log`. The command SHALL NOT invent issue numbers that do not appear in those sources. When no issue numbers are available yet, the Issues column MAY use a documented placeholder rather than fabricated `#N` values.
- **Why:** a short scaffold note that identifies the row as release-scaffolded (operator-editable).

#### Scenario: `--theme` overrides milestone and placeholder

- **WHEN** the operator runs release with `--theme "Factory reliability"`
- **AND** a plan row is written for documentation
- **THEN** the Theme column of that row SHALL be `Factory reliability`

#### Scenario: Milestone title used when `--theme` is absent

- **WHEN** no `--theme` flag is provided
- **AND** a GitHub milestone whose title matches the resolved version is available
- **AND** a plan row is written for documentation
- **THEN** the Theme column SHALL use that milestone title (or a documented extraction of it)

#### Scenario: Issue column does not invent numbers

- **WHEN** a plan row is written for documentation
- **AND** neither milestone membership nor shipped-PR / git-log discovery yields issue numbers
- **THEN** the Issues column SHALL NOT contain fabricated issue numbers
- **AND** SHALL use an empty, placeholder, or explicitly "fill manually" style value instead

#### Scenario: Issues column prefers milestone membership

- **WHEN** milestone membership is `[#910, #978]` and ROADMAP previously listed `[#901, #765]`
- **AND** a documentation plan row is written
- **THEN** the Issues column SHALL reflect the milestone membership (or a documented merge with shipped discovery), not the stale ROADMAP list as authority
