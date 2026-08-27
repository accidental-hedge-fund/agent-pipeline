## Why

OMP (Oh My Pi) is not an agent-pipeline outer host. Builtins today are `claude`, `codex`, `grok`, and `opencode`. `pi` is a stage adapter, not an install target. An OMP `/pipeline` session therefore loads the OpenCode-generated LLM prompt at `~/.config/opencode/commands/pipeline.md`, which shell-injects PATH `node` into the OpenCode bridge. Operators need a first-class OMP install that runs `/pipeline --version` and `/pipeline train --milestone <m>` on the installed launcher, with no OpenCode template, env override, or `~/.local/bin/pipeline` wrapper.

## What Changes

- Add `hosts/omp/` as a builtin outer host: overlay, `outer-host.manifest.json`, installer base `~/.omp/agent`.
- Add installer target `--host omp` that provisions the global OMP skill tree and a native non-LLM TypeScript `/pipeline` command. Project `.omp` directories are not installer-managed.
- The generated OMP command execs `scripts/pipeline.mjs` with the absolute `process.execPath` captured at install time. It does not use a shell or PATH `node`. It forwards the session working directory and exact argv.
- Register outer-host id `omp` in `pipeline path --json` (additive) and `engine-promote --host`. Default `--host all` includes `omp`.
- Keep adapter id `pi` as a harness adapter. Do not collapse it into outer-host id `omp`.
- Add an `omp` profile as bootstrap compatibility metadata only. Live implementer and reviewer stay on `.github/pipeline.yml`.
- Initial OMP lifecycle is `stdout_only`. Durable follow stays on pipeline detach, run-store, and event commands.

## Acceptance criteria

- [ ] `hosts/omp/` exists with overlay and `outer-host.manifest.json`. Registry, installer `--host`, and builtin host lists name `omp`.
- [ ] `install --host omp` writes a managed skill tree under `~/.omp/agent/skills/pipeline` and a native TypeScript `/pipeline` command under `~/.omp/agent/commands/`. It does not write project `.omp` directories. It does not install or load `~/.config/opencode/commands/pipeline.md` as the OMP surface.
- [ ] After that install, `/pipeline --version` and `/pipeline train --milestone <m>` invoke the installed launcher. The generated command starts `scripts/pipeline.mjs` with the absolute install-time `process.execPath`. It does not hardcode PATH `node`, spawn a shell, or require `~/.local/bin/pipeline`.
- [ ] The command forwards the OMP session working directory and the exact user argv to the launcher without interpolation loss.
- [ ] `pipeline path --json` reports additive `hosts.omp` and does not change Claude/Codex `hostCoverage` meanings. `engine-promote --host omp` is valid. Default `--host all` includes `omp`.
- [ ] Adapter id `pi` remains a harness adapter. Outer-host id `omp` is distinct. Tests fail if those ids are collapsed.
- [ ] The OMP outer-host manifest declares `stdout_only` material-progress notify. Durable follow is pipeline detach, run-store, and event commands. Host-rich OMP notify is not required in this change.
- [ ] An `omp` profile, if shipped, is bootstrap metadata only. It does not select live implementer or reviewer when `.github/pipeline.yml` declares both roles.
- [ ] `uninstall --host omp` removes only installer-owned OMP artifacts. Sibling OMP commands and other hosts remain. Dry-run writes nothing.
- [ ] Unmanaged content at the OMP skill path is not silently overwritten (same tree-host shadow policy).
- [ ] README and installer usage/`--host` help list `omp`. After `core/` edits, `node scripts/build.mjs` is in the same change. `npm run ci` passes.

## Capabilities

### New Capabilities

- `omp-host-install`: First-class installer host for OMP — global `~/.omp/agent` skill tree, overlay, outer-host manifest, install/update/uninstall/dry-run isolation from other hosts and from project `.omp` directories, and outer-host id `omp` distinct from adapter id `pi`.
- `omp-pipeline-command`: Native non-LLM TypeScript `/pipeline` command under the global OMP agent that execs the installed launcher with captured `process.execPath`, forwards session cwd and exact argv, and does not load the OpenCode `pipeline.md` template.

### Modified Capabilities

- `outer-host-lifecycle-contract`: Builtin outer-host set includes `omp` as a lifecycle identity independent of adapter `pi`. Initial OMP lifecycle is `stdout_only` with portable detach/run-store/event follow.
- `host-install-discovery`: Additive `hosts.omp` in `pipeline path --json` without changing the Claude/Codex `hostCoverage` enum.
- `engine-promote`: `--host omp` is a valid single-host override. Default `--host all` includes OMP.
- `installer-shadow-detection`: Personal unmanaged skill at the OMP pipeline path uses the same non-destructive tree-host shadow policy.

## Impact

- **Hosts / packaging:** new `hosts/omp/` overlay and `outer-host.manifest.json`; optional `core/profiles/omp.json` as bootstrap metadata; `core/scripts/outer-hosts/` builtins and `BUILTIN_OUTER_HOST_IDS`; new `OuterHostCommandsKind` for the OMP TypeScript command.
- **Installer:** `scripts/install.mjs` host table, command renderer, `--host all`; `scripts/install.test.mjs`.
- **Discovery / promote:** `pipeline path --json` additive `hosts.omp`; `engine-promote` valid host set.
- **Docs:** README install section; installer usage/`--host` help.
- **Out of scope:** launcher Node bootstrap / `--version` before the gate (#1236); factory-control identity vs GitHub repo name; Hermes/Buzz/Tugboat rewrite; teaching SKILL.md a per-box Node path; changing this machine's PATH; project `.omp` install; strict repository-policy enforcement (#1240, already living); host-rich OMP notify, detach UI, or run-store beyond the portable baseline.
