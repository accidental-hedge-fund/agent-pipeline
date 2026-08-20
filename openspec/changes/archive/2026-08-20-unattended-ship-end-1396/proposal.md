## Why

Ship v1.39.5 completed train and HMAC, then ship-end failed without a human. PATH `node` was 22, so the candidate launcher died. `release ensure-tag` could not re-observe the release PR because `cfg.repo` was empty. Process-start `tugboat.sh` kept composing FRG after train merged composer fixes. FRG collect threw when the durable ledger said `blocked` while GitHub already had `pipeline:ready-to-deploy` and green checks. `engine-promote` wrote `git_sha: null`. Wait-release timed out because the tag never landed, so `release.yml` never published.

A Buzz `Ship milestone vX.Y.Z` must finish tag, GitHub Release, and promote with zero operator steps outside pipeline CLI, Tugboat, and Hermes/Buzz.

## What Changes

- Tugboat SHALL spawn ship-end CLI with Node major >= 24 when `SHIP_END_NODE` is unset or too old. systemd `SHIP_END_NODE` is not required.
- `release ensure-tag` SHALL observe the merged release PR from the git remote owner/name when `cfg.repo` is empty. Tugboat SHALL pass `--repo-path "$REPO_DIR"`.
- After train-complete, Tugboat SHALL exec the packed-candidate tree’s `examples/supervisor/shell/tugboat.sh` for FRG pack onward and SHALL NOT re-run train.
- FRG collect / `factory-gate --from-run` SHALL score GitHub `pipeline:ready-to-deploy` plus green checks as ready even when the durable ledger still says blocked or the run stopped `recovery_exhausted`.
- Non-skip `engine-promote` SHALL write pin `git_sha` as the peeled annotated tag (40-hex). Packed HMAC `candidate_git_sha` MAY be an ancestor of that peel. Promote SHALL fail closed on missing peel, packed-not-ancestor, or `latest.json` `pass` not true.
- After a successful ensure-tag push, `release.yml` on `v*` tag push SHALL publish the non-draft GitHub Release. Tugboat SHALL NOT run `gh release create` or `git tag`.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `tugboat-thin-ship`: Node 24 ship-end spawn, ensure-tag `--repo-path`, candidate composer re-exec after train.
- `ship-end-candidate-engine`: process-start tugboat MUST NOT compose FRG after the candidate re-exec.
- `factory-reliability-gate`: GitHub ready-to-deploy overlay over a stale blocked ledger.
- `factory-two-track-engine-pinning`: peeled tag SHA on the production pin; packed SHA may be an ancestor.
- `release-workflow-annotated-notes`: tag push is sufficient for wait-release; Tugboat does not create the Release.

## Impact

- `examples/supervisor/shell/tugboat.sh` and `core/test/tugboat.test.ts`
- `core/scripts/stages/ship-adapter.ts`, `core/scripts/pipeline.ts`
- `core/scripts/frg-hybrid-v2-from-run.ts`, `core/scripts/frg-pack-observations.ts`
- `core/scripts/stages/engine-promote.ts`, `core/scripts/production-engine-pin.ts`
- Tests that bite each 1.39.5 failure. `plugin/` regenerated in the same change.

## Non-goals

- Human `git tag`, `gh release create`, pin JSON edits, ledger.json edits, `gh pr merge` around ready-to-deploy
- `--skip-frg` as the ship path
- Raising Grok implementer timeouts
- Committing gitignored `.agent-pipeline/frg/latest.json`
