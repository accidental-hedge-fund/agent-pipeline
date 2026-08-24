## Why

`isFactoryControlRepo("accidental-hedge-fund/agent-pipeline")` treats every clone of this GitHub repository as the factory control plane. `pipeline doctor` and `pipeline train` then default to pinned two-track intent and fail closed on a leftover `no-frg-*` pin in that clone. On 2026-08-24, `/pipeline train --milestone v1.39.13` from `/home/mcomardo/dev/agent-pipeline` (OMP → OpenCode, no factory env) died before planning on `install:engine-track` because the clone still had `no-frg-1.39.1`. Ordinary host `/pipeline` must boot without `AGENT_PIPELINE_PRODUCTION_PIN`. Factory pin policy must apply only on the live control checkout.

## What Changes

- Factory-control identity for two-track pin policy SHALL be a **checkout role** (live `REPO_DIR` / control worktree), not GitHub owner/name and not `package.json` `repository`.
- On a non-control clone of `accidental-hedge-fund/agent-pipeline`, `resolveEngineTrackIntent` for `doctor` / `train` SHALL be `null` (inactive). `install:engine-track` SHALL pass even if a leftover `no-frg-*` JSON exists under that clone.
- On the live factory control checkout, pinned intent SHALL still fail closed on `no-frg-*` / null evidence. One live pin file: `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. `engine-promote` / `factory-pin promote` SHALL write that file.
- Hermes-state `~/.local/state/hermes-factory/production-engine-pin.json` SHALL NOT be live pin authority. Host skill boot SHALL NOT require `AGENT_PIPELINE_PRODUCTION_PIN`.
- Shared identity helpers used for two-track defaults (`isFactoryControlRepo` and GitHub-name self-dogfood) SHALL stop meaning "this checkout is the factory plane."
- **BREAKING** for any host that relied on GitHub owner/name to activate pinned two-track policy on a developer clone. Explicit `--engine-track` / `engine_track` still activates the policy. `--skip-frg` still writes a non-production marker; that marker is not law on a developer clone.

## Acceptance criteria

- [ ] Factory-control identity for two-track pin policy is a checkout role (live `REPO_DIR` / control worktree). `config.repo === "accidental-hedge-fund/agent-pipeline"` and `package.json` `repository` owner/name do not activate factory-control context.
- [ ] On a non-control clone of `accidental-hedge-fund/agent-pipeline`, with no `--engine-track` / `engine_track` and no factory env, `resolveEngineTrackIntent` for `doctor` and `train` is `null`. `install:engine-track` passes when that clone has leftover `.agent-pipeline/production-engine-pin.json` with `frg_run_id` `no-frg-1.39.1`.
- [ ] On the live factory control checkout, default pinned intent still fails `install:engine-track` when the live pin is `no-frg-*` or has null/empty `frg_evidence_path`. One live pin file is `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. `engine-promote` and `factory-pin promote` write that file.
- [ ] Hermes-state `~/.local/state/hermes-factory/production-engine-pin.json` is not live pin authority. Host skill boot does not require `AGENT_PIPELINE_PRODUCTION_PIN`.
- [ ] A unit test fails if `evaluateEngineTrackCheck` / doctor identity treats a non-control clone of `accidental-hedge-fund/agent-pipeline` as pinned and fails on `no-frg-1.39.1`. A second unit test fails if factory-control checkout context accepts a `no-frg-*` pin as production-quality. Tests inject I/O.
- [ ] `--skip-frg` still writes a non-production `no-frg-*` marker. That marker does not become pinned law on a developer clone.
- [ ] After any `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This is class law on existing pin identity, doctor, and promote surfaces. A new capability folder would hide the class in a mole spec. -->

### Modified Capabilities

- `factory-two-track-engine-pinning`: Factory-control identity SHALL be the live control checkout, not GitHub owner/name. Non-control clones SHALL leave two-track policy inactive. The live control checkout SHALL keep pinned fail-closed behavior and one pin file at `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. Hermes-state SHALL NOT be pin authority. Host skill boot SHALL NOT require `AGENT_PIPELINE_PRODUCTION_PIN`.
- `install-version-coherence`: Doctor `install:engine-track` SHALL use checkout-role identity. A non-control clone of this GitHub repo SHALL NOT fail solely on a leftover `no-frg-*` pin. The live control checkout SHALL still fail closed on that marker under pinned intent.
- `engine-promote`: `factory-pin` self-dogfood SHALL be checkout-role, not `package.json` GitHub repository identity. Promote SHALL write the live control-checkout pin file.

## Impact

- **Identity core:** `core/scripts/production-engine-pin.ts` (`isFactoryControlRepo`, `isFactoryControlPackageMeta`, `resolveEngineTrackIntent`, `resolveFactoryPinAuthority`, `evaluateEngineTrackCheck`). Shared by doctor, train/advance, and factory-pin.
- **Doctor:** `core/scripts/stages/doctor.ts` `install:engine-track` and `install:production-pin-path` factory-control context.
- **Run start:** `core/scripts/pipeline-run.ts` two-track default. `pipeline train` dies on doctor-on-start today; the same identity must not pin a developer clone.
- **factory-pin CLI:** `core/scripts/pipeline.ts` self-dogfood via `package.json` `repository`. A developer clone SHALL NOT gain pin-write authority from GitHub name.
- **Tests:** `core/test/production-engine-pin.test.ts`, `core/test/doctor.test.ts`. Inject I/O. No real network, git, or subprocess.
- **Docs:** FRG runbook / supervisor docs already say one pin at `$REPO_DIR/.agent-pipeline/production-engine-pin.json` and that Hermes-state is not authority. Align identity wording with checkout role.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit. `npm run ci` must pass.
- **Depends on:** nothing. Independent of #1235 (OMP host) and #1236 (Node bootstrap). Unblocks every host the same way.
- **Does not:** ship `hosts/omp`; change launcher Node bootstrap; rewrite Tugboat/Hermes/Buzz; delete `--skip-frg`; add `auto_merge` or a merge stage; treat Hermes-state as pin authority.
