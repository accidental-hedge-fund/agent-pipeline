## 1. Remove dead config keys

- [x] 1.1 Delete `auto_merge` field from `PartialConfigSchema` in `core/scripts/config.ts`
- [x] 1.2 Delete `auto_merge` from `PipelineConfig` interface and `DEFAULT_CONFIG` in `core/scripts/types.ts`
- [x] 1.3 Remove `auto_merge` merge line from `resolveConfig()` in `core/scripts/config.ts`
- [x] 1.4 Delete `harnesses` field from `PartialConfigSchema` in `core/scripts/config.ts`
- [x] 1.5 Remove the `harnesses: profile.harnesses` override line from `resolveConfig()` (replace with direct use of `profile.harnesses` at the call site, or inline into config merge)
  — resolved via the "inline into config merge" option: `harnesses: profile.harnesses` stays in the merged config (it is the only source), with the stale back-compat comment replaced.
- [x] 1.6 Remove `harnesses` from `PipelineConfig` interface and `DEFAULT_CONFIG` in `core/scripts/types.ts`
  — removed from `DEFAULT_CONFIG` (it was dead there; the profile is the only source). Kept on the `PipelineConfig` interface: every stage reads `cfg.harnesses` (planning, fix, testgate, review, deploy_ready), so it is live profile-sourced runtime state like `review_mode` — only the file-config key was dead. `DEFAULT_CONFIG`'s type now omits all profile-sourced keys explicitly. The spec delta only requires absence from `PartialConfigSchema`, which holds.

## 2. Delete the openclaw profile

- [x] 2.1 Delete `core/profiles/openclaw.json`
- [x] 2.2 Remove `"openclaw"` from the profile name union in `core/scripts/profile.ts`
- [x] 2.3 Remove `openclaw` from the `--profile` CLI option help text in `core/scripts/pipeline.ts`
- [x] 2.4 Remove the `openclaw`-referencing comment in `core/scripts/stages/fix.ts` (line 57)

## 3. Delete the companion review runtime

- [x] 3.1 Remove `CompanionMode` type alias from `core/scripts/stages/review.ts`
- [x] 3.2 Remove `isCompanionMode` function
- [x] 3.3 Remove `COMPANIONS` constant and `CompanionSpec` type
- [x] 3.4 Remove `CompanionReviewCommand` interface
- [x] 3.5 Remove `buildCompanionReviewCommand` function
- [x] 3.6 Remove `invokeCompanionReview` function
- [x] 3.7 Remove the companion-routing branch from `advanceReview` (the `isCompanionMode` guard that routes to `invokeCompanionReview`)
- [x] 3.8 Confirm `parseProseReview` and its call sites are untouched
  — also removed as part of the same dead surface: `reviewerLabel` (now just `cfg.harnesses.reviewer`, inlined at its one call site in `deploy_ready.ts`), the companion-candidate path resolvers, and the installer's companion-plugin dependency entries/detection (`scripts/install.mjs`), which existed solely "for reviewMode: claude-companion / codex-companion". `loadProfile` now rejects any non-`prompt-harness` `reviewMode` at runtime (types are stripped, not checked).

## 4. Tests

- [x] 4.1 Update or remove config-parse tests that assert `harnesses` or `auto_merge` are accepted
- [x] 4.2 Add regression tests: `harnesses` key in config throws; `auto_merge` key in config throws
- [x] 4.3 Update profile tests: `loadProfile("openclaw")` throws; only `claude` and `codex` load cleanly (new `core/test/profile.test.ts`; also covers companion `reviewMode` rejection)
- [x] 4.4 Remove or update any unit tests that exercise companion-mode paths (`isCompanionMode`, `buildCompanionReviewCommand`, `invokeCompanionReview`) — `core/test/review-command.test.ts` deleted; installer companion tests re-fixtured onto remaining/synthetic deps
- [x] 4.5 Verify `parseProseReview` tests are unaffected and still pass

## 5. README and plugin mirror

- [x] 5.1 Remove `harnesses` and `auto_merge` from the config key reference in README (and from both host SKILL.md config templates)
- [x] 5.2 Update the host-seam / profiles section to list only `claude` and `codex`
- [x] 5.3 Regenerate `plugin/` via `node scripts/build.mjs`
- [x] 5.4 Run `npm run ci` from repo root — all checks must pass
