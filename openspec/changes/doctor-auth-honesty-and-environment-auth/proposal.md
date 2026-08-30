## Why

`pipeline doctor` on v1.39.13 reported Codex as authenticated, then a durable run died in eight seconds on a revoked refresh token themed `workflow-engine-defect`. The same host's `--harness-smoke` implementer treatments failed with "no new commit with required trailers" while the same adapter committed in production, and the stored doctor result captured no stdout, stderr, or scratch git state. An operator cannot trust default doctor, cannot use `--harness-smoke` as a gate, and cannot diagnose either failure from stored evidence. This is engine dogfood: the next identical fault must hit shared classifier, doctor copy, smoke invoke policy, and FRG product-class law — not a new mole issue.

## What Changes

- Default `pipeline doctor` stays model-free. A passing assigned-harness check SHALL report installed credentials or login-status present. It SHALL NOT say the harness is authenticated or that authentication is verified. Live proof stays `--harness-smoke`.
- Implementer `--harness-smoke` SHALL NOT use the tool-disabling lean invoke mode. Reviewer smoke MAY stay lean because it is read-only.
- On every harness-smoke assertion failure, before scratch cleanup, doctor SHALL write one bounded, sanitized, typed per-treatment artifact (stdout, stderr, before/after porcelain, HEAD/log, exit, timeout, preflight). Human and JSON results SHALL include that artifact's location and digest.
- Provider authentication is a typed harness signal. Honor `preflight_reason_code=environment-auth`. After spawn, prefer structured provider status and permit only exact allowlisted compatibility markers (including `refresh_token_invalidated` / harness 401). Do not classify arbitrary stderr prose.
- Those signals SHALL project to the existing durable class `environment-auth` (no new theme string), recover through `verify_authentication`, and score as FRG **product-class**, not engine-class `workflow-engine-defect`.
- Codex `resolved_model` telemetry and `#1272` salvage publication stay out of scope.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `doctor-preflight`: Passing assigned-harness checks report credentials / login-status present. They MUST NOT claim verified authentication. Default doctor remains model-free.
- `doctor-harness-smoke`: Implementer smoke does not use lean/tool-disabling. Every assertion failure writes a bounded sanitized per-treatment artifact before scratch cleanup. Text and JSON results name the artifact location and digest.
- `cli-harness-adapters`: Provider authentication is a typed harness signal. Preflight `unauthenticated` / `preflight_reason_code=environment-auth` stay distinct. After spawn, adapters surface structured provider auth status when the CLI emits it; classifiers MAY use only exact allowlisted compatibility markers as a fallback.
- `autonomous-recovery-controller`: Harness 401 / `refresh_token_invalidated` / unauthenticated preflight reason map to `environment-auth`, not `harness-contract` → `workflow-engine-defect`. Recovery stays `verify_authentication`. No new theme string.
- `factory-reliability-gate`: An `environment-auth` durable theme is a product-class FRG scenario, not engine-class.

## Impact

- `core/scripts/stages/doctor.ts` pass copy and check description for assigned harnesses.
- `core/scripts/stages/harness-smoke.ts` implementer invoke options, failure-artifact write, JSON/summary fields.
- `core/scripts/escalation-classify.ts` / `stage-diagnostic.ts` / invoke consumers: honor `preflight_reason_code` and post-spawn typed auth signals before `harness-contract`.
- Adapter parse path for structured provider status; allowlisted marker table is closed and tested.
- FRG `classifyFrgBlocker` scenario coverage for `environment-auth` as product-class.
- Unit tests via existing `DoctorDeps` / smoke / classifier seams. No real network, git, or subprocess in unit tests.
- After any `core/` edit: `node scripts/build.mjs` in the same commit.

## Acceptance criteria

- [ ] Default `pipeline doctor` (no `--harness-smoke`) still makes no model call. A passing assigned-harness check's human summary and JSON `reason` say credentials or login-status are present. They do not contain "authenticated" or "verified authentication".
- [ ] The same check still fails as `unauthenticated` when adapter preflight reports that class, distinct from missing-CLI and unsupported-setting.
- [ ] Implementer `--harness-smoke` invoke does not pass lean / tool-disabling. A fake implementer that can commit only when tools are enabled produces a trailer-bearing commit and the treatment passes.
- [ ] A fixture that reproduces today's lean-disabled implementer still fails until lean is dropped (the test bites).
- [ ] On spawn failure, missing trailers, contract failure, reviewer mutation, or telemetry failure, doctor writes one sanitized artifact before deleting the scratch repo. The artifact contains stdout, stderr, before and after porcelain, HEAD/log, and exit / timeout / preflight fields. Human summary and `--json` include its path and digest.
- [ ] A harness result with `preflight_reason_code=environment-auth` projects to durable class `environment-auth` and recovery recipe `verify_authentication`. It does not become `harness-contract` or `workflow-engine-defect`.
- [ ] After spawn, structured provider status for revoked/invalid session, or an exact allowlisted marker such as `refresh_token_invalidated`, projects the same way. Stop theme is `environment-auth` (existing string).
- [ ] Non-zero harness exit whose stderr only contains unallowlisted prose (for example "please log in") does **not** become `environment-auth`. It stays the existing mechanical mapping.
- [ ] FRG `classifyFrgBlocker("environment-auth")` is `product-class`. A fixture that would score the same incident as `engine-class` fails.
- [ ] No new `DurableBlockerClass` / stop-theme string is added. Codex `resolved_model` and `#1272` salvage publication are unchanged.
- [ ] Unit tests inject deps and perform no real network, git, or subprocess calls. `openspec validate doctor-auth-honesty-and-environment-auth` and `npm run ci` pass.
