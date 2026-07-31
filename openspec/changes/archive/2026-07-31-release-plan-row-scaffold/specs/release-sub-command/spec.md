## ADDED Requirements

### Requirement: The `release` sub-command SHALL ensure an unshipped release-plan row before other ROADMAP mutations

Before applying the four ROADMAP ship mutations (intro chain, plan-row ship-mark, shipped section, per-issue stamp), the release path SHALL ensure that `ROADMAP.md` contains an unshipped release-plan table row for the resolved version. When no `| **v{version}** |` row exists for that version, the command SHALL insert a scaffolded unshipped row into the release-plan table (using the same column shape as `insertReleasePlanRow` / consumed by `patchReleasePlanRow`) **before** other ROADMAP mutations. Ensure SHALL run on the same in-memory path used by pre-validate, dry-run, and live scaffold so a missing plan row does not abort solely for absence of that row.

The ensure step SHALL NOT invent a version string: the version argument or alias resolution remains mandatory. The ensure step SHALL NOT merge, tag, or publish.

#### Scenario: Missing unshipped plan row is scaffolded then release proceeds past plan-row ensure

- **WHEN** the resolved version is `1.29.0`
- **AND** `ROADMAP.md` has no line starting with `| **v1.29.0**`
- **AND** the release-plan table insert sentinel (e.g. `| *(none)* |`) is present
- **THEN** the in-memory ROADMAP SHALL gain a new unshipped row `| **v1.29.0** | … |` before ship-mark mutations run
- **AND** the command SHALL NOT abort solely with `ROADMAP anchor not found: release-plan-row` for that absence
- **AND** subsequent ship-mark of the plan row MAY mark that scaffolded row `✅ shipped` in the same scaffold pass

#### Scenario: Ensure runs before package version writes on the live path

- **WHEN** the live release path pre-validates ROADMAP anchors before bumping `package.json` files
- **AND** the only plan-row defect is a missing unshipped row for the resolved version with a usable insert sentinel
- **THEN** ensure SHALL insert the row in memory during pre-validate
- **AND** the command SHALL NOT leave version bumps on disk solely because the plan row was initially missing

#### Scenario: Dry-run surfaces the scaffolded plan row without writing

- **WHEN** `pipeline release <version> --dry-run` runs against a ROADMAP missing the unshipped plan row for that version
- **AND** insert is possible
- **THEN** the printed ROADMAP diff SHALL include the scaffolded plan row
- **AND** no `ROADMAP.md` write SHALL occur

---

### Requirement: Scaffolded release-plan rows SHALL use documented theme and issue sources without inventing issue numbers

When the release path inserts a scaffolded release-plan row, it SHALL populate columns as follows:

- **Release:** `| **v{version}** |` (unshipped — no `✅ shipped` until the ship-mark step).
- **Bump:** derived from the resolved version (`major` / `minor` / `patch`).
- **Theme:** from `--theme` when provided; otherwise from a matching GitHub milestone title when milestone discovery is available; otherwise a documented placeholder such as `<theme>`.
- **Issues:** from milestone membership (open and closed issues for a matching milestone) and/or issue numbers already discovered from shipped PRs / `git log` on that release path. The command SHALL NOT invent issue numbers that do not appear in those sources. When no issue numbers are available yet, the Issues column MAY use a documented placeholder rather than fabricated `#N` values.
- **Why:** a short scaffold note that identifies the row as release-scaffolded (operator-editable).

#### Scenario: `--theme` overrides milestone and placeholder

- **WHEN** the operator runs release with `--theme "Factory reliability"`
- **AND** a plan row must be scaffolded for the resolved version
- **THEN** the Theme column of the scaffolded row SHALL be `Factory reliability`

#### Scenario: Milestone title used when `--theme` is absent

- **WHEN** no `--theme` flag is provided
- **AND** a GitHub milestone whose title matches the resolved version is available
- **AND** a plan row must be scaffolded
- **THEN** the Theme column SHALL use that milestone title (or a documented extraction of it)

#### Scenario: Issue column does not invent numbers

- **WHEN** a plan row must be scaffolded
- **AND** neither milestone membership nor shipped-PR / git-log discovery yields issue numbers
- **THEN** the Issues column SHALL NOT contain fabricated issue numbers
- **AND** SHALL use an empty, placeholder, or explicitly “fill manually” style value instead

---

### Requirement: The `release` sub-command SHALL never overwrite an already-shipped release-plan row

When a release-plan row for the resolved version already includes the `✅ shipped` marker, ensure and ship-mark steps SHALL leave that row’s shipped status intact. The command SHALL NOT insert a second unshipped duplicate row for the same version when a shipped row already exists.

#### Scenario: Already-shipped plan row is left unchanged by ensure

- **WHEN** `ROADMAP.md` already contains `| **v1.29.0** ✅ shipped | … |`
- **AND** no separate unshipped `| **v1.29.0** |` row exists
- **THEN** ensure SHALL NOT rewrite the shipped row to unshipped
- **AND** SHALL NOT insert a second row for `v1.29.0`

#### Scenario: Existing unshipped plan row is not duplicated

- **WHEN** `ROADMAP.md` already contains an unshipped `| **v1.29.0** |` row
- **THEN** ensure SHALL leave that row in place without inserting another row for `v1.29.0`
- **AND** ship-mark SHALL operate on the existing unshipped row as today

---

### Requirement: Impossible plan-row insert SHALL fail before version bump with doctor-grade remediation

