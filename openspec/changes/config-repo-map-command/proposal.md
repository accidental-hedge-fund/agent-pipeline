## Why

`repo_map` (`depends_on` / `depended_on_by`) was added to `.github/pipeline.yml` in
v1.12.0 (#312) to declare inter-repo relationships for cross-repo planning context.
Today the only way to manage those entries after `pipeline init` is to hand-edit YAML:
`init` scaffolds the `repo_map` block commented out, and no command adds or removes
entries. pipeline-desk's config UI needs this as a delegable primitive so it can own
the surface without re-implementing YAML mutation and `owner/repo` validation itself
(companion: pipeline-desk #206).

## What Changes

- Add a `pipeline config repo-map` command family with three subcommands:
  - `pipeline config repo-map add <owner/repo> [--rel depends_on|depended_on_by]`
  - `pipeline config repo-map remove <owner/repo> [--rel depends_on|depended_on_by]`
  - `pipeline config repo-map list`
- `--rel` defaults to `depends_on`; only `depends_on` and `depended_on_by` are accepted.
- `add`/`remove` mutate `.github/pipeline.yml` in place, preserving all unrelated keys,
  comments, and formatting (surgical YAML-document edit, not a whole-file re-render).
- `add` creates the `repo_map` block (and the target list) when absent, and is
  idempotent — re-adding an existing entry is a no-op success, not a duplicate.
- `remove` is a no-op success (exit 0, warning) when the entry is not present.
- `list` prints current entries grouped by relationship kind.
- `owner/repo` strings are validated against the same format the schema enforces
  (exactly one `/`, non-empty segments, no whitespace) before any write; invalid input
  is rejected with exit 1 and a clear message.
- `add` best-effort checks GitHub reachability of the added repo and, on failure, warns
  but still writes (mirroring the runtime non-abort behavior established in #312).
- No schema change: `PartialConfigSchema.repo_map` and `pipeline config schema` output
  already describe `repo_map`.

## Capabilities

### New Capabilities
- `config-repo-map-command`: add/remove/list `repo_map` entries in `.github/pipeline.yml`
  through the `pipeline config` command family.

### Modified Capabilities
- None. Reuses the existing `repo_map` schema (`pipeline-configuration`,
  `config-schema-command`) and the cross-repo planning behavior (`cross-repo-context`)
  unchanged.

## Acceptance Criteria

- [ ] `pipeline config repo-map add owner/repo` appends the entry to the correct list in
  `.github/pipeline.yml`, creating the `repo_map` block (and the target list) if absent.
- [ ] `add` defaults to `depends_on` when `--rel` is omitted, and targets
  `depended_on_by` when `--rel depended_on_by` is passed.
- [ ] `add` of an entry already present in the target list is an idempotent no-op success
  (exit 0) that writes no duplicate.
- [ ] `pipeline config repo-map remove owner/repo` removes the entry from the target list;
  it is a no-op success (exit 0, warning) when the entry is not present.
- [ ] `pipeline config repo-map list` prints the current entries grouped by relationship
  kind (`depends_on`, `depended_on_by`).
- [ ] Invalid `owner/repo` strings (wrong format, empty segments, whitespace, missing or
  extra `/`) are rejected with exit 1 and a clear message, and no write occurs.
- [ ] An unrecognized `--rel` value is rejected with a usage error (non-zero exit) and no
  write occurs.
- [ ] Unrelated `.github/pipeline.yml` keys, comments, and formatting are preserved across
  `add` and `remove` (only the `repo_map` block changes).
- [ ] `add` warns but still writes when the GitHub reachability check for the added repo
  fails; reachability failure never aborts the write.
- [ ] `add`/`remove` on a repository with no `.github/pipeline.yml` fail with exit 1 and a
  message directing the user to run `pipeline init` (no file is created).
- [ ] `pipeline config --help` and the config subcommand dispatch advertise `repo-map`.
- [ ] Unit tests cover add (default and explicit `--rel`, block-creation, idempotency),
  remove (present and absent), list, invalid `owner/repo`, invalid `--rel`, missing config
  file, reachability-failure warning, and round-trip preservation of unrelated keys.

## Impact

- Config command dispatch and help text (`pipeline.ts`, `runConfigCommand`).
- Config repo-map mutation helpers and tests (`config.ts`, `config.test.ts`).
- README and host skill documentation for the new command.
- Generated plugin mirror after core/host changes.
