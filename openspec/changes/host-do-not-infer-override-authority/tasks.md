## 1. Status host-guidance signal

- [x] 1.1 Add the closed `host_guidance` enum (`continue` | `recover-parked` | `human-disposition-required` | `operator-merge`) to the status JSON payload as an additive field with `schema_version` still `"1"`, and verify a unit test round-trips each value on a fake issue with no network, git, or subprocess
- [x] 1.2 Derive `host_guidance` from stage, blocked/needs-human park, and existing recover-parked spend extractors on issue comments (fail closed to `human-disposition-required` when spend is unknown), and verify fixtures for unspent residual park, spent fingerprint, unknown spend, and `ready-to-deploy`
- [x] 1.3 Rewrite `needs-human` `next_action` prose so it names recover-parked then STOP and does not instruct an autonomous `--override` / `pipeline override`, and verify `core/test/status-json.test.ts` fails on the pre-change override instruction and passes on the new wording
- [x] 1.4 Keep residual-review-park `next_action` from treating generic `--unblock` or label removal as the host next action, and verify a blocked residual-park fixture emits `recover-parked` or `human-disposition-required` rather than an autonomous override or drop-`blocked` instruction
- [x] 1.5 Classify recover-parked spend by the current park fingerprint (issue + stage + keys from status-available review evidence), fail closed when that fingerprint cannot be derived, and verify a previously spent same-stage park followed by a distinct residual park projects `recover-parked`

## 2. Operation surface and generated CLI

- [x] 2.1 Change the `OPERATION_SURFACE` override description to operator-supplied or explicitly approved exact disposition, and verify the rendered SKILL verb table and a catalog unit assertion include that qualifier
- [x] 2.2 Align co-located command-docs / CLI-reference metadata for `override` with the same operator-supplied wording, regenerate `docs/cli.md`, and verify `scripts/generate-docs.mjs --check` (or `docs:check`) passes and the override summary no longer reads as an ordinary autonomous host command

## 3. Blocker recipes

- [x] 3.1 Update every `BLOCKER_RECIPES` entry that prints an override command (`needs-human`, `human-decision-required`, and any other hit) so the example is labeled the human decision path, names `pipeline recover-parked` as recovery-first on residual-park kinds, and is not host authority to execute, and verify recipe snapshot tests fail without the qualifier and pass with it
- [x] 3.2 Leave non-override-bearing recipes unchanged, and verify kinds such as `ci-exhausted` and `review-findings` still do not present review override as the primary unblock verb

## 4. Generated host SKILLs

- [x] 4.1 Extend `renderHostSkill` Authority text so `pipeline override` is operator-supplied or explicitly approved and the host must not invent the disposition, and verify all four generated SKILLs stay byte-identical after `node scripts/build.mjs`
- [x] 4.2 Add compact follow/terminal residual-park text: `pipeline recover-parked <N>` at most once per fingerprint; if still parked, STOP and notify; never invent override or remove `blocked`; do not invoke recover-parked from inside `pipeline train`, and verify `core/test/host-skill.test.ts` fails if any host omits that rule
- [x] 4.3 Keep the compact park rule out of a per-kind recipe essay, and verify the SKILL still forbids follower merge and still lists merge/ship as operator-authorized launch surfaces

## 5. Class-level regression guards

- [x] 5.1 Add a host-neutral test that fails if any of Claude, Codex, Grok, or OpenCode generated SKILLs, or a fresh `renderHostSkill` result, makes inferred override the autonomous next action, and verify a single-host-only assertion is not sufficient
- [x] 5.2 Confirm existing recover-parked eligibility tests still refuse HIGH/CRITICAL/security/authority auto-override and still allow stale/DNR/below-high reflow, and verify those tests remain green with no eligibility edits
- [x] 5.3 Confirm `pipeline override` still records a governed disposition and auto-resumes when the operator supplies the exact `"<key>: <reason>"`, and verify existing override-governance tests stay green without a new host-identity refuse path

## 6. Packaging and CI

- [x] 6.1 After `core/` edits run `node scripts/build.mjs`, commit the four generated host SKILLs if they changed, and verify `node scripts/build.mjs --check` passes
- [x] 6.2 Run `openspec validate host-do-not-infer-override-authority` and `openspec validate --all`, and verify both exit 0
- [x] 6.3 Run `npm run ci` from the repo root, and verify the full gate passes
