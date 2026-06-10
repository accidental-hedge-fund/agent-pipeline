## 1. Remove dead config keys

- [ ] 1.1 Delete `auto_merge` field from `PartialConfigSchema` in `core/scripts/config.ts`
- [ ] 1.2 Delete `auto_merge` from `PipelineConfig` interface and `DEFAULT_CONFIG` in `core/scripts/types.ts`
- [ ] 1.3 Remove `auto_merge` merge line from `resolveConfig()` in `core/scripts/config.ts`
- [ ] 1.4 Delete `harnesses` field from `PartialConfigSchema` in `core/scripts/config.ts`
- [ ] 1.5 Remove the `harnesses: profile.harnesses` override line from `resolveConfig()` (replace with direct use of `profile.harnesses` at the call site, or inline into config merge)
- [ ] 1.6 Remove `harnesses` from `PipelineConfig` interface and `DEFAULT_CONFIG` in `core/scripts/types.ts`

## 2. Delete the openclaw profile

- [ ] 2.1 Delete `core/profiles/openclaw.json`
- [ ] 2.2 Remove `"openclaw"` from the profile name union in `core/scripts/profile.ts`
- [ ] 2.3 Remove `openclaw` from the `--profile` CLI option help text in `core/scripts/pipeline.ts`
- [ ] 2.4 Remove the `openclaw`-referencing comment in `core/scripts/stages/fix.ts` (line 57)

## 3. Delete the companion review runtime

- [ ] 3.1 Remove `CompanionMode` type alias from `core/scripts/stages/review.ts`
- [ ] 3.2 Remove `isCompanionMode` function
- [ ] 3.3 Remove `COMPANIONS` constant and `CompanionSpec` type
- [ ] 3.4 Remove `CompanionReviewCommand` interface
- [ ] 3.5 Remove `buildCompanionReviewCommand` function
- [ ] 3.6 Remove `invokeCompanionReview` function
- [ ] 3.7 Remove the companion-routing branch from `advanceReview` (the `isCompanionMode` guard that routes to `invokeCompanionReview`)
- [ ] 3.8 Confirm `parseProseReview` and its call sites are untouched

## 4. Tests

- [ ] 4.1 Update or remove config-parse tests that assert `harnesses` or `auto_merge` are accepted
- [ ] 4.2 Add regression tests: `harnesses` key in config throws; `auto_merge` key in config throws
- [ ] 4.3 Update profile tests: `loadProfile("openclaw")` throws; only `claude` and `codex` load cleanly
- [ ] 4.4 Remove or update any unit tests that exercise companion-mode paths (`isCompanionMode`, `buildCompanionReviewCommand`, `invokeCompanionReview`)
- [ ] 4.5 Verify `parseProseReview` tests are unaffected and still pass

## 5. README and plugin mirror

- [ ] 5.1 Remove `harnesses` and `auto_merge` from the config key reference in README
- [ ] 5.2 Update the host-seam / profiles section to list only `claude` and `codex`
- [ ] 5.3 Regenerate `plugin/` via `node scripts/build.mjs`
- [ ] 5.4 Run `npm run ci` from repo root — all checks must pass
