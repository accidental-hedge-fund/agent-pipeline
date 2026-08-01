## ADDED Requirements

### Requirement: The `release` sub-command SHALL fail closed on open candidate soak engine-class defects before version mutation

The live and dry-run `pipeline release` paths SHALL run the open-soak-defect preflight after version
resolution and after Factory Reliability Gate (FRG) evidence for the resolved version is available
(so soak identity can be read), and SHALL do so **before** bumping `package.json` files,
regenerating the `plugin/` mirror, running `npm run ci`, editing `ROADMAP.md`, creating a release
branch, or opening a release PR. When the preflight returns a non-empty blocking set and no valid
audited override is supplied, the command SHALL exit non-zero with the preflight's doctor-grade
remediation and SHALL NOT mutate release-managed paths. This check is additive to the existing FRG
and `npm run ci` gates. It SHALL NOT merge any pull request and SHALL NOT create the release tag by
itself.

#### Scenario: Open soak defects abort before version bump

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** FRG pass evidence for `1.29.1` is available
- **AND** the open-soak-defect preflight returns at least one blocking open engine-class defect
- **AND** no valid override reason is supplied
- **THEN** the command SHALL exit non-zero listing the blocking issues
- **AND** SHALL NOT write `package.json`, `core/package.json`, or regenerate `plugin/`

#### Scenario: Clean open-defect set allows progression past the preflight

- **WHEN** FRG pass evidence is available for the resolved version
- **AND** the open-soak-defect preflight returns an empty blocking set
- **THEN** the open-soak-defect check SHALL not block the release path
- **AND** subsequent release steps MAY proceed as already specified

#### Scenario: Dry-run still evaluates open soak defects

- **WHEN** the user runs `pipeline release 1.29.1 --dry-run`
- **AND** open candidate-linked engine-class defects exist without a valid override
- **THEN** the dry-run SHALL report the block (non-zero or explicit would-block failure surface)
- **AND** SHALL NOT mutate release-managed paths

#### Scenario: Preflight does not auto-merge or auto-tag

- **WHEN** `pipeline release` evaluates the open-soak-defect preflight
- **THEN** it SHALL NOT merge the release PR as a side effect of that check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because the open-defect set is empty

---

### Requirement: The `release` sub-command SHALL expose an audited open-soak-defect override and record it on the PR

The release CLI SHALL accept an explicit flag that supplies a non-empty human reason to proceed
despite a non-empty open-soak-defect blocking set (exact flag spelling documented in `--help` and
consistent with release CLI conventions). When that override is used and release preparation opens
or updates the release PR, the PR body (or an attached durable PR annotation) SHALL include a
dedicated section listing the waived issue numbers and the override reason. Absence of that section
when an override was required and used SHALL be treated as a bug in the release path. Silent skip
without the flag SHALL NOT be available.

#### Scenario: Override flag with reason is required to pass a non-empty blocking set

- **WHEN** open candidate-linked engine-class defects exist
- **AND** the operator invokes `pipeline release` with the documented override flag and a non-empty
  reason
- **THEN** the open-soak-defect preflight SHALL not fail closed solely due to those defects
- **AND** release preparation MAY continue to subsequent steps

#### Scenario: Release PR body records waived issues and reason

- **WHEN** `pipeline release` successfully prepares a release PR after using the open-soak-defect
  override for issues `#712` and `#714` with reason `accepted residual; tracked offline`
- **THEN** the release PR body or durable annotation SHALL list `#712` and `#714`
- **AND** SHALL include the override reason text

#### Scenario: Override without open defects does not invent a waiver section requirement

- **WHEN** the blocking set is empty and no override flag is supplied
- **THEN** the release PR MAY omit the open-soak-defect waiver section
- **AND** preparation SHALL NOT fail for lack of that section
