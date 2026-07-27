## Why

`core/package.json` declares `js-yaml: ^4.1.0` and `core/package-lock.json` resolves it to
**4.1.1**, which carries two published DoS advisories — GHSA-h67p-54hq-rp68 (moderate, quadratic
merge-key alias expansion, range `>=4.0.0 <=4.1.1`) and GHSA-52cp-r559-cp3m (high, merge-key chains
forcing quadratic CPU, range `>=4.0.0 <4.3.0`). `npm audit` in `core/` reports js-yaml at **high**
today. This is the pipeline's live config-parsing surface: `resolveConfig()` and the config
diagnostics path in `core/scripts/config.ts` and the fault-report loader in
`core/scripts/product-fault.ts` all call `yaml.load()` on repo-authored
`.github/pipeline.yml` / fault-report YAML. Both advisories are fixed in **4.3.0**, a patch-line
upgrade on the same major, so the remediation is a version bump with no API surface change.

The declared range is the part that actually matters: `^4.1.0` permits a fresh resolution to land
back on 4.1.1, so relocking alone would leave the floor vulnerable. Raising the *declared floor*
is what makes the fix durable.

## What Changes

- Raise the declared `js-yaml` dependency in `core/package.json` from `^4.1.0` to `^4.3.0`, and
  relock `core/package-lock.json` so the resolved version is `>=4.3.0` on the 4.x line.
- Regenerate the `plugin/` mirror (`node scripts/build.mjs`) so
  `plugin/pipeline/skills/pipeline/core/package.json` and `…/core/package-lock.json` carry the same
  floor and the same resolved version; a stale mirror fails `build.mjs --check`.
- Add a runtime regression test that asserts the declared range floor **and** the lockfile-resolved
  version both satisfy `>=4.3.0`, so a future relock or dependency edit cannot silently drop back
  into the advisory range. Types are stripped at runtime in this repo, so this guarantee is checked
  by a real test, not a type.
- No source change to any `yaml.load` / `yaml.dump` call site: 4.3.0 keeps the 4.x API and the
  `YAMLException` `mark.line` shape the config diagnostics path depends on
  (`core/scripts/config.ts:1651-1661`).

Not in scope: migrating off `js-yaml` onto the already-present `yaml` package (tracked separately as
a follow-up, per the issue); moving to the `js-yaml` 5.x major; adding an `npm audit` gate to
`npm run ci` (considered and deferred — see `design.md`).

## Capabilities

### New Capabilities

- `dependency-advisory-hygiene`: the core runtime dependency set's obligation to declare version
  floors at or above the fixed version of known published advisories, specifically the `js-yaml`
  `>=4.3.0` floor for the YAML config-parsing surface; the requirement that the declared floor, the
  lockfile resolution, and the generated `plugin/` mirror agree; and the runtime regression guard
  that keeps the floor from drifting back.

### Modified Capabilities

None. `pipeline-configuration` behavior is unchanged — the same YAML documents parse to the same
config, with the same strict-schema and error-diagnostic behavior; only the parser's version floor
moves.

## Impact

- **Dependencies**: `core/package.json` (`js-yaml` range), `core/package-lock.json` (resolved
  version + integrity). No new dependency is added and none is removed; `js-yaml`'s own dependency
  (`argparse ^2.0.1`) is unchanged at 4.3.0.
- **Generated mirror**: `plugin/pipeline/skills/pipeline/core/package.json` and
  `plugin/pipeline/skills/pipeline/core/package-lock.json`, via `node scripts/build.mjs`.
- **Consumers of the parser (unchanged code, must keep passing)**: `core/scripts/config.ts`
  (`resolveConfig`, config diagnostics, `yamlScalar`/`yamlBlock` emission) and
  `core/scripts/product-fault.ts`.
- **Tests**: a new floor-guard test in `core/test/`, plus the existing `config.test.ts`,
  `config-template-exhaustive.test.ts`, `namespaced-commands.test.ts`, and `release.test.ts`, which
  exercise the parse/emit surface. No real network, git, or subprocess calls.
- **CI**: `npm run ci` from the repo root — `ci:core`, `build.mjs --check`, install smoke, launcher
  smoke, `openspec validate --all`, and `ci:scripts`.

## Acceptance Criteria

- [ ] `core/package.json` declares a `js-yaml` range whose lowest satisfying version is `>=4.3.0`
      (i.e. `^4.3.0` or stricter), and the range still resolves within the 4.x major.
- [ ] `core/package-lock.json` resolves `node_modules/js-yaml` to a version `>=4.3.0` with a matching
      registry `resolved` URL and `integrity` hash for that exact version.
- [ ] `cd core && npm ci && npm audit` reports **zero** advisories attributed to `js-yaml`
      (both GHSA-h67p-54hq-rp68 and GHSA-52cp-r559-cp3m are gone from the report).
- [ ] `plugin/pipeline/skills/pipeline/core/package.json` and
      `plugin/pipeline/skills/pipeline/core/package-lock.json` declare and resolve the same
      `js-yaml` range and version as `core/`, and `node scripts/build.mjs --check` passes with no
      regeneration needed.
- [ ] A test in `core/test/` fails when `core/package.json` declares a `js-yaml` range whose floor is
      below 4.3.0, and fails when `core/package-lock.json` resolves js-yaml below 4.3.0 — proven by
      reverting each value to `^4.1.0` / `4.1.1` and observing the failure.
- [ ] `cd core && npm test` is green, including the existing config-parse, config-template,
      namespaced-command, and release tests that exercise `yaml.load`/`yaml.dump`.
- [ ] A `.github/pipeline.yml` fixture with a deliberate YAML syntax error still produces a config
      diagnostic carrying a 1-based line number (`mark.line + 1` behavior preserved under 4.3.0).
- [ ] `npm run ci` is green from the repo root.
- [ ] No file under `core/scripts/` changes as part of this bump (the diff touches manifests, the
      generated mirror, and the new test only).
