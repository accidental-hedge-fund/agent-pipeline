# #978 — Post-tag CHANGELOG regeneration

## Plan

- [x] Shared `release-docs-refresh` helper with injectable deps
- [x] Unit tests (happy dirt, clean no-op, generate fail, regression bite)
- [x] `scripts/release-docs-refresh.mjs` entry for auto-tag workflow
- [x] Wire auto-tag after successful tag create/push
- [x] Workflow drift-guard tests
- [x] Optional release-finish post-tag heal (idempotent, injectable)
- [x] Comments near retired ROADMAP history helpers + operator docs
- [x] `openspec validate`, build mirror, `npm run ci`, commit

## Review

### What changed

- New `core/scripts/release-docs-refresh.ts` + `scripts/release-docs-refresh.mjs`:
  regenerate generator-owned docs after tag `vX.Y.Z`, commit only owned dirt
  (at least `CHANGELOG.md`), fail closed without deleting tags.
- `auto-tag-release.yml` runs install + refresh after release version match /
  tag path; uses `RELEASE_TAG_TOKEN` for the docs commit push.
- `release finish` keeps merge-only production deps; optional heal via injectable
  `waitForReleaseTag` + `refreshPostTagDocs` (tests cover no-op, fail-after-merge,
  skip when tag absent). Operator heal CLI documented.
- Operator surface: concepts.md, release help, command-docs, release.ts comments.

### Verification

- Targeted: release-docs-refresh, auto-tag-workflow, release-finish — 45/45 pass
- `openspec validate release-finish-changelog-regen` + `--all` (268) pass
- `node scripts/generate-docs.mjs --check` ok
- `node scripts/build.mjs` + `npm run ci` exit 0

### Note

Primary live writer is auto-tag. Finish does not auto-push docs from operator cwd
(wrong-branch risk); heal is `node scripts/release-docs-refresh.mjs --version X.Y.Z --push`.
