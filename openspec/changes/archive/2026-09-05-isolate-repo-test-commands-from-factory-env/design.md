## Context

See `proposal.md` for why. Current law and code (validated in this worktree):

- `runTests` in `core/scripts/testgate.ts` calls `runCapped` with cwd, timeout, `killProcessGroup`, and the `#384` injectable `spawnFn`. It does not pass `opts.env`. `runCapped` therefore omits the spawn `env` key, and the repo test command inherits the full parent environment.
- `runCapped` already supports an additive overlay: `{ ...process.env, ...opts.env }` when `opts.env` is present; when it is absent, spawn carries no `env` key (byte-for-byte harness default; papercut identity uses the overlay).
- Candidate-process guard names are already single-sourced as `CANDIDATE_PROCESS_GUARD_ENV` in `core/scripts/ship-end-candidate.ts`. Factory-control / pin / plane-repo names already exist as `FACTORY_CONTROL_DIR_ENV`, `PRODUCTION_PIN_ENV`, and `FACTORY_PLANE_REPO_DIR_ENV` in `core/scripts/production-engine-pin.ts`. Pack-loop SHA is `PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV`.
- `sanitizeCandidateLoopEnv` in `core/scripts/factory-release-prepare.ts` is a copy-and-delete helper whose denylist is **FRG signing credentials** (`PIPELINE_FRG_ATTESTATION_KEY`, `PIPELINE_FRG_ATTESTATION_KEY_FILE`). That is the wrong set for this defect.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Site symptom:** v1.40.1 FRG pack, issue #1457 test gate under a candidate ship child; launcher/readiness tests resolved temp fixtures through live `REPO_DIR` / factory-control / candidate-engine paths.
2. **Class:** a repo-controlled test-gate subprocess MUST NOT inherit factory topology, candidate-process lease/guard data, or operator merge authority from a ship/candidate parent. Shared surface: `runTests` → `runCapped` spawn env, not a #1457 fixture mole.
3. **Next identical fault:** a new `CANDIDATE_PROCESS_GUARD_ENV` field, or another named factory topology var already on the omitted set, is stripped without a new issue. Drift-guard test fails if the guard object gains a name the omitted set does not include.

## Goals / Non-Goals

**Goals:**

- Child env for the repo test/build command omits the named factory / candidate / merge set and keeps ordinary build inputs.
- Isolation is implemented on the existing `runTests` → `runCapped` path (first holding rung).
- Injectable `spawnFn` regression proves absence + sentinel preservation.
- Controller and harness env contracts stay as they are today.

**Non-Goals:**

