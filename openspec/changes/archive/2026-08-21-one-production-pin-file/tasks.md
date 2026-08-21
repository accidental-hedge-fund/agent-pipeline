## 1. Supervisor SKILL and env.example

- [x] 1.1 Confirm `examples/supervisor/hermes/SKILL.md` does not default `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`; remove that default if present; verify `rg` on the SKILL finds no Hermes-state pin default
- [x] 1.2 Confirm `examples/supervisor/hermes/env.example` does not document a second live pin path; if the var is shown, set it to the control-checkout pin; verify `rg` on `env.example` finds no Hermes-state pin path
- [x] 1.3 Add a hermetic unit test that reads the in-repo SKILL and `env.example` (and any product-owned generated copy) and fails if either defaults or documents the Hermes-state pin path; verify the test fails when that default is injected and passes on the current files

## 2. Factory-plane doctor split-pin fail

- [x] 2.1 Add an additive factory-plane doctor check (stable `install:` id) that fails when `AGENT_PIPELINE_PRODUCTION_PIN` is a different readable file from `$REPO_DIR/.agent-pipeline/production-engine-pin.json` and `version` or `git_sha` disagree; verify a unit test with env pin `1.39.6` vs control pin `1.39.7` returns `"fail"` (not `"warn"` or `"pass"`)
- [x] 2.2 Cover same-path / unset env / matching identity / non-factory skip in the same hermetic suite; verify unset env does not fail for split-pin disagreement and non-factory doctor skips
- [x] 2.3 Include remediation that names both pin paths and instructs unset-or-point-at-control-pin; verify the fail result includes both paths
- [x] 2.4 Resolve the doctor check's compared path with the same override → env → control order as `engine-promote`; verify a hermetic test fails (not skip/pass) for divergent `production_engine_pin_path` both when the env is unset and when the env points at the control-checkout pin

## 3. Promote single-write

- [x] 3.1 Confirm `engine-promote` writes only `productionPinPath` (override → env → control-checkout pin) and does not write a Hermes-state copy; verify a hermetic promote success records exactly one pin write
- [x] 3.2 Add a regression test that fails if a successful promote also writes `~/.local/state/hermes-factory/production-engine-pin.json`; verify the test injects file writes and uses no real network, git, or subprocess

## 4. Tugboat unset export

- [x] 4.1 Keep Tugboat `export_factory_production_pin` preserve-if-set (#1127) and default-to-control-pin when unset; verify existing tugboat tests still pass
- [x] 4.2 Add or extend a hermetic test that an unset env still exports `$REPO_DIR/.agent-pipeline/production-engine-pin.json` when a Hermes-state pin file exists on the host; verify Tugboat does not bind the Hermes-state path solely because that file exists

## 5. Docs

- [x] 5.1 Update supervisor / ship-milestone / hermes-supervisor-deployment docs so they do not document a second live pin path; verify `rg 'hermes-factory/production-engine-pin'` under `docs/` and `examples/supervisor/` matches only historical or forbidden-path language
- [x] 5.2 Note that v1.40.1 packaging MAY template env but MUST NOT reintroduce a second pin; verify the note exists in the supervisor or pin docs that packaging will read

## 6. Packaging and gate

- [x] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change; verify `node scripts/build.mjs --check` exits 0
- [x] 6.2 Run `openspec validate one-production-pin-file` and `npm run ci` from the repo root; verify both are green
