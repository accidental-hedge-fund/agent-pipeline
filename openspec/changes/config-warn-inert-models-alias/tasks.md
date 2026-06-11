## 1. Read & understand the seam

- [ ] 1.1 Read `core/scripts/config.ts` `resolveConfig` to confirm where `fileConfig.models` and `profile.harnesses` are both available
- [ ] 1.2 Read `core/scripts/types.ts` to confirm the `Harness` type and `PipelineConfig.harnesses` shape
- [ ] 1.3 Read existing config unit tests (e.g. `core/test/config.test.ts`) to understand the test seam and what is already faked

## 2. Implement the warning in config.ts

- [ ] 2.1 After `fileConfig` is validated and `merged` is assembled in `resolveConfig`, add a helper (inline or small private function) that checks each of `models.review`, `models.planning`, and `models.fix`
- [ ] 2.2 For `models.review`: if `fileConfig.models?.review !== undefined` and `merged.harnesses.reviewer === "codex"`, emit `console.warn` with the key, value, role, and reason
- [ ] 2.3 For `models.planning`: if `fileConfig.models?.planning !== undefined` and `merged.harnesses.implementer === "codex"`, emit `console.warn` with the key, value, role, and reason
- [ ] 2.4 For `models.fix`: if `fileConfig.models?.fix !== undefined` and `merged.harnesses.implementer === "codex"`, emit `console.warn` with the key, value, role, and reason
- [ ] 2.5 Confirm that the warning is emitted before the function returns and that no throw or config mutation is introduced

## 3. Unit tests

- [ ] 3.1 Add test: `models.review` set + reviewer=codex → `console.warn` fires with expected substring (key, value, "codex", "ignored")
- [ ] 3.2 Add test: `models.planning` set + implementer=codex → `console.warn` fires
- [ ] 3.3 Add test: `models.fix` set + implementer=codex → `console.warn` fires
- [ ] 3.4 Add test: `models.review` set + reviewer=claude → no warning emitted
- [ ] 3.5 Add test: `models.planning` set + implementer=claude → no warning emitted
- [ ] 3.6 Add test: `models` block absent from fileConfig (all defaults) + harness=codex → no warning emitted
- [ ] 3.7 Add test: `models.review` set but `models.planning` absent + implementer=codex → no warning for `models.planning`
- [ ] 3.8 Confirm each new test fails without the implementation (prove the test bites)

## 4. Verify CI gate

- [ ] 4.1 Run `npm run ci` from repo root; confirm all tests pass and the plugin mirror is in sync (`build.mjs --check` green)
- [ ] 4.2 If `build.mjs --check` fails, regenerate with `node scripts/build.mjs` and re-run `npm run ci`
