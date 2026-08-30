## 1. Doctor pass-copy honesty

- [ ] 1.1 Add a unit test that drives assigned-harness doctor checks through the injectable deps seam with a fake preflight ok result, and verify it fails while pass detail, check description, or JSON `reason` contain `authenticated` / `verified authentication` (no real subprocess or network).
- [ ] 1.2 Change assigned-harness pass detail, check description, and JSON `reason` to credentials / login-status present, keep `unauthenticated` fail distinct from missing-CLI, and verify the test in 1.1 passes and default doctor still makes no model call.

## 2. Implementer smoke without lean

- [ ] 2.1 Add a unit test that inspects the injected implementer `invokeSmoke` options and a fake that can commit only when lean is absent, and verify both fail while implementer smoke still passes `lean: true`.
- [ ] 2.2 Stop passing lean / tool-disabling for implementer-role smoke (reviewer MAY stay lean), and verify the tests in 2.1 pass and reviewer mutation-fail behavior is unchanged.

## 3. Smoke failure evidence artifact

- [ ] 3.1 Define the typed per-treatment failure artifact (`pipeline/harness-smoke-failure@1`) with stdout, stderr, before/after porcelain, HEAD/log, and exit / timeout / preflight fields, and verify a schema/unit fixture rejects missing required fields.
- [ ] 3.2 On spawn, trailer-miss, contract, reviewer-mutation, telemetry, and unexpected-throw failures after scratch create, write one sanitized bounded artifact before cleanup, put path and digest on the human summary and `--json` record, and verify a trailer-miss fixture calls write before delete and still status-fails if write throws.
- [ ] 3.3 Run captured stdout/stderr through the existing secret-redaction / injection-denylist pass with head/tail bounds, and verify a secret-shaped token does not appear in the persisted artifact bytes.

## 4. Typed environment-auth classification

- [ ] 4.1 Honor `preflight_reason_code=environment-auth` in harness failure classification before `spawn_error` / non-zero-exit → `harness-contract`, and verify a fixture with that reason code projects to durable class `environment-auth` (theme `environment-auth`, recipe `verify_authentication`) not `workflow-engine-defect`.
- [ ] 4.2 Prefer structured provider status after spawn and accept only the closed allowlist (including JSON `error.code` `refresh_token_invalidated` and structured HTTP 401 on that object), and verify a revoked-token fixture themes `environment-auth` while `please log in` prose with no allowlisted field stays on the existing mechanical mapping.
- [ ] 4.3 Confirm `DurableBlockerClass` / stop-theme enums gain no new member, and verify exhaustive classifier tests still compile against the existing set.

## 5. FRG product-class honesty

- [ ] 5.1 Add unit coverage that `classifyFrgBlocker("environment-auth")` is `product-class` and that a scored pack item with that theme increments product-class not `engine_class_count`, and verify the tests fail if that theme is mapped to `engine-class`.

## 6. Out of scope guards, mirror, and CI

- [ ] 6.1 Leave Codex `resolved_model` and `#1272` salvage publication unchanged, and verify no task in this change edits those paths except comments that say they are out of scope.
- [ ] 6.2 After any `core/` edits, run `node scripts/build.mjs` and include regenerated overlay/catalog in the same commit; verify `node scripts/build.mjs --check` passes.
- [ ] 6.3 Run `openspec validate doctor-auth-honesty-and-environment-auth` then `npm run ci` from the repo root, and verify both are green.
