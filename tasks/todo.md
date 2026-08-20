# #1149 Revised plan — Tugboat tags from on-disk HMAC latest.json

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [ ] Implementation
- [ ] Tests (PATH-stub / injected git first; prove they fail on current compose)
- [ ] Docs + OpenSpec task/design precision
- [ ] `node scripts/build.mjs` after any `core/` edit
- [ ] `npm run ci`

## Locked decisions (post plan-review)

1. Independent packed-candidate source is factory-release request `integrated_candidate.git_sha` (Tugboat / `SHIP_END_CANDIDATE_SHA`) or `ShipTrainEvidence.integrated_head_oid` (in-engine). HMAC `latest.json` is compared to that SHA. It is not the authority for "this ship."
2. Living CLI gains required `--packed-candidate <40-hex>`. Positional args stay `<version> <mergeOid>`. Do not compare packed SHA to the merge commit.
3. Existing `vX.Y.Z` succeeds only as an annotated tag whose peeled commit equals the merge. Never force-update or delete. Concurrent push: re-observe origin and succeed only if that tag is correct.
4. Tugboat parses finish JSON `mergeCommitOid`, fails closed if not 40-hex, invokes recorded `SHIP_END_CLI` `release ensure-tag`, and stops before `wait-release` on any failure. Finish stays tag-free. Playbook stays exec of repo Tugboat.
5. Auto-tag skip is exact-path absent **and** `git check-ignore --quiet -- "$path"`. That branch does not tag. Notes, tag-create, and docs-refresh must not fail the job on that skip.
6. #1115/#1151 APIs that exist at this base are reused. Packed-candidate proof, Tugboat invoke, auto-tag skip-gating, and race re-observe are work in this change.

See `openspec/changes/ship-tag-from-on-disk-hmac/design.md` for the full contract.
