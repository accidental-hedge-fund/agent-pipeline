## Context

1.39.5 proved train + HMAC + release PR can complete on the candidate CLI, then ship-end still needed a human for Node 22, empty `cfg.repo`, stale tugboat compose, a blocked pack ledger, null pin SHA, and a missing GitHub Release.

## Decisions

1. **Node 24 walk.** `resolve_ship_end_node` tries `SHIP_END_NODE`, then every `PATH` `node`, then `/usr/bin/node` and `/usr/local/bin/node`. The first binary whose `process.versions.node` major is >= 24 wins. The resolved path is logged. An explicit `SHIP_END_NODE` that is too old does not stick.

2. **Ensure-tag identity.** `resolveReleaseConfig` stays gh-free and may still return `repo: ""`. `defaultObserveMergedReleasePr` parses `git remote get-url origin` through `ownerRepoFromPackageRepository` when `repo` is empty. Tugboat adds `--repo-path "$REPO_DIR"` so the candidate launcher is not bound to engine-root cwd.

3. **Composer re-exec.** After `resolve_ship_end_cli`, Tugboat `exec`s `$SHIP_END_ENGINE_ROOT/examples/supervisor/shell/tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1` and `TUGBOAT_CANDIDATE_COMPOSER=$SHA`. Same PID keeps the ship lock. Skip-train requires a prior `train.complete.json` or `train.json`. Infinite re-exec is prevented by path equality or the composer SHA env.

4. **GitHub overlay.** `defaultCollectHybridV2FromRun` already fetches live labels and checks. Before `collectFrgPackObservations`, each ledger item whose GitHub labels include `pipeline:ready-to-deploy` and whose PR checks are all green is written as `state: "ready"`. Collect still throws if GitHub is not ready.

5. **Peel pin.** Non-skip `runEnginePromote` peels `vX.Y.Z^{commit}`, requires FRG `pass: true`, and requires packed `candidate_git_sha` to be that peel or an ancestor (`git merge-base --is-ancestor`). The pin `git_sha` is the peel, never null.

6. **Release from tag push.** `.github/workflows/release.yml` already runs on `push.tags: v*` and calls `gh release create`. Tugboat wait-release stays `gh release view`. No composer `gh release create`. A unit test locks the workflow trigger and the Tugboat wait path.

## Risks

- Re-exec chicken-egg: a proving ship started from 1.39.5 tugboat will not re-exec until I3 is in the process-start script. Merge I1–I6, fast-forward `REPO_DIR`, then ship.
- Overlay must not treat empty or pending checks as green.
- Peel vs packed: squash merge of the release PR is a version bump only; packed HMAC SHA is an ancestor of the peel, not equal.
