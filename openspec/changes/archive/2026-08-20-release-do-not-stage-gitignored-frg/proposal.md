## Why

After HMAC `latest.json` `pass: true` for 1.39.5, Tugboat ran `pipeline release 1.39.5 --no-edit`. `runRelease` still `git add`s `.agent-pipeline/frg/<ver>` when FRG evidence is present. #1127 gitignored that tree so evidence stays local. `git add` of an ignored path is a hard fail. No release PR opened. The control checkout stayed on `release/v1.39.5` with uncommitted version bumps. Ship died at `release-prepare`.

## What Changes

- **Class law:** `pipeline release` SHALL NOT pass `.agent-pipeline/frg/` (or any path under it) as an explicit `git add` pathspec, including `git add -f`. Evidence stays on disk. The release commit is living release-managed product files only (version bumps, ROADMAP, plugin mirror).
- **FRG gate stays fail-closed.** Missing, unbound, or non-pass on-disk `latest.json` still aborts prepare. `--skip-frg` is not the path. HMAC / pack policy does not change.
- **Post-branch add/commit restore.** After `git checkout -b release/vX.Y.Z`, a failed `git add` or `git commit` SHALL restore the configured base (`main` unless `base_branch` says otherwise). It SHALL NOT leave the control checkout on `release/vX.Y.Z` with uncommitted version bumps. On-disk FRG files SHALL remain.
- **Class vs site.** The site is `runRelease` addPaths for 1.39.5. The class is: an engine command MUST NOT `git add` an artifact-ignore-contract path, and a failed release stage/commit MUST restore the base checkout so the next identical prepare can retry.
- **BREAKING** for tests or fixtures that still assert `git add` includes `.agent-pipeline/frg/<ver>` after an FRG pass.

Non-goals: committing `latest.json` so `git add` succeeds; `--skip-frg` as the ship path; changing HMAC / pack policy; staging CHANGELOG as a new prepare output; merging inside advance/loop.

## Acceptance criteria

- [ ] With `.agent-pipeline/frg/` gitignored and a release-eligible on-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` (`pass: true`, HMAC bound to the candidate SHA), `pipeline release <X.Y.Z> --no-edit` does not pass `.agent-pipeline/frg` (or any path under it) to `git add`. Evidence stays on disk. The release commit contains version / ROADMAP / plugin-mirror files only.
- [ ] The same path still requires that on-disk `latest.json`. Missing, `pass: false`, invalid HMAC, or unbound candidate SHA fail-closes before a successful release PR. `--skip-frg` is not the default path and is not the fix.
- [ ] When `git add` or `git commit` fails after `git checkout -b release/vX.Y.Z`, the command restores the configured base branch. HEAD is not left on `release/vX.Y.Z`. Uncommitted version bumps are not left in the working tree. On-disk FRG files are not deleted.
- [ ] A unit test fails if `addPaths` includes `.agent-pipeline/frg` when that path is gitignored, or if a failed add leaves HEAD on the release branch.
- [ ] Existing tests that currently require staging `.agent-pipeline/frg/<ver>` are flipped to the new law. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `release-sub-command`: Live `pipeline release` SHALL NOT stage `.agent-pipeline/frg/`. It SHALL still require on-disk release-eligible FRG evidence. After branch creation, a failed `git add` or `git commit` SHALL restore the configured base and SHALL NOT leave uncommitted version bumps on `release/vX.Y.Z`.
- `factory-reliability-gate`: Release-eligible FRG evidence SHALL remain an on-disk lookup. Attachable on the release PR means `run_id` / pass summary on the PR surface, not `git add` of gitignored `.agent-pipeline/frg/`.
- `engine-artifact-ignore-contract`: Engine commands SHALL NOT pass an artifact-contract ignore path as an explicit `git add` pathspec. Explicit add of an ignored path is a hard fail; omitting that pathspec is the product fix.

## Impact

- **Engine:** `core/scripts/stages/release.ts` `runRelease` staging (`addPaths`) and the post-`checkout -b` failure path. Rollback today ends at branch creation; add/commit failures currently throw with no restore.
- **Tests:** `core/test/release.test.ts` cases that assert FRG is staged, plus a new regression that failed add restores the base. Inject `runCommand`; no live git, network, or GitHub.
- **Ignore contract:** `.gitignore` already lists `.agent-pipeline/frg/` (#1127). This change does not un-ignore it and does not `git add -f`.
- **Does not:** change `requireFrgPassForRelease` HMAC/pack rules; default `--skip-frg`; commit FRG; merge inside advance/loop; add CHANGELOG to the prepare stage set.
- **Evidence:** `ship-v1.39.5/release-prepare.err` 2026-08-19T20:11:34Z (`git add failed: … ignored … .agent-pipeline/frg`); `release.ts` ~2175–2185; control after fail: branch `release/v1.39.5` at `a949c581`, dirty version `1.39.5`, no commit, not pushed.