When no unshipped plan row exists for the resolved version **and** the release path cannot safely insert one (missing release-plan table or missing insert sentinel such as `| *(none)* |`), the command SHALL exit non-zero **before** writing version bumps to `package.json` / `core/package.json`. The error message SHALL include:

1. the file path `ROADMAP.md`
2. a copy-pasteable example plan row for `v{version}` in the documented column shape
3. where to insert it (e.g. before the `| *(none)* |` sentinel, or how to restore the release-plan table)

#### Scenario: Missing insert sentinel aborts with copy-paste remediation

- **WHEN** the resolved version has no plan row
- **AND** the `| *(none)* |` (or equivalent insert) sentinel is absent so auto-insert cannot run
- **THEN** the command SHALL exit non-zero before package version writes
- **AND** the error text SHALL include a copy-pasteable `| **v{version}** | … |` row
- **AND** SHALL name `ROADMAP.md` and the expected insert location or table structure

#### Scenario: Remediation failure does not leave partial version bumps

- **WHEN** ensure fails because insert is impossible
- **THEN** `package.json` and `core/package.json` SHALL remain at their pre-release versions
- **AND** no release branch SHALL be created solely from that failure path

---

### Requirement: Release help and host SKILL SHALL document the required release-plan row shape

Release usage/help output and host SKILL documentation for `pipeline release` SHALL describe the required release-plan table row shape in a form consistent with the row produced by plan-row insert and consumed by `patchReleasePlanRow` (columns: Release, Bump, Theme, Issues, Why; Release cell `| **vX.Y.Z** |` for unshipped). The documented shape SHALL NOT contradict the shape enforced by those helpers.

#### Scenario: Help text states the unshipped plan-row shape

- **WHEN** an operator reads release help or the host SKILL release section
- **THEN** the docs SHALL show or describe the unshipped `| **vX.Y.Z** | bump | theme | issues | why |` row shape
- **AND** SHALL note that release will scaffold a missing unshipped row when the insert sentinel is present, or fail with remediation when it is not

## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL scaffold `ROADMAP.md` at four locations

After CI passes, the command SHALL patch `ROADMAP.md` in memory at these four sites, **after** ensuring an unshipped release-plan row exists for the resolved version (inserting a scaffolded row when missing and insert is possible):

1. **Intro paragraph** — append a new "shipped" clause for the version to the running chain sentence (e.g., `**v1.6.0 shipped YYYY-MM-DD** (tag \`v1.6.0\`) — <theme>; see Shipped.`).
2. **Release-plan table row** — update the matching unshipped `| **vX.Y.Z** |` row's status column from blank to `✅ shipped` and add a `Shipped YYYY-MM-DD` note.
3. **Shipped section** — prepend a new `**vX.Y.Z — <theme> (shipped YYYY-MM-DD, tag \`vX.Y.Z\`):**` subsection with a table of issues/PRs derived from git history since the last tag.
4. **Per-issue semver table** — stamp the `Planned ver` column for each row that matches a shipped issue number with the resolved version.

Each site's anchor is located by a pattern match (e.g., `## Shipped`, the `| **vX.Y.Z** |` row). For the release-plan row site specifically: if the unshipped row is missing, the command SHALL attempt ensure/insert first rather than aborting solely for that absence. If any **other** required anchor is not found, or if plan-row ensure cannot insert, the command SHALL abort with a non-zero exit code and an explicit error naming the missing anchor (with remediation for plan-row insert failures) rather than writing a partially-patched file.

#### Scenario: All four sites are patched atomically

- **WHEN** the scaffold succeeds
- **THEN** the ROADMAP on disk contains all four changes in a single write (no intermediate partially-patched states)

#### Scenario: Missing release-plan row is ensured before ship mutations

- **WHEN** no `| **vX.Y.Z** |` row matching the resolved version exists in ROADMAP.md
- **AND** the release-plan insert sentinel is present
- **THEN** the command SHALL insert a scaffolded unshipped plan row for that version before applying the four ship mutations
- **AND** SHALL NOT exit solely with a missing `release-plan-row` anchor error for that absence
- **AND** SHALL NOT write a partially-patched ROADMAP if a later non-plan-row anchor then fails

#### Scenario: Shipped PRs that resolve no stampable rows abort

- **WHEN** shipped PRs exist and per-issue rows are planned for the resolved version, but none of those rows can be stamped because the shipped PRs resolve no matching closing issue numbers (e.g. empty `closingIssuesReferences`)
- **THEN** the command SHALL abort with a non-zero exit code and a manual-resolution message rather than writing an unstamped, inconsistent release ROADMAP
- **AND** when no per-issue rows are planned for the resolved version, the command SHALL NOT abort on this basis

#### Scenario: Scaffolded PR/issue rows are derived from `git log` since the last tag

- **WHEN** the command determines what shipped
- **THEN** it SHALL run `git log <last-release-tag>..HEAD` and extract PR numbers from merge-commit messages (standard GitHub `Merge pull request #N` pattern) and from squash-merge commit messages (parenthetical `(#N)` pattern), then scaffold one table row per PR in the Shipped subsection

#### Scenario: No merged PRs detected

- **WHEN** `git log` since the last tag yields no recognizable PR references
- **THEN** the scaffolded Shipped subsection SHALL contain a placeholder row `| (no merged PRs detected — fill manually) |` and the command SHALL print a warning
