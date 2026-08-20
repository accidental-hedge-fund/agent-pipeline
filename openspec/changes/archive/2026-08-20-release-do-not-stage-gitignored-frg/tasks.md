## 1. Regression tests that bite current staging

- [x] 1.1 Add a `runRelease` unit test: FRG pass + gitignored `.agent-pipeline/frg/` → `git add` argv MUST NOT contain `.agent-pipeline/frg` or any path under it. Prove it fails on current `addPaths.push(releaseFrgDir)`
- [x] 1.2 Add a `runRelease` unit test: `git add` exits non-zero after `git checkout -b` → HEAD is not left on `release/vX.Y.Z`; restore of version files ran; FRG path was not cleaned. Prove it fails on the current post-branch throw with no restore
- [x] 1.3 Keep injecting `runCommand` / deps. Do not call live git, network, or GitHub

## 2. Stop staging FRG

- [x] 2.1 Remove `if (frgEvidence) addPaths.push(releaseFrgDir)` from `runRelease`. Keep `addPaths` as the living product set (`package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`)
- [x] 2.2 Do not `git add -f`. Do not un-ignore `.agent-pipeline/frg/`. Do not add `CHANGELOG.md` to the stage set
- [x] 2.3 Leave `requireFrgPassForRelease` fail-closed. Missing / fail / unparsable / unbound evidence still aborts before bump. `--skip-frg` is not the path

## 3. Restore base on add/commit failure

- [x] 3.1 Extend the rollback guard through `git add` and `git commit`. Point of no return is a successful release commit
- [x] 3.2 On add/commit failure: restore release-managed files from HEAD (same pathspec as today's `restoreCheckout`), check out configured `base_branch` (default `main`), delete local `release/vX.Y.Z` only when it has no unique commit
- [x] 3.3 Do not `git checkout --` or `git clean` `.agent-pipeline/frg`. Do not restore after a successful commit (push failure stays on the branch)

## 4. Flip existing tests

- [x] 4.1 Change `runRelease: release commit stages only the validated version FRG directory` so it asserts `git add` does not include `.agent-pipeline/frg`
- [x] 4.2 Change `runRelease: a post-staging failure preserves the validated FRG input` so commit failure still does not clean/checkout FRG, and now restores the configured base
- [x] 4.3 Keep skipFrg "must not stage FRG" coverage. Keep missing/failed FRG abort-before-write coverage

## 5. Docs and gate

- [x] 5.1 If the FRG runbook or release docs still imply `pipeline release` commits `.agent-pipeline/frg/<ver>`, correct them to on-disk lookup + PR-body `run_id`
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.3 Run `openspec validate release-do-not-stage-gitignored-frg` and `npm run ci` from the repo root. Fix failures until green
