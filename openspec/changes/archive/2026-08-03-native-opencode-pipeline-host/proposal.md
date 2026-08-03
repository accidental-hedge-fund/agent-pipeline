## Why

OpenCode can discover a Claude-compatible `pipeline` skill, but agent-pipeline has no OpenCode host overlay or native command definition. Invoking `/pipeline --version` therefore loads instructional skill text and yields an LLM usage-style response instead of running the installed launcher. Operators who use OpenCode as a host need a first-class install path that routes `/pipeline` arguments to the real engine (via OpenCode’s LLM-mediated command templates + shell inject), matching Claude and Codex installability within OpenCode’s host constraints.

## What Changes

- Add an OpenCode-specific host package under `hosts/opencode/` (SKILL.md overlay and any command/bridge assets the host requires).
- Add installer target `--host opencode` that installs the shared core + OpenCode overlay into the documented OpenCode config location (default `~/.config/opencode/skills/pipeline`, honoring OpenCode config-dir overrides when supported).
- Install a native OpenCode `/pipeline` command in the documented OpenCode `commands/` location (LLM-mediated markdown template) that shell-injects the installed pipeline launcher via an argv-safe bridge, including `--version` / `-V`.
- Ensure argument forwarding is argv-safe (no shell interpolation or argument-loss bugs).
- Preserve install / update / uninstall / dry-run / shadow-detection semantics for OpenCode without mutating Claude or Codex install trees when `--host opencode` is selected.
- Document OpenCode as a supported installer host alongside Claude, Codex, and Grok.
- Add focused regression tests for the OpenCode install layout and version-command behavior; `npm run ci` must pass.

## Acceptance criteria

- [ ] `install --host opencode` creates the OpenCode skill tree and native `/pipeline` command surface under the OpenCode config base without creating or modifying Claude or Codex skill/command installs.
- [ ] After that install, the OpenCode `/pipeline --version` (and `-V`) path deterministically shell-injects the installed launcher version (matching `core/package.json` at the install root via the argv-safe bridge); the command template instructs the agent to report only that inject output and does not embed generic pipeline instructional skill text. The host surface remains LLM-mediated (OpenCode custom commands always start a prompt turn; pure no-LLM side-effect slash commands are not available upstream).
- [ ] The OpenCode `/pipeline` command accepts ordinary pipeline arguments (issue numbers, subcommands, flags with spaces/quotes where applicable) without shell-interpolation or argument-loss bugs.
- [ ] `update --host opencode` refreshes only installer-owned OpenCode artifacts; `uninstall --host opencode` removes only those artifacts (skill tree + installer-written OpenCode pipeline command file(s)) and leaves unrelated OpenCode commands and Claude/Codex installs untouched.
- [ ] Dry-run install/update/uninstall for OpenCode reports intended actions and writes nothing.
- [ ] Unmanaged personal content at the OpenCode skill path is handled by the same non-destructive shadow/relocation policy used for other tree hosts (no silent overwrite).
- [ ] README and installer usage/`--host` help list `opencode` among valid hosts and document the OpenCode install path.
- [ ] Unit/regression tests cover OpenCode install layout, isolation from Claude/Codex, version-command routing contract, and uninstall cleanup; `npm run ci` passes.

## Capabilities

### New Capabilities

- `opencode-host-install`: First-class installer host for OpenCode — config base resolution, skill tree materialization (core + `hosts/opencode` overlay), managed marker, install/update/uninstall/dry-run isolation from other hosts, and operator documentation.
- `opencode-pipeline-command`: Native OpenCode `/pipeline` command surface (explicitly LLM-mediated markdown template) that shell-injects the installed launcher via an argv-safe bridge and routes `--version`/`-V` inject stdout to match launcher version output rather than embedding instructional skill text.

### Modified Capabilities

- `installer-shadow-detection`: Extend personal-skill detection, marker semantics, and relocation/skip behavior to the OpenCode tree host so unmanaged OpenCode skill paths are not silently overwritten.
- `host-install-discovery`: Preserve existing Claude/Codex `hostCoverage` contract; when OpenCode is installed, discovery MAY surface OpenCode presence without breaking the existing enum consumers (additive reporting only unless a non-breaking extension is agreed in design).

## Impact

- **Hosts / packaging:** new `hosts/opencode/` overlay; optional `core/profiles/opencode.json` (or equivalent profile binding) so the launcher runs with an OpenCode-appropriate implementer/reviewer pair.
- **Installer:** `scripts/install.mjs` (`VALID_HOSTS`, `HOSTS`, install/update/uninstall paths, command install helpers); `scripts/install.test.mjs`.
- **Docs:** `README.md` (and any generated install docs if present) for OpenCode host install.
- **Possibly:** `pipeline path` discovery (`host-install-discovery`) if OpenCode is reported additively.
- **Out of scope:** Full namespaced `pipeline:<command>` OpenCode surface parity (unless trivial reuse of the existing single-source list); pure no-LLM TUI plugin registration (OpenCode does not currently support side-effect-only slash commands); auto-merge; review-rigor demotion; Grok host redesign; changing Claude/Codex install destinations.
