## 1. Biting regressions

- [ ] 1.1 Add `scripts/launcher-bootstrap.test.mjs` cases that inject `process.versions.node` `22.23.2` into both `hosts/_shared/entry.template.mjs` and `scripts/pipeline-launcher.mjs` for `--version` and `-V`. Assert stdout equals `core/package.json` `version`, exit 0, and stderr does not contain `requires Node >= 24`. Run the file with `node --test --test-isolation=none scripts/launcher-bootstrap.test.mjs` and confirm these cases **fail** against the current gate-first shims
- [ ] 1.2 Add `--version --json` cases for both launchers at injected `22.23.2`. Assert JSON `{ version, commit_sha }` with `version` matching `core/package.json` and `commit_sha` exact 40-hex or `null`. Confirm they **fail** against the current shims
- [ ] 1.3 Add injectable re-exec cases: Node 22 + fake Node 24 resolver hit, argv `status` and `train --milestone data-integrity`. Assert spawn of that 24 binary with the script path plus preserved argv, and child `PATH` starting with that binary's directory. Confirm they **fail** (current shims exit the gate and do not spawn)
- [ ] 1.4 Add injectable fail-closed cases: Node 22 + resolver miss. Assert non-zero exit, diagnostic names `22.23.2`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`, and no TypeScript load. Confirm they **fail** if `AGENT_PIPELINE_NODE` is omitted. Cover both launchers

## 2. Shared resolver helpers

- [ ] 2.1 Export a fail-closed diagnostic from `scripts/ensure-engines-node.mjs` that names invoking `process.versions.node`, `/usr/bin/node`, and `AGENT_PIPELINE_NODE`, and does not lead with `nvm install 24`. Add a unit test in `scripts/ensure-engines-node.test.mjs` that asserts those substrings. Verify `node --test --test-isolation=none scripts/ensure-engines-node.test.mjs` passes
- [ ] 2.2 Export a re-exec helper that calls `resolveEnginesNode` / `envPreferringNode`, spawns `resolved.path` with `[scriptPath, ...argv]`, and returns the child status (or continue when already ≥ 24). Extend `scripts/ensure-engines-node.test.mjs` so a Node 22 + fake 24 spawn is asserted and a miss uses the diagnostic from 2.1. Verify those tests pass without importing the launchers

## 3. Launcher bootstrap wiring

- [ ] 3.1 In `hosts/_shared/entry.template.mjs`, run the existing `--version` / `-V` / `--version --json` short-circuit (node builtins only) **before** any engines gate or resolver load. After that, if major < 24, dynamically import `ensure-engines-node.mjs` from sibling `scripts/` or repo `../../scripts/ensure-engines-node.mjs`, then re-exec or fail closed via the helpers from 2.x. Remove the early `nvm install 24` gate. Re-run task 1.1–1.4 against the template and confirm they **pass**
- [ ] 3.2 Apply the same order and helpers in `scripts/pipeline-launcher.mjs` (sibling import of `./ensure-engines-node.mjs` is enough). `path` MUST re-exec before spawning `path-cli.ts`. Re-run task 1.1–1.4 against the launcher and confirm they **pass**. Verify existing version, corrupt-install, and `path` tests still pass
- [ ] 3.3 Confirm neither launcher embeds a second `/usr/bin/node` / `PATH` / home-dir Node walker. A source assertion or grep-style test in `scripts/launcher-bootstrap.test.mjs` SHALL fail if a duplicated candidate list appears. Verify that assertion passes

## 4. Staging

- [ ] 4.1 Update `scripts/install.mjs` `stageInto` to copy `scripts/ensure-engines-node.mjs` into the skill `scripts/` directory next to `pipeline.mjs` (same pattern as `material-filter.mjs`). Add an installer test that asserts the staged file exists and the generated shim can load it. Verify the installer test **fails** before the copy and **passes** after
- [ ] 4.2 Update `scripts/build.mjs` to copy `scripts/ensure-engines-node.mjs` into `plugin/pipeline/skills/pipeline/scripts/` next to `pipeline.mjs`. Verify `node scripts/build.mjs --check` fails until the file is staged, then passes after `node scripts/build.mjs`
- [ ] 4.3 Extend `scripts/ci-install-smoke.mjs` (or the installer test) so a post-install skill tree contains `scripts/ensure-engines-node.mjs`. Verify the smoke/test fails without the copy

## 5. Engines floor and gate

- [ ] 5.1 Leave root and `core/` `engines.node` at `>=24`. Verify `scripts/packaging-coherence.mjs` still fails a fixture root floor that admits majors below 24, and that the real package.json files remain `>=24`
- [ ] 5.2 After any `core/` or `hosts/_shared/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 5.3 Run `openspec validate launcher-bootstrap-supported-node` and `npm run ci` from the repo root. Verify both are green. Do not lower `engines.node`. Do not compile `pipeline.ts` to JS. Do not add an `auto_merge` key or merge stage
