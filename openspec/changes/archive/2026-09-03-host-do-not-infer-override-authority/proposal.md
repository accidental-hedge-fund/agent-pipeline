## Why

Agent-facing status, operation-surface, blocker recipes, and generated host SKILLs currently present `pipeline override` / `--override` as the autonomous next action for a `needs-human` park. That contradicts the supervisor contract: residual review parks go through `pipeline recover-parked <N>` at most once per park fingerprint, then STOP for an exact human disposition. A production Claude host inferred an override from that guidance; Codex and Grok can execute the same inferred command without a permission classifier. The classifier is not the fix.

## What Changes

- Status `next_action` prose for `needs-human` no longer tells an autonomous host to invoke `--override`. It names recovery-first and human-disposition-required states as distinct outcomes.
- Status JSON gains an additive typed host-guidance signal so hosts do not infer authority from prose. `schema_version` stays `"1"`.
- The canonical operation surface and generated Claude/Codex/Grok/OpenCode SKILLs label `pipeline override` as operator-supplied or explicitly approved. They do not describe it as an ordinary host next action.
- Host follow/terminal guidance states: run `pipeline recover-parked <N>` at most once for the current park fingerprint; if the issue remains parked, STOP and notify; never invent an override key/reason; never drop `blocked`.
- Blocker recipes that print an override command mark it as the human decision path, not host authority to execute it.
- `pipeline override` remains available when the operator supplies or explicitly approves the exact disposition. Governed recording, evidence, expiry, renewal, and auto-resume stay unchanged.
- `recover-parked` eligibility stays unchanged: stale/DNR/below-high may reflow; HIGH/CRITICAL/security/authority never auto-override.
- Train's in-wave RecoverySupervisor recovery remains authoritative. Train still does not auto-invoke `recover-parked`.
- No second lifecycle controller, host-specific state machine, grant schema, or `auto_merge` key. Claude's permission classifier is neither required nor treated as authorization.

Out of scope: bounded engine self-repair for train/ship (`workflow-engine-defect` child Logical Operation). That work needs a separate issue that consumes this typed authority/recovery contract.

## Capabilities

### New Capabilities

- None. This change extends existing status, SKILL, recipe, and override surfaces. It does not add a host lifecycle controller or a second recoverer.

### Modified Capabilities

- `machine-readable-status`: `needs-human` next-action prose and an additive typed host-guidance field distinguish recovery-first from human-disposition-required and never advertise inferred override as the autonomous next action.
- `generated-short-host-skill`: shared Authority and follow/terminal text, plus the `override` verb description, carry the operator-supplied override boundary on all four generated hosts.
- `generated-cli-reference`: generated `docs/cli.md` override summary matches that operator-supplied wording.
- `blocked-recovery-recipes`: recipes that show an override command label it as the human decision path, not host authority.
- `ship-path-autonomy-doctrine`: the existing recover-parked-once-then-STOP rule applies to generated host SKILLs and status output, not only `docs/supervisor.md`.
- `governed-overrides`: recording still requires an operator-supplied or explicitly approved exact disposition; host factual judgment is not authorization.

## Impact

- **Class vs site:** the class is agent-facing next-action/authority guidance that treats an operator command example as host authority to invent and execute `pipeline override`. The Claude Auto classifier incident is one site. The class fix is shared status, catalog, recipe, and SKILL wording plus a typed host-guidance projection. A Claude-only permission tweak is a mole and is incomplete.
- **Reuse first:** extend `deriveNextAction` / `StatusPayload` (additive field, existing `schema_version: "1"` pattern), `OPERATION_SURFACE`, `BLOCKER_RECIPES` snapshots, `renderHostSkill` Authority/follow sections, and recover-parked spend-marker extractors already on issue comments. Do not add a new public verb, store, recoverer, or host state machine.
- **CLI:** no new public verb. `pipeline override` grammar, governance, and auto-resume stay. `pipeline recover-parked` eligibility stays.
- **Tests:** hermetic unit tests inject fakes. They fail if status or any generated host SKILL again makes inferred override the autonomous next action. Recipe snapshots pin the operator-path wording. Recover-parked HIGH/CRITICAL/security/authority refuse tests stay green.
- **Docs / packaging:** after `core/` edits run `node scripts/build.mjs`. Generated SKILLs and `docs/cli.md` must match. `npm run ci` must pass.
- **Sequencing:** consumes #693 (governed override), #1061 (one-pass parked recovery), and the ship-path recover-parked-once doctrine. Engine self-repair for train/ship is a follow-up consumer, not this change.

## Acceptance Criteria

- [ ] `needs-human` status output (prose and JSON `next_action`) does not instruct an autonomous host to invoke `--override` or `pipeline override`.
- [ ] Status JSON distinguishes recovery-first (`recover-parked` not yet spent for the current park fingerprint) from human-disposition-required (spent fingerprint, or true human-authority park) with a typed additive field; `schema_version` remains `"1"`.
- [ ] When recover-parked spend state cannot be determined, status fail-closes to human-disposition-required rather than advertising override.
- [ ] `OPERATION_SURFACE` override description, generated `docs/cli.md`, and all four generated host SKILL verb tables label `pipeline override` as operator-supplied or explicitly approved.
- [ ] Generated host SKILL Authority and follow/terminal text state: recover parked once per fingerprint; if still parked, STOP and notify; never invent an override; never remove `blocked`.
- [ ] A unit test fails if any of the four generated SKILLs omit that boundary or present inferred override as the autonomous next action.
- [ ] `BLOCKER_RECIPES` entries that include an override command state that the command is the human decision path and is not authority for an agent to execute it.
- [ ] `recover-parked` still reflows only stale/DNR/below-high and still refuses HIGH/CRITICAL/security/authority auto-override.
- [ ] `pipeline override` still records a governed disposition and auto-resumes when the operator supplies or explicitly approves the exact key and reason.
- [ ] Train still does not auto-invoke `recover-parked`; in-wave RecoverySupervisor recovery remains the train path.
- [ ] No second lifecycle controller, host-specific state machine, grant schema, or `auto_merge` config key is introduced.
- [ ] `node scripts/build.mjs` and `npm run ci` pass.
