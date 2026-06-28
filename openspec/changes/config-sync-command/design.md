## Context

`pipeline init` owns the starter `.github/pipeline.yml` template, and existing configs are intentionally preserved once created. That no-clobber behavior is correct for onboarding safety, but it leaves long-lived repos with valid configs whose examples, comments, and default blocks lag behind the current engine. The config loader already has strict schema validation, field-by-field default merging, and a never-throws validation path; sync should reuse those boundaries rather than inventing a second config format.

The agent-pipeline repo itself is in this state: the config is valid and carries intentional overrides, but its commented defaults omit newer fields such as intake/sweep timeouts, CI no-run grace, shipcheck, auto-loop, setup, and sandbox guidance.

## Goals / Non-Goals

**Goals:**

- Add a deterministic `pipeline config sync` command with preview-by-default behavior.
- Preserve effective runtime config while refreshing the YAML structure and comments to the current scaffold.
- Keep `pipeline init` no-clobber behavior unchanged.
- Make the sync behavior unit-testable with injected filesystem helpers and no GitHub/network calls.
- Update this repo's `.github/pipeline.yml` to follow the current scaffold shape while preserving its active overrides.

**Non-Goals:**

- Semantic migrations for deprecated config keys beyond surfacing diagnostics.
- Round-tripping arbitrary comments in legacy config files.
- Interactive conflict resolution.
- Modifying repo labels, issues, branches, PRs, or OpenSpec state through config sync.

## Decisions

**Decision: use the current init scaffold as the structural baseline.**

The command should not maintain a second template. The existing config template already reflects the engine's current defaults and is covered by init tests. Reusing it means newly added config keys appear in both fresh and synced configs.

**Decision: preserve behavior by overlaying explicit parsed values onto the scaffold.**

Sync should parse the existing YAML, validate it against the existing schema, then render a fresh scaffold with those explicit values uncommented or replaced. This keeps comments and key ordering current while preserving configured behavior. If the current file is invalid, sync should report diagnostics and avoid writing.

**Decision: preview mode prints a diff by default.**

Preview should be useful in terminals and CI. A unified diff is easier to review than a whole-file dump, and no write occurs unless an explicit apply flag is passed.

**Decision: apply mode writes only when sync can prove behavior preservation.**

After rendering, sync should validate the candidate and compare the resolved config before and after for behaviorally relevant fields. If the candidate changes effective config beyond intended preservation, apply must fail before writing.

**Decision: synced configs should follow the current init scaffold's active-default structure.**

The current init scaffold shows common defaults as active YAML. Config sync should follow that same shape so a synced file looks like a freshly initialized file plus the repo's explicit overrides. Behavior preservation is enforced by validating and comparing the effective config before writing, so default-valued active keys introduced by sync must not change runtime behavior.

## Risks / Trade-offs

- **Comment preservation is lossy** → Sync will prefer the current scaffold's comments over legacy comments. Mitigation: preview mode shows the exact diff, and apply is explicit.
- **Partial YAML editing can be brittle** → Rendering from parsed data plus scaffold markers is simpler and safer than token-level mutation. Mitigation: unit tests cover nested blocks and partial model overrides.
- **Behavior equivalence comparison may include derived identity fields** → Compare only config-file-governed behavioral fields, excluding profile/repo identity and command-line overrides. Mitigation: expose a focused helper and test it directly.
- **Repo-local config update could be mistaken for generated scaffold output** → Keep the repo-specific header and active overrides clear, while refreshing default-reference sections from the current scaffold.

## Migration Plan

1. Add config sync helpers and CLI dispatch.
2. Add unit tests for preview/apply, invalid config refusal, behavior preservation, and partial nested override preservation.
3. Update README and host skill docs.
4. Update this repo's `.github/pipeline.yml`.
5. Regenerate the plugin mirror and run CI.

Rollback is deleting the new command code and restoring the previous repo config file; no external state is mutated by preview mode.

## Open Questions

- None.
