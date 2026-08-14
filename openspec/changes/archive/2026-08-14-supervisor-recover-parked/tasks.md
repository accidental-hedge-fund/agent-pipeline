## 1. Inventory and seams

- [x] 1.1 Confirm park detection labels (`blocked`, `pipeline:needs-human`) and residual review artifacts used at park.
- [x] 1.2 Wire deterministic entrypoints: `tryResumeStaleBlocked` (`stages/stale-blocked-rereview.ts`), `unlink_engine_scratch` recovery action (`pipeline.ts`); document success/failure kinds in deps.
- [x] 1.3 Wire audited override path: `parseOverrideArg` + `runOverride` shared record path / `overrideComment` + governed validation — no label side door.
- [x] 1.4 Confirm structured fields: `ReviewArtifact.blockingFindings` (`key`, `severity`, `title`, `surface`), `findingKey`, category via surface / finding; authority via `human-decision-required` / `isHumanAuthorityBlocker`.
- [x] 1.5 Confirm host generation source: `OPERATION_SURFACE` in `scripts/build.mjs` + `COMMAND_REGISTRY` / `COMMAND_DOCS`; never hand-edit `plugin/`.

## 2. Pure eligibility, fingerprint, result contract

- [x] 2.1 Implement pure `classifyParkedFinding` / residual classification: non-overridable (HIGH/CRITICAL/security/authority/unknown severity) vs eligible (stale/DNR/below-high); prose never consulted.
- [x] 2.2 Implement fingerprint id `(issue, stageId, sorted keys)` + covering-superset spent rule (subset after partial override does not re-grant).
- [x] 2.3 Implement spend sentinel post/extract (`pipeline-recover-parked-spent: v1`); write-before-side-effects under issue-run lock.
- [x] 2.4 Implement override payload builder: key + closed reason `stale`|`DNR`|`below-high`; refuse keyless.
- [x] 2.5 Define `RecoverParkedResult` statuses: `deterministic-cleared` | `recovered` | `still-parked` | `already-spent` | `not-parked` | `fail-closed` + exit code map.

## 3. recover-parked command

- [x] 3.1 Register `recover-parked` in command registry + command-docs; allowedFlags; non-merge; disallowed flags → exit 2 before mutation.
- [x] 3.2 Implement `runRecoverParked` with deps injection: lock → deterministic first → classify at live HEAD → spend marker → eligible overrides only → optional one fix round → re-eval HEAD → re-enter single/advance with `skipRecoverParked` or keep park.
- [x] 3.3 CLI dispatch in `pipeline.ts`; `--json` emits result; no merge/merge-queue path.
- [x] 3.4 Re-read live HEAD before override batch and before re-entry; fail closed if unreadable.
- [x] 3.5 Partial override failure: no keyless audit; no label clear without disposition; fingerprint remains spent.

## 4. Train and outer-host hooks

- [x] 4.1 Train: after park observation post deterministic resume, call `runRecoverParked` once; map result to continue vs hold/STOP; never call override or drop labels.
- [x] 4.2 Docs: `docs/supervisor.md` / ship-path autonomy residual park row → `pipeline recover-parked` once then STOP if still parked.
- [x] 4.3 Add `recover-parked` to `OPERATION_SURFACE`; host entry CLI-only forward; regenerate via `node scripts/build.mjs`.

## 5. Unit tests (injected deps only)

- [x] 5.1 Stale/DNR/below-high → override + re-enter; no backlog restart.
- [x] 5.2 Still-valid HIGH remains parked; no override for that key.
- [x] 5.3 Still-valid CRITICAL remains parked; no override.
- [x] 5.4 `category: security` remains parked; no override.
- [x] 5.5 `human-decision-required` / missing-authority remains parked; no override.
- [x] 5.6 Structured CRITICAL + prose "nit" refuses override.
- [x] 5.7 Same sorted keys after new commit → `already-spent`; no second senior pass.
- [x] 5.8 Partial override leaves HIGH/CRITICAL subset → second invoke does not re-grant senior pass (covering-superset rule).
- [x] 5.9 Scratch-only / stale-SHA → `deterministic-cleared`; no override; no spend.
- [x] 5.10 Extra fix may commit for HIGH/CRITICAL; override of those keys refused; residuals keep park.
- [x] 5.11 Second identical fingerprint → idempotent `already-spent`.
- [x] 5.12 Train hook once-then-hold; no invented override.
- [x] 5.13 Unparked → `not-parked` no mutations; unreadable PR → `fail-closed`.
- [x] 5.14 Disallowed flags exit 2; recover-parked cannot reach merge paths.
- [x] 5.15 Registry lookup + OPERATION_SURFACE / generated host entry presence after build.
- [x] 5.16 All tests deps-injected — no real network/git/subprocess.

## 6. Mirror, validate, CI

- [x] 6.1 `node scripts/build.mjs` after core/host packaging edits; commit `plugin/` when required.
- [x] 6.2 `openspec validate supervisor-recover-parked` (and `--all` as needed).
- [x] 6.3 `npm run ci` green from repo root.
