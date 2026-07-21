## Context

`planning.ts` invokes the implementer harness twice:

- **Line 226** — standard (non-OpenSpec) path: `invoke(primary, wt.path, implPrompt, { timeoutSec: cfg.implementation_timeout, model: opts.model })`
- **Line 621** — OpenSpec path: `invoke(primary, wt.path, buildImplementingPrompt(...), { timeoutSec: cfg.implementation_timeout, model: opts.model })`

Every other harness call in `planning.ts` follows `model: opts.model ?? cfg.models.<slot>`, where `opts.model` carries a one-off CLI override and `cfg.models.<slot>` carries the per-repo default from `.github/pipeline.yml`. These two calls pass only `opts.model`, so `cfg.models.implementing` has no path to reach the harness even after the config key is added.

The `MODEL_ALIAS_ROLES` array drives `warnInertModelAliases`. It cross-references user-authored model keys against the active harness profile and emits a non-blocking advisory when a key is set for a codex-backed role. Adding `implementing` to this array makes the advisory coverage complete across all four slots.

## Goals / Non-Goals

**Goals:**
- Repos can set `models.implementing` in `.github/pipeline.yml` to control which Claude alias the implementing harness uses.
- Omitting `models.implementing` preserves today's behavior exactly — the slot resolves to `"sonnet"` from `DEFAULT_CONFIG`.
- A `models.implementing` set while the implementer harness is `codex` emits a non-blocking advisory, consistent with `planning` and `fix`.

**Non-Goals:**
- Per-step harness selection (claude vs. codex per step) — issue #40.
- A `models.docs` slot — docs runs inside the implementing harness call; there is no separate docs harness invocation (#91).
- A validated allowlist of accepted model identifier strings — `.strict()` key validation and the codex inert-alias warning are the already-shipped safeguards.

## Decisions

**Decision: default `implementing` to `"sonnet"`.** The `planning` and `fix` defaults in `DEFAULT_CONFIG.models` are both `"sonnet"`, which is the current effective default for the implementer. Matching that default means zero behavioral change for every repo that does not set the key.

**Decision: wire both call sites.** The standard path (line 226) and the OpenSpec path (line 621) must both receive `cfg.models.implementing`. Leaving one unwired would create a mode-dependent inconsistency with no user-visible signal.

**Decision: `MODEL_ALIAS_ROLES` entry uses `role: "implementer"` (not a new role).** `implementing`, `planning`, and `fix` all back the same harness role (`profile.harnesses.implementer`). Adding `implementing` with `role: "implementer"` reuses the existing warning path without new branching.

## Risks / Trade-offs

- *Both call sites must be updated.* Missing one silently ignores the config for that code path. The unit test covers both paths via the harness dependency seam.
- *Template comment omission.* If the `pipeline.yml` template comment is not updated, users who uncomment the `models:` block will not see `implementing` as a valid key. This is a documentation regression, not a functional one — the tasks list this step explicitly.
