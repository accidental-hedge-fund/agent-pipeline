## MODIFIED Requirements

### Requirement: Release simplification SHALL remain divided into five independently delivered packages

The design SHALL identify this change as package 5 of 5, owning the coherent live command contract across the CLI catalog, generated host shims, ordinary docs, and living specs; command-interface regression coverage for every approved case; ownership-safe cleanup and migration of known failed synthetic artifacts; historical-failed-ship-evidence treatment; protected-file alignment reporting; and the unchecked operator post-merge checklist. Package 1 SHALL remain the delivered no-change Tester and template-validation prerequisite. Package 2 SHALL remain the delivered exact-candidate two-issue FRG runner/observer. Package 3 SHALL remain the delivered independently complete release and SemVer ship-final-delegation. Package 4 SHALL remain the dependency-checked retirement of remaining obsolete callers. Package 5 completion SHALL NOT require a live synthetic run, tag, publication, promotion, installation, or deployment.

#### Scenario: Package two completion is independently checkable

- **WHEN** implementers evaluate package 2 completion
- **THEN** they SHALL evaluate the exact-pair runner/observer, result verification, release-path dependency replacement, regression migration, dirty-inventory correction, generated-artifact freshness, and repository verification gates
- **AND** SHALL NOT require a live synthetic run, release action, version bump, fixture merge, tag, publication, promotion, installation, or deployment

#### Scenario: Package one completion is independently checkable

- **WHEN** package 1 is evaluated after package 5 is specified
- **THEN** package 1 SHALL remain complete from its no-change Tester correction, deterministic template validation, scoped design artifacts, generated-artifact freshness, and repository verification gates
- **AND** package 5 SHALL NOT retroactively add live fixture or release work to package 1

#### Scenario: Four later packages remain explicit future work

- **WHEN** the five-package plan is read
- **THEN** package 1 SHALL remain the prerequisite template and Tester correction
- **AND** packages 2 through 4 SHALL remain independently delivered as exact-pair FRG, complete release and ship-final-delegation, and obsolete-caller retirement
- **AND** package 5 SHALL own the coherent live contract, approved command-interface coverage, and ownership-safe migration without claiming that live publication is complete

#### Scenario: Proven candidate remains the later tag target

- **WHEN** package 2 records a proven candidate `C`
- **THEN** the approved release contract SHALL require later release metadata to have preceded that proof and the eventual tag target to equal `C`
- **AND** publication verification SHALL remain owned by the later operator live pair, not by package 5 implementation

#### Scenario: Review rigor remains unchanged

- **WHEN** package 5 is implemented
- **THEN** normal independent review and GitHub CI SHALL remain required
- **AND** model defaults and ordinary review policy SHALL NOT be reduced by the simplification

#### Scenario: Package five completion is independently checkable

- **WHEN** implementers evaluate package 5 completion
- **THEN** they SHALL evaluate the live catalog and docs contract, living-spec alignment, approved command-interface coverage, ownership-safe migration tests, historical-failed-ship-evidence treatment, protected-file alignment report, unchecked operator checklist, generated-artifact freshness, and repository verification gates
- **AND** SHALL NOT require a live synthetic run, release action, version bump, fixture merge, tag, publication, promotion, installation, or deployment

## ADDED Requirements

### Requirement: Package 5 SHALL present one live release contract

Ordinary docs and living specs SHALL present independent `pipeline release VERSION` as direct-release: the complete SemVer release contract for an exact candidate. They SHALL present SemVer `pipeline ship --milestone` completion as ship-final-delegation to that independent release. Neither path SHALL deploy, promote, or install. Historical optional-FRG, finish-as-release-owner, and ship-promotion instructions SHALL remain identifiable as historical. They SHALL NOT be the live procedure.

#### Scenario: Live docs name direct-release and ship-final-delegation

- **WHEN** an operator reads the current CLI catalog, generated host SKILLs, ordinary operator docs, and living specs
- **THEN** those surfaces SHALL present `pipeline release VERSION` as the independently complete SemVer contract
- **AND** SHALL present SemVer ship completion as exactly one delegation to that release
- **AND** SHALL NOT present historical optional-FRG, finish, or ship-promotion as the live procedure

#### Scenario: Historical instructions stay labeled historical

- **WHEN** ordinary docs still contain optional-FRG, `release finish` as a tag or publish owner, or ship-promotion
- **THEN** that text SHALL be identifiable as historical
- **AND** it SHALL NOT be the live procedure

### Requirement: Direct-release and ship-final-delegation SHALL complete the same SemVer contract

Direct-release and ship-final-delegation SHALL complete the same SemVer release contract for an exact candidate. Command-interface coverage SHALL include equivalent direct-release and ship-final-delegation without deployment. Neither path SHALL deploy, promote, or install.

