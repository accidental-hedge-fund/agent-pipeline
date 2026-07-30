# Audit hit list — plan-review authority language (#574)

Surfaces audited for claims that equate `plan-review` with human sign-off / human
approval, and for the "human must review the plan" myth in engine comments.

## Operator surfaces (must fix)

| Path | Phrase / claim | Disposition |
| --- | --- | --- |
| `README.md` L15 (Lifecycle band) | `` `plan-review` is the human sign-off before implementation starts `` | **Rewrite** to independent agent plan review + optional human feedback window |
| `README.md` § Human plan feedback | Correct optional-feedback model, but does not name closed vocabulary or state no-human-input expiry as non-approval | **Align** with four terms + explicit empty-window semantics |

## Engine comments (must fix — comment only)

| Path | Phrase / claim | Disposition |
| --- | --- | --- |
| `core/scripts/pipeline-run.ts` `isAutoLoopEligible` JSDoc | `` `plan-review` and `shipcheck-gate` are human-judgment checkpoints ``; plan-review `waiting` means "a human must review the plan" | **Rewrite** comments; keep eligibility hard-stop behavior |
| `core/test/auto-loop.test.ts` shipcheck hard-stop test | "shipcheck-gate is a human-judgment checkpoint (like plan-review)" | **Rewrite** comment to match corrected reason |

## Operator surfaces audited — no over-claim found

| Path | Notes |
| --- | --- |
| `hosts/claude/SKILL.md` | Mentions plan-review as stage/role only; no human sign-off claim |
| `hosts/codex/SKILL.md` | Same |
| `core/scripts/status-json.ts` `deriveNextAction` | `"Plan review is in progress."` — neutral, not human-approval language |
| `docs/harness-audit.md` | "cross-harness plan-review step" — correct agent framing |
| `README.md` Human merge band | Correctly names human merge at `ready-to-deploy` |

## Intentionally left alone

| Path | Why |
| --- | --- |
| `ROADMAP.md` #23 "Optional human approval checkpoints" | Deferred feature name, not a description of today's plan-review |
| `correction` / improve `human-judgment` control level | Separate control-compiler vocabulary; not plan-review authority |
| `backfill.ts` "a human must review and merge this PR" | True human-approval surface (merge), not plan-review |
| OpenSpec archive / historical design docs | Historical; not operator front-door |

## Forbidden phrases for drift-guard (minimum)

- `plan-review` is the human sign-off
- `plan-review is the human sign-off`
- `plan-review` is human sign-off / human approval (equality, not negation)

Explicit distinction sentences (e.g. "plan-review is **not** human sign-off") remain allowed.
