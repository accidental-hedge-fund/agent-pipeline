# config-repo-map-command Specification

## Purpose
TBD - created by archiving change config-repo-map-command. Update Purpose after archive.
## Requirements
### Requirement: `pipeline config repo-map add` appends an entry to the target relationship list

The command SHALL add `<owner/repo>` to the selected `repo_map` list in `.github/pipeline.yml`
at the resolved git root of `--repo-path` (defaulting to cwd), invoked as
`pipeline config repo-map add <owner/repo> [--rel depends_on|depended_on_by] [--repo-path <path>]`.
`--rel` SHALL default to
`depends_on`. When the `repo_map` block is absent it SHALL be created; when the target list is
absent it SHALL be created. The command SHALL exit 0 on success. It SHALL NOT touch the other
relationship list or any other repo's config.

#### Scenario: add to depends_on by default

- **WHEN** the user runs `pipeline config repo-map add acme/lib`
- **THEN** `acme/lib` SHALL be present in `repo_map.depends_on` in `.github/pipeline.yml`
- **AND** `repo_map.depended_on_by` SHALL be unchanged
- **AND** the command SHALL exit 0

#### Scenario: add to depended_on_by with explicit --rel

- **WHEN** the user runs `pipeline config repo-map add acme/app --rel depended_on_by`
- **THEN** `acme/app` SHALL be present in `repo_map.depended_on_by`
- **AND** `repo_map.depends_on` SHALL be unchanged

#### Scenario: repo_map block created when absent

- **WHEN** `.github/pipeline.yml` exists with no `repo_map` block and the user runs `pipeline config repo-map add acme/lib`
- **THEN** a `repo_map` block SHALL be created with `depends_on` containing `acme/lib`
- **AND** the resulting file SHALL validate against the config schema

### Requirement: `pipeline config repo-map add` is idempotent for an already-present entry

The `pipeline config repo-map add` command SHALL treat adding an `<owner/repo>` that is already
present in the target list as a no-op success. It SHALL NOT write a duplicate entry and SHALL exit 0.

#### Scenario: re-adding an existing entry writes no duplicate

- **WHEN** `repo_map.depends_on` already contains `acme/lib` and the user runs `pipeline config repo-map add acme/lib`
- **THEN** `repo_map.depends_on` SHALL contain `acme/lib` exactly once
- **AND** the command SHALL report a no-op and exit 0

### Requirement: `pipeline config repo-map remove` removes an entry and tolerates absence

The command SHALL remove `<owner/repo>` from the selected `repo_map` list (default `depends_on`),
invoked as `pipeline config repo-map remove <owner/repo> [--rel depends_on|depended_on_by] [--repo-path <path>]`.
When the entry is not present the command SHALL be a no-op that emits a warning and exits 0.
The command SHALL exit 0 on success.

#### Scenario: remove an existing entry

- **WHEN** `repo_map.depends_on` contains `acme/lib` and the user runs `pipeline config repo-map remove acme/lib`
- **THEN** `acme/lib` SHALL NOT be present in `repo_map.depends_on`
- **AND** the command SHALL exit 0

#### Scenario: remove an absent entry is a tolerant no-op

- **WHEN** `repo_map.depends_on` does not contain `acme/lib` and the user runs `pipeline config repo-map remove acme/lib`
- **THEN** the command SHALL emit a warning that the entry was not present
- **AND** it SHALL leave the config unchanged and exit 0

### Requirement: `pipeline config repo-map list` prints entries grouped by relationship kind

The `pipeline config repo-map list [--repo-path <path>]` command SHALL print the current
`repo_map` entries grouped by relationship kind (`depends_on`, `depended_on_by`). It SHALL exit 0.
When `repo_map` is absent or both lists are empty it SHALL print that there are no entries and exit 0.

#### Scenario: list prints both relationship groups

- **WHEN** `repo_map.depends_on` lists `acme/lib` and `repo_map.depended_on_by` lists `acme/app`
- **THEN** the output SHALL group `acme/lib` under `depends_on` and `acme/app` under `depended_on_by`
- **AND** the command SHALL exit 0

#### Scenario: list reports empty repo_map

