## Why

The README (~2040 lines), both host `SKILL.md` files, and `ROADMAP.md` hand-restate the same CLI surface, config keys, and release history in three+ places. Those copies drift (commands, stage counts, config keys) and grow without bound — especially the ROADMAP "Shipped" prose, which is now a single run-on from v1.0.0 through the latest patch. The structured sources already exist (`command-registry.ts`, the Zod schema in `config.ts`, git tags / GitHub Releases). Generating the reference docs and CHANGELOG from those sources, shrinking the README to a landing page, and gating staleness in CI eliminates three-way drift and bounds roadmap growth. This is prerequisite hygiene for a docs site (#598) and fits the v1.29.0 factory-hygiene theme.

## What Changes

- Add a **CLI reference generator** whose source of truth is `command-registry.ts` (plus any minimal doc metadata co-located with the registry). It emits:
  - `docs/cli.md` (human CLI reference)
  - the **command tables** consumed by `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (same inventory; host-specific invocation tokens only)
- Add a **config reference generator** whose source of truth is the Zod schema in `config.ts` (field descriptions already present via `.describe()` and the `pipeline config schema` path). It emits `docs/config.md`.
- Add a **staleness CI gate** (mirror-style, like `build.mjs --check`) that fails when any committed generated artifact differs from a fresh generation run.
- **Split the README** into a lean landing page (what-it-is, prerequisites, quickstart, install, links out) targeting well under ~400 lines, with deeper content moved to `docs/cli.md`, `docs/config.md`, and a hand-authored `docs/concepts.md` (advanced topics / lifecycle / conventions extracted from today's README — not generated from OpenSpec in this change).
- **Retire accreting ROADMAP "Shipped" prose**: `ROADMAP.md` keeps only the forward-looking plan; a `CHANGELOG.md` is generated (or append-maintained by release tooling) from git tags / GitHub Releases so each release is a bounded entry instead of an ever-growing paragraph.
- Docs-and-tooling only: **no engine behavior, stage machine, merge policy, or CLI dispatch change**.

## Capabilities

### New Capabilities

- `generated-cli-reference`: Generate the CLI reference (and host SKILL command tables) from the command registry as single source of truth, with a CI staleness gate.
- `generated-config-reference`: Generate the config reference from the Zod/`PartialConfigSchema` surface as single source of truth, with a CI staleness gate.
- `docs-landing-split`: Structure operator docs as a lean README landing page plus `docs/{cli,config,concepts}.md` companions, preserving the purpose-first / quickstart contracts of `readme-user-clarity` across the split.
- `generated-changelog`: Replace ROADMAP "Shipped" accretion with a `CHANGELOG.md` produced from tags/Releases (or release-tooling append of bounded per-release entries), leaving `ROADMAP.md` forward-looking only.

### Modified Capabilities

- `readme-user-clarity`: Relocate the deep config/CLI reference expectations from the monolithic README body into linked `docs/` pages while keeping the first-screenful, quickstart, and navigability guarantees.
- `command-registry`: Extend the registry (or a co-located, registry-keyed companion) with the minimal documentation metadata the CLI generator needs (summary/usage/host surface / documented flag) so adding a command updates help and docs together — without changing dispatch or flag-validation semantics.

## Acceptance Criteria

- [ ] A generator produces `docs/cli.md` from `command-registry.ts` (and its doc metadata) such that every **documented** registry command appears with its usage synopsis and summary; hidden/undocumented keywords (e.g. legacy `run`) are omitted from the generated surface.
- [ ] The same generator (or a parameterized sibling) feeds the **command tables** in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` from that single inventory; the two hosts differ only by invocation token (`/pipeline` vs `$pipeline`), not by which commands are listed.
- [ ] A generator produces `docs/config.md` from the Zod schema in `config.ts` / `PartialConfigSchema`, covering recognized top-level keys with descriptions consistent with `.describe()` / `pipeline config schema`.
- [ ] A CI check (e.g. `node scripts/generate-docs.mjs --check` or equivalent, wired into `npm run ci`) fails when any committed generated artifact (`docs/cli.md`, `docs/config.md`, and the generated SKILL command-table regions, plus `CHANGELOG.md` if generated) is stale relative to source.
- [ ] `README.md` is a lean landing page (what-it-is, prerequisites, quickstart, install) well under ~400 lines, with working links to `docs/cli.md`, `docs/config.md`, and `docs/concepts.md`.
- [ ] `docs/concepts.md` exists and holds the advanced/lifecycle/concepts material that left the README; it is navigable and does not re-hand-author the full CLI/config key inventory.
- [ ] `ROADMAP.md` no longer accretes a free-form "Shipped" prose paragraph per release; it retains only the forward-looking release plan (and any non-history planning content).
- [ ] `CHANGELOG.md` exists and is populated from git tags and/or GitHub Releases (or release tooling appends a bounded entry per release) so historical shipped detail is not maintained as unbounded ROADMAP prose.
- [ ] Hand-maintained CLI command inventories that duplicate the registry are removed or reduced to thin pointers into the generated reference (no three-way hand-edited command list remains across README + both SKILLs).
- [ ] No engine stage behavior, review policy, merge surface, or CLI dispatch semantics change; this is docs-and-tooling only.
- [ ] `npm run ci` is green, including `openspec validate --all` and `node scripts/build.mjs --check` (plugin mirror in sync when host SKILL content changes).

## Impact

- **New tooling:** docs generator script(s) under `scripts/` (and possibly thin helpers under `core/scripts/` if they must import the registry/schema via type-stripping), plus a `--check` mode wired into root `package.json` / `npm run ci`.
- **Sources of truth:** `core/scripts/command-registry.ts` (and optional co-located doc metadata), `core/scripts/config.ts` (`PartialConfigSchema` / `.describe()` annotations), git tags / GitHub Releases (for CHANGELOG).
- **Generated / rewritten docs:** `docs/cli.md`, `docs/config.md`, `docs/concepts.md`, lean `README.md`, `CHANGELOG.md`, trimmed `ROADMAP.md`, generated command-table regions in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (then `plugin/` mirror via `build.mjs`).
- **Tests:** unit tests for generators (pure transforms over fixtures; no network/git in unit tests) and a CI staleness check; optional golden snapshots for emitted Markdown shape.
- **Out of scope this change:** publishing a docs *site* (#598); stage-count SSOT / living TERMINAL alignment (#626 — ship independently or first if sequencing prefers, but not part of this generator epic's code path).
- **No** changes to pipeline stage machine behavior, auto-merge posture, or harness execution.
