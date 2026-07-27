# Tasks — js-yaml-dos-advisory-bump (#625)

## 1. Bump the declared floor and relock

- [x] 1.1 Change `dependencies["js-yaml"]` in `core/package.json` from `^4.1.0` to `^4.3.0`.
- [x] 1.2 From `core/`, relock narrowly (`npm install js-yaml@^4.3.0 --package-lock-only --no-audit
  --no-fund`, then `npm install --no-audit --no-fund`) so `node_modules/js-yaml` resolves to
  `>=4.3.0` with the matching `resolved` URL and `integrity` hash.
- [x] 1.3 Inspect `git diff core/package-lock.json` and confirm only the js-yaml entry (and its own
  unchanged `argparse ^2.0.1` dependency line, if reordered) moved — no unrelated packages churned.

## 2. Verify the advisory is actually gone

- [x] 2.1 `cd core && npm ci && npm audit` — confirm zero entries attributed to `js-yaml`, and that
  neither GHSA-h67p-54hq-rp68 nor GHSA-52cp-r559-cp3m appears. Capture the before/after output as
  evidence.
- [x] 2.2 Confirm no file under `core/scripts/` needed a change (the 4.x API and the
  `YAMLException.mark.line` shape used by the config diagnostics path are unchanged).

## 3. Floor-guard regression test

- [x] 3.1 Add a `node --test` case in `core/test/` that reads `core/package.json` and
  `core/package-lock.json` from disk and asserts (a) the declared `js-yaml` range's floor is
  `>=4.3.0` and stays within 4.x, and (b) the lockfile-resolved `node_modules/js-yaml` version is
  `>=4.3.0`. No network, git, or subprocess calls; no new dependency for the comparison.
- [x] 3.2 Prove both halves bite: temporarily revert `core/package.json` to `^4.1.0` → test fails;
  restore, temporarily revert the lockfile entry to 4.1.1 → test fails; restore both.

## 4. Existing parse/emit coverage

- [x] 4.1 `cd core && npm test` — all green, in particular `config.test.ts`,
  `config-template-exhaustive.test.ts`, `namespaced-commands.test.ts`, and `release.test.ts`.
- [x] 4.2 Confirm the malformed-`.github/pipeline.yml` path still yields a config diagnostic with a
  1-based line number under 4.3.0 (add or extend an assertion if the existing coverage does not pin
  the line number).

## 5. Regenerate the plugin mirror

- [x] 5.1 `node scripts/build.mjs` from the repo root; confirm
  `plugin/pipeline/skills/pipeline/core/package.json` and `…/core/package-lock.json` now carry the
  same range and resolved version as `core/`.
- [x] 5.2 `node scripts/build.mjs --check` exits zero; commit the regenerated mirror in the same
  change.

## 6. Full gate and close-out

- [x] 6.1 `npm run ci` from the repo root — green (`ci:core`, `build.mjs --check`, install smoke,
  launcher smoke, `openspec validate --all`, `ci:scripts`).
- [x] 6.2 `openspec validate js-yaml-dos-advisory-bump --strict` passes.
- [ ] 6.3 File follow-up issues for the two deliberately deferred items: consolidating onto the
  single `yaml` package, and a repo-wide `npm audit` CI gate (see `design.md` decisions 3 and 5).
- [x] 6.4 Re-read the proposal's acceptance criteria and confirm each is satisfied with evidence.
