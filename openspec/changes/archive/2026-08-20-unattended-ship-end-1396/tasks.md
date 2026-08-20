## 1. Tugboat Node 24 (#1162)

- [ ] Add `resolve_ship_end_node` and call it from `resolve_ship_end_cli`
- [ ] Test: PATH node 22 plus a later PATH node 24 spawns 24, not 22
- [ ] Test: unset `SHIP_END_NODE` still finds Node >= 24

## 2. ensure-tag repo identity (#1163)

- [ ] Observe owner/name from `git remote get-url origin` when `cfg.repo` is empty
- [ ] Tugboat `invoke_release_ensure_tag` passes `--repo-path "$REPO_DIR"`
- [ ] Test: empty repo plus a real origin remote does not throw
- [ ] Test: ensure-tag argv includes `--repo-path`

## 3. Candidate composer re-exec (#1164)

- [ ] After train-complete, exec candidate `examples/supervisor/shell/tugboat.sh`
- [ ] `TUGBOAT_SKIP_TRAIN=1` skips train and requires a prior train artifact
- [ ] Test: after train the composer path is the candidate SHA’s `tugboat.sh`
- [ ] Test: skip-train does not invoke `$PIPELINE train`

## 4. GitHub overlay on stale ledger (#1165)

- [ ] Overlay ledger `blocked` to `ready` when GitHub is R2D and checks are green
- [ ] Overlay ledger `ready` still requires live GitHub R2D and green checks
- [ ] Test: ledger blocked + GitHub R2D/green does not throw `did not finish clean`
- [ ] Test: ready ledger + missing R2D label throws `did not finish clean`
- [ ] Test: ready ledger + failed or pending check throws `did not finish clean`

## 5. Peeled pin SHA (#1166)

- [ ] Non-skip engine-promote writes peeled tag SHA
- [ ] Fail closed on missing peel, packed-not-ancestor, or FRG pass not true
- [ ] Test: null `git_sha` is refused; packed ancestor of peel is accepted

## 6. Tag push publishes Release (#1167)

- [ ] Assert `release.yml` `on.push.tags: v*` plus `gh release create`
- [ ] Assert Tugboat wait-release uses `gh release view` and never `gh release create`

## 7. Mirror and CI

- [ ] `node scripts/build.mjs`
- [ ] `npm run ci`
