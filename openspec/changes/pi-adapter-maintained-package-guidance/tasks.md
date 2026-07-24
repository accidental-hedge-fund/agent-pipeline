## 1. Update the Pi adapter install guidance (core)

- [ ] 1.1 In `core/scripts/harness-adapters/pi.ts`, replace `@mariozechner/pi-coding-agent`
      with `@earendil-works/pi-coding-agent` in the `missing-cli` preflight `message`.
- [ ] 1.2 Update the file-header provenance comment's package name to
      `@earendil-works/pi-coding-agent` (keep the `pi -p ...` argv provenance and other
      notes intact — only the package name changes).

## 2. Add the regression assertion

- [ ] 2.1 In `core/test/harness-adapters-preflight.test.ts`, add a test asserting the Pi
      adapter's `missing-cli` guidance names `@earendil-works/pi-coding-agent` and does NOT
      contain `@mariozechner/pi-coding-agent`.
- [ ] 2.2 Prove the test bites: confirm it fails against the pre-change string, then passes
      after task 1.

## 3. Regenerate the packaged-plugin mirror

- [ ] 3.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` copy in the
      same change.
- [ ] 3.2 Confirm `node scripts/build.mjs --check` reports the mirror in sync.

## 4. Verify

- [ ] 4.1 Confirm no executable source under `core/` or `plugin/` still contains
      `@mariozechner/pi-coding-agent` (archive records exempt).
- [ ] 4.2 Confirm Pi preflight still keys `missing-cli` off the `pi` binary presence check
      (`--version`/`--help`) unchanged — no probe-argument or binary-name change.
- [ ] 4.3 Run `npm run ci` from the repo root and confirm it passes.
