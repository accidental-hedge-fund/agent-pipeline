## Why

`pipeline factory-release prepare` exists (#953) but does not start a pack
loop. It writes a pack-instance stub with `loop_run_id: null`, scans for a
pre-bound `factory-release-binding.json`, and otherwise returns
`missing_generator` / `pack_loop_missing`. That is why 1.34+ ship could not
auto-produce genuine Factory Reliability Gate (FRG) evidence (Hermes session
`20260810_155817_8e519c`; parent #1035). Hybrid v2 scoring now exists on
base (#1036). The generator still does not start the candidate pack loop
that scoring requires.

This is a **class** change to the durable factory-release prepare path. It
is not a path-local mole for one release. After this change, the next
identical "prepare exists but no bound pack loop started" fault uses the
same start/resume + bind + score sequence. It does not need a new mole
issue.

## What Changes

- **Default start/resume of a request-bound pack loop.** First
  `pipeline factory-release prepare --request <abs.json> --json` for a
  post-1.33 version SHALL create or reuse `factory-gate` pack issues from
  `frg-packs/factory-gate-v1/templates/` (minimum item count per manifest),
  dispatch `pipeline loop --engine-track candidate` (work-list or
  `factory-gate` label) with `factory-release-binding.json` bound to request
  fingerprint + candidate SHA + version + manifest, persist `loop_run_id`
  on the pack instance, and return a machine-readable in-progress /
  awaiting status. It SHALL NOT invent `pass` or `status: "complete"`.
- **Idempotent re-invoke.** A second call with the same request SHALL
  resume the same bound `loop_run_id`. It SHALL NOT start a second unbound
  pack. It SHALL NOT adopt the newest unbound `factory-gate` loop.
- **Terminal scoring through the existing scorer.** When the bound loop is
  terminal, prepare SHALL score with `factory-gate --for <ver> --from-run
  <id>` (or the in-process equivalent). It SHALL NOT pass a synthetic
  `--observations` file. Hybrid v2 scoring from #1036 applies
  (required-live from the candidate pack loop; closed Layer A-allowed TAP
  hashes on the same candidate SHA).
- **Release-eligible `latest.json` only on genuine pass.**
  `.agent-pipeline/frg/<ver>/latest.json` with `pass: true` is written only
  when the scorer produces a genuine release-eligible pass. Fail stays
  fail. Prepare SHALL NOT invent pass to unblock attestation or
  `runRelease`.
- **No merge / tag / promote / skip-frg authority.** Prepare still never
  merges, tags, promotes a production pin, or flips Tugboat `--skip-frg`.

**BREAKING** for callers that treated first-call `pack_loop_missing` /
`missing_generator` as the durable "bind a loop yourself" contract. After
this change, a missing pre-bound loop is a start/resume signal, not a
terminal generator defect.

## Acceptance Criteria

- [ ] First `factory-release prepare --request <abs.json> --json` for a
      post-1.33 version with no pre-existing bound loop **dispatches** a
      request-bound candidate pack loop (unit test with an injected loop
      start seam). The JSON result is in-progress or awaiting. It is not
      `pass: true` and not `status: "complete"`.
- [ ] That first call creates or reuses `factory-gate` pack issues from
      `frg-packs/factory-gate-v1/templates/` and meets the manifest
      minimum item count. The pack instance persists a non-null
      `loop_run_id`.
- [ ] The dispatched loop carries `factory-release-binding.json` bound to
      request fingerprint, candidate SHA, target version, and manifest
      identity, and is started with `--engine-track candidate` (work-list
      or `factory-gate` label).
- [ ] A second call with the same request resumes the same `loop_run_id`.
      It does not start a second unbound pack.
- [ ] An unbound newest `factory-gate` loop is **not** adopted as evidence
      or as the resumed run.
- [ ] When the bound loop is terminal, the score path invokes
      `factory-gate --for <ver> --from-run <id>` (or the in-process
      equivalent) and does **not** pass `--observations`. Hybrid v2
      scoring from #1036 applies.
- [ ] Release-eligible `.agent-pipeline/frg/<ver>/latest.json` with
      `pass: true` is written only on a genuine scorer pass. A fail
      result stays `pass: false` and does not unlock
      `status: "complete"`.
- [ ] Prepare still never merges, tags, promotes a pin, or flips Tugboat
      `--skip-frg`.
- [ ] Unit tests bite the start, resume, unbound-refusal, and no-
      `--observations` cases and fail without the production change.
      Tests inject I/O; they make no real network, git, or subprocess
      calls.
- [ ] `plugin/` is regenerated after any `core/` edit. `npm run ci` is
      green.

## Capabilities

### New Capabilities

<!-- None. This extends the existing factory-release prepare path. -->

### Modified Capabilities

- `factory-reliability-gate`: Durable post-1.33 FRG generation SHALL
  start or resume a request-bound `factory-gate` pack loop instead of
  failing `missing_generator` / `pack_loop_missing` when no pre-bound
  loop exists. Terminal scoring SHALL use `factory-gate --for --from-run`
  with no synthetic `--observations`. Release-eligible `latest.json`
  `pass: true` is written only on a genuine pass.
- `release-sub-command`: The candidate-native
  `pipeline factory-release prepare` first call for a post-1.33 request
  SHALL dispatch or resume that bound pack loop and return in-progress /
  awaiting. Re-invoke is idempotent on the same `loop_run_id`. The
  command still grants no merge, tag, pin, install, or `--skip-frg`
  authority.

## Impact

- **Specs:** deltas on living `factory-reliability-gate` and
  `release-sub-command`. The two-call attestation protocol stays; a
  pack-loop start/resume phase is inserted before unsigned artifacts
  can be structurally eligible.
- **Code (implementation, not this proposal step):**
  `core/scripts/factory-release-prepare.ts` (wire the existing unused
  `startBoundPackLoop` seam as the production default; persist
  `loop_run_id`; return in-progress while the bound loop is not
  terminal), pack issue create/reuse from
  `core/scripts/frg-packs/factory-gate-v1/templates/` via
  `renderFrgPackIssues`, loop dispatch with `--engine-track candidate`,
  terminal score through `runFactoryGate` / `--from-run` with no
  `--observations`. Tests in `core/test/factory-release-prepare.test.ts`
  (and related). Regenerate `plugin/` after core edits.
- **Docs:** `docs/factory-reliability-gate-runbook.md` and
  `FACTORY_RELEASE_PREPARE_HELP` so first-call behavior is start/resume,
  not "bind a loop yourself."
- **Depends on:** #1036 (hybrid v2 scoring on base). Parent tracker
  #1035.
- **Does not:** change Tugboat default / `--skip-frg`; auto-tag or pin
  `no-frg-*`; accept fabricated observations; score a product milestone
  as FRG; add merge/tag/promote/install authority; add live process-kill
  or forge-5xx injection.
