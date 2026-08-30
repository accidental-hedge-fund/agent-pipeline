## ADDED Requirements

### Requirement: The `refine-spec` registry entry SHALL allow `--issue` and `apply` without a positional issue number

The `refine-spec` command-registry entry SHALL keep `needsIssueNumber: false`. Its `allowedFlags` SHALL include the existing `--title`, `--body`, `--json`, and `--repo-path` flags and SHALL also include `--issue`. Flag validation SHALL reject unknown flags with exit code 2 before config resolution or GitHub writes. The `apply` token SHALL be a refine-spec sub-verb, not a separate advance issue number. `--title/--body` preview SHALL remain usable without GitHub authentication. `--issue` preview and `apply` SHALL require GitHub authentication.

#### Scenario: Title/body path stays positional-issue-free

- **WHEN** the operator runs `pipeline refine-spec --title "T" --body "B"`
- **THEN** registry lookup for `refine-spec` SHALL succeed with `needsIssueNumber: false`
- **AND** the invocation SHALL NOT be rejected for missing a positional issue number

#### Scenario: Issue flag is allowed

- **WHEN** the operator runs `pipeline refine-spec --issue 42`
- **THEN** flag validation SHALL accept `--issue`
- **AND** SHALL NOT exit 2 solely because `--title` and `--body` are absent

#### Scenario: Unknown flag still exits 2

- **WHEN** the operator runs `pipeline refine-spec --issue 42 --bogus`
- **THEN** the CLI SHALL exit 2 naming the unsupported flag
- **AND** no GitHub write SHALL occur
