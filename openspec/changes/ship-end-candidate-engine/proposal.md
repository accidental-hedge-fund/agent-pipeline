## Why

Tugboat ship-end always invokes `$PIPELINE` (`~/.local/bin/pipeline`), which is the previously promoted production pin. Train merges candidate fixes into `main`, then `factory-release prepare`, `pipeline release`, `release finish`, and tag still run the old CLI. A 1.39.5 fix to `release.ts` (do not `git add` gitignored FRG) cannot ship 1.39.5 until that candidate engine is the running CLI. 1.39.4 promote also left `~/.local/bin/pipeline-ship-playbook` stale versus repo `tugboat.sh`.

## What Changes

- **Class law:** after train-complete, ship-end verbs that score or publish the candidate SHALL execute the **candidate** engine (control checkout at the FRG-bound SHA, or an explicit candidate install). They SHALL NOT execute the previous production pin.
- **Ship-end set:** `factory-release prepare`, `factory-gate` (FRG pack attestor), `pipeline release`, `pipeline release finish`, and any composer-invoked tag. Train / implementer / review harnesses stay on the production pin.
- **Playbook parity:** installed `pipeline-ship-playbook` SHALL match repo `examples/supervisor/shell/tugboat.sh` on that candidate SHA, **or** Tugboat SHALL run the repo script from `REPO_DIR`. Marker-only presence SHALL NOT count as parity.
- **Gate:** a unit test or doctor check SHALL fail when ship-end `$PIPELINE --version` or playbook digest does not match the candidate SHA being released, whenever those tools are used for release / FRG / tag.
- **Observable outcome:** a 1.39.x ship SHALL be able to land a `release.ts` fix on `main` and then open the release PR with that fix in the running CLI.
- **BREAKING** for any ship composer, test, or doctor posture that still treats the production-pin CLI as the correct executor for post-train FRG / release / finish / tag.

Non-goals: running implementer/review harnesses on an unpromoted engine for the train items themselves; `--skip-frg` as the ship path; auto-promoting before GitHub Release.

## Acceptance criteria

- [ ] After train-complete, Tugboat (and the installed playbook copy, and in-engine `pipeline ship`) invoke `factory-release prepare`, `factory-gate`, `pipeline release`, `release finish`, and any composer-invoked tag using the candidate engine at the FRG-bound SHA (or an explicit candidate install), not `~/.local/bin/pipeline` when that binary is the previous production pin.
- [ ] Train `--merge` still invokes the production-pin CLI. Implementer and review harnesses for train items do not switch to the unpromoted candidate.
- [ ] Installed `pipeline-ship-playbook` content digest matches candidate `examples/supervisor/shell/tugboat.sh`, **or** the composer execs that repo script from `REPO_DIR`. A stale installed playbook used for ship-end fails the check.
- [ ] A unit test or doctor check fails when ship-end `$PIPELINE --version` or playbook digest does not match the candidate SHA being released (skip when those tools are not used for release/FRG/tag).
- [ ] A fixture of “production pin is 1.39.4, candidate SHA contains a `release.ts` fix, train is complete” opens (or would open) the release PR using the candidate CLI, not 1.39.4.
- [ ] `--skip-frg` remains an operator escape with a logged reason. It is not the default ship path. Promote still waits for GitHub Release publication.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `ship-end-candidate-engine`: Shared class law that ship-end (FRG pack, release prepare, release finish, tag) executes the candidate engine bound to the SHA being released, plus a doctor/test gate that fails on production-pin / stale-playbook mismatch.

### Modified Capabilities

- `tugboat-thin-ship`: After train-complete, Tugboat SHALL resolve and invoke the candidate engine for FRG pack, release, finish, and tag. `$PIPELINE` production-pin default SHALL apply to train only. Installed composer parity SHALL be candidate-SHA-bound, or Tugboat SHALL run the repo script from `REPO_DIR`.
- `supervisor-ship-playbook`: The installed alternate playbook SHALL use the same candidate-engine ship-end compose, or fail closed. Doctor SHALL fail a stale playbook used for release/FRG/tag.
- `release-sub-command`: Upgrade the candidate-native handoff from MAY to SHALL for ship-end composers when the installed production engine is behind the candidate that provides the command.
- `ship-coordinator`: In-engine `pipeline ship` SHALL run post-train FRG / release / finish / tag on the candidate engine, not on the production-pin process that started train.
- `factory-two-track-engine-pinning`: Document ship-end candidate execution as the publishing track. It is not a silent reclassification of pinned-track production/dogfood loops.

## Impact

- **Composers:** `examples/supervisor/shell/tugboat.sh`, `examples/supervisor/shell/pipeline-ship-playbook.sh`, shared FRG pack helpers. Candidate CLI resolution after train-complete.
- **Engine:** `core/scripts/stages/ship-adapter.ts` (in-engine ship post-train phases), `core/scripts/stages/doctor.ts` (or a pure helper it calls), possibly `core/scripts/tugboat-install-parity.ts` extended for candidate-SHA + `$PIPELINE --version` identity.
- **Tests:** hermetic fixtures that fail if ship-end argv still uses the production-pin binary when pin version ≠ candidate; playbook digest mismatch vs candidate tugboat; doctor skip when those tools are unused.
- **Docs:** `docs/runbooks/ship-milestone.md` and supervisor install notes: train = pin; ship-end = candidate.
- **Does not:** change train harness routing; add `--skip-frg` as default; promote before GitHub Release; merge inside advance/loop; reverse papercut backlog policy (#538).
- **Depends on:** living Tugboat FRG pack (#1039 / #1133), candidate-native `factory-release prepare` (#1037), two-track pin, Option 1 pack digest parity (#927).
- **Evidence:** 1.39.5 Tugboat `PIPELINE=/home/mcomardo/.local/bin/pipeline` version `1.39.4`; installed playbook digest `2afe3c92…` vs repo tugboat on `a949c581` digest `9b8063d1…`; `release.ts` git-add fail ran inside 1.39.4 CLI against gitignored FRG from #1127.
