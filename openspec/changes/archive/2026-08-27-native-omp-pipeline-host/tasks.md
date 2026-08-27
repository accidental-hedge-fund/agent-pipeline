## 1. Host overlay, manifest, and profile

- [x] 1.1 Add `hosts/omp/SKILL.md` (OMP invocation `/pipeline`, inventory-symmetric with Claude/Codex; no plugin-marketplace requirement) and verify it exists beside the other host overlays
- [x] 1.2 Add `hosts/omp/outer-host.manifest.json` with id `omp`, tree install under `~/.omp/agent`, `commandsKind` `omp-native`, and `material_progress_notify.mapping.surface` `stdout_only`; verify the file parses as manifest version 1
- [x] 1.3 Mirror the builtin JSON under `core/scripts/outer-hosts/builtins/omp.json` and add `omp` to `BUILTIN_OUTER_HOST_IDS`; verify registry/conformance tests list `omp`
- [x] 1.4 Extend `OuterHostCommandsKind` with `omp-native` (not `opencode-native`) and verify type/runtime consumers accept it
- [x] 1.5 Add `core/profiles/omp.json` as bootstrap metadata (`invocation: "/pipeline"`, existing adapter names only, no adapter `omp`, not implementer `pi` as a host alias) and verify `loadProfile("omp")` succeeds
- [x] 1.6 Wire launcher profile baking for OMP installs and verify the installed shim uses profile `omp`

## 2. Installer host target

- [x] 2.1 Register `HOSTS.omp` from the manifest: base `<home>/.omp/agent`, skills `skills/pipeline`, overlay `hosts/omp`; verify `--host omp` is accepted
- [x] 2.2 Extend usage header, unknown-host errors, and `--host all` detection to include `omp` (include when `~/.omp/agent` exists; `--host omp` creates the base if missing) and verify help lists `omp`
- [x] 2.3 Wire install/update to stage core + overlay + launcher + managed marker for OMP; verify a dry-run writes nothing and a live install creates `.pipeline-installer-managed`
- [x] 2.4 Ensure `--host omp` never mutates Claude/Codex/Grok/OpenCode paths or project `.omp` / named OMP profile agent dirs; verify isolation tests
- [x] 2.5 Wire uninstall to remove only the OMP managed skill tree plus command cleanup in §3; verify missing-install uninstall is a no-op success

## 3. Native OMP /pipeline command

- [x] 3.1 Confirm current OMP TypeScript custom-command export shape (`CustomCommandFactory` fields) from upstream types/docs before generating the file
- [x] 3.2 Implement installer write of `~/.omp/agent/commands/pipeline/index.ts` (or the confirmed equivalent) named `pipeline`; verify the artifact exists after `--host omp`
- [x] 3.3 Bake absolute install-time `process.execPath` and absolute `<skill>/scripts/pipeline.mjs` into the command; verify the file contains those paths and does not invoke PATH `node` or `sh -c`
- [x] 3.4 Forward session working directory as spawn cwd and user tokens as discrete argv; verify tests with spaces and metacharacters at the spawn boundary
- [x] 3.5 Return void from the command handler (no LLM prompt turn) and do not write or load `~/.config/opencode/commands/pipeline.md` as the OMP surface; verify OpenCode file is untouched by `--host omp`
- [x] 3.6 Route `--version` / `-V` to the installed launcher and verify stdout equals launcher / `core/package.json` version
- [x] 3.7 Uninstall only the installer-owned `commands/pipeline/` artifact; verify sibling OMP commands remain

## 4. Shadow detection

- [x] 4.1 Apply personal-skill shadow detect + TTY/non-TTY relocation/skip policy to OMP tree installs (same marker contract as Claude/OpenCode); verify unmanaged trees are not silently overwritten
- [x] 4.2 Relocate backups under `~/.omp/agent`; verify unique `pipeline.<unique>.bak` and never overwrite an existing backup

## 5. Discovery and promote

- [x] 5.1 Add additive `hosts.omp.available` to `pipeline path --json`; verify Claude/Codex `hostCoverage` meanings are unchanged when OMP is present or OMP-only
- [x] 5.2 Accept `engine-promote --host omp` and keep default `--host all`; verify invalid host still fails closed and omitted host still records `--host all`

## 6. Identity guards

- [x] 6.1 Add a regression that fails if outer-host id `omp` is collapsed into adapter id `pi` (registry, `--host pi` rejected, adapter `pi` still resolves)
- [x] 6.2 Add a conformance/lifecycle test that the `omp` manifest passes the kit with `stdout_only` notify and portable follow fallbacks

## 7. Documentation

- [x] 7.1 Document `install --host omp` in README: `~/.omp/agent` paths, project `.omp` not managed, native TypeScript `/pipeline`, captured execPath, not the OpenCode template
- [x] 7.2 Align installer help strings with implemented hosts including `omp`

## 8. Tests and verification

- [x] 8.1 Add installer unit tests: OMP layout, isolation, dry-run, update, uninstall, missing-base create, no env override, no project `.omp` writes
- [x] 8.2 Add command tests: execPath bake, argv safety, cwd forward, version routing, OpenCode template not used
- [x] 8.3 Add shadow-detection tests for personal OMP skill (accept/decline/non-TTY)
- [x] 8.4 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 8.5 Run `openspec validate native-omp-pipeline-host` and `npm run ci` from repo root until green
- [x] 8.6 Spot-check proposal acceptance criteria against the landed diff
