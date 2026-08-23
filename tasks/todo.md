# #1223 Revised plan — getPrDiff files-API fallback

## Status

- [x] Plan review feedback incorporated (see chat `## Feedback Incorporated`)
- [x] Implementation (`core/scripts/gh.ts` only for helper + classifier)
- [x] Tests in `core/test/gh.test.ts` (injectable runner; prove 406 + omitted-text tests fail on current helper)
- [x] OpenSpec change `getprdiff-files-api-fallback` kept in sync
- [x] `node scripts/build.mjs` after any `core/` edit
- [x] `npm run ci`

## Locked decisions (post plan-review)

1. Fast path stays `gh pr diff -R cfg.repo` with `retries: 1`. 406 is not transient.
2. Fallback is `gh api repos/${cfg.repo}/pulls/${n}/files?per_page=100 --paginate --slurp`, flattened as `T[][]` (live PR #1222: 4 pages, 377 files).
3. Omitted text (`patch` missing, `changes > 0`) is materialized from git blobs / contents. Header-only is only for `changes === 0`.
4. Flattened length `>= 3000` throws. No silent prefix.
5. Same `cfg.repo` as fast path. No `--hostname`. No `git diff`. No caller signature change.
6. OpenSpec delta lives at `openspec/changes/getprdiff-files-api-fallback/`.

See that change's `design.md` for the full contract.

## Results

- `getPrDiff` tries `gh pr diff` first (`retries: 1`). HTTP 406 / too-large falls back to paginated files-list composition.
- Omitted text patches (`patch` absent, `changes > 0`) are materialized from git blobs / contents. A 3000-file list throws.
- Tests: `core/test/gh.test.ts` (injectable runner; 50 passing including #1223 cases).
- `openspec validate getprdiff-files-api-fallback`: valid.
- `node scripts/build.mjs --check`: clean.
- `npm run ci`: exit 0.
