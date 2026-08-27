## Context

See proposal.md for motivation.

Today `resolveHarnessRoles` fills each missing `harnesses.*` key from `profile.harnesses`. `resolveConfig()` loads the active profile for every run, including when `.github/pipeline.yml` is absent (`DEFAULT_CONFIG` + profile pair). Host launchers inject `--profile`, so the outer host chooses live workers whenever repository policy is missing or partial.

`configurable-harness-roles` (#608) already lets a complete `harnesses:` block win over the profile. This change removes the remaining fallback. Living specs still disagree: `pipeline-configuration` and `configurable-harness-roles` describe per-role profile fallback, while `cross-host-profiles` still says the implementer SHALL NOT be overridable by `.github/pipeline.yml`. This design treats repository config as the only live-worker source and records that reversal in the deltas.

Init already calls `resolveConfig({ tolerateInvalidConfig: true })` so it can scaffold a missing file. `--version` / `-V` and `path` never resolve execution config. Those exemptions stay.

## Goals / Non-Goals

**Goals:**
- One shared fail-closed check in configuration resolution, not per-command copies.
- Distinct diagnostics for missing file, missing `harnesses` block, and each missing role.
- Profiles keep serving bootstrap and presentation; they stop selecting live workers.
- Fresh `pipeline init` writes a file that already declares both roles, so the next execution command can run.

**Non-Goals:**
- Renaming, removing, or replacing the profile JSON files.
- Changing `review_harness` structured model/effort/prompt-delivery when it agrees with `harnesses.reviewer`.
- Changing OMP install (#1235) or Node engine bootstrap (#1236).
- Flipping `COMMAND_REGISTRY.needsConfig` as the enforcement mechanism (loop stays `needsConfig: false` at the coordinator layer; item dispatch still resolves config).

## Decisions

### Decision 1 — Put the gate in `resolveConfig()`, default on

Execution-policy resolution requires `.github/pipeline.yml` and both `harnesses.implementer` and `harnesses.reviewer` before returning a config. Callers that already resolve config for work (advance, single, train, ship, merge, doctor, item dispatch from loop) inherit the gate. Launchers do not grow a second check.

The alternative — a command-registry flag such as `requiresDeclaredHarnessRoles` — would duplicate the rule and miss any future caller that calls `resolveConfig()` directly.

`pipeline config validate` stays never-throwing: the same conditions become `severity: "error"` diagnostics.

### Decision 2 — Keep schema keys present-or-absent; reject absence in a dedicated check

`PartialConfigSchema.harnesses.implementer` / `reviewer` stay optional at the Zod layer so a missing key is distinguishable from an unknown key or an empty string. After a successful parse (or after detecting a missing file), a dedicated check fails closed with a message that names the missing path and the remedy.

Making the Zod keys required would collapse missing-file, missing-block, and missing-key into generic "Required" errors. Empty strings already fail `min(1)`.

### Decision 3 — `review_harness` is overlay, not a role declaration

`harnesses.reviewer` is required for execution. `review_harness` alone is a partial policy and fails closed, even though #608 allowed it to supply the reviewer. Structured `model` / `effort` / `prompt_delivery` still apply when both names agree. Conflicting names still fail naming both keys and values.

The alternative — counting `review_harness.command` as the reviewer declaration — would leave two ways to name the live reviewer and keep averaging `harnesses.reviewer` vs `review_harness`.

### Decision 4 — Profiles stay loaded; they are not live workers

`resolveConfig()` still loads the active profile for `reviewMode`, invocation, marker footer, implementation-ready message, and conventions filename. Resolved `cfg.harnesses.implementer` / `reviewer` come only from the repository block. Evidence for an execution run records each live role source as `repo-config` (structured reviewer settings may still cite `review_harness`). `profile` is not a live role source for execution.

Init is the bootstrap exception: when it creates a new file, it writes both keys as active values using the active profile pair as starter text. After that write, those values are repository policy. Init does not invoke either harness.

`pipeline config sync` SHALL NOT invent live workers from the profile for an existing file that lacks a role. It reports the missing keys and refuses to write a still-partial candidate. Comment refresh on an already-complete block is allowed and MUST drop "falls back to the active profile" wording.

### Decision 5 — Exemptions are named and narrow

| Surface | Gate |
| --- | --- |
| Default `resolveConfig()` (execution) | Required |
| `pipeline init` | Exempt so it can create the file; still does not invoke live workers |
| `--version` / `-V` | Never resolves execution config |
| `path` | Never resolves execution config |
| `pipeline config validate` | Same rules as diagnostics, not throws |
| `pipeline config schema` | No repository file |
| Host launchers | Must not inject live roles; CLI resolve still gates |
| `loop` coordinator / logs | Observation paths that do not resolve execution config stay as documented; each item that advances goes through `resolveConfig()` |

Implementation: reuse or narrow `tolerateInvalidConfig` for init only. Do not reuse it as a silent profile fallback for execution.

### Decision 6 — Fail before side effects because resolution already precedes them

Advance, single, train, ship, and loop item dispatch already call `resolveConfig()` before worktree add, GitHub writes, or `invoke`. The new check lives in that function, so existing order is the proof. Tests assert `resolveConfig()` throws on absent/partial policy without any worktree/gh/harness fake being called. Do not add a second preflight in each stage.

### Decision 7 — Repair the stale `cross-host-profiles` contract in this change

`cross-host-profiles` still says the implementer comes from the profile and SHALL NOT be overridable by `.github/pipeline.yml`. That contradicts #608 and this issue. This change removes that requirement rather than leaving the conflict for a later refactor.

## Risks / Trade-offs

- **Existing repos that omit `harnesses:` stop running.** → Mitigation: diagnostic names the missing keys and `pipeline init`; this repo already declares both roles. That break is the product intent.
- **Init from different hosts writes different starter pairs.** → Mitigation: the file is the source of truth after the write; operators edit it. Not a runtime fallback.
- **`loop.needsConfig` stays false.** → Mitigation: item dispatch still resolves config; a loop that never advances an item does not need live workers. Do not start harness work for an item whose resolve failed.
- **`tolerateInvalidConfig` today falls back to the profile pair.** → Mitigation: execution no longer uses that fallback. Init may still tolerate a broken existing file so it can ensure labels without clobbering.

## Migration Plan

1. Operators of a runnable repo add both keys if missing:

```yaml
harnesses:
  implementer: grok
  reviewer: codex
```

2. Repos with no file run `pipeline init`, then edit the written pair if the starter values are wrong.
3. No rollback switch. Reverting the engine restores profile fallback.

## Open Questions

None. Exemptions, `review_harness` overlay, and init starter values are decided above.
