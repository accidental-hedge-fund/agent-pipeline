## 1. Schema and scaffold

- [x] 1.1 Add optional top-level boolean `skip_frg` to `PartialConfigSchema` with `.describe()` text that states it is an escape, default unset/false requires FRG, and CLI `--skip-frg` still wins
- [x] 1.2 Merge the parsed key through `resolveConfig` / the gh-free yml parse. Leave `DEFAULT_CONFIG` without `skip_frg: true` (absence-default)
- [x] 1.3 Comment `# skip_frg: false` off in `buildConfigTemplate` / `config sync` using the schema `.describe()` text, same pattern as `engine_track`
- [x] 1.4 Confirm this factory repo's committed `.github/pipeline.yml` does not set `skip_frg: true`

## 2. Shared skip resolution

- [x] 2.1 Add one resolver used by both commands: CLI `--skip-frg` skips (source `cli`); else config `true` skips (source `config`); else no skip
- [x] 2.2 Read `skip_frg` from `.github/pipeline.yml` with the existing gh-free `PartialConfigSchema` parse. Missing file or unset key is not skip. Do not call full `resolveConfig()` for this read

## 3. Honor the resolver on release and promote

- [x] 3.1 `pipeline release` uses the resolver. Feed the existing `skipFrg` path (including soak-defect skip). When source is `config`, log that the skip came from config
- [x] 3.2 `pipeline engine-promote` uses the same resolver for `allowWithoutFrg`. When source is `config`, log that the skip came from config
- [x] 3.3 Keep `--skip-frg` working when the yml key is false or unset. Config cannot cancel an explicit CLI skip

## 4. Tests

- [x] 4.1 Schema / scaffold tests: key is optional boolean; template documents it commented off; generated schema description is present
- [x] 4.2 Resolver tests: unset/false = no skip; `true` = skip source config; CLI flag = skip source cli even when config is false or true
- [x] 4.3 Release tests: unset/false still requires FRG; config `true` skips without the flag and logs config; `--skip-frg` still skips when yml is false/unset
- [x] 4.4 Engine-promote tests: same three cases as 4.3
- [x] 4.5 Tests inject I/O. They make no real network, git, or subprocess calls. Prove at least one test fails without the fix

## 5. Docs, mirror, gate

- [x] 5.1 Regenerate `docs/config.md` from the schema so `skip_frg` appears with the `.describe()` text
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.3 Run `openspec validate config-skip-frg-toggle` and `npm run ci` from the repo root. Fix failures until green
