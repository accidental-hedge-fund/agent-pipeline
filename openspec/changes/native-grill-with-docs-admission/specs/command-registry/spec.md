## ADDED Requirements

### Requirement: The command registry SHALL include a `grill` entry with selector, dry-run, status, follow, and resume flags

The `COMMAND_REGISTRY` SHALL contain a `grill` keyword with `needsIssueNumber: false`. Its `allowedFlags` SHALL include `issue`, `issues`, `milestone`, `label`, `dryRun`, `json`, `follow`, and `resume` (plus universal `repoPath` / `base` / `profile` as declared for peers). Flag validation SHALL reject unknown flags with exit code 2 before config resolution or GitHub writes. `status` SHALL be a grill sub-verb, not a positional advance issue number. Selector usage text SHALL be declared once in command-docs / OPERATION_SURFACE metadata so generated CLI reference and host SKILL tables publish the same grammar. This change SHALL NOT add a second command-grammar module.

#### Scenario: Grill lookup succeeds without a positional issue number

- **WHEN** the operator runs `pipeline grill --issue 42`
- **THEN** `lookupCommand("grill")` SHALL return a non-null entry with `needsIssueNumber: false`
- **AND** flag validation SHALL accept `--issue`

#### Scenario: Unknown flag exits 2 before writes

- **WHEN** the operator runs `pipeline grill --issue 42 --bogus`
- **THEN** the CLI SHALL exit 2 naming the unsupported flag
- **AND** no GitHub write SHALL occur

#### Scenario: Status is not an advance issue number

- **WHEN** the operator runs `pipeline grill status --run-id <id>`
- **THEN** flag validation SHALL accept the status sub-verb
- **AND** SHALL NOT treat `status` as an advance issue number

## MODIFIED Requirements

### Requirement: The pipeline CLI SHALL maintain a declarative command registry

The pipeline CLI SHALL maintain a `COMMAND_REGISTRY` constant in `core/scripts/command-registry.ts` mapping each recognized command keyword to a `CommandEntry` record. Each `CommandEntry` SHALL declare at minimum: `needsIssueNumber` (boolean), `allowedFlags` (a `Set<string>` of Commander option attribute names, or the sentinel `"all"` for the advance command), `mutatesGitHub` (boolean), `needsConfig` (boolean), `needsGhAuth` (boolean), and `supportsJson` (boolean). The registry SHALL be the single authoritative source for command dispatch routing and flag validation. The registry SHALL include entries for the operations promoted from mode-selecting flags to positional sub-command keywords by this change — `status`, `unblock`, `override`, and `cleanup` — and `cleanup` SHALL be dispatched as an actual positional keyword (`pipeline cleanup`), not only as the legacy `--cleanup` flag mode. The registry SHALL also include the human-invoked `merge-queue` keyword for selector-based ready-to-deploy queue planning. The registry SHALL include `grill` as the native grill-with-docs admission keyword.

#### Scenario: Every recognized command keyword has a registry entry

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** it SHALL contain entries for every keyword the pipeline CLI recognizes: advance (the default/numeric case), init, doctor, release, intake, triage, merge, merge-queue, sweep, refine-spec, grill, logs, summary, path, config, run, improve, scoreboard, roadmap, cleanup, remove-worktree, **status, unblock, and override**
- **AND** `lookupCommand("status")`, `lookupCommand("unblock")`, `lookupCommand("override")`, and `lookupCommand("cleanup")` SHALL each return a non-null entry
- **AND** `lookupCommand("merge-queue")` SHALL return a non-null entry
- **AND** `lookupCommand("grill")` SHALL return a non-null entry
- **AND** `lookupCommand("unknown-cmd")` SHALL return `null`
- **AND** `lookupCommand(undefined)` SHALL return the advance entry

#### Scenario: Registry lookup is the single source for dispatch routing

- **WHEN** a new sub-command is added to the pipeline CLI
- **THEN** adding it to `COMMAND_REGISTRY` SHALL be sufficient to register it for dispatch routing and flag validation, without editing any per-command conflict list elsewhere in `pipeline.ts`

#### Scenario: Promoted keyword entries declare correct issue-number metadata

- **WHEN** the registry entries for `status`, `unblock`, and `override` are inspected
- **THEN** each SHALL declare `needsIssueNumber: true` (these operations act on an issue/PR number, e.g. `pipeline status 42`)
- **AND** the `cleanup` entry SHALL declare `needsIssueNumber: false` (it takes no issue number)
- **AND** each promoted entry's handler SHALL be the same handler the corresponding legacy flag invoked, so the operation's behavior is unchanged

---

### Requirement: The `refine-spec` registry entry SHALL allow `--issue` and `apply` without a positional issue number

The `refine-spec` command-registry entry SHALL keep `needsIssueNumber: false`. Its `allowedFlags` SHALL include the existing `--title`, `--body`, `--json`, and `--repo-path` flags. During migration it MAY still include `--issue` and `--proposal-file` so compatibility shims parse. Flag validation SHALL reject unknown flags with exit code 2 before config resolution or GitHub writes. After replacement coverage, `--issue` / `apply` SHALL NOT remain a second admission controller. `--title/--body` preview SHALL remain usable without GitHub authentication.

#### Scenario: Title/body path stays positional-issue-free

- **WHEN** the operator runs `pipeline refine-spec --title "T" --body "B"`
- **THEN** registry lookup for `refine-spec` SHALL succeed with `needsIssueNumber: false`
- **AND** the invocation SHALL NOT be rejected for missing a positional issue number

#### Scenario: Issue flag is allowed

- **WHEN** the operator runs `pipeline refine-spec --issue 42`
- **THEN** flag validation SHALL accept `--issue`
- **AND** SHALL NOT exit 2 solely because `--title` and `--body` are absent

#### Scenario: Unknown flag still exits 2

- **WHEN** the operator runs `pipeline refine-spec --title "T" --body "B" --bogus`
- **THEN** the CLI SHALL exit 2 naming the unsupported flag
- **AND** no GitHub write SHALL occur

#### Scenario: Proposal-file flag is allowed on apply

- **WHEN** the operator runs `pipeline refine-spec apply --issue 42 --proposal-file /tmp/envelope.json`
- **THEN** flag validation SHALL accept `--issue` and `--proposal-file`
- **AND** SHALL NOT treat `apply` as an advance issue number
