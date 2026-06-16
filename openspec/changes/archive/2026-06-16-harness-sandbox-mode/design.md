## Context

The claude harness is invoked by `core/scripts/harness.ts:invoke()` with `--permission-mode bypassPermissions`. This grants the subprocess read/write access to the entire host filesystem and network — acceptable for local developer workstations, but too permissive for shared build runners, CI machines, or sensitive environments.

Claude's CLI already exposes a native sandboxed mode (`--permission-mode default`) that restricts filesystem access to the working directory and requires explicit approval for broader operations. Codex's `--full-auto` mode already constrains writes to the worktree. The gap is purely on the claude side.

The maintainer decision (2026-06-10 simplification audit) scoped this to a single config toggle that swaps one flag — no container runtime, no E2E sandbox shim.

## Goals / Non-Goals

**Goals:**
- Let a repo opt into `--permission-mode default` for the claude harness via one config key.
- Keep the default invocation byte-identical to the pre-change state.
- Require zero new runtime dependencies.

**Non-Goals:**
- Container-based isolation (Docker / E2B / Modal) — deferred indefinitely per simplification audit.
- Sandboxing the reviewer harness — only the implementer/fix harness carries execution risk.
- Codex flag changes — codex `--full-auto` is already workspace-scoped.
- Any CI-only or environment-variable-based toggle — config file is the single mechanism.

## Decisions

### 1. Single boolean key `harness_sandbox` in `pipeline.yml`

**Chosen:** `harness_sandbox: true/false` (default `false`).

**Alternatives considered:**
- `harness_sandbox: "claude"` string enum for per-harness control → over-engineered; codex doesn't need it and the key name already scopes to harness invocation.
- `permission_mode: default|bypassPermissions` exposing the raw claude flag → leaks CLI surface into config; brittler if claude renames the flag.
- Environment variable (`PIPELINE_SANDBOX=1`) → harder to version-control per-repo intent; inconsistent with how all other pipeline options are set.

### 2. Flag swap inside `invoke()`, not a separate function

**Chosen:** The existing `if (harness === "claude") { … }` branch in `invoke()` reads `opts.sandbox` (passed from the call site, which reads `cfg.harness_sandbox`) and selects `bypassPermissions` vs `default`.

**Alternatives considered:**
- Separate `invokeSandboxed()` function → code duplication; the branch is one conditional on a single arg string.
- Wrapper shell script → fragile, OS-specific, not testable via node `--test`.

### 3. `invoke()` receives sandbox flag via `InvokeOptions`, not global config

**Chosen:** Add `sandbox?: boolean` to `InvokeOptions`. Call sites (`stages/`) read the resolved config and pass the flag through.

**Rationale:** `harness.ts` has no config import today (it's a low-level utility). Keeping it dependency-free preserves testability — unit tests can toggle the flag without a fake config resolver.

## Risks / Trade-offs

- **claude permission-mode behaviour change** — `--permission-mode default` may prompt interactively or refuse operations that `bypassPermissions` would allow. Repos that opt in may see harness runs stall on interactive prompts. Mitigation: the key is opt-in; documentation should call this out explicitly.
- **Flag name stability** — if claude renames `--permission-mode default`, the feature silently breaks. Mitigation: the flag is in one place (`invoke()`); an integration smoke test can assert the flag string is present in the spawned args.

## Migration Plan

No migration needed — the default value (`false`) keeps the current invocation unchanged. Repos opt in by adding `harness_sandbox: true` to `.github/pipeline.yml`.