- **WHEN** `.github/pipeline.yml` has no `repo_map` block
- **THEN** the command SHALL report that there are no repo_map entries and exit 0

### Requirement: `owner/repo` input is validated before any write

The `pipeline config repo-map add` and `remove` commands SHALL validate the `<owner/repo>`
argument against the same format the config schema enforces (exactly one `/`, non-empty segments,
no whitespace) before reading or writing config. An invalid argument SHALL be rejected with a clear
message and exit 1, and SHALL cause no write.

#### Scenario: malformed owner/repo rejected with exit 1

- **WHEN** the user runs `pipeline config repo-map add not-a-repo` (no `/`)
- **THEN** the command SHALL print an error identifying the invalid `owner/repo` format
- **AND** the config file SHALL be unchanged
- **AND** the command SHALL exit 1

#### Scenario: empty segment rejected with exit 1

- **WHEN** the user runs `pipeline config repo-map add acme/` (empty repo segment)
- **THEN** the command SHALL exit 1 with a format error and perform no write

### Requirement: An unrecognized `--rel` value is rejected as a usage error

The `pipeline config repo-map` command SHALL accept only `depends_on` and `depended_on_by` as
`--rel` values. Any other `--rel` value SHALL be rejected as a usage error with a non-zero exit and
SHALL cause no write.

#### Scenario: invalid --rel value rejected

- **WHEN** the user runs `pipeline config repo-map add acme/lib --rel siblings`
- **THEN** the command SHALL print a usage error naming the accepted `--rel` values
- **AND** it SHALL exit non-zero and perform no write

### Requirement: Add/remove preserve unrelated config keys, comments, and formatting

The `pipeline config repo-map add` and `remove` commands SHALL edit only the `repo_map` block of
`.github/pipeline.yml` and SHALL preserve all unrelated keys, values, comments, and formatting.
Round-tripping an add followed by the matching remove SHALL leave every non-`repo_map` line
unchanged.

#### Scenario: unrelated keys and comments survive an add

- **WHEN** a config with other keys and comments has `pipeline config repo-map add acme/lib` applied
- **THEN** every non-`repo_map` key, value, and comment SHALL be byte-for-byte unchanged
- **AND** only the `repo_map` block SHALL differ

### Requirement: Add performs a best-effort reachability check that warns but never aborts

The `pipeline config repo-map add` command SHALL make a best-effort check that the added
`<owner/repo>` is reachable on GitHub. When the check fails (no access, not found, or a transient
error) the command SHALL emit a named warning and SHALL still write the entry. Reachability failure
SHALL NOT abort the write or fail the command.

#### Scenario: unreachable repo warns but is still added

- **WHEN** the reachability check for `acme/private` fails and the user runs `pipeline config repo-map add acme/private`
- **THEN** a warning naming `acme/private` SHALL be emitted
- **AND** `acme/private` SHALL still be written to `repo_map.depends_on`
- **AND** the command SHALL exit 0

### Requirement: Add/remove require an existing config file

The `pipeline config repo-map add` and `remove` commands SHALL operate only on an existing
`.github/pipeline.yml`. When the file is absent at the resolved git root the command SHALL print an
error directing the user to run `pipeline init`, SHALL create no file, and SHALL exit 1.

#### Scenario: missing config file directs to pipeline init

- **WHEN** the resolved git root has no `.github/pipeline.yml` and the user runs `pipeline config repo-map add acme/lib`
- **THEN** the command SHALL print an error directing the user to run `pipeline init`
- **AND** no file SHALL be created
- **AND** the command SHALL exit 1

### Requirement: The config command surface advertises repo-map

The `pipeline config` command SHALL advertise the `repo-map` subcommand family in its help text and
in its unknown-subcommand message, alongside the existing `schema`, `validate`, and `sync` subcommands.

#### Scenario: config help lists repo-map

- **WHEN** the user requests `pipeline config` help
- **THEN** the help text SHALL mention `repo-map` and its `add` / `remove` / `list` subcommands

#### Scenario: unknown subcommand message lists repo-map

- **WHEN** the user runs `pipeline config bogus`
- **THEN** the error SHALL list `repo-map` among the available subcommands

