## 1. Config layer

- [ ] 1.1 Add `harness_sandbox: boolean` to `PipelineConfig` type in `core/scripts/types.ts`; set `DEFAULT_CONFIG.harness_sandbox = false`
- [ ] 1.2 Add `harness_sandbox: z.boolean().optional()` to `PartialConfigSchema` in `core/scripts/config.ts`

## 2. Harness invocation

- [ ] 2.1 Add `sandbox?: boolean` field to `InvokeOptions` in `core/scripts/harness.ts`
- [ ] 2.2 In `invoke()`, update the `harness === "claude"` branch: emit `--permission-mode default` when `opts.sandbox` is `true`, otherwise emit `--permission-mode bypassPermissions` (current behaviour)

## 3. Call-site wiring

- [ ] 3.1 Audit every `invoke()` call in `core/scripts/stages/` and `core/scripts/harness.ts`; pass `sandbox: cfg.harness_sandbox` for implementer/fix invocations (review invocations are unaffected — leave `sandbox` absent/false there)

## 4. Tests

- [ ] 4.1 Unit test: `invoke()` with `sandbox: true` and harness `"claude"` produces args containing `--permission-mode default` and NOT `bypassPermissions`
- [ ] 4.2 Unit test: `invoke()` with `sandbox: false` (or absent) and harness `"claude"` produces args byte-identical to the current production invocation
- [ ] 4.3 Unit test: `invoke()` with `sandbox: true` and harness `"codex"` produces args identical to `sandbox: false`
- [ ] 4.4 Config test: `resolveConfig()` with `harness_sandbox: true` parses without error and returns `harness_sandbox === true`
- [ ] 4.5 Config test: `resolveConfig()` with `harness_sandbox` absent returns `harness_sandbox === false`
- [ ] 4.6 Config test: `resolveConfig()` with `harness_sandbox: "yes"` throws a validation error

## 5. Mirror & CI

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate `plugin/`; commit `plugin/` alongside `core/` changes
- [ ] 5.2 Run `npm run ci` from repo root; confirm all tests pass and mirror check is green
