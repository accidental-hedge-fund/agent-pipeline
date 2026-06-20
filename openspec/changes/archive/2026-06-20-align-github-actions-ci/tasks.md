## 1. Update GitHub Actions CI workflow

- [ ] 1.1 Replace the four manually-enumerated steps in `.github/workflows/ci.yml` (Core test suite, Generated plugin is up to date, Install smoke test) with a single `npm ci --no-audit --no-fund` install step (root) followed by `npm run ci`, keeping the Node 24 setup and checkout steps.
- [ ] 1.2 Verify the updated workflow file is syntactically valid YAML and references the correct working directory (root, not `core/`).

## 2. Verify CI gate

- [ ] 2.1 Confirm `npm run ci` runs all four sub-commands locally: `ci:core`, `node scripts/build.mjs --check`, `ci:install-smoke`, `ci:launcher-smoke`.
- [ ] 2.2 Confirm the CI job log (from a push or PR) includes launcher smoke output (`launcher smoke: N passed, 0 failed`).

## 3. Mirror + CI

- [ ] 3.1 `node scripts/build.mjs` — no core/ changes so mirror should remain in sync; verify with `--check`.
- [ ] 3.2 `npm run ci` green.
