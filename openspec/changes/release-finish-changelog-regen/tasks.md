## 1. Shared post-tag docs refresh helper

- [ ] 1.1 Add a testable helper under `core/scripts/` that regenerates docs (generator write contract) and commits generator-owned dirt when present, with injectable deps for generate/write, dirt detection, commit, and push
- [ ] 1.2 Define success no-op when generation produces no diff (no empty commit)
- [ ] 1.3 Fail closed on generate or commit/push errors without deleting or rewriting version tags
- [ ] 1.4 Restrict staged paths to generator-owned artifacts (at least `CHANGELOG.md`; co-owned outputs dirtied by the same generate only)

## 2. Auto-tag workflow invoker (primary live path)

- [ ] 2.1 After successful annotated tag create/push in `.github/workflows/auto-tag-release.yml`, invoke the helper (via a small repo script entry or equivalent) on a checkout that can see the new tag
- [ ] 2.2 Ensure the docs commit push uses a contents-write credential already required for release automation; document any secret scope gap as a hard failure message
- [ ] 2.3 Confirm a subsequent auto-tag run on the docs commit subject is a successful no-op (no re-tag / no loop)
- [ ] 2.4 Extend workflow drift-guard tests so the post-tag docs-refresh step cannot be removed unnoticed

## 3. Release finish optional heal (secondary)

- [ ] 3.1 Keep `release finish` merge-only for tag/publish authority (no tag create, no GitHub Release publish)
- [ ] 3.2 Optionally observe tag presence after merge and call the same helper when writable; ensure idempotent no-op when already fresh
- [ ] 3.3 Do not unmerge the PR if docs heal fails; surface a clear retry/heal error instead

## 4. Regression tests

- [ ] 4.1 Unit test: inject a fake release/tag list that includes a new version → assert generate write + commit of generator-owned paths (including `CHANGELOG.md`)
- [ ] 4.2 Unit test: no dirt after generate → no commit, success
- [ ] 4.3 Unit test: generate failure → error, no commit, no tag deletion
- [ ] 4.4 Prove the happy-path test fails if regenerate-and-commit is removed (regression bite)

## 5. Comments and operator surface

- [ ] 5.1 Update release-stage comments near retired ROADMAP history helpers to point at post-tag CHANGELOG refresh (not prepare-time history accretion)
- [ ] 5.2 Note in release runbook / command help if needed that tag-derived CHANGELOG refresh is automatic after auto-tag, not a manual next-PR chore

## 6. Verify and ship prep

- [ ] 6.1 Run `openspec validate release-finish-changelog-regen` (and `openspec validate --all` if required by local gate) after any artifact edits
- [ ] 6.2 Run targeted core tests for the new helper + workflow drift guards
- [ ] 6.3 After implementation: `node scripts/build.mjs` if any `core/` runtime files change, commit `plugin/` mirror in the same change, and pass `npm run ci`
