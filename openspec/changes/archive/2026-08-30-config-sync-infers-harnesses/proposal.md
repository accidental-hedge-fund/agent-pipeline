## Why

#1240 made `harnesses.implementer` and `harnesses.reviewer` required repository execution policy, but shipped no migration path. `pipeline config sync` is the command whose job is to refresh an existing `.github/pipeline.yml`, yet it is blocked by the missing key it exists to add. Upgrading a 1.38.x consumer to 1.39.x therefore takes every repo-bound command offline, including `status` and `doctor`, until a human hand-edits the file.

## What Changes

- `pipeline config sync` MAY proceed when the only validation errors are omitted required harness roles. It infers each missing role from explicit `models:` values (and `review_harness.command` when present) via a closed, versioned, migration-only alias table. It never fills a role from the host profile. A commented `# harnesses:` block is not policy.
- Failed inference writes nothing, exits 2, and names each unresolved role. Successful preview shows the complete candidate. `--apply` writes through the existing append-preserving sync path, then the candidate receives full configuration validation.
- Missing-role diagnostics name `pipeline config sync`. A missing file still names `pipeline init`. `pipeline config validate` and every other verb stay fail-closed.
- This repository's `.github/pipeline.yml` ships active `harnesses.implementer` and `harnesses.reviewer`. `npm run ci` runs `config validate` against that file.
- ADR `docs/adr/0001-config-sync-infers-harnesses-from-models.md` remains the governing design record and is expanded to the 2026-08-29 locked clarification.

Out of scope: weakening `status`, `doctor`, or execution `resolveConfig()`; filling roles from the active profile; treating comments as policy; inferring OpenCode, Pi, extension, `auto`, or unknown aliases; a generic migratable-key framework beyond harness roles.

## Capabilities

### New Capabilities

- `config-sync-harness-inference`: the `config sync` exception, the closed alias table, implementer/reviewer evidence rules, preserve-declared-roles, preview/apply, and failed-inference exit 2.

### Modified Capabilities

- `required-repository-harness-roles`: missing-role diagnostics name `pipeline config sync`; missing-file diagnostics still name `pipeline init`; execution stays fail-closed. This engine repository declares both roles and CI validates the file.
- `config-validate-command`: `config validate` still errors on missing roles and now names `pipeline config sync`. `config sync` is no longer blocked solely by those missing-role errors.
- `pipeline-configuration`: sync may rewrite a file whose only errors are omitted required harness roles; the inferred roles are the allowed effective change.
- `configurable-harness-roles`: sync still MUST NOT invent a live role from the active profile; it MAY infer a missing role from models per `config-sync-harness-inference`.
- `init-command`: the "refuse to change effective configuration" rule gains the same named exception for inferred missing harness roles.

## Impact

- `core/scripts/config.ts` (`syncConfig`, missing-role diagnostics, inference helper, alias table). `core/scripts/pipeline.ts` exit code for failed inference.
- Unit tests in `core/test/config.test.ts` (and adjacent config tests) with injected fakes. The existing `#1240` "do not invent from profile" test stays.
- This repo's `.github/pipeline.yml` (active `harnesses` if absent) and the `npm run ci` chain (a `config validate` step).
- ADR 0001, generated `docs/config.md` if schema/diagnostic copy changes, and `node scripts/build.mjs` after any `core/` edit.

## Acceptance criteria

- [ ] `pipeline config sync` on a pre-1.39 file that omits `harnesses:` and has unambiguous implementer/reviewer model evidence proceeds. Preview writes nothing. `--apply` adds the inferred `harnesses` block and preserves other explicit values.
- [ ] `pipeline config sync --apply` on the reporter shape (`models.planning`/`implementing`/`fix` Claude aliases, `models.review` a Codex/OpenAI id) writes `implementer: claude` and `reviewer: codex`.
- [ ] `pipeline config sync` still fails closed, writes nothing, and does not use the active profile when models are absent, `auto`, unknown, conflicting, OpenCode, Pi, or extension-only.
- [ ] Failed inference exits 2 and names each unresolved role (`harnesses.implementer` and/or `harnesses.reviewer`).
- [ ] Any other validation error (unknown key, invalid YAML, schema type error, conflicting `review_harness`) still blocks sync. `config validate`, `status`, and `doctor` stay fail-closed on missing roles.
- [ ] An already-declared role is preserved. Only omitted roles are inferred. A commented `# harnesses:` block is treated as omitted.
- [ ] Missing-role diagnostics from `resolveConfig()`, `config validate`, and sibling commands name `pipeline config sync`. A missing file still names `pipeline init`.
- [ ] This repository's `.github/pipeline.yml` contains uncommented `harnesses.implementer` and `harnesses.reviewer`. `npm run ci` fails if `pipeline config validate` against that file is invalid.
- [ ] ADR 0001 records the locked inference rules. Unit tests prove the regression (sync blocked by missing roles; profile fill) would fail without the fix. `openspec validate config-sync-infers-harnesses` and `npm run ci` pass.
