## Context

`core/scripts/harness.ts` passes `--model` only when the active harness is `claude`; the `codex` branch ignores the option entirely (the comment at line 27 confirms: *"Currently only honored by claude."*). Harness roles (`implementer`, `reviewer`) are resolved from the active profile — never from file config — so a user cannot change the harness via `pipeline.yml`. The `models.*` keys in `pipeline.yml` map to roles as follows:

| Config key | Harness role |
|---|---|
| `models.review` | `reviewer` |
| `models.planning` | `implementer` |
| `models.fix` | `implementer` |

When `fileConfig.models` is explicitly set but the backing role is `codex`, the alias is silently lost.

## Goals / Non-Goals

**Goals:**
- Emit a `console.warn` for each `models.*` key that is explicitly present in `fileConfig` and whose backing harness role is `codex`.
- Keep the warning non-blocking: no throw, no resolved-config mutation, no fallback.
- Only warn for user-authored values — `DEFAULT_CONFIG` values must not trigger the warning.

**Non-Goals:**
- Per-step model selection (that is #70 / v1.2.0 scope).
- Changing the resolved config or harness behavior in any way.
- Validating model alias values against a known list.

## Decisions

### Detection point: after merge, inside `resolveConfig`

The check runs immediately after `fileConfig` is validated and `merged` is assembled. At that point `profile.harnesses` and `fileConfig.models` are both fully resolved, so the check is a simple cross-reference with no additional I/O.

**Alternative considered:** check at call sites (planning, review stages). Rejected — spreads the logic across multiple files, could fire multiple times per run, and misses future call sites.

### One warning per inert key

Each of `models.review`, `models.planning`, and `models.fix` is checked independently. If two are inert, two warnings appear, making the problem unambiguous for the user.

**Message format:**
```
[pipeline] config warning: models.<key> is set to "<value>" but the <role> harness is "codex" — model aliases are only honored by the claude harness. The setting is ignored.
```

### No warning when the value equals `DEFAULT_CONFIG.models.<key>`

The guard condition is `fileConfig.models?.<key> !== undefined`, not a value comparison. Since `fileConfig` contains only what was explicitly parsed from the file (the Zod schema marks `models` as optional), any key present in `fileConfig.models` was user-authored.

## Risks / Trade-offs

- **Warning noise if the profile ever changes:** if a repo that warned on `codex` later switches to a `claude` profile, the warning stops automatically (the profile drives the check). No stale warnings.
- **No dedup across multiple `resolveConfig` calls in one run:** `resolveConfig` is called once per pipeline loop iteration; duplicate warnings within a run are not a concern at current call-site density.
