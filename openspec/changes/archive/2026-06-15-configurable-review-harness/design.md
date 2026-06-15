## Context

After PR #102 (#93) deleted the companion runtime, review runs exclusively as `prompt-harness`: `invoke(cfg.harnesses.reviewer, worktreeDir, prompt, opts)`. The reviewer is always the profile's cross-harness default; there is no per-repo knob. Two things block configurability:
1. `Harness = "claude" | "codex"` — the narrow union accepted by `invoke()`.
2. No reviewer-selection key in `PartialConfigSchema` — the strict schema rejects the deleted `harnesses:` block outright.

## Goals / Non-Goals

**Goals**
- One additive optional key (`review_harness`) in `.github/pipeline.yml`.
- `invoke()` accepts a `string` harness parameter; built-in invocation paths are unchanged.
- Specific, named failure when a configured reviewer CLI cannot be spawned.
- All behavior unchanged when `review_harness` is absent.

**Non-Goals**
- Custom invocation flags or environment variables per reviewer.
- Multiple reviewer CLIs per run.
- Reviewer auto-discovery.
- Reviving the companion runtime or the deleted `harnesses:` block.
- API-key-based reviewers as a new transport.

## Decisions

**Decision: `review_harness` as the key name.** Follows the established naming pattern (`review_timeout`, `review_mode`, `review_policy`). Does not shadow or reintroduce the deleted `harnesses:` block. Validated at config-parse time as `z.string().optional()` — no enum restriction, because a custom CLI name is arbitrary. Whether the CLI actually exists is a runtime check, consistent with how `eval_gate.command` and `test_gate.command` are handled.

**Decision: widen `invoke()` to `string`, not union.** `"claude"` and `"codex"` keep their existing CLI invocation shapes (`claude --print --permission-mode bypassPermissions --output-format text <prompt>` and `codex exec --full-auto -C <worktreeDir> <prompt>`). For any other string, `invoke()` spawns `<value> <prompt>` — the prompt is passed as a positional argument and stdout is captured as the harness output. This is the minimal generalization: the custom CLI reads the prompt and must emit a fenced JSON verdict block on stdout (the same output contract `parseStructuredVerdict` already handles).

**Decision: specific spawn-failure message, not `throw "Unknown harness"`.** When a non-built-in CLI cannot be spawned (ENOENT, permission denied, immediate non-zero exit), `invoke()` surfaces `"reviewer CLI '<name>' not found or not executable — ensure it is installed and on PATH"` via the returned `HarnessResult`. This flows through `invokeReviewer`, which on spawn failure applies the #39 self-review fallback (tries the implementing harness with disclosure).

**Decision: `resolveConfig` applies the override after profile merge.** The profile sets `cfg.harnesses.reviewer`; if `fileConfig.review_harness` is present, it overwrites `cfg.harnesses.reviewer` immediately after the merge step. All stage code reads only `cfg.harnesses.reviewer` — no extra lookup is needed anywhere in the pipeline.

**Decision: `invokeReviewer` reviewer param widened to `string`, implementer stays `Harness`.** The reviewer can now be any CLI string; the implementer (the self-review fallback) is always a built-in harness. `selfReviewBanner` accepts `string` for both params since it only formats a message.

## Risks / Trade-offs

- *Custom reviewer produces malformed output* → `parseStructuredVerdict` already handles it: conservative `needs-attention` default with the raw output attached as `_raw`. No new risk.
- *Custom reviewer is slower or more expensive* → user's choice; no pipeline change.
- *User sets `review_harness: codex` (same as profile default)* → no-op; behavior identical to absent key. Not worth guarding.
- *Custom reviewer ignores the JSON verdict prompt* → `parseStructuredVerdict` falls back conservatively; the #16 SHA gate re-reviews the next commit. The system already handles prose-only output from Codex (`parseProseReview`).
