## Why

The Pi harness adapter (added in #431 / #479) still directs users to install the
now-deprecated npm package `@mariozechner/pi-coding-agent`. npm marks that package
deprecated with the notice "please use @earendil-works/pi-coding-agent instead going
forward". The maintained package is `@earendil-works/pi-coding-agent` (latest `0.82.0`;
the deprecated package is pinned at `0.73.1`). A user who follows the adapter's
missing-CLI guidance today installs an unmaintained package.

Both executable copies of the adapter carry the stale name — its file-header provenance
comment and its `missing-cli` preflight message — and there is no regression assertion
preventing the deprecated name from drifting back into user-facing guidance.

## What Changes

- Replace the deprecated `@mariozechner/pi-coding-agent` package name with the maintained
  `@earendil-works/pi-coding-agent` in the Pi adapter's user-facing install guidance: the
  `missing-cli` preflight message (and the file-header provenance comment) in
  `core/scripts/harness-adapters/pi.ts`.
- Regenerate the packaged-plugin mirror so `plugin/.../harness-adapters/pi.ts` matches
  core (via `node scripts/build.mjs`; the mirror is generated, never hand-edited).
- Add a regression assertion so the Pi adapter's user-facing install guidance names the
  maintained package and can never drift back to the deprecated name.
- The Pi preflight continues to detect the `pi` binary installed by the maintained
  package unchanged — the binary name (`pi`) and the probes (`--version`/`--help`/
  `--list-models`) are identical across both packages, so only the human-readable install
  string changes.

Historical OpenSpec archive documents that reference the deprecated package are
implementation-time records and remain unchanged.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `cli-harness-adapters`: the Pi adapter's missing-CLI preflight guidance SHALL name the
  maintained npm package, and a regression assertion SHALL prevent drift back to the
  deprecated package name.

## Impact

- `core/scripts/harness-adapters/pi.ts` — file-header comment and `missing-cli` message.
- `plugin/pipeline/skills/pipeline/core/scripts/harness-adapters/pi.ts` — regenerated
  mirror (not hand-edited).
- `core/test/harness-adapters-preflight.test.ts` — new regression assertion on the
  missing-CLI guidance string.
- No changes to the `pi` binary name, adapter argv, preflight probes, capabilities, or any
  other stage or config surface.

## Acceptance Criteria

- [ ] The Pi adapter's `missing-cli` preflight message names `@earendil-works/pi-coding-agent`
      and does NOT contain the substring `@mariozechner/pi-coding-agent`.
- [ ] The Pi adapter's file-header provenance comment names `@earendil-works/pi-coding-agent`
      and does NOT contain `@mariozechner/pi-coding-agent`.
- [ ] The packaged-plugin copy
      (`plugin/pipeline/skills/pipeline/core/scripts/harness-adapters/pi.ts`) is byte-for-byte
      in sync with core; `node scripts/build.mjs --check` reports no drift.
- [ ] No executable source file under `core/` or `plugin/` contains the substring
      `@mariozechner/pi-coding-agent` (historical `openspec/changes/archive/**` records are
      exempt).
- [ ] A regression test asserts the Pi adapter's missing-CLI guidance names the maintained
      package and fails if the deprecated name reappears; the test bites (it fails against
      the pre-change string).
- [ ] Pi preflight still returns `missing-cli` only when the `pi` binary is absent and
      passes its presence check when `pi` (as installed by `@earendil-works/pi-coding-agent`)
      is on `PATH` — no change to the binary name or probe arguments.
- [ ] `npm run ci` passes with no regressions.
