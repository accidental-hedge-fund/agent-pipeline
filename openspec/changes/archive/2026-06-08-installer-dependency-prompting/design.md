## Context

The installer (`scripts/install.mjs`) is a zero-dependency Node script that uses only builtins. It already detects companion plugins (`companionPresent`, `codexCompanionPresent`) and the openspec CLI but only emits info-level warnings — it has no install/update logic for these. The preflight function (lines 171–201) is the natural seam to extend. Shadow detection (lines 207–244) established the pattern for interactive prompts with non-TTY fallback — the same pattern applies here.

Four external dependencies are in scope:
1. **`cc-plugin-codex`** (`sendbird/cc-plugin-codex`) — adds `claude-companion.mjs` to Codex's plugin cache; the `$pipeline` (Codex) flow drives Claude Code through it for review.
2. **`codex-plugin-cc`** (`openai/codex-plugin-cc`) — adds `codex-companion.mjs` to Claude Code's plugin cache; the `/pipeline` (Claude) flow drives Codex through it for review.
3. **`openspec`** CLI (`Fission-AI/OpenSpec`) — required only when `openspec.enabled: true` in `.github/pipeline.yml`.
4. **`last30days`** skill (`mvanhorn/last30days-skill`) — required only when `last30days.enabled: true` in `.github/pipeline.yml`.

## Goals / Non-Goals

**Goals:**
- Detect which of the four dependencies are (a) relevant to the chosen host and (b) missing or outdated.
- Prompt once per dependency in TTY mode; install/update on accept.
- Skip silently in non-TTY mode, report skipped items, honour `--yes-deps` / `PIPELINE_INSTALL_DEPS=1` to auto-accept in CI.
- Report final per-dependency status: `installed` / `updated` / `already current` / `declined` / `failed`.
- Never block the core install on a dependency decline or failure.

**Non-Goals:**
- Auto-installing base CLIs (Node, git, gh, claude, codex) — remain warnings only.
- Pinning dependency versions — always install/update to latest.
- Configuring credentials or API keys a dependency needs post-install.
- Removing shared dependencies on uninstall.
- Managing indirect (transitive) dependencies of the four target deps.

## Decisions

### 1. Reuse existing readline prompt infrastructure

The installer already uses Node's `readline` (via the shadow-detection relocation prompt). Extend the same `askYN(question)` helper rather than introducing a new prompt library. Keeps the zero-external-dependency constraint intact.

**Alternatives considered:**
- A separate `inquirer`-style library: adds a dependency, contradicts the zero-dep rule.
- Batch prompt ("install all at once Y/N"): less granular than per-dependency, harder to decline individual ones.

### 2. Relevance gating via host selection + feature flags

Each dependency maps to a gate:
- `cc-plugin-codex` — only offered when the Codex host is being installed.
- `codex-plugin-cc` — only offered when the Claude Code host is being installed.
- `openspec` — only offered when `openspec.enabled` is `on`/`true` in `.github/pipeline.yml`, or when it is `auto`/absent and the target repo has an `openspec/` directory ("when openspec is in use").
- `last30days` — only offered when `last30days.enabled: true` in `.github/pipeline.yml`.

**Rationale:** avoids prompting Claude-only users about Codex plugins and vice versa; aligns with issue scope ("relevance-gated by host/feature").

### 3. Install mechanism per dependency

| Dependency | Detection | Install/Update command |
|---|---|---|
| `cc-plugin-codex` | `companionPresent()` (claude-companion.mjs in `~/.codex/plugins`) + version comparison | `npx --yes cc-plugin-codex install` / `npx --yes cc-plugin-codex update` |
| `codex-plugin-cc` | `codexCompanionPresent()` (codex-companion.mjs in `~/.claude/plugins`) + version comparison | `npx --yes codex-plugin-cc install` |
| `openspec` | `which openspec` + `npm list -g @fission-ai/openspec` | `npm install -g @fission-ai/openspec@latest` |
| `last30days` | skill dir presence + `.claude-plugin/plugin.json` version | `npx --yes skills add mvanhorn/last30days-skill -g` / `npx --yes skills update last30days -g` |

**Note:** exact install commands must be confirmed against each dependency's published README during implementation — the table shows intent, not literal commands. Implementation tasks include a research step for each.

### 4. Non-interactive defaults

When `process.stdin.isTTY` is falsy (piped/CI) and neither `--yes-deps` nor `PIPELINE_INSTALL_DEPS=1` is set, all dependency prompts are skipped. The installer prints a summary line for each skipped dep:

```
ℹ  Skipped cc-plugin-codex (non-interactive). Re-run with --yes-deps to install.
```

When `--yes-deps` or `PIPELINE_INSTALL_DEPS=1` is set, prompts are auto-accepted (equivalent to "Y" for every dep), matching the shadow-detection CI behaviour pattern.

### 5. Failure isolation

Each dependency install runs in its own try/catch. A failure marks that dep `failed` and logs the error, then continues to the next dep and completes the core install. The final status table shows the failure so the user can retry manually.

### 6. Version comparison strategy

"Outdated" detection: compare installed version (via the dependency's own `--version` flag or a version file) against `npm view <pkg> version` (or GitHub API for non-npm packages). If comparison fails (network error, no version flag), treat as "unknown" and still offer to re-install — conservative but never silently stale.

## Risks / Trade-offs

- **Install command changes** → dependency maintainers can change their install flow. Mitigation: implementation tasks include confirming each command from upstream docs; re-check on each installer release.
- **Version detection fragility** → non-npm deps (cc-plugin-codex, last30days) may not expose a clean `--version`. Mitigation: fall back to "install anyway" on unknown version; document the fallback in status output.
- **Network errors during install** → caught by failure isolation (decision 5); user sees `failed` status and instructions to retry.
- **`--yes-deps` scope** → auto-accepting all deps in CI may be surprising for users who want selective installs. Mitigation: per-dep `--yes-dep=<name>` is explicitly out of scope for now; document `--yes-deps` as all-or-nothing in help text.
