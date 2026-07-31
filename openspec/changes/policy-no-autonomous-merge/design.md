## Context

Operator-invoked merge already exists in code:

- `pipeline merge <pr>` → `mergePr` in `core/scripts/stages/merge.ts`, dispatched only from the CLI merge keyword path in `pipeline.ts` (explicit comment: sole path that calls `mergePr` for the human merge sub-command).
- `pipeline merge-queue … --apply` → `runMergeQueue` in `core/scripts/stages/merge-queue.ts`, which may call `mergePr` under apply mode; dry-run remains the default.

Policy docs and the state-machine living spec still describe a stronger, outdated rule ("never merges" / "no merge command anywhere"), which contradicts shipped surfaces and the merge-queue capability's own "human-owned merge authority" wording. The maintainer ruling (2026-07-31) settles the conflict: **no autonomous merge by default**; operators may explicitly authorize merge for a given invocation.

This change is documentation-and-spec reconciliation with optional test-guard tightening. Runtime merge and advance behavior MUST NOT change.

## Goals / Non-Goals

**Goals:**

- Make golden-rule and living-spec language honest about structural isolation (advance never merges) while acknowledging explicit operator merge authority.
- Align README and host SKILL product positioning with the same boundary (autonomous through ready-to-deploy; merge only with session-bound operator authority; deployment out of scope).
- Keep `auto_merge` config rejection and advance-loop isolation tests as the structural enforcement surface.
- Produce a single OpenSpec change that archives cleanly into living specs.

**Non-Goals:**

- Implementing or expanding unattended auto-merge (#662).
- Changing merge-queue apply/repair semantics (#675).
- Adding merge as a `STAGES` entry or wiring merge into `pipeline advance`.
- Rewriting every historical "pipeline never merges" phrase in archived changes, pilots, or ROADMAP history — only live operator-facing and convention surfaces that define current policy.

## Decisions

### Decision 1: Policy phrase is "no autonomous merge," not "no merge capability"

**Choice:** Standard phrase across CLAUDE.md / AGENTS.md / specs / README / SKILL:

- Advance loop terminal = `pipeline:ready-to-deploy`.
- Merge only via explicit operator commands in the same session that invoked them.
- No `auto_merge` config key; no unattended/background merge path in this product surface.
- Unattended merge evidence standard remains #662.

**Why not keep "never merges":** It is factually false for operator-invoked `pipeline merge` and `merge-queue --apply`, and it trains agents to treat legitimate merge surfaces as forbidden.

### Decision 2: Structural claim is reachability from `pipeline advance`, not "no merge symbols in the process"

**Choice:** Spec text states:

1. No merge stage in `STAGES`.
2. No merge call reachable from the autonomous advance loop / stage handlers that advance dispatches.
3. Merge modules may live under `core/scripts/stages/` and may be imported by CLI-only dispatch paths (`merge` keyword, `merge-queue` keyword) without weakening the guarantee.

**Why:** `pipeline.ts` and `merge-queue.ts` already import `mergePr`. A literal "no merge command anywhere in the orchestrator" claim is false. Reachability from advance is the invariant isolation tests already approximate.

### Decision 3: Name both operator merge surfaces in the carve-out

**Choice:** Carve-out paragraph lists:

- `pipeline merge <pr>` (per-PR squash merge)
- `pipeline merge-queue --apply` (batch sequential merge; dry-run default)

Both are session-bound operator authority. Do not describe merge-queue as dry-run-only in "never does" lists when `--apply` is shipped.

### Decision 4: Docs-and-spec only; mirror host skills when hosts change

**Choice:** Edit source docs under repo root and `hosts/`; if `plugin/` mirrors host skill content, regenerate via `node scripts/build.mjs` in the same change. No stage/handler logic edits except optional comments that restate the policy if needed for test string matches — prefer test comments over code path edits.

### Decision 5: Drift-guard scope

**Choice:** Preserve existing tests:

- Stage handlers do not import merge-queue drive symbols.
- Stage handlers do not import `merge.ts` / call `mergePr`.
- Config schema rejects `auto_merge`.

If current tests already cover "advance loop never calls mergePr," document them as the guard; if any gap remains (e.g. only "stage handlers don't import merge.ts" but not advance-loop path), add a minimal static/read test that proves `mergePr` is not invoked from advance-loop dispatch without changing runtime code.

## Risks / Trade-offs

- **[Risk] Residual "never merges" language elsewhere confuses agents** → Mitigation: update the high-traffic sources (CLAUDE.md, AGENTS.md, README lead, host SKILL boundary sections). Leave archived OpenSpec history and historical ROADMAP notes alone unless they are still presented as current rules.
- **[Risk] Softening language is read as enabling unattended merge** → Mitigation: every rewording keeps "no `auto_merge` key," "advance never merges," and "unattended merge is #662" explicit.
- **[Risk] Over-editing merge-queue living specs that still describe dry-run-era apply as "future"** → Mitigation: only modify the authority/isolation requirement that this issue names; do not re-litigate full merge-queue apply behavior (owned by prior shipped changes / #675).

## Migration Plan

1. Land docs + delta specs + any guard-test tightening in one PR.
2. Archive this OpenSpec change at pre-merge (standard pipeline path).
3. No config migration; no operator action required.

## Open Questions

None for this change — maintainer ruling is explicit. Unattended merge design stays on #662.
