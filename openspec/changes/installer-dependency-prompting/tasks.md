## 1. Research: Confirm install commands for each dependency

- [ ] 1.1 Read `sendbird/cc-plugin-codex` README and document the exact install command (e.g., `claude mcp add` or `npx`) and how to detect the installed version
- [ ] 1.2 Read `openai/codex-plugin-cc` README and document the exact install command and version detection strategy
- [ ] 1.3 Read `Fission-AI/OpenSpec` README and document the `npm install -g` package name and version flag
- [ ] 1.4 Read `mvanhorn/last30days-skill` README and document the skill install command and version detection path
- [ ] 1.5 Record confirmed commands in a comment block at the top of the new `installDeps` function so future maintainers can re-verify them

## 2. Dependency detection helpers

- [ ] 2.1 Extend or wrap `companionPresent()` and `codexCompanionPresent()` to also return the installed version (or `null` if undetectable)
- [ ] 2.2 Add `openspecPresent()` helper — runs `openspec --version`, returns version string or `null`
- [ ] 2.3 Add `last30daysPresent()` helper — checks skill directory or version file, returns version string or `null`
- [ ] 2.4 Add `fetchLatestVersion(dep)` helper — fetches latest version from npm registry or GitHub API; returns version string or `null` on failure
- [ ] 2.5 Add unit tests for all four detection helpers (present/absent/version-unknown cases)

## 3. Relevance gating

- [ ] 3.1 Read `.github/pipeline.yml` feature flags in the installer (reuse any existing config-read logic; add if absent)
- [ ] 3.2 Implement `getRelevantDeps(hosts, featureFlags)` — returns the ordered list of deps to check based on chosen hosts and feature flags
- [ ] 3.3 Add unit tests: Claude-only host omits `codex-plugin-cc`; Codex-only omits `cc-plugin-codex`; missing `last30days.enabled` omits last30days; present flag includes it

## 4. Prompting phase

- [ ] 4.1 Add `promptDeps(deps, opts)` function — iterates relevant deps, for each: detects presence/version, then prompts (interactive) or auto-accepts/skips (non-interactive)
- [ ] 4.2 Wire `--yes-deps` CLI flag into the installer's argument parser
- [ ] 4.3 Wire `PIPELINE_INSTALL_DEPS` env var as equivalent to `--yes-deps`
- [ ] 4.4 Implement non-interactive skip path: when no TTY and no `--yes-deps`/env, record each dep as `skipped`
- [ ] 4.5 Implement auto-accept path: when `--yes-deps` or env is set in non-TTY, proceed to install without prompting
- [ ] 4.6 Add unit tests for prompt routing: TTY+accept, TTY+decline, non-TTY without opt-in (skip), non-TTY with `--yes-deps` (auto-accept)

## 5. Install/update execution

- [ ] 5.1 Implement `installDep(dep)` — runs the confirmed install command (from task 1), captures stdout/stderr, returns `{status: 'installed'|'updated'|'already current'|'failed', error?: string}`
- [ ] 5.2 Wrap each `installDep` call in try/catch so a thrown error marks the dep `failed` without propagating
- [ ] 5.3 Add unit/integration tests: successful install, failed install (non-zero exit), already-current detection

## 6. Status reporting

- [ ] 6.1 Implement `printDepSummary(results)` — prints one status line per dep with name, status, and (for `failed`) the error summary plus manual install command
- [ ] 6.2 Add a trailing hint line when any dep has status `skipped`: "Re-run with --yes-deps or PIPELINE_INSTALL_DEPS=1 to install."
- [ ] 6.3 Call `printDepSummary` at the end of the installer, after the core install completes
- [ ] 6.4 Add snapshot/output tests for the summary rendering

## 7. Integration into installer flow

- [ ] 7.1 Insert the `promptDeps` call into `scripts/install.mjs` after the preflight block and before the success message
- [ ] 7.2 Verify that a declined or failed dependency does not alter the installer's exit code (core install still exits 0)
- [ ] 7.3 Verify the existing preflight warnings for base CLIs are unaffected and still emit as info/warn (no regression)

## 8. End-to-end tests

- [ ] 8.1 Add an integration test scenario: fresh install with all deps missing — verify each dep is prompted and `installed` status is reported
- [ ] 8.2 Add an integration test scenario: non-interactive mode — verify all deps are `skipped` and re-run hint is printed
- [ ] 8.3 Add an integration test scenario: `--yes-deps` in non-TTY — verify all deps are auto-installed without prompts
- [ ] 8.4 Run `pnpm test` and confirm all existing tests still pass

## 9. Documentation

- [ ] 9.1 Update `README.md` prerequisites section to note that the installer now offers to install companion plugins and optional tools
- [ ] 9.2 Document `--yes-deps` and `PIPELINE_INSTALL_DEPS=1` in the README install section
