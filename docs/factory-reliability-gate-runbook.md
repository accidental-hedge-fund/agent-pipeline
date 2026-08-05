# Factory Reliability Gate (FRG) — runbook (#723 / #757)

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
Tag creation remains owned by `auto-tag-release.yml`, which **verifies FRG evidence
before** creating or pushing a tag (#757).

## Two-track engine pinning (#762)

Factory self-hosting uses **two tracks** so a candidate regression cannot immediately
degrade the factory's ability to repair itself:

| Track | What runs | Who uses it |
|-------|-----------|-------------|
| **Pinned** | Last FRG-passed release promoted into production dogfood | Ordinary `pipeline loop` / advance / production dogfood |
| **Candidate** | Working tree / release branch / unreleased build | FRG Layer B soaks and documented eval campaigns only |

**Production pin** (authoritative target for the pinned track):

```text
.agent-pipeline/production-engine-pin.json
```

Fields: `version`, `tag` (for `npx …#vX.Y.Z install`), `frg_run_id`, optional
`git_sha` (null/unknown is valid — never invent a SHA), `promoted_at`, optional
`previous` for rollback.

| Action | Command |
|--------|---------|
| Show pin | `pipeline factory-pin show` |
| Bootstrap from FRG pass | `pipeline factory-pin init --from-frg <X.Y.Z>` |
| Promote after FRG pass | `pipeline factory-pin promote --for <X.Y.Z> [--git-sha <sha>]` |
| Optional promote after gate | `pipeline factory-gate --for <X.Y.Z> --from-run <id> --promote-pin-on-pass` |
| Rollback | `pipeline factory-pin rollback` (uses `previous`) or `… rollback --to <X.Y.Z>` |
| Verify | `pipeline doctor` → check `install:engine-track` |

After promote or rollback, **reinstall** the skill from the pin tag and re-run doctor:

```bash
npx -y github:accidental-hedge-fund/agent-pipeline#vX.Y.Z install
pipeline doctor
```

**Rules:**

1. Production dogfood installs and runs the **pinned** tag, not an unpinned floating
   default-branch install and not a silent working-tree candidate.
2. FRG Layer B exercises the **candidate** until `pass: true`; associated run evidence
   records `engine.track: "candidate"`.
3. Promote updates the pin artifact only. It does **not** merge PRs, create git tags,
   or enable auto-merge. Green unit CI alone never moves the pin.
4. `pipeline doctor` reports pin target, installed version, and track coherence
   (`install:engine-track`). Run evidence records `engine.track` at run start.

## Two layers (both mandatory)

| Layer | When | What |
|-------|------|------|
| **A. Hermetic** | Every PR that can break composition; always in `npm test` / `npm run ci` | Fake-deps composition tests for capacity, resume, OpenSpec archive coherence, lockfold, docs parity, supersede_mode, auto-tag FRG guard |
| **B. Live** | **Every release** (patch / minor / major) | Multi-item durable `pipeline:loop` against a **representative** fixed scenario pack; immutable evidence artifact |

## Numeric thresholds (bootstrap / provisional)

| Key | Symbol | Value | Meaning |
|-----|--------|------:|---------|
| `min_clean_ready_to_deploy` | **K** | `2` | Minimum pack items that reach `ready` / ready-to-deploy without an engine-class block |
| `capacity_stress_n` | **N** | `2` | Blocked-retain count the pack must tolerate under low max worktrees without capacity cascade |
| `max_engine_class_rate` | — | `0.25` | Maximum allowed engine-class rate with **item_count** denominator (strictly greater **fails**) |

**Bootstrap origin (#757):** K=`2` and max engine-class rate `25%` are **provisional** values
chosen for the first mandatory gate. They are **not** multi-release empirical optima.
Tightening them is a **follow-on** once the [trend ledger](#trend-ledger) has sufficient
history for operators to review. This change does **not** alter the numeric values.

Thresholds remain numeric and checked by `pipeline factory-gate` /
`computeFrgEvidence` in `core/scripts/factory-reliability-gate.ts`.

## Engine-class rate formula

Whenever `scoreboard.item_count ≥ 1`:

```text
engine_class_rate = engine_class_count / item_count
```

- Denominator is **processed pack item count** (every `per_item` row once).
- Clean items with no blocker class are in the denominator.
- Zero engine-class items → rate `0` (never `null` / never print `n/a` when `item_count ≥ 1`).
- `item_count === 0` → not release-eligible.
- Each pack item contributes at most one taxonomy class (terminal projection; multi-event
  recovery on the same item does not multi-count).

Product-class and human-authority counts remain on the scoreboard for honesty; they are
**not** the rate denominator.

## Blocker taxonomy

| Bucket | Meaning | Gate effect |
|--------|---------|-------------|
| **engine-class** | Factory defects (capacity cascade, resume strand, archive false-pass, lock dirt at 0 attempts, docs-after-PR, PR supersession bugs, `workflow-engine-defect`, typed engine exhaustion, unknown free-form themes) | Counted toward engine-class rate; rate above threshold fails FRG |
| **product-class** | Intentional product failures / out-of-scope product issues injected by the pack | Does not fail FRG by itself |
| **human-authority** | Correct human holds (`missing-authority`, `specification-decision`) | Does not fail FRG by itself; **false** projection for injected recoverables fails release-eligible composition |

## Representative pack composition (#757)

Release-eligible `pass: true` requires a **representative** pack — not only clean-item
throughput at K. Machine-readable `composition.dimensions[]` must show every required
dimension as `status: pass`, with `false_human_authority_count === 0`.

| Dimension id | Meaning |
|--------------|---------|
| `openspec-bearing-item` | ≥1 item carried a real OpenSpec change through archive/coherence |
| `fix-rereview-cycle` | ≥1 item traversed blocking finding → fix → re-review |
| `concurrency-contention` | Multi-item concurrency with worktree contention N≥2 |
| `managed-worktree-dirt` | Missing/dirty managed worktrees exercised |
| `process-restart-hydration` | Process death + fresh-process resume/hydration |
| `forge-http-5xx-backoff` | Forge HTTP 5xx with bounded backoff |
| `ci-pending-red-recovery` | Pending/red CI with bounded recovery |
| `same-head-noop-reentry` | Same-HEAD no-op re-entry |
| `capacity-live-run-coexistence` | Concurrent capacity pressure + live-run coexistence |
| `recovery-controller-one-item` | Production #787 controller via **`pipeline single <N>`** |
| `recovery-controller-multi-item` | Production #787 controller via **`pipeline loop`** |

Clean-only comment / trivial no-op packs (**#749/#750 class**) are **retired** as
non-representative fixtures for release-eligible FRG. Satisfying K alone does **not**
yield `pass: true`. Failure evidence lists `composition.missing[]` naming each gap.

### Recovery controller bounds (policy-backed)

| Injected class | Canonical path | Bound (`DEFAULT_RECOVERY_POLICY`) |
|----------------|----------------|-------------------------------------|
| forge HTTP 5xx / rate limit | `transient-rate-limit` | retry_budget **5**, backoff max 900s |
| workflow / OpenSpec state | `workflow-state` | retry_budget **3**, max 300s |
| pending/red CI | `implementation-ci` | retry_budget **3**, max 600s |
| review fix cycle | `review-findings` | retry_budget **3** |
| process death / restart | `workflow-engine-defect` / resume | retry_budget **2** |
| capacity pressure | capacity + worktree | N=`capacity_stress_n` (2) |
| same-HEAD no-op | noop-advance | must not false `human_authority` |
| true human holds | `missing-authority`, `specification-decision` | retry_budget **0**, legitimate `human_authority` |

Recovery aggregates (`recovery_aggregates.by_reason`) feed the scoreboard path (item
classification) and the [trend ledger](#trend-ledger) when available from the pack run.

## Scenario pack inventory

| Scenario id | Layer A | Layer B | Pass criteria |
|-------------|---------|---------|---------------|
| `capacity-blocked-retain` | test | yes | Low max worktrees + blocked retain ≥ N; next eligible item is **not** false-blocked as needs-human solely for capacity |
| `resume-mid-flight` | test | yes | Kill/resume supervisor; every in-flight item has a live next action; no permanent dead `pr_opened` strand |
| `openspec-multi-change` | test | yes | Partial archive / foreign active: archive result and residual still-active check **agree** |
| `implement-lockfile-dirt` | test | yes | Uncommitted lockfile after HEAD advanced is folded/cleaned; no human-block on known lock dirt at 0 attempts |
| `local-docs-parity` | test | yes | Docs/generator checks that fail on CI fail **before** PR open (or before ready-to-deploy) |
| `clean-item-throughput` | test (scoring) | yes | ≥ **K** easy items reach ready without engine-class block |
| `blocker-taxonomy` | test (scoring) | yes | Engine-class rate ≤ max (item_count denom) |
| `pr-supersession` | test | yes | Default `supersede_mode: close` — stale second PR for same issue does not remain open after new head |
| `release-plan-row` | test | yes | Auto-tag FRG guard validates release-eligible evidence before tag create/push |
| `empty-depends-on-stack-honesty` | test | yes | Empty `depends_on` items that still stack OpenSpec across branches → **warn** or **fail** |

The pack uses a **dedicated** synthetic / labeled work-list (`factory-gate` label or
reliability selector) — **not** the full product milestone backlog.

### Layer A waivers

| Scenario id | Tracking issue |
|-------------|----------------|
| _(none)_ | All required Layer A scenarios have hermetic tests after #757 |

Former closed-issue citations (#729, #730) are **not** valid waivers. Coverage is tests.

## Evidence schema

Machine-readable JSON (`schema_version: 1`), additive fields for #757:

| Field | Type | Meaning |
|-------|------|---------|
| `schema_version` | number | Always `1` for this contract |
| `version` | string | Release version `X.Y.Z` (no leading `v`) |
| `run_id` | string | Unique FRG run id (non-empty) |
| `pass` | boolean | Overall machine-checked outcome |
| `scenarios` | array | Per-scenario `{ id, status, detail, observed?, threshold? }` |
| `scoreboard` | object | counts, `engine_class_rate`, `per_item[]` (rate = count/item_count when item_count≥1) |
| `thresholds` | object | K, N, max engine-class rate applied |
| `loop_run_id` | string \| null | Durable loop run id; **required non-empty for release-eligible `pass: true`** |
| `pack_id` | string \| null | Fixed pack identity (must be `factory-gate-v1` for release-eligible pass) |
| `composition` | object | `dimensions[]`, `false_human_authority_count`, `missing[]` |
| `integrity` | object | `producer`, `scoreboard_fingerprint`, `composition_fingerprint`, `attestation?` |
| `recovery_aggregates` | object? | optional `by_reason` map |
| `created_at` | string | ISO-8601 |
| `notes` | string[] | Pack selection / warnings |

Integrity fingerprints are recomputed on parse; a minimal forged `{ "pass": true }` fails.

**Producer attestation (required for release-eligible pass / auto-tag):**

- Env / secret: `PIPELINE_FRG_ATTESTATION_KEY` (same value as repo Actions secret used by
  `auto-tag-release.yml`).
- Mint: export the key before `pipeline factory-gate …` so `integrity.attestation` is written
  (`alg: hmac-sha256-v1`, hex MAC over version/run_id/loop_run_id/pack_id + fingerprints).
- Without the key, the driver will **not** mint release-eligible `pass: true`.
- Auto-tag verifies the MAC with the secret; self-consistent hand-authored JSON that only
  recomputes public fingerprints is **rejected** (fail closed, no tag).

### Evidence paths (stable)

Under the **repository root**:

```text
.agent-pipeline/frg/<X.Y.Z>/<frg-run-id>/evidence.json   # immutable primary
.agent-pipeline/frg/<X.Y.Z>/latest.json                  # lookup pointer (full evidence copy)
.agent-pipeline/frg/trend-ledger.jsonl                   # append-only trend (#757)
```

`pipeline release` and `auto-tag-release.yml` read `latest.json` for the resolved version.

**Commit bar:** `.agent-pipeline/frg/` is **not** gitignored. Operators **must** commit at
least `.agent-pipeline/frg/<X.Y.Z>/latest.json` (and preferably the sibling
`…/<run_id>/evidence.json`) on the **release PR** so auto-tag’s checkout sees the artifact.
A worktree-local-only write that is never committed **correctly fails** auto-tag (fail closed).

### Trend ledger

Each successful primary evidence write appends one JSON line (idempotent on
`(version, run_id)`). Fields include version, run_id, loop_run_id, pass, pack_id,
created_at, item/rate counts, thresholds snapshot, optional recovery aggregates, and
composition missing summary.

Ledger I/O failure after primary write is **fail-soft**: reported on stderr; evidence is
**not** deleted; `pass` is not flipped. Operators can rebuild from
`frg/*/…/evidence.json` trees.

## Driver invocation (Layer B)

### Score an existing durable loop run (recommended after a pack loop finishes)

```bash
export PIPELINE_FRG_ATTESTATION_KEY='…'   # same value as the repo Actions secret
pipeline factory-gate --for 1.30.0 --from-run <loop-run-id> \
  --observations path/to/observations.json \
  [--scenario id=status:detail[:observed=N]] \
  [--json] [--no-close-pack]
```

- Exit `0` only when `pass: true`.
- Exit non-zero when `pass: false` or evidence cannot be produced.
- Writes evidence under `.agent-pipeline/frg/<version>/…` and appends the trend ledger.
- `--json` prints the full evidence object on stdout.
- **Fixed-pack only:** `--from-run` validates the durable loop contract against the versioned
  pack manifest (`pack_id=factory-gate-v1`: selector must be label `factory-gate` or milestone
  `factory-gate` / `frg-pack` / `reliability-pack`, and ≥2 items). Unrelated successful loops are
  refused and do not write release evidence.
- **Observation required:** overall `pass: true` requires every named pack scenario to be
  observed with machine-checked criteria; `not_observed`, `fail`, or `skip` fails the gate.
  `capacity-blocked-retain` pass requires `observed ≥ N` (`capacity_stress_n`). `warn` is
  pass-permitting only for documented honesty outcomes (e.g. `empty-depends-on-stack-honesty`).
- **Composition required:** release-eligible pass also requires every composition dimension
  to pass (via ledger projection and/or observations file).
- **Live loop + pack provenance:** non-empty `loop_run_id` and `pack_id=factory-gate-v1`.
- **Post-pass pack auto-close (#754):** after a release-eligible `pass: true` write, closes
  synthetic pack open PRs/issues **without merge** unless `--no-close-pack`.

### Observations file schema (`--observations`)

```json
{
  "schema_version": 1,
  "scenarios": [
    {
      "id": "resume-mid-flight",
      "status": "pass",
      "detail": "killed mid-advance; pipeline loop --resume recovered",
      "observed": null,
      "threshold": null
    }
  ],
  "composition": [
    {
      "id": "fix-rereview-cycle",
      "status": "pass",
      "detail": "item 42: blocking finding → fix → re-review pass",
      "observed": null
    },
    {
      "id": "recovery-controller-one-item",
      "status": "pass",
      "detail": "pipeline single 42 exercised #787 recovery path",
      "observed": 1
    }
  ],
  "false_human_authority_count": 0,
  "recovery_aggregates": {
    "by_reason": {
      "implementation-ci": {
        "success": 1,
        "exhaustion": 0,
        "resumes": 0,
        "elapsed_ms": 12000
      }
    }
  }
}
```

Unknown scenario or composition ids are **hard-rejected** (CLI exit non-zero before scoring).
Auto-scored scenarios (`clean-item-throughput`, `blocker-taxonomy`) still derive from the
ledger; observations cannot loosen numeric capacity / rate rules.

**Test-only helper** `frgRequiredObservationOverrides` / `frgRequiredCompositionOverrides`
must not be used as the operator path for minting release evidence.

Optional repeated CLI tokens:

```bash
--scenario resume-mid-flight=pass:killed and resumed
--scenario capacity-blocked-retain=pass:ok:observed=2
```

### Start the pack (operator procedure)

1. File or select a **representative fixed pack** labeled `factory-gate` (or a known
   reliability milestone selector) covering scenarios **and** composition dimensions.
   Do **not** use #749/#750-class comment-only fixtures. Do **not** use the full product
   milestone as the work-list.
2. Exercise one-item recovery via `pipeline single <N>` and multi-item via
   `pipeline loop --label factory-gate` (production #787 controller paths).
3. Set concurrency low enough to exercise capacity (e.g. `max_concurrent_worktrees: 2–3`
   and loop `concurrency.max_concurrent` aligned with the runbook). Document values in
   FRG `notes`.
4. Inject/observe recovery classes (worktree dirt/missing, process death + resume, forge
   5xx, CI pending/red, same-HEAD no-op, capacity + live-run).
5. When the pack run is terminal (or sufficiently complete for scoring), score it with an
   observations file covering remaining non-auto dimensions:

   ```bash
   pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> \
     --observations docs/frg-observations.example.json --json
   ```

6. **Commit** `.agent-pipeline/frg/<X.Y.Z>/latest.json` (and run evidence) on the release
   branch/PR. `pipeline release` embeds the FRG section; files must land in the tree for
   auto-tag.

### Concurrency settings (documented defaults for FRG)

| Setting | Suggested FRG value | Why |
|---------|---------------------|-----|
| `max_concurrent_worktrees` | `2`–`3` | Force capacity under blocked retain |
| Loop `concurrency.max_concurrent` | `2` | Multi-item composition without full factory blast radius |
| Selector | `factory-gate` label **or** reliability milestone | Fixed pack, not product backlog |

## Release integration

`pipeline release <X.Y.Z|major|minor|patch>` **after version resolution**:

1. Looks up `.agent-pipeline/frg/<version>/latest.json`.
2. **Fails closed** when missing, unparsable, `pass: false`, empty `run_id`, or not
   release-eligible (composition, integrity, rate integrity, etc.).
3. **Open soak-defect preflight (#755)** — with FRG `loop_run_id` / `run_id` available,
   fails closed when open engine-class soak defects are attributable to that candidate.
4. On success, includes an FRG section on the release PR body (`run_id`, numeric rate, composition).
5. Still runs `npm run ci` (additive). FRG, open-soak preflight, and CI are independent.
6. Does **not** merge or tag because FRG/open-soak passed.

### Auto-tag FRG guard (#757)

On a detected release merge (`release: X.Y.Z — …` subject + `core/package.json` version match,
tag not already present), `.github/workflows/auto-tag-release.yml`:

1. Verifies `.agent-pipeline/frg/<X.Y.Z>/latest.json` via the shared Node validator
   (`factory-reliability-gate.ts --validate-tag <version>`).
2. **Fails closed** (no tag create/push) when missing, unparsable, `pass: false`, or not
   release-eligible.
3. On success, proceeds to notes resolution and annotated tag push (existing rules).
4. Non-release pushes remain successful no-ops without FRG.
5. Existing tags remain successful no-ops.

FRG never creates tags itself; the workflow remains the tag owner.

### Open soak-defect override (audited only)

```bash
pipeline release <X.Y.Z> --allow-open-soak-defects "<non-empty reason>"
```

The reason is recorded on the release PR body. Silent skip is not available.

Remediation:

```bash
pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> --observations <file>
```

## Attachment checklist (release PR)

- [ ] FRG `run_id` visible on the PR body (or comment)
- [ ] Result shows **pass** for the **same** version as the release
- [ ] **Committed** `.agent-pipeline/frg/<version>/latest.json` on the release branch
- [ ] Engine-class rate is numeric (item_count denom) and ≤ max
- [ ] Composition dimensions all pass; `false_human_authority_count` is 0
- [ ] Open engine-class soak defects closed **or** audited `--allow-open-soak-defects`

Unrecorded local claims (“we soaked it”) **do not** satisfy the attachment requirement.

## Repeatability

Every subsequent release reuses:

1. This runbook  
2. `pipeline factory-gate` with observations CLI  
3. The same scenario id + composition dimension inventory and evidence schema  
4. Trend ledger history for threshold review  

Each version gets its **own** evidence artifact keyed by `version`.

## Related docs

- CLI: `docs/cli.md` (`factory-gate` command)
- Two-item pilot (smoke, not a release gate): `docs/durable-run-two-item-live-pilot-runbook.md`
- Implementation: `core/scripts/factory-reliability-gate.ts`
- OpenSpec change: `openspec/changes/frg-representative-pack-requirements/`
- Auto-tag workflow: `.github/workflows/auto-tag-release.yml`
