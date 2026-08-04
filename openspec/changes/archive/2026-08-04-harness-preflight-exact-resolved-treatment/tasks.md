## 1. Preflight request surface and absolute executable resolution

- [x] 1.1 Define the production preflight-on-invoke input shape (exact resolved adapter, role, model, effort, sandbox/tool policy, materialized prompt) additive to existing `AdapterRequest` / invoke options without breaking doctor call sites
- [x] 1.2 Implement absolute executable resolution for PATH-declared adapter commands using injectable deps (no real subprocess in unit tests); record absolute path when resolution succeeds
- [x] 1.3 Wire shared once-per-run version/binary probe (`cli-version-probe`) into the production preflight path; do not add a second always-on per-call version exec
- [x] 1.4 Unit-test resolution success/failure and cache reuse between preflight and fingerprint consumers

## 2. Production invoke choke point

- [x] 2.1 Implement a single production preflight-before-invoke helper that runs #779 prompt-size check, absolute executable readiness, role eligibility, and `adapter.preflight` with the exact resolved request
- [x] 2.2 Call the helper from `harness.invoke` (and any other production local-CLI spawn entry that must not bypass it) **before** `buildInvocation` / spawn
- [x] 2.3 On preflight failure, return a structured failed harness result (or equivalent) without spawn and without harness fallback or ambient model substitution
- [x] 2.4 Injected-deps tests: implementer and reviewer roles each pass distinct model/effort/sandbox values and assert the preflight request received those exact values

## 3. Capability refusal matrix and typed remediation

- [x] 3.1 Cover refusal before spawn for unsupported model, unsupported effort, unsupported sandbox/tool policy, oversize/unknown prompt limit, and missing executable (distinguishable classes)
- [x] 3.2 Preserve missing-CLI vs unauthenticated vs headless-unavailable distinguishability from existing adapter preflight vocabulary
- [x] 3.3 Project preflight failures into #760-compatible typed reason / `HumanInterventionKind` (and existing blocker emitters as applicable) with operator remediation text
- [x] 3.4 Regression: synthetic registered/compatibility adapter failures produce bounded diagnostic quality comparable to built-in path (class + message, no secrets)

## 4. Detached PATH parity

- [x] 4.1 Ensure detach launch packing preserves harness-discovery PATH equivalence with foreground (or packs resolved absolute executable paths)
- [x] 4.2 Record absolute executable for run/probe consumers when resolved at launch or preflight time
- [x] 4.3 Injected-deps regression: stripped detach PATH without absolute packing fails the parity assertion; packing that preserves discovery passes

## 5. Fingerprint consumption and no dual probes

- [x] 5.1 Thread preflight-produced absolute path and cached `cliVersion` into treatment fingerprint / `AdapterProbe` consumers
- [x] 5.2 Test that fingerprint accounting does not spawn an independent version process when the shared cache is warm
- [x] 5.3 Confirm version-drift remains fail-soft (warn without block) while missing CLI remains blocking

## 6. Docs, mirror, and CI

- [x] 6.1 Document operator-visible difference between doctor run-start checks and mandatory production preflight-on-invoke (only if host/skill/config docs already discuss doctor vs invoke)
- [x] 6.2 After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change
- [x] 6.3 Run `npm run ci` from repo root and fix failures until green
- [x] 6.4 Run `openspec validate harness-preflight-exact-resolved-treatment` and keep the change valid through implementation
