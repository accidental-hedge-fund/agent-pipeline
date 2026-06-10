## Why

The config schema and runtime carry four dead-weight surfaces: `harnesses` and `auto_merge` are accepted config keys that validate but never change behavior; `openclaw` is an undocumented near-duplicate of the `claude` profile; and the companion review runtime (`isCompanionMode` / `invokeCompanionReview`) has no reachable path since every shipped profile uses `prompt-harness`. Each entry misleads config authors and code readers into thinking more exists than does, widens the apparent host seam, and adds maintenance surface with no return.

## What Changes

- **BREAKING** Remove `harnesses` from `PartialConfigSchema` — repos that set it now get a strict-schema parse error (they were already getting silent incorrect behavior: the value was accepted then immediately discarded in favour of the profile value)
- **BREAKING** Remove `auto_merge` from `PartialConfigSchema` and `DEFAULT_CONFIG` — no pipeline stage reads or acts on it; the never-merge guarantee is structural, not config-governed
- Delete `core/profiles/openclaw.json` — its `harnesses` and `reviewMode` are identical to `claude`; only branding strings differ; no shipped SKILL.md references it as a primary profile
- Delete the companion review runtime from `review.ts`: `CompanionMode` type, `isCompanionMode`, `COMPANIONS` map, `CompanionReviewCommand` interface, `buildCompanionReviewCommand`, and `invokeCompanionReview`; the dead branch in `advanceReview` that routes to companion invocation
- `parseProseReview` is NOT removed — it parses prompt-harness Codex prose output and is called on every Codex reviewer response
- Remove `openclaw` from the `--profile` CLI option list and the profile name union type
- Update README host-seam and config key sections; update tests covering the removed keys/paths

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `pipeline-configuration`: remove back-compat acceptance of `harnesses` and `auto_merge`; strict schema now rejects both keys outright
- `cross-host-profiles`: ship only `claude` and `codex`; remove `openclaw` from the profile inventory
- `review-layer`: companion modes (`claude-companion`, `codex-companion`) are removed as valid `reviewMode` values; `reviewMode` accepts only `prompt-harness`

## Impact

- `core/scripts/config.ts` — remove `harnesses` and `auto_merge` zod fields + merge lines
- `core/scripts/types.ts` — remove `harnesses` and `auto_merge` from `PipelineConfig` interface and `DEFAULT_CONFIG`
- `core/profiles/openclaw.json` — deleted
- `core/scripts/stages/review.ts` — remove companion-mode types, constants, and functions; keep `parseProseReview`
- `core/scripts/pipeline.ts` — remove `openclaw` from `--profile` help text
- `core/scripts/profile.ts` — remove `"openclaw"` from the name union
- `core/scripts/stages/fix.ts` — remove the comment referencing openclaw behavior (line 57)
- `plugin/` — regenerated via `node scripts/build.mjs` after core changes
- `core/test/*.test.ts` — update or remove assertions covering removed keys and companion paths
- README — update config reference and host-seam sections
