## 1. Registry documentation metadata

- [x] 1.1 Add documentation metadata for each documented `COMMAND_REGISTRY` keyword (co-located fields or companion map): at least `summary`, `usage`, and documented/hidden flag
- [x] 1.2 Mark legacy/hidden keywords as undocumented so generators omit them
- [x] 1.3 Confirm dispatch fields (`allowedFlags`, `needsIssueNumber`, etc.) are unchanged and existing registry tests still pass

## 2. CLI reference generator

- [x] 2.1 Implement the generator path that reads registry + doc metadata and emits `docs/cli.md`
- [x] 2.2 Emit host SKILL command-table regions between stable markers in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (host token only difference)
- [x] 2.3 Unit-test pure transforms: documented command present, hidden omitted, no invented commands (fixtures; no network/git/subprocess)
- [x] 2.4 Prove a missing/stale artifact fails the check mode (bite test or intentional corruption then restore)

## 3. Config reference generator

- [x] 3.1 Implement generation of `docs/config.md` from `PartialConfigSchema` / Zod descriptions (reuse schema-walk logic from `pipeline config schema` where practical)
- [x] 3.2 Include types/enums and descriptions; exclude rejected keys such as `auto_merge`
- [x] 3.3 Unit-test schema-slice → Markdown shape for representative keys and an enum field

## 4. Docs generator CLI + CI staleness gate

- [x] 4.1 Provide `scripts/generate-docs.mjs` with write mode and `--check` mode covering `docs/cli.md`, `docs/config.md`, SKILL generated regions, and generator-owned `CHANGELOG.md` if applicable; emit stale-path diagnostics compatible with `extractStalePaths`
- [x] 4.2 Add `docs:generate` / `docs:check` package scripts if useful; confirm existing `ci:docs` reaches real check-mode once the generator file is present (no permanent no-op)
- [x] 4.3 Document the regenerate command for contributors (brief note in README Development or CLAUDE.md only if needed for the change)

## 5. README landing split + concepts companion

- [x] 5.1 Create `docs/concepts.md` by extracting advanced/lifecycle/concepts material from the current README (hand-authored; no full CLI/config inventory fork)
- [x] 5.2 Rewrite `README.md` as a lean landing page (purpose, prerequisites, quickstart, install, links) under ~400 lines with links to `docs/cli.md`, `docs/config.md`, `docs/concepts.md`, `CHANGELOG.md`, and `ROADMAP.md`
- [x] 5.3 Remove hand-maintained full CLI command inventories from the README body in favor of the generated companion
- [x] 5.4 Verify `readme-user-clarity` first-run path still works from README alone

## 6. CHANGELOG + ROADMAP history retirement

- [x] 6.1 Implement CHANGELOG generation or release-append path from git tags and/or GitHub Releases with an injectable deps seam for tests
- [x] 6.2 Produce initial `CHANGELOG.md` covering existing released tags (bounded per-version sections)
- [x] 6.3 Remove accreting ROADMAP "Shipped" prose; leave forward-looking plan; add pointer to `CHANGELOG.md`
- [x] 6.4 Unit-test changelog transform with fixtures (no live network/git in unit tests)
- [x] 6.5 Stop release tooling from prepending free-form ROADMAP Shipped history as the primary notes surface; refresh/append CHANGELOG instead (or document a regenerate step if a full release hook is deferred); add a regression that release mutations do not reintroduce unbounded Shipped prose

## 7. Host surfaces, mirror, and full gate

- [x] 7.1 After SKILL marker regions are generated, run `node scripts/build.mjs` and commit the `plugin/` mirror in the same change
- [x] 7.2 Run `openspec validate docs-generate-cli-config-reference` and fix structural issues
- [x] 7.3 Run `npm run ci` from the repo root and confirm green (`ci:core`, docs check, `build.mjs --check`, install-smoke, `openspec validate --all`)
- [x] 7.4 Confirm no engine stage/dispatch/merge behavior changed (docs-and-tooling only)

## 8. Explicit non-goals check

- [x] 8.1 Do not implement a published docs site (#598)
- [x] 8.2 Do not implement stage-count SSOT / living TERMINAL rewrite (#626) unless already fixed elsewhere; leave a note in PR if residual stage-count prose is spotted but out of scope
