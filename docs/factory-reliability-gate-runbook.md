# Factory Reliability Gate (FRG) — runbook (#723)

**Hard rule:** no release tag and no release PR prepared as ready without a recorded
FRG pass artifact for that version.

```text
No release tag / release PR → ready
  without a recorded Factory Reliability Gate (FRG) artifact for that version.
```

Green `npm run ci` is **necessary but not sufficient**. Two-item pilots and ad-hoc
soaks do **not** substitute unless they run through this driver and produce a
conforming FRG evidence artifact for the target version.

FRG **never** merges PRs, enables auto-merge, or creates git tags (golden rule #4).
After a **release-eligible** pass, FRG **auto-closes** synthetic pack open PRs and
linked open issues **without merging** as post-pass hygiene (#754). Close ≠ merge.

## Two layers (both mandatory)

| Layer | When | What |
|-------|------|------|
| **A. Hermetic** | Every PR that can break composition; always in `npm test` / `npm run ci` | Fake-deps composition tests for capacity, resume, OpenSpec archive coherence, lockfold, docs parity |
| **B. Live** | **Every release** (patch / minor / major) | Multi-item durable `pipeline:loop` against a fixed scenario pack; immutable evidence artifact |

## Numeric thresholds (v1)

| Key | Symbol | Value | Meaning |
|-----|--------|------:|---------|
| `min_clean_ready_to_deploy` | **K** | `2` | Minimum pack items that reach `ready` / ready-to-deploy without an engine-class block |
| `capacity_stress_n` | **N** | `2` | Blocked-retain count the pack must tolerate under low max worktrees without capacity cascade |
| `max_engine_class_rate` | — | `0.25` | Maximum allowed engine-class / classified-blocker rate (strictly greater **fails**) |

Thresholds may tighten over time via this runbook; they remain numeric and checked by
`pipeline factory-gate` / `computeFrgEvidence` in `core/scripts/factory-reliability-gate.ts`.

## Blocker taxonomy

| Bucket | Meaning | Gate effect |
|--------|---------|-------------|
| **engine-class** | Factory defects (capacity cascade, resume strand, archive false-pass, lock dirt at 0 attempts, docs-after-PR, PR supersession bugs, `workflow-engine-defect`, unknown free-form themes) | Counted toward engine-class rate; rate above threshold fails FRG |
| **product-class** | Intentional product failures / out-of-scope product issues injected by the pack | Does not fail FRG by itself |
| **human-authority** | Correct human holds (`missing-authority`, `specification-decision`) | Does not fail FRG by itself |

## Scenario pack inventory

| Scenario id | Layer A | Layer B | Pass criteria |
|-------------|---------|---------|---------------|
| `capacity-blocked-retain` | test | yes | Low max worktrees + blocked retain ≥ N; next eligible item is **not** false-blocked as needs-human solely for capacity |
| `resume-mid-flight` | test | yes | Kill/resume supervisor; every in-flight item has a live next action; no permanent dead `pr_opened` strand |
| `openspec-multi-change` | test | yes | Partial archive / foreign active: archive result and residual still-active check **agree** |
| `implement-lockfile-dirt` | test | yes | Uncommitted lockfile after HEAD advanced is folded/cleaned; no human-block on known lock dirt at 0 attempts |
| `local-docs-parity` | test | yes | Docs/generator checks that fail on CI fail **before** PR open (or before ready-to-deploy) |
| `clean-item-throughput` | test (scoring) | yes | ≥ **K** easy items reach ready without engine-class block |
| `blocker-taxonomy` | test (scoring) | yes | Engine-class rate ≤ max |
| `pr-supersession` | **waiver #729** | yes | Stale second PR for same issue does not remain open after new head |
| `release-plan-row` | **waiver #730** | yes | Release-cut plan-row present or scaffolded; tag path documented |
| `empty-depends-on-stack-honesty` | test | yes | Empty `depends_on` items that still stack OpenSpec across branches → **warn** or **fail** |

The pack uses a **dedicated** synthetic / labeled work-list (`factory-gate` label or
reliability selector) — **not** the full product milestone backlog.

### Layer A waivers (explicit; no silent gaps)

| Scenario id | Tracking issue |
|-------------|----------------|
| `pr-supersession` | #729 |
| `release-plan-row` | #730 |

## Evidence schema

Machine-readable JSON (`schema_version: 1`):

| Field | Type | Meaning |
|-------|------|---------|
| `schema_version` | number | Always `1` for this contract |
| `version` | string | Release version `X.Y.Z` (no leading `v`) |
| `run_id` | string | Unique FRG run id (non-empty) |
| `pass` | boolean | Overall machine-checked outcome |
| `scenarios` | array | Per-scenario `{ id, status, detail, observed?, threshold? }` |
| `scoreboard` | object | `item_count`, `ready_clean_count`, `engine_class_*`, `product_class_count`, `human_authority_count`, `engine_class_rate`, `per_item[]` |
| `thresholds` | object | K, N, max engine-class rate applied |
| `loop_run_id` | string \| null | Durable loop run id; **required non-empty for release-eligible `pass: true`** |
| `pack_id` | string \| null | Fixed pack identity (must be `factory-gate-v1` for release-eligible pass) |
| `created_at` | string | ISO-8601 |
| `notes` | string[] | Pack selection / warnings |

### Evidence paths (stable)

Under the **repository root**:

```text
.agent-pipeline/frg/<X.Y.Z>/<frg-run-id>/evidence.json   # immutable
.agent-pipeline/frg/<X.Y.Z>/latest.json                  # lookup pointer (full evidence copy)
```

`pipeline release` reads `latest.json` for the resolved version.

## Driver invocation (Layer B)

### Score an existing durable loop run (recommended after a pack loop finishes)

```bash
pipeline factory-gate --for 1.29.1 --from-run <loop-run-id> [--json] [--no-close-pack]
```

- Exit `0` only when `pass: true`.
- Exit non-zero when `pass: false` or evidence cannot be produced.
- Writes evidence under `.agent-pipeline/frg/<version>/…`.
- `--json` prints the full evidence object on stdout.
- **Fixed-pack only:** `--from-run` validates the durable loop contract against the versioned
  pack manifest (`pack_id=factory-gate-v1`: selector must be label `factory-gate` or milestone
  `factory-gate` / `frg-pack` / `reliability-pack`, and ≥2 items). Unrelated successful loops are
  refused and do not write release evidence.
- **Observation required:** overall `pass: true` requires every named pack scenario to be
  observed with machine-checked criteria; `not_observed`, `fail`, or `skip` fails the gate.
  `capacity-blocked-retain` pass requires `observed ≥ N` (`capacity_stress_n`). `warn` is
  pass-permitting only for documented honesty outcomes (e.g. `empty-depends-on-stack-honesty`).
- **Live loop + pack provenance:** release-eligible `pass: true` also requires non-empty
  `loop_run_id` and `pack_id=factory-gate-v1`. Offline/fixture scoring does not write evidence
  by default and cannot mint release-usable pass artifacts without that provenance.
- Incomplete evidence (empty scenarios, missing thresholds/scoreboard) is rejected by release
  lookup.
- **Post-pass pack auto-close (#754):** after a release-eligible `pass: true` write, the driver
  closes **without merging** each open PR (and open linked issue) for `scoreboard.per_item[]`
  entries that are `ready_clean: true` **and** still carry the pack selector label
  (`factory-gate` for the default pack). Comments cite version + `run_id`. Scope is **only**
  those scored pack items — never a repo-wide “close all factory-gate”, and never product-
  milestone / non-pack work that merely shared a host or loop window. Close failures are
  reported but **do not** flip `pass` or delete evidence. Use `--no-close-pack` to skip
  auto-close (debugging mid-pack scoring, intentional land-of-provenance). **Merge is never
  part of FRG** — operators who want pack PRs on main still merge by hand.

### Start the pack (operator procedure)

1. File or select a **small fixed pack** of issues labeled `factory-gate` (or a known
   reliability milestone selector) covering the scenario inventory. Do **not** use the
   full product milestone as the work-list.
2. Set concurrency low enough to exercise capacity (e.g. `max_concurrent_worktrees: 2–3`
   and loop `concurrency.max_concurrent` aligned with the runbook). Document the values
   used in FRG `notes`.
3. Start the durable loop:

   ```bash
   pipeline loop --label factory-gate
   # or: pipeline loop --milestone "<reliability-pack-milestone>"
   ```

4. Exercise mid-flight resume (kill supervisor mid-advance; `pipeline loop --resume <run-id>`).
5. When the pack run is terminal (or sufficiently complete for scoring), score it:

   ```bash
   pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> --json
   # default: auto-closes synthetic pack R2D PRs/issues without merge
   # pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> --no-close-pack
   ```

6. Attach evidence to the release PR (automated by `pipeline release` on success; or paste
   `run_id` + pass summary manually). Synthetic pack throwaways should already be closed
   after step 5 unless you passed `--no-close-pack`.

### Concurrency settings (documented defaults for FRG)

| Setting | Suggested FRG value | Why |
|---------|---------------------|-----|
| `max_concurrent_worktrees` | `2`–`3` | Force capacity under blocked retain |
| Loop `concurrency.max_concurrent` | `2` | Multi-item composition without full factory blast radius |
| Selector | `factory-gate` label **or** reliability milestone | Fixed pack, not product backlog |

## Release integration

`pipeline release <X.Y.Z|major|minor|patch>` **after version resolution**:

1. Looks up `.agent-pipeline/frg/<version>/latest.json`.
2. **Fails closed** when missing, unparsable, `pass: false`, or empty `run_id`.
3. **Open soak-defect preflight (#755)** — with FRG `loop_run_id` / `run_id` available, **fails closed** when open engine-class soak defects are attributable to that candidate (typed terminal / recovery-exhaustion evidence preferred; `bug` + `pipeline:engine-class` label fallback for historical records). Runs **before** any version-file mutation. A recoverable intermediate that converged in-run does **not** block.
4. On success, includes an FRG section on the release PR body (`run_id`, pass summary). When the audited override was used, also includes a waiver section (waived issue numbers + reason).
5. Still runs `npm run ci` (additive). FRG, open-soak preflight, and CI are independent; none alone is sufficient.
6. Does **not** merge or tag because FRG/open-soak passed.

### Open soak-defect override (audited only)

When open candidate-linked engine-class defects must not hold a deliberate release:

```bash
pipeline release <X.Y.Z> --allow-open-soak-defects "<non-empty reason>"
```

The reason is recorded on the release PR body. **Silent skip is not available** (no env/config default clears this gate).

Remediation message always points at this runbook and:

```bash
pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id>
```

## Attachment checklist (release PR)

- [ ] FRG `run_id` visible on the PR body (or comment)
- [ ] Result shows **pass** for the **same** version as the release
- [ ] Artifact path or digest available for auditors
- [ ] Engine-class rate and clean-ready counts meet thresholds
- [ ] Open engine-class soak defects from the candidate soak are closed **or** an audited `--allow-open-soak-defects` waiver section is on the PR body (#755)

Unrecorded local claims (“we soaked it”) **do not** satisfy the attachment requirement.

## Repeatability

Every subsequent release reuses:

1. This runbook  
2. `pipeline factory-gate`  
3. The same scenario id inventory and evidence schema  

Each version gets its **own** evidence artifact keyed by `version`.

## First shipping release after the gate lands

Target: **v1.29.1** (or the next release that ships this change).

1. Land reliability siblings as needed (#712, #714, #716, #718, #722, …).  
2. Run Layer B pack + `pipeline factory-gate --for 1.29.1 --from-run …`.  
3. Retain `pass: true` evidence under `.agent-pipeline/frg/1.29.1/`.  
4. Link FRG `run_id` from the release PR and issue #723.  
5. Next release (e.g. v1.30.0) reuses this same procedure (prove not a one-off).

## Related docs

- Two-item pilot (smoke, not a release gate): `docs/durable-run-two-item-live-pilot-runbook.md`
- Parallel conflict pilot: `docs/durable-run-parallel-conflict-pilot-runbook.md`
- Implementation: `core/scripts/factory-reliability-gate.ts`
- OpenSpec: `openspec/changes/release-mandatory-factory-reliability-gate/`
