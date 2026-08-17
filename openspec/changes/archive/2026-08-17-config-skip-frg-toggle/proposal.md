## Why

After #1039, Tugboat and the factory default require Factory Reliability Gate
(FRG) evidence on `pipeline release` and `pipeline engine-promote`. Skip is
CLI-only (`--skip-frg`). A repo that must ship while a pack is broken or
incomplete has no durable, repo-local escape except repeating that flag on
every command. `.github/pipeline.yml` has no key for this. `engine_track` is
pin vs candidate, not a gate switch.

## What Changes

- Add an optional boolean `skip_frg` on `.github/pipeline.yml`.
- `pipeline release` and `pipeline engine-promote` honor that key.
- Unset or `false` keeps FRG required. This is an escape, not a new
  default-off.
- Explicit CLI `--skip-frg` still skips. Config `true` skips when the flag
  is absent. Config cannot force FRG on if the operator passed `--skip-frg`.
- When the yml key causes the skip, the command logs that the skip came from
  config, not only from `--skip-frg`.
- Scaffold and `pipeline config sync` comment the key off. The comment uses
  the schema `.describe()` text. `docs/config.md` comes from the schema.
- This factory repo SHALL NOT set `skip_frg: true`. After #1039 the default
  remains FRG-on.

This is not **BREAKING**. The default path is unchanged.

## Acceptance Criteria

- [ ] Unset or `skip_frg: false`: `pipeline release` and
      `pipeline engine-promote` still require FRG unless the operator
      passes `--skip-frg`.
- [ ] `skip_frg: true`: both commands skip FRG without `--skip-frg` and
      log that the skip came from config.
- [ ] `--skip-frg` still skips when the yml key is false or unset.
- [ ] Config `false` or unset cannot force FRG on when `--skip-frg` is
      present.
- [ ] Scaffold / `config sync` show `# skip_frg: false` (commented off)
      with the schema `.describe()` text. Generated `docs/config.md`
      documents the key.
- [ ] This factory repo's committed `.github/pipeline.yml` does not set
      `skip_frg: true`.
- [ ] Unit tests cover default, config-true, and CLI-wins. After any
      `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

- `config-skip-frg`: Optional `skip_frg` on `.github/pipeline.yml`. Default
  unset/false requires FRG. Shared resolution for release and
  engine-promote. CLI `--skip-frg` wins. Config-sourced skip is logged as
  config. Scaffold and `config sync` comment the key off. This factory
  repo does not enable it.

### Modified Capabilities

- `release-sub-command`: The live `pipeline release` FRG check SHALL honor
  the resolved skip (CLI or config). A config-sourced skip SHALL name
  config in the skip log.
- `engine-promote`: The live `pipeline engine-promote` FRG check SHALL
  honor the same resolved skip. A config-sourced skip SHALL name config
  in the skip log.

## Impact

- **Schema / config:** `PartialConfigSchema` in `core/scripts/config.ts`;
  scaffold / `config sync` writer; generated `docs/config.md`.
- **Release:** `core/scripts/stages/release.ts` and the CLI wiring in
  `core/scripts/pipeline.ts` that sets `ReleaseOpts.skipFrg`.
- **Promote:** `core/scripts/stages/engine-promote.ts` /
  `production-engine-pin.ts` `allowWithoutFrg` and the CLI `--skip-frg`
  wiring.
- **Tests:** `core/test/release.test.ts`, `core/test/engine-promote.test.ts`,
  and config schema / scaffold tests. Inject I/O. No live pack.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Depends on:** #1039 (escape after the Tugboat default flips to FRG-on).
  Parallel with #1040 / #1041 is fine.
- **Does not:** flip Tugboat's default; disable `factory-gate`; change
  auto-tag or `no-frg-*` pin honesty; add a grant factory or second ship
  brain; set `skip_frg: true` on this factory repo.
