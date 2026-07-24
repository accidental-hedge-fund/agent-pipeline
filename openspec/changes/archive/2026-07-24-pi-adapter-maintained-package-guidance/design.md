## Context

The Pi harness adapter (`core/scripts/harness-adapters/pi.ts`, added in #431 / #479) names
the deprecated npm package `@mariozechner/pi-coding-agent` in two user-facing spots: the
`missing-cli` preflight `message` and the file-header provenance comment. npm marks that
package deprecated with a notice pointing at `@earendil-works/pi-coding-agent`. A user
following the adapter's guidance today installs the unmaintained package.

## Decision — guidance-only text change; adapter behavior is unchanged

This is a targeted string swap, not a behavioral change to the adapter:

- Only the human-readable package name in the `missing-cli` message and the file-header
  comment changes, from `@mariozechner/pi-coding-agent` to
  `@earendil-works/pi-coding-agent`.
- The `pi` binary name, the preflight probe arguments (`--version`/`--help`/
  `--list-models`), the adapter's argv, and its capabilities are untouched — both npm
  packages install the same `pi` binary, so presence detection is identical regardless of
  which package a user installs.
- No new capability, config surface, or stage behavior is introduced. The change is scoped
  entirely to `core/scripts/harness-adapters/pi.ts`, its regenerated `plugin/` mirror, and
  one new regression assertion in `core/test/harness-adapters-preflight.test.ts` that pins
  the maintained name and fails if the deprecated name reappears.

A separate design decision was considered and rejected: also rewriting historical
`openspec/changes/archive/**` records that mention the deprecated package. Those are
implementation-time records of what was true when they were written, not live
user-facing guidance, so they are left unchanged.
