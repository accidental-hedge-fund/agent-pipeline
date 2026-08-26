## Why

Runnable repositories still fill missing `harnesses.implementer` / `harnesses.reviewer` values from the launcher's active profile. That lets an outer host choose live stage workers when `.github/pipeline.yml` is absent or partial. Repository configuration must be the execution-policy boundary, and a missing declaration must fail before any work starts.

## What Changes

- **BREAKING:** Every repo-bound command that resolves pipeline configuration for execution requires `.github/pipeline.yml` with both `harnesses.implementer` and `harnesses.reviewer`. Missing file, missing `harnesses` block, or either missing role fails closed with an actionable diagnostic. The failure occurs before a worktree, GitHub mutation, or harness invocation.
- **BREAKING:** The active profile no longer selects either live harness role for a runnable repository. Profiles remain compatibility/bootstrap metadata (invocation strings, review mode, presentation defaults, conventions filename) until a later configuration-interface refactor. This change does not rename or remove profiles.
- `review_harness` remains a structured overlay for reviewer model, effort, and prompt-delivery. It does not replace `harnesses.reviewer`. `review_harness` without `harnesses.reviewer` is a partial policy and fails closed. Agreeing declarations still apply structured settings; conflicting commands still fail naming both keys and values.
- Setup and dependency-free introspection keep their documented behavior: `pipeline init` may create `.github/pipeline.yml`; `--version` / `-V` and `path` do not require the file.
- Direct CLI, every installed host launcher, and `single`, `loop`, `train`, and `ship` share the same enforcement through shared configuration resolution. Launchers MUST NOT inject live implementer or reviewer workers.
- Schema descriptions, init/sync scaffold comments, generated config docs, and tests cover complete, absent, and partial policy. They MUST NOT document profile fallback for live roles.

Out of scope: OMP installation and its native command surface (#1235); Node bootstrap and Node engine resolution (#1236); renaming or removing profiles; selecting provider/model values beyond existing repository configuration.

## Capabilities

### New Capabilities
- `required-repository-harness-roles`: fail-closed execution-policy gate that requires a repository-declared implementer and reviewer before runnable work; exemptions for init and dependency-free introspection; shared enforcement through configuration resolution for CLI, host launchers, single, loop, train, and ship; actionable diagnostics that name the missing file or role.

### Modified Capabilities
- `configurable-harness-roles`: optional/partial `harnesses` blocks with per-role profile fallback become invalid for execution; both keys are required; live role provenance is repository config, not the profile.
- `pipeline-configuration`: execution-policy resolution no longer treats an absent file as `DEFAULT_CONFIG` plus profile harnesses; repository config is authoritative for live workers.
- `configurable-review-harness`: `review_harness` alone no longer supplies the live reviewer; profile-fallback scenarios for a missing reviewer declaration are removed.
- `cross-host-profiles`: the requirement that the profile (not file config) selects live per-role harnesses is removed; profiles no longer supply live workers for a runnable repository.
- `init-command`: a freshly scaffolded `.github/pipeline.yml` writes both role keys as active required values and does not document profile fallback for live workers.
- `config-validate-command`: missing file (already an error), missing `harnesses` block, and either missing role are validation errors with actionable diagnostics.

## Impact

- **Config resolution:** `core/scripts/config.ts` (`resolveConfig`, `resolveHarnessRoles`, schema descriptions, init/sync scaffold for the `harnesses` block). Execution callers fail closed; `init` remains able to create the file.
- **CLI / coordinators:** every path that resolves config for execution — including `advance`, `single`, `loop` item dispatch, `train`, `ship`, merge surfaces, and host launchers — hits the same gate before worktree creation, GitHub mutation, or harness spawn.
- **Docs / schema:** `pipeline config schema`, `pipeline config validate`, `pipeline config sync`, generated `docs/config.md`, SKILL.md examples, and scaffold comments stop describing live-role profile fallback.
- **Tests:** unit tests with injected fakes cover complete, absent, and partial policy; init/--version/path exemptions; host-independent resolution; no real network, git, or subprocess.
- **Packaging:** regenerate `plugin/` via `node scripts/build.mjs` in the same commit as any `core/` edit.

## Acceptance Criteria

- [ ] `resolveConfig()` for execution fails when `.github/pipeline.yml` is absent, naming the missing file and directing the operator to `pipeline init` plus both required role keys.
- [ ] `resolveConfig()` for execution fails when the file exists but omits `harnesses`, `harnesses.implementer`, or `harnesses.reviewer`, naming each missing key and stating that the active profile does not fill live workers.
- [ ] The failure occurs inside shared configuration resolution, before any worktree create/remove, GitHub mutation, or harness `invoke`.
- [ ] A file that declares both `harnesses.implementer` and `harnesses.reviewer` resolves those exact values under the `claude` profile and under the `codex` profile.
- [ ] Changing the active profile does not change the resolved live implementer or reviewer when both repository keys are set.
- [ ] `review_harness` without `harnesses.reviewer` fails closed as a partial declaration. Agreeing `review_harness` and `harnesses.reviewer` still apply structured model/effort/prompt-delivery. Conflicting commands still fail naming both keys and values.
- [ ] `pipeline init` succeeds when the file is absent and writes both role keys as active values. `--version` / `-V` and `path` succeed without the file.
- [ ] Direct CLI, each installed host launcher, and `single`, `loop`, `train`, and `ship` use the same `resolveConfig()` gate. Launchers do not inject live harness roles.
- [ ] `pipeline config validate` reports missing file and missing/partial harness roles as errors. Schema, scaffold comments, and generated config docs no longer describe profile fallback for live roles.
- [ ] Unit tests cover complete, absent, and partial policy and prove the test would fail without the gate. `npm run ci` passes, including `node scripts/build.mjs --check` and `openspec validate --all`.