- Rewriting harness / implement / review / fix child environments.
- Reusing or widening `sanitizeCandidateLoopEnv` (wrong denylist).
- A new isolation module, config key, or sandbox wrapper.
- Stripping `PATH`, `HOME`, `NODE_*`, `npm_*`, or unrelated CI tokens.
- Changing timeout, process-group kill, capture, or pass/fail semantics.
- Merging inside advance/loop; a second durable scheduler; format-gate env isolation (out of this issue's spawn seam).
- Prefix-matching all `PIPELINE_*` names (too broad; would drop papercut identity and run ids if a later caller reused this helper).

## Decisions

### D1: Isolate only at the repo test-command spawn

**Decision:** `runTests` is the only caller that applies the omitted-name overlay. `invoke` / harness `runCapped` callers keep today's contract.

**Why:** The defect is repo-controlled tests observing ship topology. Harness children are pipeline-controlled and may need parent identity. The issue requires the controller and harness environment to stay unchanged.

**Rejected:** Strip factory env from every `runCapped` spawn. That would change harness children and violate the issue.

**Rejected:** Unset the variables in the controller before `npm run ci`. That is a site mole and would break the ship process itself.

### D2: Reuse `runCapped` `opts.env` overlay; omit undefined keys after merge

**Decision:** `runTests` passes an overlay whose keys are exactly the omitted names, each `undefined`. `runCapped` keeps `{ ...process.env, ...opts.env }` and, when `opts.env` is present, drops keys whose value is `undefined` before spawn so those names are absent from the spawn `env` object. When `opts.env` is absent, spawn still carries no `env` key.

**Why this is the first holding rung:** `opts.env` and `spawnFn` already exist. `{ ...process.env, ...overlay }` does not remove omitted keys unless the overlay sets them to `undefined` **and** undefined keys are dropped (otherwise process.env values remain, or keys sit as `undefined` on the object). Dropping undefined after merge is a one-line correction of the existing overlay, not a new `replaceEnv` / `unsetEnv` API.

**Rejected:** New `opts.unsetEnv` / `envReplace` flags. Extra API for one caller.

**Rejected:** Change overlay to replacement (`env: opts.env` as complete env). Breaks papercut additive identity.

**Rejected:** Copy `process.env`, `delete` keys, pass the copy as `opts.env`. Merge would re-add the deleted keys from `process.env`.

### D3: Derive the omitted set from existing constants; do not reuse `sanitizeCandidateLoopEnv`

**Decision:** Build the omitted-name list in `testgate.ts` from:

| Source | Names |
|--------|--------|
| `Object.values(CANDIDATE_PROCESS_GUARD_ENV)` | every current (and future) candidate-process guard name |
| `FACTORY_CONTROL_DIR_ENV` | `AGENT_PIPELINE_FACTORY_CONTROL` |
| `PRODUCTION_PIN_ENV` | `AGENT_PIPELINE_PRODUCTION_PIN` |
| `FACTORY_PLANE_REPO_DIR_ENV` | `REPO_DIR` |
| `PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV` | `PIPELINE_PACK_LOOP_CANDIDATE_SHA` |
| existing string literals (no constant today) | `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_STARTING_LOCK_PID`, `ALLOW_MERGE` |

A tiny colocated helper (or inline overlay) in `testgate.ts` is enough. Do not add a new module.

**Rejected:** Call `sanitizeCandidateLoopEnv`. That function removes FRG attestation keys only. Widening it would mix two isolation classes (signing credentials vs factory topology) and still miss this issue's names.

**Rejected:** Prefix-strip `PIPELINE_CANDIDATE_PROCESS_*` only, leaving factory names as a one-off. Incomplete class fix; `REPO_DIR` / `ALLOW_MERGE` are the #1457 failure and the merge-authority leak.

### D4: Prove the contract at the existing `spawnFn` seam

**Decision:** Extend `core/test/testgate.test.ts` with a `runTests(..., spawnFn)` test in the same style as the #384 capture-stream fake: capture `options.env`, assert omitted names are not string values, assert a sentinel is preserved. Add a drift-guard that every `CANDIDATE_PROCESS_GUARD_ENV` value is in the omitted set. Do not spawn a real `npm run ci` in the unit test.

**Why:** The issue asks for an injectable spawn regression. `runTests` already forwards `spawnFn` to `runCapped`. Unit tests must not make real network, git, or unconstrained subprocess calls.

The v1.40.1 FRG nested-`npm run ci` outcome is a ship-path consequence of this spawn contract, not a second implementation. Existing timeout / process-group / capture tests remain the regression net for those mechanics.

## Risks / Trade-offs

- [Risk] Dropping undefined keys after merge could change a hypothetical caller that passed `FOO: undefined` expecting the key to remain on the object. → Mitigation: Node already omits undefined env values at exec; papercut only passes defined strings. Existing `runCapped` tests assert added keys and the no-`opts.env` path, not undefined keys.
- [Risk] Over-stripping breaks repo tests that need `PATH` / `HOME` / `NODE_OPTIONS`. → Mitigation: omitted set is a closed named list, not a `PIPELINE_*` prefix.
- [Risk] This repo's own tests still read `process.env.REPO_DIR` when the test gate of a *different* parent is not the caller. → Mitigation: isolation applies to the spawned test process, which is the #1457 failure mode. Tests that already inject `deps.env` stay valid.
- [Risk] Format-gate or eval-gate repo commands still inherit factory env. → Mitigation: out of scope; class surface for this issue is `runTests`. File a follow-up if a later dogfood hit is a different spawn seam.
- [Trade-off] `undefined` overlay plus drop-undefined is slightly less obvious than copy-and-delete, but it is the only overlay that works with the existing merge without a new flag.

## Migration Plan

No migration. Behavior is additive at one spawn site. Rollback is revert of the `runTests` overlay and the `runCapped` undefined-drop.

## Open Questions

None.
