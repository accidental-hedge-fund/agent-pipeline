## Why

The reviewer harness cannot be given a model when it is a CLI other than `claude`. `invoke()` in `harness.ts` appends `--model` only on the `claude` branch; the `codex` branch receives only `-c model_reasoning_effort=<value>` and drops any configured model. `warnInertModelAliases` (#116) still declares `models.review` "silently inert" whenever the reviewer role is codex, and #366 shipped the structured `review_harness: { command, model, effort }` form but preserved that split — so even an explicit `review_harness: { command: codex, model: gpt-5.6-terra }` ignores the model.

The only workarounds today are editing the operator's global `~/.codex/config.toml` (machine-wide side effects) or a wrapper script (loses effort passthrough and the config-file audit trail). `codex exec` already accepts `-m <model>` (and `-c model_reasoning_effort=<level>`), so honoring a configured reviewer model is a passthrough, not a new integration. Operators should be able to pin **both the model and the effort** of the reviewer per repo, for the built-in codex reviewer CLI.

## What Changes

- `invoke()`'s `codex` branch honors `opts.model`: when set, it appends `-m <model>` to `codex exec …`. The `claude` branch is unchanged (`--model` / `--effort` as today). Custom (non-claude, non-codex) reviewer CLIs still receive neither flag.
- Reviewer model resolution becomes reviewer-harness-aware. An explicit (non-`auto`) reviewer model resolves verbatim and is passed to codex as `-m <model>` — the operator owns naming a codex-valid id. When the reviewer model is the `auto` sentinel and the reviewer is codex, the routing matrix's Adversarial cells map only to claude-only aliases (`claude-fable-5`), which have no codex equivalent; the invocation therefore **omits `-m`** (codex uses its configured default) and **never passes a claude alias to codex**. This preserves today's effective behavior for `auto` while honoring explicit ids.
- `warnInertModelAliases` no longer fires for `models.review` when the reviewer is codex (the model is now honored). It now warns for `models.review` when the reviewer is a **custom** (non-claude, non-codex) CLI, which receives no model flag — mirroring the existing custom-CLI inert-effort advisory. The implementer-role keys (`models.planning`/`implementing`/`fix`) continue to warn under a codex implementer (implementer passthrough is out of scope).
- An invalid/unavailable codex model id surfaces codex's own CLI error in the blocked-item evidence, with the configured model id present in the evidence, rather than silently falling back.
- Config docs (the `pipeline init` scaffold comments, README, and skill docs) drop the "model aliases are only honored by the claude harness" caveat for the codex reviewer case.

## Acceptance Criteria

- [ ] When the effective reviewer command is `codex`, a configured reviewer model (structured `review_harness.model`, else `models.review`) reaches the invocation as `codex exec -m <model> …`; effort continues to flow as `-c model_reasoning_effort=<level>`.
- [ ] The claude reviewer branch behavior is unchanged (`--model` / `--effort` exactly as today).
- [ ] `warnInertModelAliases` no longer fires for a codex-backed reviewer; it still warns for custom (non-claude, non-codex) reviewer CLIs, which receive neither flag; implementer-role codex keys still warn.
- [ ] `auto` sentinel resolution for the reviewer resolves to a model valid for the target CLI, or omits the flag when no mapping exists — it never sends a claude alias (e.g. `sonnet`, `claude-fable-5`) to codex.
- [ ] An invalid/unavailable model id surfaces the codex CLI's own error in the blocked-item evidence, naming the configured model, rather than silently falling back.
- [ ] Config docs (`pipeline init` scaffold comments, README, skill docs) no longer claim model aliases are honored only by the claude harness for the codex reviewer case.
- [ ] Unit tests cover: codex reviewer with model+effort, codex reviewer with effort only (today's behavior), custom CLI still warns-inert, and `auto`-sentinel resolution per CLI.

## Capabilities

### Modified Capabilities

- `configurable-review-harness`: `invoke()`'s codex branch honors a configured reviewer model via `-m <model>`; reviewer model resolution is reviewer-harness-aware so `auto` never sends a claude alias to codex; an unavailable codex model surfaces codex's error in evidence.
- `config-inert-models-warn`: the `models.review` inert-alias warning fires for a custom reviewer CLI (not for codex, whose model is now honored, nor for claude); implementer-role keys under codex are unchanged.
- `stage-model-effort-routing`: the codex `invoke()` model passthrough (`-m <value>`) is specified alongside the existing effort passthrough; `auto` resolution for a codex reviewer omits the flag rather than emitting a claude-only alias.

## Impact

- `core/scripts/harness.ts` — codex branch appends `-m <model>` when `opts.model` is set; comment/JSDoc updated to drop "only honored by claude".
- `core/scripts/config.ts` — `warnInertModelAliases` review-role branch reframed (warn for custom reviewer CLI, not codex); the validate-command mirror of the same warning (`validateConfig`); scaffold comment strings in `renderModelLines`.
- `core/scripts/stages/review-routing.ts` (and the plan-review / pre_merge reviewer call sites) — reviewer model resolution made reviewer-harness-aware so an `auto`-resolved claude-only alias is not passed to a codex reviewer.
- `README.md` and `hosts/**/SKILL.md` (skill docs) — remove the codex-reviewer model caveat.
- `core/test/` — new unit tests for codex model+effort passthrough, codex effort-only, custom-CLI inert warning, and per-CLI auto resolution.
- `plugin/` — regenerated mirror committed in the same change.
