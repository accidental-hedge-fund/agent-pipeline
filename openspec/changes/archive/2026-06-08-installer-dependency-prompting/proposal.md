## Why

The installer today detects companion plugins and optional tools (openspec, last30days) but only emits warnings — it never offers to actually install them. A new user who finishes the install wizard still has a broken pipeline until they manually chase down and install each dependency, which is undiscoverable friction that defeats the purpose of having a managed install.

## What Changes

- The installer gains a **dependency-prompting phase** that runs after the core skill is placed and after the existing preflight warnings.
- For each dependency that is (a) relevant to the chosen host/features and (b) missing or outdated, the installer emits a single interactive prompt asking whether to install or update it.
- Accepted dependencies are installed at their **latest** version; already-present ones are brought to latest on accept.
- Declining any individual dependency (or all) still lets the core install complete successfully.
- In non-interactive (no-TTY) mode the prompt is skipped; the installer reports which dependencies were skipped and how to pre-confirm for automated installs (`--yes-deps` flag or `PIPELINE_INSTALL_DEPS=1` env).
- At the end, the installer prints a per-dependency status table: `installed` / `updated` / `already current` / `declined` / `failed`.
- Base CLI prerequisites (Node, git, gh, claude, codex) remain preflight **warnings only** — not auto-installed.

## Capabilities

### New Capabilities

- `installer-dependency-prompting`: detect relevant external dependencies, prompt to install/update each, report status; honours non-interactive mode; never blocks core install on decline or failure.

### Modified Capabilities

- `installer-shadow-detection`: no requirement changes — implementation is adjacent but the spec behaviour is unchanged.

## Impact

- `scripts/install.mjs` — new dependency-prompting phase added after preflight; existing companion-detection helpers (`companionPresent`, `codexCompanionPresent`) reused as detection backbone.
- New `--yes-deps` CLI flag and `PIPELINE_INSTALL_DEPS` env var recognised by installer.
- `scripts/install.test.mjs` — new test coverage for prompting logic, non-interactive fallback, and status reporting.
- No changes to `core/`, host overlays, or the pipeline harness itself.
