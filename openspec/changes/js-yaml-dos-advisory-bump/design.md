# Design — js-yaml-dos-advisory-bump (#625)

The change itself is small; the decisions worth recording are about *where* the guarantee lives and
what was deliberately left out.

## Context

- Declared: `core/package.json` → `"js-yaml": "^4.1.0"`.
- Resolved: `core/package-lock.json` → `node_modules/js-yaml` 4.1.1.
- `npm audit` in `core/` (verified 2026-07-27) reports js-yaml at **high**, via two advisories:
  - GHSA-h67p-54hq-rp68 — moderate, CWE-407, range `>=4.0.0 <=4.1.1`.
  - GHSA-52cp-r559-cp3m — high, CWE-400/407, range `>=4.0.0 <4.3.0`.
- Published 4.x versions include 4.2.0 and 4.3.0; the 5.x major also exists.
- Call sites: `core/scripts/config.ts` (`yaml.load` at 822 / 1289 / 1342 / 1651 / 1809, `yaml.dump`
  via `yamlScalar`) and `core/scripts/product-fault.ts:419`. The repo also depends on the separate
  `yaml` package (2.9.0) for CST-based diagnostics — that dependency is unaffected.

## Decision 1 — raise the declared floor to `^4.3.0`, not just relock

Relocking alone (`npm update js-yaml`) would fix today's tree while leaving `^4.1.0` declared. Any
fresh resolution without this exact lockfile — a regenerated lockfile, a dependency-graph change,
a consumer install that discards the lock — could land on 4.1.1 again and silently reopen both
advisories. `^4.3.0` makes the fix a property of the manifest, and keeps the caret so ordinary 4.x
patch upgrades stay available.

## Decision 2 — stay on the 4.x line; do not move to js-yaml 5.x

5.x is a major release with API/behavior changes that would require auditing every `yaml.load` and
`yaml.dump` call site and the `YAMLException.mark.line` contract the config diagnostics path relies
on. 4.3.0 fully remediates both advisories with no API change, so the major upgrade buys no security
and costs a review surface disproportionate to a security patch. It can be evaluated separately.

## Decision 3 — do not migrate off js-yaml onto the already-present `yaml` package

The issue explicitly places this out of scope, and it is the right call for this change: consolidating
two YAML libraries into one is a behavior-affecting refactor (different error shapes, different
`dump` formatting, different merge-key semantics) that would need its own review. Bundling it into a
security bump would violate the repo's surgical-diff discipline. Track as a follow-up.

## Decision 4 — guard the floor with a runtime test, not a comment

The repo strips types at runtime and CI runs `npm ci --no-audit`, so nothing today would notice the
floor sliding back. A plain `node --test` case in `core/test/` reads `core/package.json` and
`core/package-lock.json` from disk and asserts both are `>=4.3.0`. This is the regression test the
project's conventions require for a fix, it is deterministic, and it does no network, git, or
subprocess work — matching the existing test discipline. Both halves must be proven to bite by
temporarily reverting the manifest and the lockfile respectively.

Minimum-version comparison is a numeric compare of the parsed `major.minor.patch` triple plus a
check that the declared range's literal floor parses — no new dependency (`semver`) is introduced for
a single comparison.

## Decision 5 — no `npm audit` gate added to CI (considered, deferred)

Adding `npm audit --audit-level=high` to `npm run ci` would generalize the guarantee beyond js-yaml,
but it makes CI depend on the network and on a mutable, externally-published advisory database: a
newly-published advisory in any transitive dependency would turn every unrelated PR red, including
the pipeline's own self-driven runs. That is a policy change with its own blast radius and belongs in
its own issue, not in a one-package security bump. The targeted floor-guard test in Decision 4 covers
the concrete regression this issue is about; the broader gate is noted as a follow-up.

## Decision 6 — mirror regeneration is part of this change, not a follow-up

`plugin/pipeline/skills/pipeline/core/{package.json,package-lock.json}` is what an *installed*
plugin provisions from (`scripts/postinstall.mjs` and `scripts/install.mjs` both run
`npm ci --omit=dev` against the installed core). If the mirror is not regenerated, installed users
keep getting 4.1.1 even though the source tree is patched — the security fix would not reach the
actual consumers. `node scripts/build.mjs --check` in `npm run ci` enforces this.

## Risks

- **Behavior drift at 4.2.0/4.3.0.** These releases bound merge-key/alias expansion; a document that
  previously expanded into a pathological structure may now be rejected. The repo's own config
  templates and fixtures use no anchors, aliases, or merge keys, so the risk is confined to an
  operator's hand-written `.github/pipeline.yml`. The existing config, config-template,
  namespaced-command, and release tests exercise the parse/emit path and must stay green; the
  malformed-YAML diagnostic scenario pins the `mark.line` contract explicitly.
- **Lockfile churn.** Only the js-yaml entry (and, if npm reformats, nothing else) should move.
  A diff touching unrelated lock entries means the relock was too broad and should be redone
  narrowly.
