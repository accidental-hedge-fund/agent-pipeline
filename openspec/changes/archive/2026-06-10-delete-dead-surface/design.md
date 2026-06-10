## Context

The pipeline config schema uses `z.object({...}).strict()` for the top-level block, meaning any key not listed in the schema causes `resolveConfig()` to throw. Currently `harnesses` and `auto_merge` are listed but never consumed; removing them flips their parse outcome from silent discard to loud rejection. Three shipped profiles (`claude`, `codex`, `openclaw`) exist; all set `reviewMode: "prompt-harness"`, meaning the companion invocation branches in `review.ts` have been unreachable since PR #54 introduced prompt-harness as the default.

## Goals / Non-Goals

**Goals:**
- Every key the schema accepts changes observable behavior
- Every function in `review.ts` is reachable by at least one shipped profile
- The profile inventory matches the SKILL.md surface (`claude` + `codex` only)

**Non-Goals:**
- Making `reviewMode` user-configurable (#40)
- Reviewer-unavailable fallback (#39)
- Changing `claude` or `codex` profile behavior in any way

## Decisions

### Decision 1: Remove `harnesses` and `auto_merge` immediately (no deprecation window)

**Alternatives considered:**
- (A) Warn-then-remove over two releases — adds a deprecation log path that needs its own tests and maintenance
- (B) Keep accepting but log a warning — leaves the misleading surface in place

**Chosen:** Immediate removal. Both keys were inert from day one — repos setting them were already running with different effective values. A hard parse error is a better signal than a silent ignore. The migration cost is minimal: remove the key from `.github/pipeline.yml`.

### Decision 2: Remove `openclaw` profile outright (no alias)

**Alternatives considered:**
- (A) Reduce to a documented alias pointing users to `claude` — adds a forwarding path and load-time logic
- (B) Keep file but strip to a stub — still confuses profile inventory

**Chosen:** Delete the file. No shipped SKILL.md targets `openclaw` as the primary profile; the only functional difference (branding strings) is irrelevant to correctness. Users who set `--profile openclaw` will get `loadProfile` throwing with an unknown-profile error — the same UX as any unrecognized profile name.

### Decision 3: Delete the companion runtime entirely; keep `parseProseReview`

**Alternatives considered:**
- (A) Document how to reach companion mode — requires wiring a profile to it, which contradicts rigor-over-latency since it was removed for prose-verdict regression reasons (PR #54)
- (B) Keep the code, add a TODO — leaves unreachable dead code and its tests

**Chosen:** Delete `isCompanionMode`, `CompanionMode`, `COMPANIONS`, `buildCompanionReviewCommand`, `invokeCompanionReview`, and the companion branch in `advanceReview`. `parseProseReview` stays — it is the parser for Codex's native prose output when running as reviewer in prompt-harness mode, and is actively called.

The `reviewMode` field is kept in the profile schema (future #40 may make it user-configurable) but narrows from `"prompt-harness" | "claude-companion" | "codex-companion"` to `"prompt-harness"` only.

## Risks / Trade-offs

- [Breaking config change] Repos setting `harnesses:` or `auto_merge:` will fail parse → Mitigation: these repos were already running with incorrect effective values; the error message from zod strict will identify the offending key
- [openclaw users] Any user who set `--profile openclaw` will get a runtime error → Mitigation: no SKILL.md ships with openclaw as the invoked profile; it was only reachable via an explicit CLI flag

## Migration Plan

1. Remove `harnesses` and `auto_merge` from the zod schema (config.ts) and types (types.ts)
2. Delete `core/profiles/openclaw.json`
3. Remove companion-mode code from `review.ts`; verify `parseProseReview` call sites are unaffected
4. Update `pipeline.ts` and `profile.ts` to drop `openclaw` references
5. Update README config and host-seam sections
6. Run `npm run ci` — update tests that assert on removed keys/paths
7. Regenerate `plugin/` via `node scripts/build.mjs`