#### Scenario: Equivalent paths without deployment

- **WHEN** injected-I/O tests drive complete release for version `X.Y.Z` and SemVer ship-final-delegation for the same version
- **THEN** both paths SHALL require the same milestone, metadata, exact-candidate FRG, annotated tag, and publication contract
- **AND** neither path SHALL install, promote, or deploy

### Requirement: Historical-failed-ship-evidence SHALL NOT authorize the current candidate

Failed or prior ship, FRG, scorer, or attestor ledgers and files SHALL remain as historical-failed-ship-evidence. The product SHALL treat them as superseded. They SHALL NOT be current-candidate authority and SHALL NOT be a prerequisite for a new release. A new release SHALL NOT require a working old scorer or attestor. A historical pass SHALL NOT be authority for the current candidate.

#### Scenario: New release ignores a historical pass

- **WHEN** a historical scorer or attestor file records a pass for a prior candidate
- **AND** the operator runs direct-release for the current candidate
- **THEN** the product SHALL NOT treat that historical pass as proof for the current candidate
- **AND** the new release SHALL still require current authoritative observations

#### Scenario: Missing old scorer is not a blocker

- **WHEN** the old scorer or attestor is absent or unreadable
- **AND** the operator runs direct-release for the current candidate
- **THEN** the product SHALL NOT require that old scorer or attestor
- **AND** it SHALL proceed or fail only on current authoritative observations

### Requirement: Package 5 SHALL keep command-interface regression coverage for every approved case

Command-interface regression coverage SHALL exist for every approved case: milestone integration checks; isolated metadata-first merge; candidate source identity; exactly two issues across partial create and resume; same-host duplicate exclusion; fresh genuine `pipeline:ready-to-deploy`; rejection of false, forged, wrong-head, and mismatched evidence; no fixture merging; correct external-wait versus regression handling; unchanged and changed Tester candidates; dirty pre-commit CI; stale main; tag and publication idempotency; cleanup debt; equivalent direct-release and ship-final-delegation without deployment. False, forged, wrong-head, and mismatched evidence SHALL fail closed. Fixture merging SHALL NOT be a passing path.

#### Scenario: Approved-case inventory is complete

- **WHEN** the command-interface inventory is inspected
- **THEN** it SHALL name every approved case
- **AND** each named case SHALL have a covering regression

#### Scenario: Forged evidence is not a passing path

- **WHEN** a command-interface case supplies false, forged, wrong-head, or mismatched release evidence
- **THEN** the product SHALL reject that evidence
- **AND** SHALL NOT treat fixture merging as success

### Requirement: Package 5 SHALL report protected-file alignment without editing those files

If protected `CLAUDE.md`, rules, settings, or commands disagree with the current release contract, the change SHALL report the required alignment. This change SHALL NOT edit those protected files.

#### Scenario: Disagreement is reported

- **WHEN** a protected file disagrees with direct-release and ship-final-delegation
- **THEN** the committed alignment report SHALL name that file and the required alignment
- **AND** this change SHALL leave the protected file unedited

#### Scenario: Agreement is reported

- **WHEN** the protected files already agree with the live contract
- **THEN** the committed alignment report SHALL state that they agree
- **AND** this change SHALL leave those files unedited

### Requirement: Package 5 SHALL keep observability and policy stable

Optional observability from #1482 SHALL remain. Permanent repository models and review policy SHALL remain. The product pull request SHALL NOT add a temporary Sol override, a synthetic fixture implementation, or a second scheduler. This change SHALL NOT edit ledgers by hand and SHALL NOT delete diagnostic evidence to reset budgets.

#### Scenario: Stability constraints hold

- **WHEN** the package 5 product pull request is inspected
- **THEN** optional observability from #1482 SHALL still be present
- **AND** permanent repository models and review policy SHALL be unchanged
- **AND** the pull request SHALL NOT add a temporary Sol override, a synthetic fixture implementation, or a second scheduler

### Requirement: Package 5 SHALL record an unchecked operator post-merge checklist

The repository SHALL record an operator checklist whose items stay unchecked until each observation occurs after merge. The checklist SHALL include: test exact main `C`; obtain two unmerged `pipeline:ready-to-deploy` results; create annotated `v1.40.1` at `C`; verify matching versions and notes and a non-draft publication; prove a repeated release of that publication is idempotent. This issue SHALL NOT check those items.

#### Scenario: Checklist items stay unchecked

- **WHEN** package 5 reaches `pipeline:ready-to-deploy`
- **THEN** the committed operator checklist SHALL exist
- **AND** every live-observation item SHALL remain unchecked
- **AND** independently verified publication SHALL remain outside this issue
