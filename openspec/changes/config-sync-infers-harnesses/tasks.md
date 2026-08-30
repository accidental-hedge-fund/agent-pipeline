## 1. Diagnostics name the remediation command

- [ ] 1.1 Extend the shared omitted-role diagnostic so it names `pipeline config sync`, and verify `resolveConfig()` and `pipeline config validate` messages for a missing `harnesses` block include both the missing keys and `pipeline config sync`
- [ ] 1.2 Keep the missing-file diagnostic naming `pipeline init` only, and verify a repo with no `.github/pipeline.yml` still directs the operator to `pipeline init` and does not name `config sync` as the create command

## 2. Sync exception and inference table

- [ ] 2.1 Allow `syncConfig` to continue when every error diagnostic is an omitted required harness role, and verify a fixture with no `harnesses:` block and otherwise valid YAML no longer returns `ok: false` solely for those missing keys
- [ ] 2.2 Keep `syncConfig` fail-closed on any other error, and verify fixtures for unknown key, invalid YAML, empty-string role, and unknown key inside `harnesses` still write nothing
- [ ] 2.3 Add the versioned migration-only alias table (Claude / Grok / `gpt-` → `codex`) and verify representative values (`sonnet`, `claude-fable-5`, `grok-4.6`, `gpt-5.6-terra`) classify and `auto`, unknown, OpenCode, and Pi values do not
- [ ] 2.4 Keep the existing `#1240` test that refuses to invent a missing reviewer from the active profile, and verify it still fails to write when reviewer evidence is absent

## 3. Role inference rules

- [ ] 3.1 Infer implementer from unanimous classified `models.planning` / `implementing` / `fix` / `intake` / `sweep` values, and verify one classified field is enough and conflicting or unknown siblings leave implementer unresolved
- [ ] 3.2 Infer reviewer from `models.review` and explicit `review_harness.command`, and verify built-in command agreement, custom command without classified review model, and custom-or-built-in plus disagreeing review model all match the spec
- [ ] 3.3 Preserve every declared role and infer only omitted roles, and verify `implementer: grok` plus `models.review: gpt-5.6-terra` writes `reviewer: codex` without changing implementer
- [ ] 3.4 Treat a commented `# harnesses:` block as omitted policy, and verify unambiguous `models:` evidence still infers roles

## 4. Preview, apply, and exit codes

- [ ] 4.1 Make preview print the complete candidate including inferred `harnesses` and write nothing, and verify `pipeline config sync` without `--apply` exits 0 with the file unchanged
- [ ] 4.2 Apply inferred roles through append-preserving sync (append a missing top-level `harnesses` block; rewrite only a partial `harnesses` block), then fully validate the candidate before write, and verify unrelated keys and comments stay byte-identical
- [ ] 4.3 Failed inference writes nothing, names each unresolved role, and exits 2, and verify a conflicting-implementer plus missing-reviewer fixture exits 2 rather than 1
- [ ] 4.4 Other sync blocks stay at exit 1, and verify an unknown-key fixture still exits 1

## 5. Engine self-host file, ADR, and CI

- [ ] 5.1 Confirm this repository's `.github/pipeline.yml` contains uncommented `harnesses.implementer` and `harnesses.reviewer`, and add them only if absent
- [ ] 5.2 Expand `docs/adr/0001-config-sync-infers-harnesses-from-models.md` to the locked 2026-08-29 rules, and verify it remains the single ADR for this change
- [ ] 5.3 Add a `npm run ci` step that runs in-tree `config validate` / `validateConfig` against this repo's live `.github/pipeline.yml`, and verify the gate fails if that file omits a required role
- [ ] 5.4 Update generated config docs if diagnostic or schema copy changes, and verify `npm run ci` docs check is green

## 6. Packaging and gate

- [ ] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change, and verify `node scripts/build.mjs --check` passes
- [ ] 6.2 Run `openspec validate config-sync-infers-harnesses` then `npm run ci` from the repo root, and verify both are green
